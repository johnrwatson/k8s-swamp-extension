import { z } from "npm:zod@4";
import { buildClient, K8sGlobalArgsSchema, normalizeMeta, sanitizeInstanceName } from "./_helpers.ts";

// --- Schemas ---

const ContainerSchema = z.object({
  name: z.string(),
  image: z.string(),
  ports: z.array(z.object({
    containerPort: z.number(),
    protocol: z.string(),
  })),
  env: z.array(z.object({
    name: z.string(),
    value: z.string(),
  })),
  requestsCpu: z.string(),
  requestsMemory: z.string(),
  limitsCpu: z.string(),
  limitsMemory: z.string(),
  volumeMounts: z.array(z.object({
    name: z.string(),
    mountPath: z.string(),
    readOnly: z.boolean(),
  })),
  runAsNonRoot: z.boolean(),
  readOnlyRootFilesystem: z.boolean(),
  runAsUser: z.number(),
});

const VolumeSchema = z.object({
  name: z.string(),
  type: z.string(),
  source: z.string(),
});

const DeploymentSchema = z.object({
  name: z.string(),
  namespace: z.string(),
  uid: z.string(),
  replicas: z.number(),
  readyReplicas: z.number(),
  updatedReplicas: z.number(),
  availableReplicas: z.number(),
  strategyType: z.string(),
  maxUnavailable: z.string(),
  maxSurge: z.string(),
  conditions: z.array(z.object({
    type: z.string(),
    status: z.string(),
    reason: z.string(),
    message: z.string(),
    lastTransitionTime: z.string(),
  })),
  containers: z.array(ContainerSchema),
  volumes: z.array(VolumeSchema),
  podTemplateLabels: z.record(z.string(), z.string()),
  selector: z.record(z.string(), z.string()),
  labels: z.record(z.string(), z.string()),
  annotations: z.record(z.string(), z.string()),
  createdAt: z.string(),
}).passthrough();

const ReplicaSetSchema = z.object({
  name: z.string(),
  namespace: z.string(),
  uid: z.string(),
  replicas: z.number(),
  readyReplicas: z.number(),
  ownerDeployment: z.string(),
  revision: z.string(),
  labels: z.record(z.string(), z.string()),
  createdAt: z.string(),
}).passthrough();

// --- Helpers ---

function normalizeVolume(vol) {
  if (vol.configMap) return { name: vol.name, type: "configMap", source: vol.configMap.name || "" };
  if (vol.secret) return { name: vol.name, type: "secret", source: vol.secret.secretName || "" };
  if (vol.emptyDir) return { name: vol.name, type: "emptyDir", source: "" };
  if (vol.persistentVolumeClaim) return { name: vol.name, type: "pvc", source: vol.persistentVolumeClaim.claimName || "" };
  if (vol.hostPath) return { name: vol.name, type: "hostPath", source: vol.hostPath.path || "" };
  return { name: vol.name, type: "unknown", source: "" };
}

function normalizeContainer(c) {
  const res = c.resources || {};
  const req = res.requests || {};
  const lim = res.limits || {};
  const sc = c.securityContext || {};

  return {
    name: c.name || "",
    image: c.image || "",
    ports: (c.ports || []).map((p) => ({
      containerPort: p.containerPort || 0,
      protocol: p.protocol || "TCP",
    })),
    env: (c.env || []).map((e) => ({
      name: e.name || "",
      value: e.value || (e.valueFrom ? JSON.stringify(e.valueFrom) : ""),
    })),
    requestsCpu: req.cpu || "",
    requestsMemory: req.memory || "",
    limitsCpu: lim.cpu || "",
    limitsMemory: lim.memory || "",
    volumeMounts: (c.volumeMounts || []).map((vm) => ({
      name: vm.name || "",
      mountPath: vm.mountPath || "",
      readOnly: vm.readOnly || false,
    })),
    runAsNonRoot: sc.runAsNonRoot || false,
    readOnlyRootFilesystem: sc.readOnlyRootFilesystem || false,
    runAsUser: sc.runAsUser ?? -1,
  };
}

