import { z } from "npm:zod@4";
import {
  buildClient,
  ContextInfoSchema,
  K8sGlobalArgsSchema,
  listKubeContexts,
  normalizeMeta,
  sanitizeInstanceName,
} from "./_helpers.ts";

// --- Schemas ---

const PodSchema = z.object({
  name: z.string(),
  namespace: z.string(),
  uid: z.string(),
  phase: z.string(),
  nodeName: z.string(),
  podIP: z.string(),
  hostIP: z.string(),
  startTime: z.string(),
  restartCount: z.number(),
  containerStatuses: z.array(z.object({
    name: z.string(),
    ready: z.boolean(),
    restartCount: z.number(),
    state: z.string(),
    image: z.string(),
  })),
  conditions: z.array(z.object({
    type: z.string(),
    status: z.string(),
  })),
  labels: z.record(z.string(), z.string()),
  annotations: z.record(z.string(), z.string()),
  createdAt: z.string(),
}).passthrough();

const MetricsSchema = z.object({
  name: z.string(),
  namespace: z.string(),
  cpuUsage: z.string(),
  memoryUsage: z.string(),
  collectedAt: z.string(),
  containers: z.array(z.object({
    name: z.string(),
    cpuUsage: z.string(),
    memoryUsage: z.string(),
  })),
}).passthrough();

const ExecResultSchema = z.object({
  podName: z.string(),
  namespace: z.string(),
  container: z.string(),
  command: z.string(),
  stdout: z.string(),
  exitCode: z.number(),
  executedAt: z.string(),
}).passthrough();

// --- Pod-specific helpers ---

function normalizePod(raw) {
  const meta = normalizeMeta(raw);
  const status = raw.status || {};
  const spec = raw.spec || {};

  const containerStatuses = (status.containerStatuses || []).map((cs) => ({
    name: cs.name || "",
    ready: cs.ready || false,
    restartCount: cs.restartCount || 0,
    state: cs.state ? Object.keys(cs.state)[0] || "unknown" : "unknown",
    image: cs.image || "",
  }));

  const totalRestarts = containerStatuses.reduce(
    (sum, cs) => sum + cs.restartCount,
    0,
  );

  const conditions = (status.conditions || []).map((c) => ({
    type: c.type || "",
    status: c.status || "",
  }));

  return {
    ...meta,
    phase: status.phase || "Unknown",
    nodeName: spec.nodeName || "",
    podIP: status.podIP || "",
    hostIP: status.hostIP || "",
    startTime: status.startTime ? new Date(status.startTime).toISOString() : "",
    restartCount: totalRestarts,
    containerStatuses,
    conditions,
  };
}

// --- Model ---

