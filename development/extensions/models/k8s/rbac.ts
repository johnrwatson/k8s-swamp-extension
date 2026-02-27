import { z } from "npm:zod@4";
import { buildClient, K8sGlobalArgsSchema, normalizeMeta, sanitizeInstanceName } from "./_helpers.ts";

// --- Schemas ---

const RuleSchema = z.object({
  apiGroups: z.array(z.string()),
  resources: z.array(z.string()),
  verbs: z.array(z.string()),
  resourceNames: z.array(z.string()),
});

const RoleSchema = z.object({
  name: z.string(),
  namespace: z.string(),
  uid: z.string(),
  rules: z.array(RuleSchema),
  labels: z.record(z.string(), z.string()),
  annotations: z.record(z.string(), z.string()),
  createdAt: z.string(),
}).passthrough();

const ClusterRoleSchema = z.object({
  name: z.string(),
  uid: z.string(),
  rules: z.array(RuleSchema),
  aggregationSelectors: z.array(z.record(z.string(), z.string())),
  labels: z.record(z.string(), z.string()),
  annotations: z.record(z.string(), z.string()),
  createdAt: z.string(),
}).passthrough();

const SubjectSchema = z.object({
  kind: z.string(),
  name: z.string(),
  namespace: z.string(),
  apiGroup: z.string(),
});

const RoleBindingSchema = z.object({
  name: z.string(),
  namespace: z.string(),
  uid: z.string(),
  roleRef: z.string(),
  roleRefKind: z.string(),
  subjects: z.array(SubjectSchema),
  labels: z.record(z.string(), z.string()),
  annotations: z.record(z.string(), z.string()),
  createdAt: z.string(),
}).passthrough();

const ClusterRoleBindingSchema = z.object({
  name: z.string(),
  uid: z.string(),
  roleRef: z.string(),
  roleRefKind: z.string(),
  subjects: z.array(SubjectSchema),
  labels: z.record(z.string(), z.string()),
  annotations: z.record(z.string(), z.string()),
  createdAt: z.string(),
}).passthrough();

const ServiceAccountSchema = z.object({
  name: z.string(),
  namespace: z.string(),
  uid: z.string(),
  automountToken: z.boolean(),
  secretCount: z.number(),
  labels: z.record(z.string(), z.string()),
  annotations: z.record(z.string(), z.string()),
  createdAt: z.string(),
}).passthrough();

// --- Helpers ---

function normalizeRule(rule) {
  return {
    apiGroups: rule.apiGroups || [],
    resources: rule.resources || [],
    verbs: rule.verbs || [],
    resourceNames: rule.resourceNames || [],
  };
}

function normalizeRole(raw) {
  const meta = normalizeMeta(raw);
  return {
    ...meta,
    rules: (raw.rules || []).map(normalizeRule),
  };
}

function normalizeClusterRole(raw) {
  const meta = normalizeMeta(raw);
  const aggregation = raw.aggregationRule || {};
  const selectors = (aggregation.clusterRoleSelectors || []).map(
    (s) => (s.matchLabels || {}),
  );
  return {
    name: meta.name,
    uid: meta.uid,
    rules: (raw.rules || []).map(normalizeRule),
    aggregationSelectors: selectors,
    labels: meta.labels,
    annotations: meta.annotations,
    createdAt: meta.createdAt,
  };
}

function normalizeSubject(subject) {
  return {
    kind: subject.kind || "",
    name: subject.name || "",
    namespace: subject.namespace || "",
    apiGroup: subject.apiGroup || "",
  };
}

function normalizeRoleBinding(raw) {
  const meta = normalizeMeta(raw);
  const ref = raw.roleRef || {};
  return {
    ...meta,
    roleRef: ref.name || "",
    roleRefKind: ref.kind || "",
    subjects: (raw.subjects || []).map(normalizeSubject),
  };
}

