import { z } from "npm:zod@4";
import { buildClient, K8sGlobalArgsSchema, normalizeMeta, sanitizeInstanceName } from "./_helpers.ts";

// --- Schemas ---

const JobSchema = z.object({
  name: z.string(),
  namespace: z.string(),
  uid: z.string(),
  completions: z.number(),
  parallelism: z.number(),
  succeeded: z.number(),
  failed: z.number(),
  active: z.number(),
  backoffLimit: z.number(),
  startTime: z.string(),
  completionTime: z.string(),
  durationSeconds: z.number(),
  conditions: z.array(z.object({
    type: z.string(),
    status: z.string(),
    reason: z.string(),
    message: z.string(),
    lastTransitionTime: z.string(),
  })),
  containers: z.array(z.object({
    name: z.string(),
    image: z.string(),
  })),
  ownerCronJob: z.string(),
  labels: z.record(z.string(), z.string()),
  annotations: z.record(z.string(), z.string()),
  createdAt: z.string(),
}).passthrough();

const CronJobSchema = z.object({
  name: z.string(),
  namespace: z.string(),
  uid: z.string(),
  schedule: z.string(),
  suspend: z.boolean(),
  concurrencyPolicy: z.string(),
  lastScheduleTime: z.string(),
  lastSuccessfulTime: z.string(),
  activeJobs: z.number(),
  successfulJobsHistoryLimit: z.number(),
  failedJobsHistoryLimit: z.number(),
  containers: z.array(z.object({
    name: z.string(),
    image: z.string(),
  })),
  labels: z.record(z.string(), z.string()),
  annotations: z.record(z.string(), z.string()),
  createdAt: z.string(),
}).passthrough();

// --- Helpers ---

function normalizeJob(raw) {
  const meta = normalizeMeta(raw);
  const spec = raw.spec || {};
  const status = raw.status || {};
  const templateSpec = (spec.template || {}).spec || {};
  const ownerRefs = raw.metadata?.ownerReferences || [];
  const cronOwner = ownerRefs.find((o) => o.kind === "CronJob");

  const startTime = status.startTime ? new Date(status.startTime).toISOString() : "";
  const completionTime = status.completionTime ? new Date(status.completionTime).toISOString() : "";
  let durationSeconds = 0;
  if (startTime && completionTime) {
    durationSeconds = Math.round((new Date(completionTime).getTime() - new Date(startTime).getTime()) / 1000);
  }

  return {
    ...meta,
    completions: spec.completions ?? 1,
    parallelism: spec.parallelism ?? 1,
    succeeded: status.succeeded ?? 0,
    failed: status.failed ?? 0,
    active: status.active ?? 0,
    backoffLimit: spec.backoffLimit ?? 6,
    startTime,
    completionTime,
    durationSeconds,
    conditions: (status.conditions || []).map((c) => ({
      type: c.type || "",
      status: c.status || "",
      reason: c.reason || "",
      message: c.message || "",
      lastTransitionTime: c.lastTransitionTime ? new Date(c.lastTransitionTime).toISOString() : "",
    })),
    containers: (templateSpec.containers || []).map((c) => ({
      name: c.name || "",
      image: c.image || "",
    })),
    ownerCronJob: cronOwner?.name || "",
  };
}

function normalizeCronJob(raw) {
  const meta = normalizeMeta(raw);
  const spec = raw.spec || {};
  const status = raw.status || {};
  const jobSpec = spec.jobTemplate?.spec?.template?.spec || {};

  return {
    ...meta,
    schedule: spec.schedule || "",
    suspend: spec.suspend || false,
    concurrencyPolicy: spec.concurrencyPolicy || "Allow",
    lastScheduleTime: status.lastScheduleTime ? new Date(status.lastScheduleTime).toISOString() : "",
    lastSuccessfulTime: status.lastSuccessfulTime ? new Date(status.lastSuccessfulTime).toISOString() : "",
    activeJobs: (status.active || []).length,
    successfulJobsHistoryLimit: spec.successfulJobsHistoryLimit ?? 3,
    failedJobsHistoryLimit: spec.failedJobsHistoryLimit ?? 1,
    containers: (jobSpec.containers || []).map((c) => ({
      name: c.name || "",
      image: c.image || "",
    })),
  };
}