function normalizeDeployment(raw) {
  const meta = normalizeMeta(raw);
  const spec = raw.spec || {};
  const status = raw.status || {};
  const strategy = spec.strategy || {};
  const rolling = strategy.rollingUpdate || {};
  const template = spec.template || {};
  const templateSpec = template.spec || {};
  const templateMeta = template.metadata || {};

  return {
    ...meta,
    replicas: spec.replicas ?? 0,
    readyReplicas: status.readyReplicas ?? 0,
    updatedReplicas: status.updatedReplicas ?? 0,
    availableReplicas: status.availableReplicas ?? 0,
    strategyType: strategy.type || "RollingUpdate",
    maxUnavailable: String(rolling.maxUnavailable ?? "25%"),
    maxSurge: String(rolling.maxSurge ?? "25%"),
    conditions: (status.conditions || []).map((c) => ({
      type: c.type || "",
      status: c.status || "",
      reason: c.reason || "",
      message: c.message || "",
      lastTransitionTime: c.lastTransitionTime ? new Date(c.lastTransitionTime).toISOString() : "",
    })),
    containers: (templateSpec.containers || []).map(normalizeContainer),
    volumes: (templateSpec.volumes || []).map(normalizeVolume),
    podTemplateLabels: templateMeta.labels || {},
    selector: spec.selector?.matchLabels || {},
  };
}

function normalizeReplicaSet(raw) {
  const meta = normalizeMeta(raw);
  const spec = raw.spec || {};
  const status = raw.status || {};
  const ownerRefs = raw.metadata?.ownerReferences || [];
  const deployOwner = ownerRefs.find((o) => o.kind === "Deployment");

  return {
    ...meta,
    replicas: status.replicas ?? 0,
    readyReplicas: status.readyReplicas ?? 0,
    ownerDeployment: deployOwner?.name || "",
    revision: meta.annotations["deployment.kubernetes.io/revision"] || "",
  };
}

// --- Model ---