function normalizeClusterRoleBinding(raw) {
  const meta = normalizeMeta(raw);
  const ref = raw.roleRef || {};
  return {
    name: meta.name,
    uid: meta.uid,
    roleRef: ref.name || "",
    roleRefKind: ref.kind || "",
    subjects: (raw.subjects || []).map(normalizeSubject),
    labels: meta.labels,
    annotations: meta.annotations,
    createdAt: meta.createdAt,
  };
}

function normalizeServiceAccount(raw) {
  const meta = normalizeMeta(raw);
  return {
    ...meta,
    automountToken: raw.automountServiceAccountToken !== false,
    secretCount: (raw.secrets || []).length,
  };
}

// --- Model ---

export const model = {
  type: "@swamp_lord/rbac",
  version: "2026.02.27.1",
  globalArguments: K8sGlobalArgsSchema,
  resources: {
    role: {
      description: "Namespaced Role with API group/resource/verb permission rules",
      schema: RoleSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    clusterRole: {
      description: "Cluster-scoped ClusterRole with permission rules and optional aggregation selectors",
      schema: ClusterRoleSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    roleBinding: {
      description: "Namespaced RoleBinding linking subjects (users, groups, service accounts) to a Role or ClusterRole",
      schema: RoleBindingSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    clusterRoleBinding: {
      description: "Cluster-scoped ClusterRoleBinding linking subjects to a ClusterRole",
      schema: ClusterRoleBindingSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    serviceAccount: {
      description: "ServiceAccount with auto-mount token status and associated secret count",
      schema: ServiceAccountSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    listRoles: {
      description: "List all Roles in the namespace with their permission rules (apiGroups, resources, verbs)",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { rbacApi } = buildClient(context.globalArgs);
        const ns = context.globalArgs.namespace;
        const labels = context.globalArgs.labels;

        const resp = await rbacApi.listNamespacedRole({ namespace: ns, labelSelector: labels });
        const roles = resp.items || [];

        context.logger.info("Found {count} Roles in {ns}", { count: roles.length, ns });

        const handles = [];
        for (const role of roles) {
          const normalized = normalizeRole(role);
          const handle = await context.writeResource("role", sanitizeInstanceName(normalized.name), normalized);
          handles.push(handle);
        }
        return { dataHandles: handles };
      },
    },

    getRole: {
      description: "Get a Role's full permission rules showing which API groups, resources, and verbs are allowed",
      arguments: z.object({
        roleName: z.string(),
      }),
      execute: async (args, context) => {
        const { rbacApi } = buildClient(context.globalArgs);
        const ns = context.globalArgs.namespace;

        const role = await rbacApi.readNamespacedRole({ name: args.roleName, namespace: ns });
        const normalized = normalizeRole(role);

        const handle = await context.writeResource("role", sanitizeInstanceName(normalized.name), normalized);
        return { dataHandles: [handle] };
      },
    },

    listClusterRoles: {
      description: "List all ClusterRoles in the cluster with their permission rules and aggregation selectors",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { rbacApi } = buildClient(context.globalArgs);
        const labels = context.globalArgs.labels;

        const resp = await rbacApi.listClusterRole({ labelSelector: labels });
        const roles = resp.items || [];

        context.logger.info("Found {count} ClusterRoles", { count: roles.length });

        const handles = [];
        for (const role of roles) {
          const normalized = normalizeClusterRole(role);
          const handle = await context.writeResource("clusterRole", sanitizeInstanceName(normalized.name), normalized);
          handles.push(handle);
        }
        return { dataHandles: handles };
      },
    },

    getClusterRole: {
      description: "Get a ClusterRole's full permission rules and aggregation configuration",
      arguments: z.object({
        clusterRoleName: z.string(),
      }),
      execute: async (args, context) => {
        const { rbacApi } = buildClient(context.globalArgs);

        const role = await rbacApi.readClusterRole({ name: args.clusterRoleName });
        const normalized = normalizeClusterRole(role);

        const handle = await context.writeResource("clusterRole", sanitizeInstanceName(normalized.name), normalized);
        return { dataHandles: [handle] };
      },
    },

    listRoleBindings: {
      description: "List all RoleBindings in the namespace showing which subjects are bound to which roles",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { rbacApi } = buildClient(context.globalArgs);
        const ns = context.globalArgs.namespace;
        const labels = context.globalArgs.labels;

        const resp = await rbacApi.listNamespacedRoleBinding({ namespace: ns, labelSelector: labels });
        const bindings = resp.items || [];

        context.logger.info("Found {count} RoleBindings in {ns}", { count: bindings.length, ns });

        const handles = [];
        for (const binding of bindings) {
          const normalized = normalizeRoleBinding(binding);
          const handle = await context.writeResource("roleBinding", sanitizeInstanceName(normalized.name), normalized);
          handles.push(handle);
        }
        return { dataHandles: handles };
      },
    },

    getRoleBinding: {
      description: "Get a RoleBinding's subjects (users, groups, service accounts) and the role it references",
      arguments: z.object({
        roleBindingName: z.string(),
      }),
      execute: async (args, context) => {
        const { rbacApi } = buildClient(context.globalArgs);
        const ns = context.globalArgs.namespace;

        const binding = await rbacApi.readNamespacedRoleBinding({ name: args.roleBindingName, namespace: ns });
        const normalized = normalizeRoleBinding(binding);

        const handle = await context.writeResource("roleBinding", sanitizeInstanceName(normalized.name), normalized);
        return { dataHandles: [handle] };
      },
    },

    listClusterRoleBindings: {
      description: "List all ClusterRoleBindings showing which subjects have cluster-wide role assignments",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { rbacApi } = buildClient(context.globalArgs);
        const labels = context.globalArgs.labels;

        const resp = await rbacApi.listClusterRoleBinding({ labelSelector: labels });
        const bindings = resp.items || [];

        context.logger.info("Found {count} ClusterRoleBindings", { count: bindings.length });

        const handles = [];
        for (const binding of bindings) {
          const normalized = normalizeClusterRoleBinding(binding);
          const handle = await context.writeResource("clusterRoleBinding", sanitizeInstanceName(normalized.name), normalized);
          handles.push(handle);
        }
        return { dataHandles: handles };
      },
    },

    getClusterRoleBinding: {
      description: "Get a ClusterRoleBinding's subjects and the cluster role it references",
      arguments: z.object({
        clusterRoleBindingName: z.string(),
      }),
      execute: async (args, context) => {
        const { rbacApi } = buildClient(context.globalArgs);

        const binding = await rbacApi.readClusterRoleBinding({ name: args.clusterRoleBindingName });
        const normalized = normalizeClusterRoleBinding(binding);

        const handle = await context.writeResource("clusterRoleBinding", sanitizeInstanceName(normalized.name), normalized);
        return { dataHandles: [handle] };
      },
    },

    listServiceAccounts: {
      description: "List all ServiceAccounts in the namespace with auto-mount token status and secret counts",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { coreApi } = buildClient(context.globalArgs);
        const ns = context.globalArgs.namespace;
        const labels = context.globalArgs.labels;

        const resp = await coreApi.listNamespacedServiceAccount({ namespace: ns, labelSelector: labels });
        const accounts = resp.items || [];

        context.logger.info("Found {count} ServiceAccounts in {ns}", { count: accounts.length, ns });

        const handles = [];
        for (const sa of accounts) {
          const normalized = normalizeServiceAccount(sa);
          const handle = await context.writeResource("serviceAccount", sanitizeInstanceName(normalized.name), normalized);
          handles.push(handle);
        }
        return { dataHandles: handles };
      },
    },

    getServiceAccount: {
      description: "Get a ServiceAccount's auto-mount token setting and associated secrets",
      arguments: z.object({
        serviceAccountName: z.string(),
      }),
      execute: async (args, context) => {
        const { coreApi } = buildClient(context.globalArgs);
        const ns = context.globalArgs.namespace;

        const sa = await coreApi.readNamespacedServiceAccount({ name: args.serviceAccountName, namespace: ns });
        const normalized = normalizeServiceAccount(sa);

        const handle = await context.writeResource("serviceAccount", sanitizeInstanceName(normalized.name), normalized);
        return { dataHandles: [handle] };
      },
    },
  },
};
