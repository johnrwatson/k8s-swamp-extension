import { z } from "npm:zod@4";
import {
  buildClient,
  K8sGlobalArgsSchema,
  normalizeMeta,
  sanitizeInstanceName,
} from "./_helpers.ts";

// --- Schemas ---

const HpaSchema = z.object({
  name: z.string(),
  namespace: z.string(),
  uid: z.string(),
  scaleTargetRef: z.string(),
  minReplicas: z.number(),
  maxReplicas: z.number(),
  currentReplicas: z.number(),
  desiredReplicas: z.number(),
  metrics: z.array(z.object({
    type: z.string(),
    name: z.string(),
    currentValue: z.string(),
    targetValue: z.string(),
  })),
  conditions: z.array(z.object({
    type: z.string(),
    status: z.string(),
    reason: z.string(),
    message: z.string(),
    lastTransitionTime: z.string(),
  })),
  lastScaleTime: z.string(),
  labels: z.record(z.string(), z.string()),
  annotations: z.record(z.string(), z.string()),
  createdAt: z.string(),
}).passthrough();

// --- Helpers ---

function normalizeMetricStatus(metric) {
  const type = metric.type || "Unknown";
  let name = "";
  let currentValue = "";

  if (type === "Resource") {
    const res = metric.resource || {};
    name = res.name || "";
    const current = res.current || {};
    currentValue = current.averageUtilization != null
      ? `${current.averageUtilization}%`
      : current.averageValue || "";
  } else if (type === "Pods") {
    const pods = metric.pods || {};
    name = (pods.metric || {}).name || "";
    currentValue = (pods.current || {}).averageValue || "";
  } else if (type === "Object") {
    const obj = metric.object || {};
    name = (obj.metric || {}).name || "";
    currentValue = (obj.current || {}).value || "";
  } else if (type === "External") {
    const ext = metric.external || {};
    name = (ext.metric || {}).name || "";
    currentValue = (ext.current || {}).value ||
      (ext.current || {}).averageValue || "";
  }

  return { type, name, currentValue, targetValue: "" };
}

function normalizeMetricSpec(spec) {
  const type = spec.type || "Unknown";
  let name = "";
  let targetValue = "";

  if (type === "Resource") {
    const res = spec.resource || {};
    name = res.name || "";
    const target = res.target || {};
    targetValue = target.averageUtilization != null
      ? `${target.averageUtilization}%`
      : target.averageValue || target.value || "";
  } else if (type === "Pods") {
    const pods = spec.pods || {};
    name = (pods.metric || {}).name || "";
    targetValue = (pods.target || {}).averageValue || "";
  } else if (type === "Object") {
    const obj = spec.object || {};
    name = (obj.metric || {}).name || "";
    targetValue = (obj.target || {}).value || (obj.target || {}).averageValue ||
      "";
  } else if (type === "External") {
    const ext = spec.external || {};
    name = (ext.metric || {}).name || "";
    targetValue = (ext.target || {}).value || (ext.target || {}).averageValue ||
      "";
  }

  return { type, name, targetValue };
}

function normalizeHpa(raw) {
  const meta = normalizeMeta(raw);
  const spec = raw.spec || {};
  const status = raw.status || {};
  const ref = spec.scaleTargetRef || {};

  // Merge spec metrics (targets) with status metrics (current values)
  const specMetrics = spec.metrics || [];
  const statusMetrics = status.currentMetrics || [];

  const metrics = specMetrics.map((sm, i) => {
    const specNorm = normalizeMetricSpec(sm);
    const statusNorm = statusMetrics[i]
      ? normalizeMetricStatus(statusMetrics[i])
      : {};
    return {
      type: specNorm.type,
      name: specNorm.name,
      currentValue: statusNorm.currentValue || "",
      targetValue: specNorm.targetValue,
    };
  });

  return {
    ...meta,
    scaleTargetRef: `${ref.kind || ""}/${ref.name || ""}`,
    minReplicas: spec.minReplicas ?? 1,
    maxReplicas: spec.maxReplicas ?? 0,
    currentReplicas: status.currentReplicas ?? 0,
    desiredReplicas: status.desiredReplicas ?? 0,
    metrics,
    conditions: (status.conditions || []).map((c) => ({
      type: c.type || "",
      status: c.status || "",
      reason: c.reason || "",
      message: c.message || "",
      lastTransitionTime: c.lastTransitionTime
        ? new Date(c.lastTransitionTime).toISOString()
        : "",
    })),
    lastScaleTime: status.lastScaleTime
      ? new Date(status.lastScaleTime).toISOString()
      : "",
  };
}