export const model = {
  type: "@john/pod",
  version: "2026.02.26.1",
  globalArguments: K8sGlobalArgsSchema,
  resources: {
    pod: {
      description:
        "Pod state including phase, container statuses, conditions, IPs, and restart counts",
      schema: PodSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    metrics: {
      description:
        "Per-pod and per-container CPU/memory usage from the metrics-server",
      schema: MetricsSchema,
      lifetime: "1h",
      garbageCollection: 5,
    },
    execResult: {
      description:
        "Stdout, exit code, and metadata from a non-interactive kubectl exec",
      schema: ExecResultSchema,
      lifetime: "1h",
      garbageCollection: 5,
    },
    contextInfo: {
      description: "Available kubeconfig contexts",
      schema: ContextInfoSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
  },
  files: {
    logs: {
      description: "Raw container stdout/stderr logs fetched from the K8s API",
      contentType: "text/plain",
      lifetime: "7d",
      garbageCollection: 5,
      streaming: true,
    },
  },
  methods: {
    // --- Read-only methods ---

    listContexts: {
      description: "List available kubeconfig contexts",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { kc } = buildClient(context.globalArgs);
        const contexts = listKubeContexts(kc);

        const handles = [];
        for (const ctx of contexts) {
          const handle = await context.writeResource(
            "contextInfo",
            sanitizeInstanceName(ctx.name),
            ctx,
          );
          handles.push(handle);
        }
        return { dataHandles: handles };
      },
    },

    list: {
      description:
        "List all pods in the configured namespace, optionally filtered by label selector",
      arguments: z.object({ namespace: z.string().optional() }),
      execute: async (args, context) => {
        const { coreApi } = buildClient(context.globalArgs);
        const ns = args.namespace ?? context.globalArgs.namespace;
        const labels = context.globalArgs.labels;

        const resp = await coreApi.listNamespacedPod({
          namespace: ns,
          labelSelector: labels,
        });
        const pods = resp.items || [];

        context.logger.info("Found {count} pods in {ns}", {
          count: pods.length,
          ns,
        });

        const handles = [];
        for (const pod of pods) {
          const normalized = normalizePod(pod);
          const handle = await context.writeResource(
            "pod",
            normalized.name,
            normalized,
          );
          handles.push(handle);
        }
        return { dataHandles: handles };
      },
    },

    get: {
      description:
        "Get a single pod's full status including phase, container states, conditions, and IPs",
      arguments: z.object({
        podName: z.string(),
        namespace: z.string().optional(),
      }),
      execute: async (args, context) => {
        const { coreApi } = buildClient(context.globalArgs);
        const ns = args.namespace ?? context.globalArgs.namespace;

        const pod = await coreApi.readNamespacedPod({
          name: args.podName,
          namespace: ns,
        });
        const normalized = normalizePod(pod);

        const handle = await context.writeResource(
          "pod",
          normalized.name,
          normalized,
        );
        return { dataHandles: [handle] };
      },
    },

    // --- Mutating methods ---

    create: {
      description:
        "Create a pod from a container image name or a full pod spec object",
      arguments: z.object({
        podName: z.string(),
        image: z.string().optional(),
        spec: z.any().optional(),
        namespace: z.string().optional(),
      }),
      execute: async (args, context) => {
        const { coreApi } = buildClient(context.globalArgs);
        const ns = args.namespace ?? context.globalArgs.namespace;

        let podSpec;
        if (args.spec) {
          podSpec = args.spec;
        } else if (args.image) {
          podSpec = {
            metadata: { name: args.podName, namespace: ns },
            spec: {
              containers: [{
                name: args.podName,
                image: args.image,
              }],
            },
          };
        } else {
          throw new Error("Either 'image' or 'spec' must be provided");
        }

        const created = await coreApi.createNamespacedPod({
          namespace: ns,
          body: podSpec,
        });
        const normalized = normalizePod(created);

        const handle = await context.writeResource(
          "pod",
          normalized.name,
          normalized,
        );
        return { dataHandles: [handle] };
      },
    },

    delete: {
      description: "Delete a pod",
      arguments: z.object({
        podName: z.string(),
        namespace: z.string().optional(),
      }),
      execute: async (args, context) => {
        const { coreApi } = buildClient(context.globalArgs);
        const ns = args.namespace ?? context.globalArgs.namespace;

        await coreApi.deleteNamespacedPod({
          name: args.podName,
          namespace: ns,
        });

        context.logger.info("Deleted pod {name} in {ns}", {
          name: args.podName,
          ns,
        });
        return { dataHandles: [] };
      },
    },

    restart: {
      description:
        "Delete a pod and wait up to waitSeconds for its controller to recreate it in Running state",
      arguments: z.object({
        podName: z.string(),
        waitSeconds: z.number().default(30),
        namespace: z.string().optional(),
      }),
      execute: async (args, context) => {
        const { coreApi } = buildClient(context.globalArgs);
        const ns = args.namespace ?? context.globalArgs.namespace;

        await coreApi.deleteNamespacedPod({
          name: args.podName,
          namespace: ns,
        });

        context.logger.info("Deleted pod {name}, waiting for recreation", {
          name: args.podName,
        });

        // Wait for the pod to be recreated by its controller
        const deadline = Date.now() + args.waitSeconds * 1000;
        let newPod = null;

        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 2000));
          try {
            const pod = await coreApi.readNamespacedPod({
              name: args.podName,
              namespace: ns,
            });
            if (pod.status?.phase === "Running") {
              newPod = pod;
              break;
            }
          } catch {
            // Pod not yet recreated, keep waiting
          }
        }

        if (newPod) {
          const normalized = normalizePod(newPod);
          const handle = await context.writeResource(
            "pod",
            normalized.name,
            normalized,
          );
          return { dataHandles: [handle] };
        }

        context.logger.warning(
          "Pod {name} not yet running after {sec}s wait",
          { name: args.podName, sec: args.waitSeconds },
        );
        return { dataHandles: [] };
      },
    },

    // --- Operational methods ---

    getLogs: {
      description:
        "Fetch the last N lines of container logs via the K8s API and store as a streaming file",
      arguments: z.object({
        podName: z.string(),
        container: z.string().optional(),
        tailLines: z.number().default(100),
        previous: z.boolean().default(false),
        namespace: z.string().optional(),
      }),
      execute: async (args, context) => {
        const { coreApi } = buildClient(context.globalArgs);
        const ns = args.namespace ?? context.globalArgs.namespace;

        const resp = await coreApi.readNamespacedPodLog({
          name: args.podName,
          namespace: ns,
          container: args.container,
          tailLines: args.tailLines,
          previous: args.previous,
        });

        const logText = typeof resp === "string" ? resp : String(resp);
        const writer = context.createFileWriter(
          "logs",
          `${args.podName}${args.container ? `-${args.container}` : ""}`,
        );
        const handle = await writer.writeText(logText);

        return { dataHandles: [handle] };
      },
    },

    getMetrics: {
      description:
        "Query the metrics-server API for per-pod and per-container CPU/memory usage in the namespace",
      arguments: z.object({ namespace: z.string().optional() }),
      execute: async (args, context) => {
        const { metricsClient } = buildClient(context.globalArgs);
        const ns = args.namespace ?? context.globalArgs.namespace;

        let podMetrics;
        try {
          const resp = await metricsClient.getPodMetrics(ns);
          podMetrics = resp.items || [];
        } catch (err) {
          context.logger.warning(
            "Metrics API unavailable: {error}. Is metrics-server installed?",
            { error: err.message },
          );
          return { dataHandles: [] };
        }

        const handles = [];
        for (const pm of podMetrics) {
          const containers = (pm.containers || []).map((c) => ({
            name: c.name || "",
            cpuUsage: c.usage?.cpu || "0",
            memoryUsage: c.usage?.memory || "0",
          }));

          const totalCpu = containers
            .map((c) => c.cpuUsage)
            .join("+");
          const totalMem = containers
            .map((c) => c.memoryUsage)
            .join("+");

          const normalized = {
            name: pm.metadata?.name || "",
            namespace: pm.metadata?.namespace || ns,
            cpuUsage: totalCpu,
            memoryUsage: totalMem,
            collectedAt: new Date().toISOString(),
            containers,
          };

          const handle = await context.writeResource(
            "metrics",
            normalized.name,
            normalized,
          );
          handles.push(handle);
        }

        context.logger.info("Collected metrics for {count} pods", {
          count: handles.length,
        });
        return { dataHandles: handles };
      },
    },

    exec: {
      description:
        "Run a command in a pod container via kubectl exec and capture stdout/stderr and exit code",
      arguments: z.object({
        podName: z.string(),
        command: z.array(z.string()),
        container: z.string().optional(),
      }),
      execute: async (args, context) => {
        const globalArgs = context.globalArgs;
        const ns = globalArgs.namespace;

        const kubectlArgs = [
          "exec",
          args.podName,
          "-n",
          ns,
        ];

        if (args.container) {
          kubectlArgs.push("-c", args.container);
        }

        if (globalArgs.context) {
          kubectlArgs.push("--context", globalArgs.context);
        }

        if (globalArgs.kubeconfig) {
          kubectlArgs.push("--kubeconfig", globalArgs.kubeconfig);
        }

        kubectlArgs.push("--", ...args.command);

        const cmd = new Deno.Command("kubectl", {
          args: kubectlArgs,
          stdout: "piped",
          stderr: "piped",
        });

        const output = await cmd.output();
        const stdout = new TextDecoder().decode(output.stdout);
        const stderr = new TextDecoder().decode(output.stderr);

        if (!output.success && stderr) {
          context.logger.warning("exec stderr: {stderr}", { stderr });
        }

        const result = {
          podName: args.podName,
          namespace: ns,
          container: args.container || "",
          command: args.command.join(" "),
          stdout: stdout,
          exitCode: output.code,
          executedAt: new Date().toISOString(),
        };

        const handle = await context.writeResource(
          "execResult",
          `${args.podName}-exec`,
          result,
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