export const model = {
  type: "@swamp_lord/deployment",
  version: "2026.02.27.1",
  globalArguments: K8sGlobalArgsSchema,
  resources: {
    deployment: {
      description: "Deployment spec with replicas, strategy, containers, volumes, security contexts, and rollout conditions",
      schema: DeploymentSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    replicaSet: {
      description: "ReplicaSet showing replica counts, owner deployment, and revision number",
      schema: ReplicaSetSchema,
      lifetime: "1h",
      garbageCollection: 10,
    },
  },
  methods: {
    list: {
      description: "List all deployments in the configured namespace with replicas, strategy, containers, and conditions",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { appsApi } = buildClient(context.globalArgs);
        const ns = context.globalArgs.namespace;
        const labels = context.globalArgs.labels;

        const resp = await appsApi.listNamespacedDeployment({ namespace: ns, labelSelector: labels });
        const deployments = resp.items || [];

        context.logger.info("Found {count} deployments in {ns}", {
          count: deployments.length,
          ns,
        });

        const handles = [];
        for (const dep of deployments) {
          const normalized = normalizeDeployment(dep);
          const handle = await context.writeResource(
            "deployment",
            sanitizeInstanceName(normalized.name),
            normalized,
          );
          handles.push(handle);
        }
        return { dataHandles: handles };
      },
    },

    get: {
      description: "Get a deployment's full spec including containers, volumes, security contexts, and rollout conditions",
      arguments: z.object({
        deploymentName: z.string(),
      }),
      execute: async (args, context) => {
        const { appsApi } = buildClient(context.globalArgs);
        const ns = context.globalArgs.namespace;

        const dep = await appsApi.readNamespacedDeployment({ name: args.deploymentName, namespace: ns });
        const normalized = normalizeDeployment(dep);

        const handle = await context.writeResource(
          "deployment",
          sanitizeInstanceName(normalized.name),
          normalized,
        );
        return { dataHandles: [handle] };
      },
    },

    create: {
      description: "Create a deployment from a container image or full spec object",
      arguments: z.object({
        deploymentName: z.string(),
        image: z.string().optional(),
        replicas: z.number().default(1),
        spec: z.any().optional(),
      }),
      execute: async (args, context) => {
        const { appsApi } = buildClient(context.globalArgs);
        const ns = context.globalArgs.namespace;

        let body;
        if (args.spec) {
          body = args.spec;
        } else if (args.image) {
          body = {
            metadata: { name: args.deploymentName, namespace: ns },
            spec: {
              replicas: args.replicas,
              selector: { matchLabels: { app: args.deploymentName } },
              template: {
                metadata: { labels: { app: args.deploymentName } },
                spec: {
                  containers: [{
                    name: args.deploymentName,
                    image: args.image,
                  }],
                },
              },
            },
          };
        } else {
          throw new Error("Either 'image' or 'spec' must be provided");
        }

        const created = await appsApi.createNamespacedDeployment({ namespace: ns, body });
        const normalized = normalizeDeployment(created);

        context.logger.info("Created deployment {name} in {ns}", {
          name: args.deploymentName,
          ns,
        });

        const handle = await context.writeResource(
          "deployment",
          sanitizeInstanceName(normalized.name),
          normalized,
        );
        return { dataHandles: [handle] };
      },
    },

    update: {
      description: "Update a deployment's container image and/or replica count via read-then-replace",
      arguments: z.object({
        deploymentName: z.string(),
        image: z.string().optional(),
        replicas: z.number().optional(),
      }),
      execute: async (args, context) => {
        const { appsApi } = buildClient(context.globalArgs);
        const ns = context.globalArgs.namespace;

        const current = await appsApi.readNamespacedDeployment({ name: args.deploymentName, namespace: ns });

        if (args.replicas !== undefined) {
          current.spec.replicas = args.replicas;
        }
        if (args.image && current.spec.template.spec.containers.length > 0) {
          current.spec.template.spec.containers[0].image = args.image;
        }

        const replaced = await appsApi.replaceNamespacedDeployment({
          name: args.deploymentName,
          namespace: ns,
          body: current,
        });
        const normalized = normalizeDeployment(replaced);

        context.logger.info("Updated deployment {name} in {ns}", {
          name: args.deploymentName,
          ns,
        });

        const handle = await context.writeResource(
          "deployment",
          sanitizeInstanceName(normalized.name),
          normalized,
        );
        return { dataHandles: [handle] };
      },
    },

    delete: {
      description: "Delete a deployment",
      arguments: z.object({
        deploymentName: z.string(),
      }),
      execute: async (args, context) => {
        const { appsApi } = buildClient(context.globalArgs);
        const ns = context.globalArgs.namespace;

        await appsApi.deleteNamespacedDeployment({ name: args.deploymentName, namespace: ns });

        context.logger.info("Deleted deployment {name} in {ns}", {
          name: args.deploymentName,
          ns,
        });
        return { dataHandles: [] };
      },
    },

    scale: {
      description: "Scale a deployment to the specified replica count",
      arguments: z.object({
        deploymentName: z.string(),
        replicas: z.number(),
      }),
      execute: async (args, context) => {
        const { appsApi } = buildClient(context.globalArgs);
        const ns = context.globalArgs.namespace;

        const current = await appsApi.readNamespacedDeployment({ name: args.deploymentName, namespace: ns });
        current.spec.replicas = args.replicas;

        const replaced = await appsApi.replaceNamespacedDeployment({
          name: args.deploymentName,
          namespace: ns,
          body: current,
        });
        const normalized = normalizeDeployment(replaced);

        context.logger.info("Scaled deployment {name} to {replicas} replicas", {
          name: args.deploymentName,
          replicas: args.replicas,
        });

        const handle = await context.writeResource(
          "deployment",
          sanitizeInstanceName(normalized.name),
          normalized,
        );
        return { dataHandles: [handle] };
      },
    },

    restart: {
      description: "Trigger a rolling restart by setting the restartedAt annotation on the pod template",
      arguments: z.object({
        deploymentName: z.string(),
      }),
      execute: async (args, context) => {
        const { appsApi } = buildClient(context.globalArgs);
        const ns = context.globalArgs.namespace;

        const current = await appsApi.readNamespacedDeployment({ name: args.deploymentName, namespace: ns });

        if (!current.spec.template.metadata) {
          current.spec.template.metadata = {};
        }
        if (!current.spec.template.metadata.annotations) {
          current.spec.template.metadata.annotations = {};
        }
        current.spec.template.metadata.annotations["kubectl.kubernetes.io/restartedAt"] =
          new Date().toISOString();

        const replaced = await appsApi.replaceNamespacedDeployment({
          name: args.deploymentName,
          namespace: ns,
          body: current,
        });
        const normalized = normalizeDeployment(replaced);

        context.logger.info("Triggered rolling restart for deployment {name}", {
          name: args.deploymentName,
        });

        const handle = await context.writeResource(
          "deployment",
          sanitizeInstanceName(normalized.name),
          normalized,
        );
        return { dataHandles: [handle] };
      },
    },

    pause: {
      description: "Pause a deployment's rollout by setting spec.paused = true",
      arguments: z.object({
        deploymentName: z.string(),
      }),
      execute: async (args, context) => {
        const { appsApi } = buildClient(context.globalArgs);
        const ns = context.globalArgs.namespace;

        const current = await appsApi.readNamespacedDeployment({ name: args.deploymentName, namespace: ns });
        current.spec.paused = true;

        const replaced = await appsApi.replaceNamespacedDeployment({
          name: args.deploymentName,
          namespace: ns,
          body: current,
        });
        const normalized = normalizeDeployment(replaced);

        context.logger.info("Paused deployment {name}", { name: args.deploymentName });

        const handle = await context.writeResource(
          "deployment",
          sanitizeInstanceName(normalized.name),
          normalized,
        );
        return { dataHandles: [handle] };
      },
    },

    resume: {
      description: "Resume a paused deployment's rollout by setting spec.paused = false",
      arguments: z.object({
        deploymentName: z.string(),
      }),
      execute: async (args, context) => {
        const { appsApi } = buildClient(context.globalArgs);
        const ns = context.globalArgs.namespace;

        const current = await appsApi.readNamespacedDeployment({ name: args.deploymentName, namespace: ns });
        current.spec.paused = false;

        const replaced = await appsApi.replaceNamespacedDeployment({
          name: args.deploymentName,
          namespace: ns,
          body: current,
        });
        const normalized = normalizeDeployment(replaced);

        context.logger.info("Resumed deployment {name}", { name: args.deploymentName });

        const handle = await context.writeResource(
          "deployment",
          sanitizeInstanceName(normalized.name),
          normalized,
        );
        return { dataHandles: [handle] };
      },
    },

    getRolloutStatus: {
      description: "Get a deployment's rollout status with Available, Progressing, and ReplicaFailure conditions",
      arguments: z.object({
        deploymentName: z.string(),
      }),
      execute: async (args, context) => {
        const { appsApi } = buildClient(context.globalArgs);
        const ns = context.globalArgs.namespace;

        const dep = await appsApi.readNamespacedDeployment({ name: args.deploymentName, namespace: ns });
        const normalized = normalizeDeployment(dep);

        context.logger.info("Rollout status for {name}: {conditions}", {
          name: args.deploymentName,
          conditions: normalized.conditions.map((c) => `${c.type}=${c.status}`).join(", "),
        });

        const handle = await context.writeResource(
          "deployment",
          sanitizeInstanceName(normalized.name),
          normalized,
        );
        return { dataHandles: [handle] };
      },
    },

    getReplicaSets: {
      description: "List ReplicaSets owned by a deployment, showing rollout history and revisions",
      arguments: z.object({
        deploymentName: z.string(),
      }),
      execute: async (args, context) => {
        const { appsApi } = buildClient(context.globalArgs);
        const ns = context.globalArgs.namespace;

        const resp = await appsApi.listNamespacedReplicaSet({ namespace: ns });
        const allRs = resp.items || [];

        // Filter to ReplicaSets owned by this deployment
        const owned = allRs.filter((rs) => {
          const owners = rs.metadata?.ownerReferences || [];
          return owners.some((o) => o.kind === "Deployment" && o.name === args.deploymentName);
        });

        context.logger.info("Found {count} ReplicaSets for deployment {name}", {
          count: owned.length,
          name: args.deploymentName,
        });

        const handles = [];
        for (const rs of owned) {
          const normalized = normalizeReplicaSet(rs);
          const handle = await context.writeResource(
            "replicaSet",
            sanitizeInstanceName(normalized.name),
            normalized,
          );
          handles.push(handle);
        }
        return { dataHandles: handles };
      },
    },
  },
};
