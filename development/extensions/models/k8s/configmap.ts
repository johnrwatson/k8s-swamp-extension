import { z } from "npm:zod@4";
import { buildClient, K8sGlobalArgsSchema, normalizeMeta, sanitizeInstanceName } from "./_helpers.ts";

// --- Schemas ---

const ConfigMapSchema = z.object({
  name: z.string(),
  namespace: z.string(),
  uid: z.string(),
  data: z.record(z.string(), z.string()),
  dataKeys: z.array(z.string()),
  labels: z.record(z.string(), z.string()),
  annotations: z.record(z.string(), z.string()),
  createdAt: z.string(),
}).passthrough();

// --- Helpers ---

function normalizeConfigMap(raw) {
  const meta = normalizeMeta(raw);
  const data = raw.data || {};

  return {
    ...meta,
    data,
    dataKeys: Object.keys(data),
  };
}

// --- Model ---

export const model = {
  type: "@swamp_lord/configmap",
  version: "2026.02.27.1",
  globalArguments: K8sGlobalArgsSchema,
  resources: {
    configmap: {
      description: "ConfigMap with key-value data, data keys list, labels, and annotations",
      schema: ConfigMapSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    list: {
      description: "List all configmaps in the configured namespace",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { coreApi } = buildClient(context.globalArgs);
        const ns = context.globalArgs.namespace;
        const labels = context.globalArgs.labels;

        const resp = await coreApi.listNamespacedConfigMap({ namespace: ns, labelSelector: labels });
        const configmaps = resp.items || [];

        context.logger.info("Found {count} configmaps in {ns}", {
          count: configmaps.length,
          ns,
        });

        const handles = [];
        for (const cm of configmaps) {
          const normalized = normalizeConfigMap(cm);
          const handle = await context.writeResource(
            "configmap",
            sanitizeInstanceName(normalized.name),
            normalized,
          );
          handles.push(handle);
        }
        return { dataHandles: handles };
      },
    },

    get: {
      description: "Get a single configmap's data and metadata",
      arguments: z.object({
        configMapName: z.string(),
      }),
      execute: async (args, context) => {
        const { coreApi } = buildClient(context.globalArgs);
        const ns = context.globalArgs.namespace;

        const cm = await coreApi.readNamespacedConfigMap({ name: args.configMapName, namespace: ns });
        const normalized = normalizeConfigMap(cm);

        const handle = await context.writeResource(
          "configmap",
          sanitizeInstanceName(normalized.name),
          normalized,
        );
        return { dataHandles: [handle] };
      },
    },

    create: {
      description: "Create a configmap from key-value data pairs with optional labels",
      arguments: z.object({
        configMapName: z.string(),
        data: z.record(z.string(), z.string()),
        labels: z.record(z.string(), z.string()).optional(),
      }),
      execute: async (args, context) => {
        const { coreApi } = buildClient(context.globalArgs);
        const ns = context.globalArgs.namespace;

        const body = {
          metadata: {
            name: args.configMapName,
            namespace: ns,
            ...(args.labels && { labels: args.labels }),
          },
          data: args.data,
        };

        const created = await coreApi.createNamespacedConfigMap({ namespace: ns, body });
        const normalized = normalizeConfigMap(created);

        context.logger.info("Created configmap {name} in {ns}", {
          name: args.configMapName,
          ns,
        });

        const handle = await context.writeResource(
          "configmap",
          sanitizeInstanceName(normalized.name),
          normalized,
        );
        return { dataHandles: [handle] };
      },
    },

    update: {
      description: "Merge new keys into an existing configmap via read-then-replace",
      arguments: z.object({
        configMapName: z.string(),
        data: z.record(z.string(), z.string()),
      }),
      execute: async (args, context) => {
        const { coreApi } = buildClient(context.globalArgs);
        const ns = context.globalArgs.namespace;

        const current = await coreApi.readNamespacedConfigMap({ name: args.configMapName, namespace: ns });
        current.data = { ...(current.data || {}), ...args.data };

        const replaced = await coreApi.replaceNamespacedConfigMap({
          name: args.configMapName,
          namespace: ns,
          body: current,
        });
        const normalized = normalizeConfigMap(replaced);

        context.logger.info("Updated configmap {name} in {ns}", {
          name: args.configMapName,
          ns,
        });

        const handle = await context.writeResource(
          "configmap",
          sanitizeInstanceName(normalized.name),
          normalized,
        );
        return { dataHandles: [handle] };
      },
    },

    delete: {
      description: "Delete a configmap",
      arguments: z.object({
        configMapName: z.string(),
      }),
      execute: async (args, context) => {
        const { coreApi } = buildClient(context.globalArgs);
        const ns = context.globalArgs.namespace;

        await coreApi.deleteNamespacedConfigMap({ name: args.configMapName, namespace: ns });

        context.logger.info("Deleted configmap {name} in {ns}", {
          name: args.configMapName,
          ns,
        });
        return { dataHandles: [] };
      },
    },
  },
};
