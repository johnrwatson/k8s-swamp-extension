import { z } from "npm:zod@4";
import {
  buildClient,
  normalizeMeta,
  sanitizeInstanceName,
} from "./_helpers.ts";

// --- Global Args (cluster-scoped, no namespace) ---

const NodeGlobalArgsSchema = z.object({
  context: z.string().optional(),
  kubeconfig: z.string().optional(),
  labels: z.string().optional(),
});

// --- Schemas ---

const NodeSchema = z.object({
  name: z.string(),
  uid: z.string(),
  conditions: z.array(z.object({
    type: z.string(),
    status: z.string(),
    reason: z.string(),
    message: z.string(),
    lastTransitionTime: z.string(),
  })),
  capacityCpu: z.string(),
  capacityMemory: z.string(),
  capacityPods: z.string(),
  allocatableCpu: z.string(),
  allocatableMemory: z.string(),
  allocatablePods: z.string(),
  os: z.string(),
  arch: z.string(),
  kubeletVersion: z.string(),
  containerRuntime: z.string(),
  internalIP: z.string(),
  hostname: z.string(),
  taints: z.array(z.object({
    key: z.string(),
    value: z.string(),
    effect: z.string(),
  })),
  unschedulable: z.boolean(),
  podCIDR: z.string(),
  labels: z.record(z.string(), z.string()),
  annotations: z.record(z.string(), z.string()),
  createdAt: z.string(),
}).passthrough();

const NodeMetricsSchema = z.object({
  name: z.string(),
  cpuUsage: z.string(),
  memoryUsage: z.string(),
  collectedAt: z.string(),
}).passthrough();