// --- Model ---

export const model = {
  type: "@john/hpa",
  version: "2026.02.27.1",
  globalArguments: K8sGlobalArgsSchema,
  resources: {
    hpa: {
      description:
        "HorizontalPodAutoscaler with current/target metrics, replica range, scale conditions, and last scale time",
      schema: HpaSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    list: {
      description:
        "List all HorizontalPodAutoscalers in the namespace with current vs target metrics and replica counts",
      arguments: z.object({ namespace: z.string().optional() }),
      execute: async (args, context) => {
        const { autoscalingApi } = buildClient(context.globalArgs);
        const ns = args.namespace ?? context.globalArgs.namespace;
        const labels = context.globalArgs.labels;

        const resp = await autoscalingApi.listNamespacedHorizontalPodAutoscaler(
          { namespace: ns, labelSelector: labels },
        );
        const hpas = resp.items || [];

        context.logger.info("Found {count} HPAs in {ns}", {
          count: hpas.length,
          ns,
        });

        const handles = [];
        for (const hpa of hpas) {
          const normalized = normalizeHpa(hpa);
          const handle = await context.writeResource(
            "hpa",
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
        "Get an HPA's current vs target metrics, replica range, scale conditions, and last scale time",
      arguments: z.object({
        hpaName: z.string(),
        namespace: z.string().optional(),
      }),
      execute: async (args, context) => {
        const { autoscalingApi } = buildClient(context.globalArgs);
        const ns = args.namespace ?? context.globalArgs.namespace;

        const hpa = await autoscalingApi.readNamespacedHorizontalPodAutoscaler({
          name: args.hpaName,
          namespace: ns,
        });
        const normalized = normalizeHpa(hpa);

        const handle = await context.writeResource(
          "hpa",
          sanitizeInstanceName(normalized.name),
          normalized,
        );
        return { dataHandles: [handle] };
      },
    },

    create: {
      description:
        "Create an HPA targeting a deployment with CPU utilization threshold and replica range",
      arguments: z.object({
        hpaName: z.string(),
        targetDeployment: z.string(),
        minReplicas: z.number().default(1),
        maxReplicas: z.number(),
        cpuTargetPercent: z.number().default(80),
        namespace: z.string().optional(),
      }),
      execute: async (args, context) => {
        const { autoscalingApi } = buildClient(context.globalArgs);
        const ns = args.namespace ?? context.globalArgs.namespace;

        const body = {
          metadata: { name: args.hpaName, namespace: ns },
          spec: {
            scaleTargetRef: {
              apiVersion: "apps/v1",
              kind: "Deployment",
              name: args.targetDeployment,
            },
            minReplicas: args.minReplicas,
            maxReplicas: args.maxReplicas,
            metrics: [{
              type: "Resource",
              resource: {
                name: "cpu",
                target: {
                  type: "Utilization",
                  averageUtilization: args.cpuTargetPercent,
                },
              },
            }],
          },
        };

        const created = await autoscalingApi
          .createNamespacedHorizontalPodAutoscaler({ namespace: ns, body });
        const normalized = normalizeHpa(created);

        context.logger.info("Created HPA {name} targeting {target} in {ns}", {
          name: args.hpaName,
          target: args.targetDeployment,
          ns,
        });

        const handle = await context.writeResource(
          "hpa",
          sanitizeInstanceName(normalized.name),
          normalized,
        );
        return { dataHandles: [handle] };
      },
    },

    delete: {
      description: "Delete a HorizontalPodAutoscaler",
      arguments: z.object({
        hpaName: z.string(),
        namespace: z.string().optional(),
      }),
      execute: async (args, context) => {
        const { autoscalingApi } = buildClient(context.globalArgs);
        const ns = args.namespace ?? context.globalArgs.namespace;

        await autoscalingApi.deleteNamespacedHorizontalPodAutoscaler({
          name: args.hpaName,
          namespace: ns,
        });

        context.logger.info("Deleted HPA {name} in {ns}", {
          name: args.hpaName,
          ns,
        });
        return { dataHandles: [] };
      },
    },
  },
};
