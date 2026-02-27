import { z } from "npm:zod@4";
import { buildClient, K8sGlobalArgsSchema, normalizeMeta } from "./_helpers.ts";

// --- Schemas ---

const ServiceSchema = z.object({
  name: z.string(),
  namespace: z.string(),
  uid: z.string(),
  type: z.string(),
  clusterIP: z.string(),
  externalIPs: z.array(z.string()),
  ports: z.array(z.object({
    name: z.string(),
    protocol: z.string(),
    port: z.number(),
    targetPort: z.string(),
    nodePort: z.number(),
  })),
  selector: z.record(z.string(), z.string()),
  labels: z.record(z.string(), z.string()),
  annotations: z.record(z.string(), z.string()),
  createdAt: z.string(),
}).passthrough();

const EndpointsSchema = z.object({
  serviceName: z.string(),
  namespace: z.string(),
  subsets: z.array(z.object({
    addresses: z.array(z.object({
      ip: z.string(),
      nodeName: z.string(),
      targetRef: z.string(),
    })),
    notReadyAddresses: z.array(z.object({
      ip: z.string(),
      nodeName: z.string(),
      targetRef: z.string(),
    })),
    ports: z.array(z.object({
      name: z.string(),
      port: z.number(),
      protocol: z.string(),
    })),
  })),
  totalReady: z.number(),
  totalNotReady: z.number(),
  collectedAt: z.string(),
}).passthrough();

const DiagnosisSchema = z.object({
  serviceName: z.string(),
  namespace: z.string(),
  selector: z.record(z.string(), z.string()),
  matchedPods: z.object({
    count: z.number(),
    names: z.array(z.string()),
  }),
  unmatchedPods: z.object({
    count: z.number(),
    pods: z.array(z.object({
      name: z.string(),
      missingLabels: z.array(z.string()),
    })),
  }),
  portAnalysis: z.array(z.object({
    servicePort: z.number(),
    targetPort: z.string(),
    listeningPodCount: z.number(),
  })),
  healthy: z.boolean(),
}).passthrough();

// --- Helpers ---

function normalizeService(raw) {
  const meta = normalizeMeta(raw);
  const spec = raw.spec || {};

  return {
    ...meta,
    type: spec.type || "ClusterIP",
    clusterIP: spec.clusterIP || "",
    externalIPs: spec.externalIPs || [],
    ports: (spec.ports || []).map((p) => ({
      name: p.name || "",
      protocol: p.protocol || "TCP",
      port: p.port || 0,
      targetPort: String(p.targetPort || ""),
      nodePort: p.nodePort || 0,
    })),
    selector: spec.selector || {},
  };
}

function normalizeEndpoints(raw) {
  const meta = raw.metadata || {};
  const subsets = (raw.subsets || []).map((s) => ({
    addresses: (s.addresses || []).map((a) => ({
      ip: a.ip || "",
      nodeName: a.nodeName || "",
      targetRef: a.targetRef ? `${a.targetRef.kind}/${a.targetRef.name}` : "",
    })),
    notReadyAddresses: (s.notReadyAddresses || []).map((a) => ({
      ip: a.ip || "",
      nodeName: a.nodeName || "",
      targetRef: a.targetRef ? `${a.targetRef.kind}/${a.targetRef.name}` : "",
    })),
    ports: (s.ports || []).map((p) => ({
      name: p.name || "",
      port: p.port || 0,
      protocol: p.protocol || "TCP",
    })),
  }));

  let totalReady = 0;
  let totalNotReady = 0;
  for (const s of subsets) {
    totalReady += s.addresses.length;
    totalNotReady += s.notReadyAddresses.length;
  }

  return {
    serviceName: meta.name || "",
    namespace: meta.namespace || "",
    subsets,
    totalReady,
    totalNotReady,
    collectedAt: new Date().toISOString(),
  };
}

// --- Model ---

