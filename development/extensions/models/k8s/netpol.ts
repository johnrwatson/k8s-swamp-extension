import { z } from "npm:zod@4";
import { buildClient, K8sGlobalArgsSchema, normalizeMeta, sanitizeInstanceName } from "./_helpers.ts";

// --- Schemas ---

const NetPolSchema = z.object({
  name: z.string(),
  namespace: z.string(),
  uid: z.string(),
  podSelector: z.record(z.string(), z.string()),
  policyTypes: z.array(z.string()),
  ingressRules: z.array(z.object({
    from: z.array(z.object({
      type: z.string(),
      selector: z.record(z.string(), z.string()),
      cidr: z.string(),
      except: z.array(z.string()),
    })),
    ports: z.array(z.object({
      protocol: z.string(),
      port: z.string(),
      endPort: z.number(),
    })),
  })),
  egressRules: z.array(z.object({
    to: z.array(z.object({
      type: z.string(),
      selector: z.record(z.string(), z.string()),
      cidr: z.string(),
      except: z.array(z.string()),
    })),
    ports: z.array(z.object({
      protocol: z.string(),
      port: z.string(),
      endPort: z.number(),
    })),
  })),
  labels: z.record(z.string(), z.string()),
  annotations: z.record(z.string(), z.string()),
  createdAt: z.string(),
}).passthrough();

// --- Helpers ---

function normalizePeer(peer) {
  if (peer.podSelector) {
    return {
      type: "podSelector",
      selector: peer.podSelector.matchLabels || {},
      cidr: "",
      except: [],
    };
  }
  if (peer.namespaceSelector) {
    return {
      type: "namespaceSelector",
      selector: peer.namespaceSelector.matchLabels || {},
      cidr: "",
      except: [],
    };
  }
  if (peer.ipBlock) {
    return {
      type: "ipBlock",
      selector: {},
      cidr: peer.ipBlock.cidr || "",
      except: peer.ipBlock.except || [],
    };
  }
  return { type: "unknown", selector: {}, cidr: "", except: [] };
}

function normalizePort(port) {
  return {
    protocol: port.protocol || "TCP",
    port: String(port.port || ""),
    endPort: port.endPort || 0,
  };
}

function normalizeNetPol(raw) {
  const meta = normalizeMeta(raw);
  const spec = raw.spec || {};

  const ingressRules = (spec.ingress || []).map((rule) => ({
    from: (rule.from || []).map(normalizePeer),
    ports: (rule.ports || []).map(normalizePort),
  }));

  const egressRules = (spec.egress || []).map((rule) => ({
    to: (rule.to || []).map(normalizePeer),
    ports: (rule.ports || []).map(normalizePort),
  }));

  return {
    ...meta,
    podSelector: (spec.podSelector || {}).matchLabels || {},
    policyTypes: spec.policyTypes || [],
    ingressRules,
    egressRules,
  };
}

// --- Model ---