const NodePodSchema = z.object({
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

// --- Helpers ---

function normalizeNode(raw) {
  const meta = normalizeMeta(raw);
  const status = raw.status || {};
  const spec = raw.spec || {};
  const info = status.nodeInfo || {};
  const capacity = status.capacity || {};
  const allocatable = status.allocatable || {};
  const addresses = status.addresses || [];

  const findAddress = (type) => {
    const addr = addresses.find((a) => a.type === type);
    return addr?.address || "";
  };

  return {
    name: meta.name,
    uid: meta.uid,
    conditions: (status.conditions || []).map((c) => ({
      type: c.type || "",
      status: c.status || "",
      reason: c.reason || "",
      message: c.message || "",
      lastTransitionTime: c.lastTransitionTime
        ? new Date(c.lastTransitionTime).toISOString()
        : "",
    })),
    capacityCpu: capacity.cpu || "",
    capacityMemory: capacity.memory || "",
    capacityPods: capacity.pods || "",
    allocatableCpu: allocatable.cpu || "",
    allocatableMemory: allocatable.memory || "",
    allocatablePods: allocatable.pods || "",
    os: info.operatingSystem || "",
    arch: info.architecture || "",
    kubeletVersion: info.kubeletVersion || "",
    containerRuntime: info.containerRuntimeVersion || "",
    internalIP: findAddress("InternalIP"),
    hostname: findAddress("Hostname"),
    taints: (spec.taints || []).map((t) => ({
      key: t.key || "",
      value: t.value || "",
      effect: t.effect || "",
    })),
    unschedulable: spec.unschedulable || false,
    podCIDR: spec.podCIDR || "",
    labels: meta.labels,
    annotations: meta.annotations,
    createdAt: meta.createdAt,
  };
}

function normalizePodForNode(raw) {
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

  return {
    ...meta,
    phase: status.phase || "Unknown",
    nodeName: spec.nodeName || "",
    podIP: status.podIP || "",
    hostIP: status.hostIP || "",
    startTime: status.startTime ? new Date(status.startTime).toISOString() : "",
    restartCount: totalRestarts,
    containerStatuses,
    conditions: (status.conditions || []).map((c) => ({
      type: c.type || "",
      status: c.status || "",
    })),
  };
}

// --- Model ---

export const model = {
  type: "@john/node",
  version: "2026.02.27.1",
  globalArguments: NodeGlobalArgsSchema,
  resources: {
    node: {
      description:
        "Node with conditions, capacity, allocatable resources, taints, and node info",
      schema: NodeSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    nodeMetrics: {
      description: "Node CPU and memory usage from metrics-server",
      schema: NodeMetricsSchema,
      lifetime: "1h",
      garbageCollection: 5,
    },
    nodePod: {
      description: "Pod running on a specific node",
      schema: NodePodSchema,
      lifetime: "1h",
      garbageCollection: 10,
    },
  },
  methods: {
    list: {
      description:
        "List all nodes with status, capacity, conditions, and taints",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { coreApi } = buildClient(context.globalArgs);
        const labels = context.globalArgs.labels;

        const resp = await coreApi.listNode({ labelSelector: labels });
        const nodes = resp.items || [];

        context.logger.info("Found {count} nodes", { count: nodes.length });

        const handles = [];
        for (const node of nodes) {
          const normalized = normalizeNode(node);
          const handle = await context.writeResource(
            "node",
            sanitizeInstanceName(normalized.name),
            normalized,
          );
          handles.push(handle);
        }
        return { dataHandles: handles };
      },
    },

    get: {
      description:
        "Get a node's full status including conditions, capacity, taints, and node info",
      arguments: z.object({
        nodeName: z.string(),
      }),
      execute: async (args, context) => {
        const { coreApi } = buildClient(context.globalArgs);

        const node = await coreApi.readNode({ name: args.nodeName });
        const normalized = normalizeNode(node);

        const handle = await context.writeResource(
          "node",
          sanitizeInstanceName(normalized.name),
          normalized,
        );
        return { dataHandles: [handle] };
      },
    },

    getMetrics: {
      description: "Get CPU and memory usage for all nodes from metrics-server",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { metricsClient } = buildClient(context.globalArgs);

        let nodeMetrics;
        try {
          const resp = await metricsClient.getNodeMetrics();
          nodeMetrics = resp.items || [];
        } catch (err) {
          context.logger.warning(
            "Metrics API unavailable: {error}. Is metrics-server installed?",
            { error: err.message },
          );
          return { dataHandles: [] };
        }

        const handles = [];
        for (const nm of nodeMetrics) {
          const normalized = {
            name: nm.metadata?.name || "",
            cpuUsage: nm.usage?.cpu || "0",
            memoryUsage: nm.usage?.memory || "0",
            collectedAt: new Date().toISOString(),
          };

          const handle = await context.writeResource(
            "nodeMetrics",
            sanitizeInstanceName(normalized.name),
            normalized,
          );
          handles.push(handle);
        }

        context.logger.info("Collected metrics for {count} nodes", {
          count: handles.length,
        });
        return { dataHandles: handles };
      },
    },

    cordon: {
      description: "Cordon a node by setting spec.unschedulable = true",
      arguments: z.object({
        nodeName: z.string(),
      }),
      execute: async (args, context) => {
        const { coreApi } = buildClient(context.globalArgs);

        const current = await coreApi.readNode({ name: args.nodeName });
        current.spec.unschedulable = true;

        const replaced = await coreApi.replaceNode({
          name: args.nodeName,
          body: current,
        });
        const normalized = normalizeNode(replaced);

        context.logger.info("Cordoned node {name}", { name: args.nodeName });

        const handle = await context.writeResource(
          "node",
          sanitizeInstanceName(normalized.name),
          normalized,
        );
        return { dataHandles: [handle] };
      },
    },

    uncordon: {
      description: "Uncordon a node by setting spec.unschedulable = false",
      arguments: z.object({
        nodeName: z.string(),
      }),
      execute: async (args, context) => {
        const { coreApi } = buildClient(context.globalArgs);

        const current = await coreApi.readNode({ name: args.nodeName });
        current.spec.unschedulable = false;

        const replaced = await coreApi.replaceNode({
          name: args.nodeName,
          body: current,
        });
        const normalized = normalizeNode(replaced);

        context.logger.info("Uncordoned node {name}", { name: args.nodeName });

        const handle = await context.writeResource(
          "node",
          sanitizeInstanceName(normalized.name),
          normalized,
        );
        return { dataHandles: [handle] };
      },
    },

    taint: {
      description: "Add a taint to a node",
      arguments: z.object({
        nodeName: z.string(),
        key: z.string(),
        value: z.string().default(""),
        effect: z.enum(["NoSchedule", "PreferNoSchedule", "NoExecute"]),
      }),
      execute: async (args, context) => {
        const { coreApi } = buildClient(context.globalArgs);

        const current = await coreApi.readNode({ name: args.nodeName });
        if (!current.spec.taints) {
          current.spec.taints = [];
        }

        // Remove existing taint with the same key if any
        current.spec.taints = current.spec.taints.filter((t) =>
          t.key !== args.key
        );
        current.spec.taints.push({
          key: args.key,
          value: args.value,
          effect: args.effect,
        });

        const replaced = await coreApi.replaceNode({
          name: args.nodeName,
          body: current,
        });
        const normalized = normalizeNode(replaced);

        context.logger.info(
          "Added taint {key}={value}:{effect} to node {name}",
          {
            key: args.key,
            value: args.value,
            effect: args.effect,
            name: args.nodeName,
          },
        );

        const handle = await context.writeResource(
          "node",
          sanitizeInstanceName(normalized.name),
          normalized,
        );
        return { dataHandles: [handle] };
      },
    },

    untaint: {
      description: "Remove a taint from a node by key",
      arguments: z.object({
        nodeName: z.string(),
        key: z.string(),
      }),
      execute: async (args, context) => {
        const { coreApi } = buildClient(context.globalArgs);

        const current = await coreApi.readNode({ name: args.nodeName });
        if (current.spec.taints) {
          current.spec.taints = current.spec.taints.filter((t) =>
            t.key !== args.key
          );
        }

        const replaced = await coreApi.replaceNode({
          name: args.nodeName,
          body: current,
        });
        const normalized = normalizeNode(replaced);

        context.logger.info("Removed taint {key} from node {name}", {
          key: args.key,
          name: args.nodeName,
        });

        const handle = await context.writeResource(
          "node",
          sanitizeInstanceName(normalized.name),
          normalized,
        );
        return { dataHandles: [handle] };
      },
    },

    getPodsOnNode: {
      description:
        "List all pods running on a specific node across all namespaces",
      arguments: z.object({
        nodeName: z.string(),
      }),
      execute: async (args, context) => {
        const { coreApi } = buildClient(context.globalArgs);

        const resp = await coreApi.listPodForAllNamespaces({
          fieldSelector: `spec.nodeName=${args.nodeName}`,
        });
        const pods = resp.items || [];

        context.logger.info("Found {count} pods on node {node}", {
          count: pods.length,
          node: args.nodeName,
        });

        const handles = [];
        for (const pod of pods) {
          const normalized = normalizePodForNode(pod);
          const handle = await context.writeResource(
            "nodePod",
            sanitizeInstanceName(`${normalized.namespace}-${normalized.name}`),
            normalized,
          );
          handles.push(handle);
        }
        return { dataHandles: handles };
      },
    },
  },
};