// --- Model ---

export const model = {
  type: "@swamp_lord/job",
  version: "2026.02.27.1",
  globalArguments: K8sGlobalArgsSchema,
  resources: {
    job: {
      description: "Job with completions, failures, duration, conditions, and owner CronJob reference",
      schema: JobSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    cronJob: {
      description: "CronJob with schedule, suspend status, concurrency policy, and last schedule/success times",
      schema: CronJobSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    listJobs: {
      description: "List all Jobs in the namespace with completion status, duration, and failure counts",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { batchApi } = buildClient(context.globalArgs);
        const ns = context.globalArgs.namespace;
        const labels = context.globalArgs.labels;

        const resp = await batchApi.listNamespacedJob({ namespace: ns, labelSelector: labels });
        const jobs = resp.items || [];

        context.logger.info("Found {count} jobs in {ns}", { count: jobs.length, ns });

        const handles = [];
        for (const job of jobs) {
          const normalized = normalizeJob(job);
          const handle = await context.writeResource("job", sanitizeInstanceName(normalized.name), normalized);
          handles.push(handle);
        }
        return { dataHandles: handles };
      },
    },

    getJob: {
      description: "Get a Job's full status including completions, failures, duration, conditions, and containers",
      arguments: z.object({
        jobName: z.string(),
      }),
      execute: async (args, context) => {
        const { batchApi } = buildClient(context.globalArgs);
        const ns = context.globalArgs.namespace;

        const job = await batchApi.readNamespacedJob({ name: args.jobName, namespace: ns });
        const normalized = normalizeJob(job);

        const handle = await context.writeResource("job", sanitizeInstanceName(normalized.name), normalized);
        return { dataHandles: [handle] };
      },
    },

    deleteJob: {
      description: "Delete a Job and its pods",
      arguments: z.object({
        jobName: z.string(),
      }),
      execute: async (args, context) => {
        const { batchApi } = buildClient(context.globalArgs);
        const ns = context.globalArgs.namespace;

        await batchApi.deleteNamespacedJob({
          name: args.jobName,
          namespace: ns,
          body: { propagationPolicy: "Background" },
        });

        context.logger.info("Deleted job {name} in {ns}", { name: args.jobName, ns });
        return { dataHandles: [] };
      },
    },

    listCronJobs: {
      description: "List all CronJobs with schedule, suspend status, last run times, and active job count",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { batchApi } = buildClient(context.globalArgs);
        const ns = context.globalArgs.namespace;
        const labels = context.globalArgs.labels;

        const resp = await batchApi.listNamespacedCronJob({ namespace: ns, labelSelector: labels });
        const cronJobs = resp.items || [];

        context.logger.info("Found {count} CronJobs in {ns}", { count: cronJobs.length, ns });

        const handles = [];
        for (const cj of cronJobs) {
          const normalized = normalizeCronJob(cj);
          const handle = await context.writeResource("cronJob", sanitizeInstanceName(normalized.name), normalized);
          handles.push(handle);
        }
        return { dataHandles: handles };
      },
    },

    getCronJob: {
      description: "Get a CronJob's schedule, suspend status, concurrency policy, and history limits",
      arguments: z.object({
        cronJobName: z.string(),
      }),
      execute: async (args, context) => {
        const { batchApi } = buildClient(context.globalArgs);
        const ns = context.globalArgs.namespace;

        const cj = await batchApi.readNamespacedCronJob({ name: args.cronJobName, namespace: ns });
        const normalized = normalizeCronJob(cj);

        const handle = await context.writeResource("cronJob", sanitizeInstanceName(normalized.name), normalized);
        return { dataHandles: [handle] };
      },
    },

    deleteCronJob: {
      description: "Delete a CronJob and all its child Jobs",
      arguments: z.object({
        cronJobName: z.string(),
      }),
      execute: async (args, context) => {
        const { batchApi } = buildClient(context.globalArgs);
        const ns = context.globalArgs.namespace;

        await batchApi.deleteNamespacedCronJob({
          name: args.cronJobName,
          namespace: ns,
          body: { propagationPolicy: "Background" },
        });

        context.logger.info("Deleted CronJob {name} in {ns}", { name: args.cronJobName, ns });
        return { dataHandles: [] };
      },
    },
  },
};