export const model = {
  type: "@swamp_lord/netpol",
  version: "2026.02.27.1",
  globalArguments: K8sGlobalArgsSchema,
  resources: {
    netpol: {
      description: "NetworkPolicy with pod selector, ingress/egress rules, peer selectors, and CIDR blocks",
      schema: NetPolSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    list: {
      description: "List all NetworkPolicies in the namespace with pod selectors, policy types, and rule counts",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { networkingApi } = buildClient(context.globalArgs);
        const ns = context.globalArgs.namespace;
        const labels = context.globalArgs.labels;

        const resp = await networkingApi.listNamespacedNetworkPolicy({ namespace: ns, labelSelector: labels });
        const policies = resp.items || [];

        context.logger.info("Found {count} NetworkPolicies in {ns}", { count: policies.length, ns });

        const handles = [];
        for (const pol of policies) {
          const normalized = normalizeNetPol(pol);
          const handle = await context.writeResource("netpol", sanitizeInstanceName(normalized.name), normalized);
          handles.push(handle);
        }
        return { dataHandles: handles };
      },
    },

    get: {
      description: "Get a NetworkPolicy's full spec with pod selector, ingress/egress rules, peer selectors, and CIDR blocks",
      arguments: z.object({
        policyName: z.string(),
      }),
      execute: async (args, context) => {
        const { networkingApi } = buildClient(context.globalArgs);
        const ns = context.globalArgs.namespace;

        const pol = await networkingApi.readNamespacedNetworkPolicy({ name: args.policyName, namespace: ns });
        const normalized = normalizeNetPol(pol);

        const handle = await context.writeResource("netpol", sanitizeInstanceName(normalized.name), normalized);
        return { dataHandles: [handle] };
      },
    },

    create: {
      description: "Create a NetworkPolicy with pod selector and ingress/egress rules",
      arguments: z.object({
        policyName: z.string(),
        podSelector: z.record(z.string(), z.string()).default({}),
        policyTypes: z.array(z.enum(["Ingress", "Egress"])).default(["Ingress"]),
        ingress: z.array(z.object({
          from: z.array(z.object({
            podSelector: z.record(z.string(), z.string()).optional(),
            namespaceSelector: z.record(z.string(), z.string()).optional(),
            ipBlock: z.object({
              cidr: z.string(),
              except: z.array(z.string()).optional(),
            }).optional(),
          })).optional(),
          ports: z.array(z.object({
            protocol: z.string().default("TCP"),
            port: z.number(),
          })).optional(),
        })).optional(),
        egress: z.array(z.object({
          to: z.array(z.object({
            podSelector: z.record(z.string(), z.string()).optional(),
            namespaceSelector: z.record(z.string(), z.string()).optional(),
            ipBlock: z.object({
              cidr: z.string(),
              except: z.array(z.string()).optional(),
            }).optional(),
          })).optional(),
          ports: z.array(z.object({
            protocol: z.string().default("TCP"),
            port: z.number(),
          })).optional(),
        })).optional(),
      }),
      execute: async (args, context) => {
        const { networkingApi } = buildClient(context.globalArgs);
        const ns = context.globalArgs.namespace;

        const spec = {
          podSelector: { matchLabels: args.podSelector },
          policyTypes: args.policyTypes,
        };

        if (args.ingress) {
          spec.ingress = args.ingress.map((rule) => {
            const r = {};
            if (rule.from) {
              r.from = rule.from.map((peer) => {
                const p = {};
                if (peer.podSelector) p.podSelector = { matchLabels: peer.podSelector };
                if (peer.namespaceSelector) p.namespaceSelector = { matchLabels: peer.namespaceSelector };
                if (peer.ipBlock) p.ipBlock = peer.ipBlock;
                return p;
              });
            }
            if (rule.ports) r.ports = rule.ports;
            return r;
          });
        }

        if (args.egress) {
          spec.egress = args.egress.map((rule) => {
            const r = {};
            if (rule.to) {
              r.to = rule.to.map((peer) => {
                const p = {};
                if (peer.podSelector) p.podSelector = { matchLabels: peer.podSelector };
                if (peer.namespaceSelector) p.namespaceSelector = { matchLabels: peer.namespaceSelector };
                if (peer.ipBlock) p.ipBlock = peer.ipBlock;
                return p;
              });
            }
            if (rule.ports) r.ports = rule.ports;
            return r;
          });
        }

        const body = {
          metadata: { name: args.policyName, namespace: ns },
          spec,
        };

        const created = await networkingApi.createNamespacedNetworkPolicy({ namespace: ns, body });
        const normalized = normalizeNetPol(created);

        context.logger.info("Created NetworkPolicy {name} in {ns}", { name: args.policyName, ns });

        const handle = await context.writeResource("netpol", sanitizeInstanceName(normalized.name), normalized);
        return { dataHandles: [handle] };
      },
    },

    delete: {
      description: "Delete a NetworkPolicy",
      arguments: z.object({
        policyName: z.string(),
      }),
      execute: async (args, context) => {
        const { networkingApi } = buildClient(context.globalArgs);
        const ns = context.globalArgs.namespace;

        await networkingApi.deleteNamespacedNetworkPolicy({ name: args.policyName, namespace: ns });

        context.logger.info("Deleted NetworkPolicy {name} in {ns}", { name: args.policyName, ns });
        return { dataHandles: [] };
      },
    },
  },
};
