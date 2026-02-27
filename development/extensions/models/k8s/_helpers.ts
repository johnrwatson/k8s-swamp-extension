import { z } from "npm:zod@4";
import * as k8s from "npm:@kubernetes/client-node@1.0.0";

// Shared global arguments for all @swamp_lord/* models
export const K8sGlobalArgsSchema = z.object({
  namespace: z.string().default("default"),
  context: z.string().optional(),
  kubeconfig: z.string().optional(),
  labels: z.string().optional(),
});

// Schema for kubeconfig context info
export const ContextInfoSchema = z.object({
  name: z.string(),
  cluster: z.string(),
  user: z.string(),
  namespace: z.string(),
  isCurrentContext: z.boolean(),
}).passthrough();

// Build a configured K8s client from global args
export function buildClient(globalArgs) {
  const kc = new k8s.KubeConfig();

  if (globalArgs.kubeconfig) {
    kc.loadFromFile(globalArgs.kubeconfig);
  } else {
    kc.loadFromDefault();
  }

  if (globalArgs.context) {
    kc.setCurrentContext(globalArgs.context);
  }

  const coreApi = kc.makeApiClient(k8s.CoreV1Api);
  const appsApi = kc.makeApiClient(k8s.AppsV1Api);
  const batchApi = kc.makeApiClient(k8s.BatchV1Api);
  const networkingApi = kc.makeApiClient(k8s.NetworkingV1Api);
  const autoscalingApi = kc.makeApiClient(k8s.AutoscalingV2Api);
  const rbacApi = kc.makeApiClient(k8s.RbacAuthorizationV1Api);
  const metricsClient = new k8s.Metrics(kc);

  return { kc, coreApi, appsApi, batchApi, networkingApi, autoscalingApi, rbacApi, metricsClient };
}

// Extract common metadata from any K8s object
export function normalizeMeta(raw) {
  const meta = raw.metadata || {};
  return {
    name: meta.name || "",
    namespace: meta.namespace || "",
    uid: meta.uid || "",
    labels: meta.labels || {},
    annotations: meta.annotations || {},
    createdAt: meta.creationTimestamp
      ? new Date(meta.creationTimestamp).toISOString()
      : "",
  };
}

// Sanitize a string for use as a swamp data instance name
// Replaces disallowed characters (/, \, ..) with dashes
export function sanitizeInstanceName(name) {
  return name
    .replace(/\.\./g, "--")
    .replace(/[/\\]/g, "-")
    .replace(/\0/g, "");
}

// List all kubeconfig contexts
export function listKubeContexts(kc) {
  const currentContext = kc.getCurrentContext();
  return kc.getContexts().map((ctx) => {
    const cluster = kc.getCluster(ctx.cluster);
    const user = kc.getUser(ctx.user);
    return {
      name: ctx.name,
      cluster: cluster?.name || ctx.cluster || "",
      user: user?.name || ctx.user || "",
      namespace: ctx.namespace || "default",
      isCurrentContext: ctx.name === currentContext,
    };
  });
}
