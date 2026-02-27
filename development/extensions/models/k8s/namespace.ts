import { z } from "npm:zod@4";
import { buildClient, normalizeMeta } from "./_helpers.ts";

// --- Global Args (cluster-scoped, no namespace field) ---

const GlobalArgsSchema = z.object({
  context: z.string().optional(),
  kubeconfig: z.string().optional(),
  labels: z.string().optional(),
});

// --- Schemas ---

const NamespaceSchema = z.object({
  name: z.string(),
  uid: z.string(),
  phase: z.string(),
  labels: z.record(z.string(), z.string()),
  annotations: z.record(z.string(), z.string()),
  finalizers: z.array(z.string()),
  conditions: z.array(z.object({
    type: z.string(),
    status: z.string(),
    message: z.string(),
  })),
  createdAt: z.string(),
}).passthrough();

const ResourceQuotaSchema = z.object({
  name: z.string(),
  namespace: z.string(),
  hard: z.record(z.string(), z.string()),
  used: z.record(z.string(), z.string()),
  createdAt: z.string(),
}).passthrough();

const LimitRangeSchema = z.object({
  name: z.string(),
  namespace: z.string(),
  limits: z.array(z.object({
    type: z.string(),
    default: z.record(z.string(), z.string()),
    defaultRequest: z.record(z.string(), z.string()),
    max: z.record(z.string(), z.string()),
    min: z.record(z.string(), z.string()),
  })),
  createdAt: z.string(),
}).passthrough();

const ResourceCountsSchema = z.object({
  namespace: z.string(),
  pods: z.number(),
  services: z.number(),
  deployments: z.number(),
  configmaps: z.number(),
  secrets: z.number(),
  serviceaccounts: z.number(),
  persistentvolumeclaims: z.number(),
  collectedAt: z.string(),
}).passthrough();

// --- Helpers ---

function normalizeNamespace(raw) {
  const meta = normalizeMeta(raw);
  const status = raw.status || {};
  const spec = raw.spec || {};

  return {
    name: meta.name,
    uid: meta.uid,
    phase: status.phase || "Unknown",
    labels: meta.labels,
    annotations: meta.annotations,
    finalizers: spec.finalizers || [],
    conditions: (status.conditions || []).map((c) => ({
      type: c.type || "",
      status: c.status || "",
      message: c.message || "",
    })),
    createdAt: meta.createdAt,
  };
}

function normalizeResourceQuota(raw) {
  const meta = normalizeMeta(raw);
  const status = raw.status || {};
  const spec = raw.spec || {};

  const toRecord = (obj) => {
    if (!obj) return {};
    const result = {};
    for (const [k, v] of Object.entries(obj)) {
      result[k] = String(v);
    }
    return result;
  };

  return {
    name: meta.name,
    namespace: meta.namespace,
    hard: toRecord(spec.hard),
    used: toRecord(status.used),
    createdAt: meta.createdAt,
  };
}

function normalizeLimitRange(raw) {
  const meta = normalizeMeta(raw);
  const spec = raw.spec || {};

  const toRecord = (obj) => {
    if (!obj) return {};
    const result = {};
    for (const [k, v] of Object.entries(obj)) {
      result[k] = String(v);
    }
    return result;
  };

  return {
    name: meta.name,
    namespace: meta.namespace,
    limits: (spec.limits || []).map((l) => ({
      type: l.type || "",
      default: toRecord(l.default),
      defaultRequest: toRecord(l.defaultRequest),
      max: toRecord(l.max),
      min: toRecord(l.min),
    })),
    createdAt: meta.createdAt,
  };
}

// --- Model ---