export const model = {
  type: "@swamp_lord/service",
  version: "2026.02.27.1",
  globalArguments: K8sGlobalArgsSchema,
  resources: {
    service: {
      description: "Service spec including type, clusterIP, ports, and pod selector labels",
      schema: ServiceSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    endpoints: {
      description: "Endpoint addresses backing a service, split into ready and not-ready",
      schema: EndpointsSchema,
      lifetime: "1h",
      garbageCollection: 5,
    },
    diagnosis: {
      description: "Service diagnosis comparing selector vs pod labels, port analysis, and health status",
      schema: DiagnosisSchema,
      lifetime: "1h",
      garbageCollection: 5,
    },
  },
  methods: {
    list: {
      description: "List all services in the configured namespace with their type, ports, and selectors",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { coreApi } = buildClient(context.globalArgs);
        const ns = context.globalArgs.namespace;
        const labels = context.globalArgs.labels;

        const resp = await coreApi.listNamespacedService({ namespace: ns, labelSelector: labels });
        const services = resp.items || [];

        context.logger.info("Found {count} services in {ns}", {
          count: services.length,
          ns,
        });

        const handles = [];
        for (const svc of services) {
          const normalized = normalizeService(svc);
          const handle = await context.writeResource(
            "service",
            normalized.name,
            normalized,
          );
          handles.push(handle);
        }
        return { dataHandles: handles };
      },
    },

    get: {
      description: "Get a single service's spec including type, clusterIP, ports, and pod selector",
      arguments: z.object({
        serviceName: z.string(),
      }),
      execute: async (args, context) => {
        const { coreApi } = buildClient(context.globalArgs);
        const ns = context.globalArgs.namespace;

        const svc = await coreApi.readNamespacedService({ name: args.serviceName, namespace: ns });
        const normalized = normalizeService(svc);

        const handle = await context.writeResource(
          "service",
          normalized.name,
          normalized,
        );
        return { dataHandles: [handle] };
      },
    },

    getEndpoints: {
      description: "Get the endpoint addresses backing a service, showing which pods are ready and not ready",
      arguments: z.object({
        serviceName: z.string(),
      }),
      execute: async (args, context) => {
        const { coreApi } = buildClient(context.globalArgs);
        const ns = context.globalArgs.namespace;

        const ep = await coreApi.readNamespacedEndpoints({ name: args.serviceName, namespace: ns });
        const normalized = normalizeEndpoints(ep);

        context.logger.info("Endpoints for {svc}: {ready} ready, {notReady} not ready", {
          svc: args.serviceName,
          ready: normalized.totalReady,
          notReady: normalized.totalNotReady,
        });

        const handle = await context.writeResource(
          "endpoints",
          args.serviceName,
          normalized,
        );
        return { dataHandles: [handle] };
      },
    },

    create: {
      description: "Create a service with selector, ports, and optional type and labels",
      arguments: z.object({
        serviceName: z.string(),
        selector: z.record(z.string(), z.string()),
        ports: z.array(z.object({
          name: z.string().optional(),
          port: z.number(),
          targetPort: z.number().optional(),
          protocol: z.string().default("TCP"),
        })),
        type: z.string().default("ClusterIP"),
        labels: z.record(z.string(), z.string()).optional(),
      }),
      execute: async (args, context) => {
        const { coreApi } = buildClient(context.globalArgs);
        const ns = context.globalArgs.namespace;

        const body = {
          metadata: {
            name: args.serviceName,
            namespace: ns,
            ...(args.labels && { labels: args.labels }),
          },
          spec: {
            type: args.type,
            selector: args.selector,
            ports: args.ports.map((p) => ({
              ...(p.name && { name: p.name }),
              port: p.port,
              targetPort: p.targetPort || p.port,
              protocol: p.protocol,
            })),
          },
        };

        const created = await coreApi.createNamespacedService({ namespace: ns, body });
        const normalized = normalizeService(created);

        context.logger.info("Created service {name} in {ns}", {
          name: args.serviceName,
          ns,
        });

        const handle = await context.writeResource(
          "service",
          normalized.name,
          normalized,
        );
        return { dataHandles: [handle] };
      },
    },

    update: {
      description: "Update a service's selector and/or ports via read-then-replace",
      arguments: z.object({
        serviceName: z.string(),
        selector: z.record(z.string(), z.string()).optional(),
        ports: z.array(z.object({
          name: z.string().optional(),
          port: z.number(),
          targetPort: z.number().optional(),
          protocol: z.string().default("TCP"),
        })).optional(),
      }),
      execute: async (args, context) => {
        const { coreApi } = buildClient(context.globalArgs);
        const ns = context.globalArgs.namespace;

        const current = await coreApi.readNamespacedService({ name: args.serviceName, namespace: ns });

        if (args.selector) {
          current.spec.selector = args.selector;
        }
        if (args.ports) {
          current.spec.ports = args.ports.map((p) => ({
            ...(p.name && { name: p.name }),
            port: p.port,
            targetPort: p.targetPort || p.port,
            protocol: p.protocol,
          }));
        }

        const replaced = await coreApi.replaceNamespacedService({
          name: args.serviceName,
          namespace: ns,
          body: current,
        });
        const normalized = normalizeService(replaced);

        context.logger.info("Updated service {name} in {ns}", {
          name: args.serviceName,
          ns,
        });

        const handle = await context.writeResource(
          "service",
          normalized.name,
          normalized,
        );
        return { dataHandles: [handle] };
      },
    },

    delete: {
      description: "Delete a service",
      arguments: z.object({
        serviceName: z.string(),
      }),
      execute: async (args, context) => {
        const { coreApi } = buildClient(context.globalArgs);
        const ns = context.globalArgs.namespace;

        await coreApi.deleteNamespacedService({ name: args.serviceName, namespace: ns });

        context.logger.info("Deleted service {name} in {ns}", {
          name: args.serviceName,
          ns,
        });
        return { dataHandles: [] };
      },
    },

    diagnoseService: {
      description: "Diagnose a service by comparing its selector against pod labels, reporting mismatches and port analysis",
      arguments: z.object({
        serviceName: z.string(),
      }),
      execute: async (args, context) => {
        const { coreApi } = buildClient(context.globalArgs);
        const ns = context.globalArgs.namespace;

        // 1. Read service to get selector and ports
        const svc = await coreApi.readNamespacedService({ name: args.serviceName, namespace: ns });
        const svcSpec = svc.spec || {};
        const selector = svcSpec.selector || {};
        const svcPorts = svcSpec.ports || [];

        const selectorKeys = Object.keys(selector);
        if (selectorKeys.length === 0) {
          context.logger.warning("Service {name} has no selector", { name: args.serviceName });
        }

        // 2. List pods matching the full selector
        const selectorStr = selectorKeys.map((k) => `${k}=${selector[k]}`).join(",");
        const matchedResp = selectorStr
          ? await coreApi.listNamespacedPod({ namespace: ns, labelSelector: selectorStr })
          : { items: [] };
        const matchedPods = matchedResp.items || [];
        const matchedPodNames = matchedPods.map((p) => p.metadata?.name || "");

        // 3. List ALL pods in namespace to find partial matches
        const allPodsResp = await coreApi.listNamespacedPod({ namespace: ns });
        const allPods = allPodsResp.items || [];

        const unmatchedPods = [];
        for (const pod of allPods) {
          const podLabels = pod.metadata?.labels || {};
          const podName = pod.metadata?.name || "";

          // Skip pods that already fully match
          if (matchedPodNames.includes(podName)) continue;

          // Check if pod has at least one selector label but not all
          const hasAny = selectorKeys.some((k) => podLabels[k] === selector[k]);
          if (hasAny) {
            const missingLabels = selectorKeys.filter((k) => podLabels[k] !== selector[k]);
            unmatchedPods.push({ name: podName, missingLabels });
          }
        }

        // 4. Port analysis: for each service port, count matched pods that expose targetPort
        const portAnalysis = svcPorts.map((sp) => {
          const targetPort = String(sp.targetPort || sp.port);
          const targetPortNum = parseInt(targetPort, 10);

          let listeningPodCount = 0;
          for (const pod of matchedPods) {
            const containers = pod.spec?.containers || [];
            const hasPort = containers.some((c) =>
              (c.ports || []).some((p) =>
                p.containerPort === targetPortNum || String(p.containerPort) === targetPort
              )
            );
            if (hasPort) listeningPodCount++;
          }

          return {
            servicePort: sp.port || 0,
            targetPort,
            listeningPodCount,
          };
        });

        // 5. Determine health
        const allPortsHaveListeners = portAnalysis.every((p) => p.listeningPodCount > 0);
        const healthy = matchedPods.length > 0 && unmatchedPods.length === 0 && allPortsHaveListeners;

        const diagnosis = {
          serviceName: args.serviceName,
          namespace: ns,
          selector,
          matchedPods: {
            count: matchedPods.length,
            names: matchedPodNames,
          },
          unmatchedPods: {
            count: unmatchedPods.length,
            pods: unmatchedPods,
          },
          portAnalysis,
          healthy,
        };

        context.logger.info(
          "Diagnosis for {svc}: {matched} matched, {unmatched} unmatched, healthy={healthy}",
          {
            svc: args.serviceName,
            matched: matchedPods.length,
            unmatched: unmatchedPods.length,
            healthy,
          },
        );

        const handle = await context.writeResource(
          "diagnosis",
          args.serviceName,
          diagnosis,
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
