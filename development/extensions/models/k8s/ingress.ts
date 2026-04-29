import { z } from "npm:zod@4";
import {
  buildClient,
  K8sGlobalArgsSchema,
  normalizeMeta,
  sanitizeInstanceName,
} from "./_helpers.ts";

// --- Schemas ---

const IngressSchema = z.object({
  name: z.string(),
  namespace: z.string(),
  uid: z.string(),
  ingressClassName: z.string(),
  rules: z.array(z.object({
    host: z.string(),
    paths: z.array(z.object({
      path: z.string(),
      pathType: z.string(),
      serviceName: z.string(),
      servicePort: z.string(),
    })),
  })),
  tls: z.array(z.object({
    hosts: z.array(z.string()),
    secretName: z.string(),
  })),
  defaultBackendService: z.string(),
  defaultBackendPort: z.string(),
  loadBalancerIPs: z.array(z.string()),
  labels: z.record(z.string(), z.string()),
  annotations: z.record(z.string(), z.string()),
  createdAt: z.string(),
}).passthrough();

// --- Helpers ---

function normalizeIngress(raw) {
  const meta = normalizeMeta(raw);
  const spec = raw.spec || {};
  const status = raw.status || {};
  const lb = status.loadBalancer || {};

  const rules = (spec.rules || []).map((rule) => ({
    host: rule.host || "*",
    paths: ((rule.http || {}).paths || []).map((p) => {
      const backend = p.backend || {};
      const svc = backend.service || {};
      const port = svc.port || {};
      return {
        path: p.path || "/",
        pathType: p.pathType || "ImplementationSpecific",
        serviceName: svc.name || "",
        servicePort: String(port.number || port.name || ""),
      };
    }),
  }));

  const tls = (spec.tls || []).map((t) => ({
    hosts: t.hosts || [],
    secretName: t.secretName || "",
  }));

  const defaultBackend = spec.defaultBackend || {};
  const defaultSvc = defaultBackend.service || {};
  const defaultPort = defaultSvc.port || {};

  const loadBalancerIPs = (lb.ingress || []).map((i) =>
    i.ip || i.hostname || ""
  );

  return {
    ...meta,
    ingressClassName: spec.ingressClassName || "",
    rules,
    tls,
    defaultBackendService: defaultSvc.name || "",
    defaultBackendPort: String(defaultPort.number || defaultPort.name || ""),
    loadBalancerIPs,
  };
}

// --- Model ---