export const model = {
  type: "@swamp_lord/namespace",
  version: "2026.02.26.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    namespace: {
      description: "Namespace state including phase, finalizers, conditions, labels, and annotations",
      schema: NamespaceSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    resourceQuota: {
      description: "Resource quota showing hard limits and current usage for pods, CPU, memory, etc.",
      schema: ResourceQuotaSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    limitRange: {
      description: "Limit range defining default, min, and max resource constraints for containers in a namespace",
      schema: LimitRangeSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    resourceCounts: {
      description: "Count of pods, services, deployments, configmaps, secrets, service accounts, and PVCs in a namespace",
      schema: ResourceCountsSchema,
      lifetime: "1h",
      garbageCollection: 5,
    },
  },
  methods: {
    // --- Namespace CRUD ---

    list: {
      description: "List all namespaces in the cluster, optionally filtered by label selector",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { coreApi } = buildClient(context.globalArgs);
        const labels = context.globalArgs.labels;

        const resp = await coreApi.listNamespace({ labelSelector: labels });
        const namespaces = resp.items || [];

        context.logger.info("Found {count} namespaces", {
          count: namespaces.length,
        });

        const handles = [];
        for (const ns of namespaces) {
          const normalized = normalizeNamespace(ns);
          const handle = await context.writeResource(
            "namespace",
            normalized.name,
            normalized,
          );
          handles.push(handle);
        }
        return { dataHandles: handles };
      },
    },

    get: {
      description: "Get a single namespace's phase, finalizers, conditions, labels, and annotations",
      arguments: z.object({
        namespaceName: z.string(),
      }),
      execute: async (args, context) => {
        const { coreApi } = buildClient(context.globalArgs);

        const ns = await coreApi.readNamespace({ name: args.namespaceName });
        const normalized = normalizeNamespace(ns);

        const handle = await context.writeResource(
          "namespace",
          normalized.name,
          normalized,
        );
        return { dataHandles: [handle] };
      },
    },

    create: {
      description: "Create a new namespace with optional labels",
      arguments: z.object({
        namespaceName: z.string(),
        labels: z.record(z.string(), z.string()).optional(),
      }),
      execute: async (args, context) => {
        const { coreApi } = buildClient(context.globalArgs);

        const body = {
          metadata: {
            name: args.namespaceName,
            ...(args.labels && { labels: args.labels }),
          },
        };

        const created = await coreApi.createNamespace({ body });
        const normalized = normalizeNamespace(created);

        context.logger.info("Created namespace {name}", {
          name: args.namespaceName,
        });

        const handle = await context.writeResource(
          "namespace",
          normalized.name,
          normalized,
        );
        return { dataHandles: [handle] };
      },
    },

    delete: {
      description: "Delete a namespace and all resources within it",
      arguments: z.object({
        namespaceName: z.string(),
      }),
      execute: async (args, context) => {
        const { coreApi } = buildClient(context.globalArgs);

        await coreApi.deleteNamespace({ name: args.namespaceName });

        context.logger.info("Deleted namespace {name}", {
          name: args.namespaceName,
        });
        return { dataHandles: [] };
      },
    },

    update: {
      description: "Merge new labels and/or annotations onto a namespace via read-then-replace",
      arguments: z.object({
        namespaceName: z.string(),
        labels: z.record(z.string(), z.string()).optional(),
        annotations: z.record(z.string(), z.string()).optional(),
      }),
      execute: async (args, context) => {
        const { coreApi } = buildClient(context.globalArgs);

        // Read current state, merge in changes, replace
        const current = await coreApi.readNamespace({ name: args.namespaceName });
        const meta = current.metadata || {};

        if (args.labels) {
          meta.labels = { ...(meta.labels || {}), ...args.labels };
        }
        if (args.annotations) {
          meta.annotations = { ...(meta.annotations || {}), ...args.annotations };
        }
        current.metadata = meta;

        const replaced = await coreApi.replaceNamespace({
          name: args.namespaceName,
          body: current,
        });
        const normalized = normalizeNamespace(replaced);

        context.logger.info("Updated namespace {name}", {
          name: args.namespaceName,
        });

        const handle = await context.writeResource(
          "namespace",
          normalized.name,
          normalized,
        );
        return { dataHandles: [handle] };
      },
    },

    // --- Resource Quotas ---

    getResourceQuotas: {
      description: "List all resource quotas in a namespace showing hard limits and current usage",
      arguments: z.object({
        namespaceName: z.string(),
      }),
      execute: async (args, context) => {
        const { coreApi } = buildClient(context.globalArgs);

        const resp = await coreApi.listNamespacedResourceQuota({
          namespace: args.namespaceName,
        });
        const quotas = resp.items || [];

        context.logger.info("Found {count} resource quotas in {ns}", {
          count: quotas.length,
          ns: args.namespaceName,
        });

        const handles = [];
        for (const q of quotas) {
          const normalized = normalizeResourceQuota(q);
          const handle = await context.writeResource(
            "resourceQuota",
            `${args.namespaceName}-${normalized.name}`,
            normalized,
          );
          handles.push(handle);
        }
        return { dataHandles: handles };
      },
    },

    setResourceQuota: {
      description: "Create or replace a resource quota with the given hard limits (pods, cpu, memory, etc.)",
      arguments: z.object({
        namespaceName: z.string(),
        quotaName: z.string(),
        hard: z.record(z.string(), z.string()),
      }),
      execute: async (args, context) => {
        const { coreApi } = buildClient(context.globalArgs);

        const body = {
          metadata: {
            name: args.quotaName,
            namespace: args.namespaceName,
          },
          spec: { hard: args.hard },
        };

        let result;
        try {
          // Try to replace existing
          await coreApi.readNamespacedResourceQuota({
            name: args.quotaName,
            namespace: args.namespaceName,
          });
          result = await coreApi.replaceNamespacedResourceQuota({
            name: args.quotaName,
            namespace: args.namespaceName,
            body,
          });
          context.logger.info("Replaced resource quota {name} in {ns}", {
            name: args.quotaName,
            ns: args.namespaceName,
          });
        } catch {
          // Create new
          result = await coreApi.createNamespacedResourceQuota({
            namespace: args.namespaceName,
            body,
          });
          context.logger.info("Created resource quota {name} in {ns}", {
            name: args.quotaName,
            ns: args.namespaceName,
          });
        }

        const normalized = normalizeResourceQuota(result);
        const handle = await context.writeResource(
          "resourceQuota",
          `${args.namespaceName}-${normalized.name}`,
          normalized,
        );
        return { dataHandles: [handle] };
      },
    },

    deleteResourceQuota: {
      description: "Delete a resource quota from a namespace",
      arguments: z.object({
        namespaceName: z.string(),
        quotaName: z.string(),
      }),
      execute: async (args, context) => {
        const { coreApi } = buildClient(context.globalArgs);

        await coreApi.deleteNamespacedResourceQuota({
          name: args.quotaName,
          namespace: args.namespaceName,
        });

        context.logger.info("Deleted resource quota {name} from {ns}", {
          name: args.quotaName,
          ns: args.namespaceName,
        });
        return { dataHandles: [] };
      },
    },

    // --- Limit Ranges ---

    getLimitRanges: {
      description: "List all limit ranges in a namespace showing default, min, and max resource constraints",
      arguments: z.object({
        namespaceName: z.string(),
      }),
      execute: async (args, context) => {
        const { coreApi } = buildClient(context.globalArgs);

        const resp = await coreApi.listNamespacedLimitRange({
          namespace: args.namespaceName,
        });
        const ranges = resp.items || [];

        context.logger.info("Found {count} limit ranges in {ns}", {
          count: ranges.length,
          ns: args.namespaceName,
        });

        const handles = [];
        for (const lr of ranges) {
          const normalized = normalizeLimitRange(lr);
          const handle = await context.writeResource(
            "limitRange",
            `${args.namespaceName}-${normalized.name}`,
            normalized,
          );
          handles.push(handle);
        }
        return { dataHandles: handles };
      },
    },

    setLimitRange: {
      description: "Create or replace a limit range defining default, min, and max resource constraints per container type",
      arguments: z.object({
        namespaceName: z.string(),
        limitRangeName: z.string(),
        limits: z.array(z.object({
          type: z.string(),
          default: z.record(z.string(), z.string()).optional(),
          defaultRequest: z.record(z.string(), z.string()).optional(),
          max: z.record(z.string(), z.string()).optional(),
          min: z.record(z.string(), z.string()).optional(),
        })),
      }),
      execute: async (args, context) => {
        const { coreApi } = buildClient(context.globalArgs);

        const body = {
          metadata: {
            name: args.limitRangeName,
            namespace: args.namespaceName,
          },
          spec: { limits: args.limits },
        };

        let result;
        try {
          await coreApi.readNamespacedLimitRange({
            name: args.limitRangeName,
            namespace: args.namespaceName,
          });
          result = await coreApi.replaceNamespacedLimitRange({
            name: args.limitRangeName,
            namespace: args.namespaceName,
            body,
          });
          context.logger.info("Replaced limit range {name} in {ns}", {
            name: args.limitRangeName,
            ns: args.namespaceName,
          });
        } catch {
          result = await coreApi.createNamespacedLimitRange({
            namespace: args.namespaceName,
            body,
          });
          context.logger.info("Created limit range {name} in {ns}", {
            name: args.limitRangeName,
            ns: args.namespaceName,
          });
        }

        const normalized = normalizeLimitRange(result);
        const handle = await context.writeResource(
          "limitRange",
          `${args.namespaceName}-${normalized.name}`,
          normalized,
        );
        return { dataHandles: [handle] };
      },
    },

    deleteLimitRange: {
      description: "Delete a limit range from a namespace",
      arguments: z.object({
        namespaceName: z.string(),
        limitRangeName: z.string(),
      }),
      execute: async (args, context) => {
        const { coreApi } = buildClient(context.globalArgs);

        await coreApi.deleteNamespacedLimitRange({
          name: args.limitRangeName,
          namespace: args.namespaceName,
        });

        context.logger.info("Deleted limit range {name} from {ns}", {
          name: args.limitRangeName,
          ns: args.namespaceName,
        });
        return { dataHandles: [] };
      },
    },

    // --- Resource Counts ---

    getResourceCounts: {
      description: "Count pods, services, deployments, configmaps, secrets, service accounts, and PVCs in a namespace via parallel API calls",
      arguments: z.object({
        namespaceName: z.string(),
      }),
      execute: async (args, context) => {
        const { coreApi, appsApi } = buildClient(context.globalArgs);
        const ns = args.namespaceName;

        // Run all counts in parallel
        const [pods, services, deployments, configmaps, secrets, serviceaccounts, pvcs] =
          await Promise.all([
            coreApi.listNamespacedPod({ namespace: ns }).then((r) => r.items?.length || 0),
            coreApi.listNamespacedService({ namespace: ns }).then((r) => r.items?.length || 0),
            appsApi.listNamespacedDeployment({ namespace: ns }).then((r) => r.items?.length || 0).catch(() => 0),
            coreApi.listNamespacedConfigMap({ namespace: ns }).then((r) => r.items?.length || 0),
            coreApi.listNamespacedSecret({ namespace: ns }).then((r) => r.items?.length || 0),
            coreApi.listNamespacedServiceAccount({ namespace: ns }).then((r) => r.items?.length || 0),
            coreApi.listNamespacedPersistentVolumeClaim({ namespace: ns }).then((r) => r.items?.length || 0),
          ]);

        const counts = {
          namespace: ns,
          pods,
          services,
          deployments,
          configmaps,
          secrets,
          serviceaccounts,
          persistentvolumeclaims: pvcs,
          collectedAt: new Date().toISOString(),
        };

        context.logger.info(
          "Resource counts for {ns}: {pods} pods, {svc} services, {dep} deployments",
          { ns, pods, svc: services, dep: deployments },
        );

        const handle = await context.writeResource(
          "resourceCounts",
          ns,
          counts,
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
