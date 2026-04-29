import { z } from "npm:zod@4";
import {
  buildClient,
  K8sGlobalArgsSchema,
  normalizeMeta,
  sanitizeInstanceName,
} from "./_helpers.ts";

// --- Schemas ---

const SecretListSchema = z.object({
  name: z.string(),
  namespace: z.string(),
  uid: z.string(),
  type: z.string(),
  dataKeys: z.array(z.string()),
  labels: z.record(z.string(), z.string()),
  annotations: z.record(z.string(), z.string()),
  createdAt: z.string(),
}).passthrough();

const SecretSchema = z.object({
  name: z.string(),
  namespace: z.string(),
  uid: z.string(),
  type: z.string(),
  data: z.record(z.string(), z.string()).meta({ sensitive: true }),
  dataKeys: z.array(z.string()),
  labels: z.record(z.string(), z.string()),
  annotations: z.record(z.string(), z.string()),
  createdAt: z.string(),
}).passthrough();

// --- Helpers ---

function decodeSecretData(raw) {
  const encoded = raw.data || {};
  const decoded = {};
  for (const [key, value] of Object.entries(encoded)) {
    try {
      decoded[key] = atob(value);
    } catch {
      decoded[key] = String(value);
    }
  }
  return decoded;
}

function normalizeSecretMeta(raw) {
  const meta = normalizeMeta(raw);
  return {
    ...meta,
    type: raw.type || "Opaque",
    dataKeys: Object.keys(raw.data || {}),
  };
}

// --- Model ---

export const model = {
  type: "@john/secret",
  version: "2026.02.27.1",
  globalArguments: K8sGlobalArgsSchema,
  resources: {
    secretMeta: {
      description: "Secret metadata with type and data key names (no content)",
      schema: SecretListSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    secret: {
      description:
        "Secret with decoded data values (sensitive, stored in vault)",
      schema: SecretSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    list: {
      description:
        "List all secrets in the namespace showing type and data keys (not content)",
      arguments: z.object({ namespace: z.string().optional() }),
      execute: async (args, context) => {
        const { coreApi } = buildClient(context.globalArgs);
        const ns = args.namespace ?? context.globalArgs.namespace;
        const labels = context.globalArgs.labels;

        const resp = await coreApi.listNamespacedSecret({
          namespace: ns,
          labelSelector: labels,
        });
        const secrets = resp.items || [];

        context.logger.info("Found {count} secrets in {ns}", {
          count: secrets.length,
          ns,
        });

        const handles = [];
        for (const sec of secrets) {
          const normalized = normalizeSecretMeta(sec);
          const handle = await context.writeResource(
            "secretMeta",
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
        "Get a secret with decoded data values (sensitive, stored in vault)",
      arguments: z.object({
        secretName: z.string(),
        namespace: z.string().optional(),
      }),
      execute: async (args, context) => {
        const { coreApi } = buildClient(context.globalArgs);
        const ns = args.namespace ?? context.globalArgs.namespace;

        const sec = await coreApi.readNamespacedSecret({
          name: args.secretName,
          namespace: ns,
        });
        const meta = normalizeMeta(sec);
        const decoded = decodeSecretData(sec);

        const normalized = {
          ...meta,
          type: sec.type || "Opaque",
          data: decoded,
          dataKeys: Object.keys(decoded),
        };

        const handle = await context.writeResource(
          "secret",
          sanitizeInstanceName(normalized.name),
          normalized,
        );
        return { dataHandles: [handle] };
      },
    },

    create: {
      description:
        "Create a secret from key-value data pairs (values will be base64-encoded)",
      arguments: z.object({
        secretName: z.string(),
        data: z.record(z.string(), z.string()),
        type: z.string().default("Opaque"),
        labels: z.record(z.string(), z.string()).optional(),
        namespace: z.string().optional(),
      }),
      execute: async (args, context) => {
        const { coreApi } = buildClient(context.globalArgs);
        const ns = args.namespace ?? context.globalArgs.namespace;

        // Base64-encode the data values
        const encodedData = {};
        for (const [key, value] of Object.entries(args.data)) {
          encodedData[key] = btoa(value);
        }

        const body = {
          metadata: {
            name: args.secretName,
            namespace: ns,
            ...(args.labels && { labels: args.labels }),
          },
          type: args.type,
          data: encodedData,
        };

        const created = await coreApi.createNamespacedSecret({
          namespace: ns,
          body,
        });
        const meta = normalizeMeta(created);
        const decoded = decodeSecretData(created);

        context.logger.info("Created secret {name} in {ns}", {
          name: args.secretName,
          ns,
        });

        const handle = await context.writeResource(
          "secret",
          sanitizeInstanceName(meta.name),
          {
            ...meta,
            type: created.type || "Opaque",
            data: decoded,
            dataKeys: Object.keys(decoded),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    update: {
      description:
        "Merge new keys into an existing secret via read-then-replace (values will be base64-encoded)",
      arguments: z.object({
        secretName: z.string(),
        data: z.record(z.string(), z.string()),
        namespace: z.string().optional(),
      }),
      execute: async (args, context) => {
        const { coreApi } = buildClient(context.globalArgs);
        const ns = args.namespace ?? context.globalArgs.namespace;

        const current = await coreApi.readNamespacedSecret({
          name: args.secretName,
          namespace: ns,
        });

        // Merge new base64-encoded values
        const existingData = current.data || {};
        for (const [key, value] of Object.entries(args.data)) {
          existingData[key] = btoa(value);
        }
        current.data = existingData;

        const replaced = await coreApi.replaceNamespacedSecret({
          name: args.secretName,
          namespace: ns,
          body: current,
        });
        const meta = normalizeMeta(replaced);
        const decoded = decodeSecretData(replaced);

        context.logger.info("Updated secret {name} in {ns}", {
          name: args.secretName,
          ns,
        });

        const handle = await context.writeResource(
          "secret",
          sanitizeInstanceName(meta.name),
          {
            ...meta,
            type: replaced.type || "Opaque",
            data: decoded,
            dataKeys: Object.keys(decoded),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    delete: {
      description: "Delete a secret",
      arguments: z.object({
        secretName: z.string(),
        namespace: z.string().optional(),
      }),
      execute: async (args, context) => {
        const { coreApi } = buildClient(context.globalArgs);
        const ns = args.namespace ?? context.globalArgs.namespace;

        await coreApi.deleteNamespacedSecret({
          name: args.secretName,
          namespace: ns,
        });

        context.logger.info("Deleted secret {name} in {ns}", {
          name: args.secretName,
          ns,
        });
        return { dataHandles: [] };
      },
    },
  },
};