export const model = {
  type: "@john/ingress",
  version: "2026.02.27.1",
  globalArguments: K8sGlobalArgsSchema,
  resources: {
    ingress: {
      description:
        "Ingress with rules, TLS config, default backend, and load balancer IPs",
      schema: IngressSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    list: {
      description: "List all ingresses in the configured namespace",
      arguments: z.object({ namespace: z.string().optional() }),
      execute: async (args, context) => {
        const { networkingApi } = buildClient(context.globalArgs);
        const ns = args.namespace ?? context.globalArgs.namespace;
        const labels = context.globalArgs.labels;

        const resp = await networkingApi.listNamespacedIngress({
          namespace: ns,
          labelSelector: labels,
        });
        const ingresses = resp.items || [];

        context.logger.info("Found {count} ingresses in {ns}", {
          count: ingresses.length,
          ns,
        });

        const handles = [];
        for (const ing of ingresses) {
          const normalized = normalizeIngress(ing);
          const handle = await context.writeResource(
            "ingress",
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
        "Get an ingress's spec with rules, TLS config, and load balancer status",
      arguments: z.object({
        ingressName: z.string(),
        namespace: z.string().optional(),
      }),
      execute: async (args, context) => {
        const { networkingApi } = buildClient(context.globalArgs);
        const ns = args.namespace ?? context.globalArgs.namespace;

        const ing = await networkingApi.readNamespacedIngress({
          name: args.ingressName,
          namespace: ns,
        });
        const normalized = normalizeIngress(ing);

        const handle = await context.writeResource(
          "ingress",
          sanitizeInstanceName(normalized.name),
          normalized,
        );
        return { dataHandles: [handle] };
      },
    },

    create: {
      description:
        "Create an ingress from rules with optional TLS config and ingress class",
      arguments: z.object({
        ingressName: z.string(),
        rules: z.array(z.object({
          host: z.string().optional(),
          paths: z.array(z.object({
            path: z.string().default("/"),
            pathType: z.string().default("Prefix"),
            serviceName: z.string(),
            servicePort: z.number(),
          })),
        })),
        ingressClassName: z.string().optional(),
        tls: z.array(z.object({
          hosts: z.array(z.string()),
          secretName: z.string(),
        })).optional(),
        annotations: z.record(z.string(), z.string()).optional(),
      }),
      execute: async (args, context) => {
        const { networkingApi } = buildClient(context.globalArgs);
        const ns = args.namespace ?? context.globalArgs.namespace;

        const body = {
          metadata: {
            name: args.ingressName,
            namespace: ns,
            ...(args.annotations && { annotations: args.annotations }),
          },
          spec: {
            ...(args.ingressClassName &&
              { ingressClassName: args.ingressClassName }),
            rules: args.rules.map((rule) => ({
              ...(rule.host && { host: rule.host }),
              http: {
                paths: rule.paths.map((p) => ({
                  path: p.path,
                  pathType: p.pathType,
                  backend: {
                    service: {
                      name: p.serviceName,
                      port: { number: p.servicePort },
                    },
                  },
                })),
              },
            })),
            ...(args.tls && { tls: args.tls }),
          },
        };

        const created = await networkingApi.createNamespacedIngress({
          namespace: ns,
          body,
        });
        const normalized = normalizeIngress(created);

        context.logger.info("Created ingress {name} in {ns}", {
          name: args.ingressName,
          ns,
        });

        const handle = await context.writeResource(
          "ingress",
          sanitizeInstanceName(normalized.name),
          normalized,
        );
        return { dataHandles: [handle] };
      },
    },

    update: {
      description:
        "Update an ingress's rules, TLS config, or annotations via read-then-replace",
      arguments: z.object({
        ingressName: z.string(),
        rules: z.array(z.object({
          host: z.string().optional(),
          paths: z.array(z.object({
            path: z.string().default("/"),
            pathType: z.string().default("Prefix"),
            serviceName: z.string(),
            servicePort: z.number(),
          })),
        })).optional(),
        tls: z.array(z.object({
          hosts: z.array(z.string()),
          secretName: z.string(),
        })).optional(),
        annotations: z.record(z.string(), z.string()).optional(),
      }),
      execute: async (args, context) => {
        const { networkingApi } = buildClient(context.globalArgs);
        const ns = args.namespace ?? context.globalArgs.namespace;

        const current = await networkingApi.readNamespacedIngress({
          name: args.ingressName,
          namespace: ns,
        });

        if (args.rules) {
          current.spec.rules = args.rules.map((rule) => ({
            ...(rule.host && { host: rule.host }),
            http: {
              paths: rule.paths.map((p) => ({
                path: p.path,
                pathType: p.pathType,
                backend: {
                  service: {
                    name: p.serviceName,
                    port: { number: p.servicePort },
                  },
                },
              })),
            },
          }));
        }
        if (args.tls) {
          current.spec.tls = args.tls;
        }
        if (args.annotations) {
          current.metadata.annotations = {
            ...(current.metadata.annotations || {}),
            ...args.annotations,
          };
        }

        const replaced = await networkingApi.replaceNamespacedIngress({
          name: args.ingressName,
          namespace: ns,
          body: current,
        });
        const normalized = normalizeIngress(replaced);

        context.logger.info("Updated ingress {name} in {ns}", {
          name: args.ingressName,
          ns,
        });

        const handle = await context.writeResource(
          "ingress",
          sanitizeInstanceName(normalized.name),
          normalized,
        );
        return { dataHandles: [handle] };
      },
    },

    delete: {
      description: "Delete an ingress",
      arguments: z.object({
        ingressName: z.string(),
        namespace: z.string().optional(),
      }),
      execute: async (args, context) => {
        const { networkingApi } = buildClient(context.globalArgs);
        const ns = args.namespace ?? context.globalArgs.namespace;

        await networkingApi.deleteNamespacedIngress({
          name: args.ingressName,
          namespace: ns,
        });

        context.logger.info("Deleted ingress {name} in {ns}", {
          name: args.ingressName,
          ns,
        });
        return { dataHandles: [] };
      },
    },
  },
};
