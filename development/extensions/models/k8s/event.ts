import { z } from "npm:zod@4";
import {
  buildClient,
  K8sGlobalArgsSchema,
  sanitizeInstanceName,
} from "./_helpers.ts";

// --- Schemas ---

const EventSchema = z.object({
  name: z.string(),
  namespace: z.string(),
  uid: z.string(),
  type: z.string(),
  reason: z.string(),
  message: z.string(),
  involvedObjectKind: z.string(),
  involvedObjectName: z.string(),
  involvedObjectNamespace: z.string(),
  involvedObjectUid: z.string(),
  count: z.number(),
  firstTimestamp: z.string(),
  lastTimestamp: z.string(),
  sourceComponent: z.string(),
  sourceHost: z.string(),
}).passthrough();

// --- Helpers ---

function normalizeEvent(raw) {
  const meta = raw.metadata || {};
  const obj = raw.involvedObject || {};
  const source = raw.source || {};

  return {
    name: meta.name || "",
    namespace: meta.namespace || "",
    uid: meta.uid || "",
    type: raw.type || "Normal",
    reason: raw.reason || "",
    message: raw.message || "",
    involvedObjectKind: obj.kind || "",
    involvedObjectName: obj.name || "",
    involvedObjectNamespace: obj.namespace || "",
    involvedObjectUid: obj.uid || "",
    count: raw.count || 1,
    firstTimestamp: raw.firstTimestamp
      ? new Date(raw.firstTimestamp).toISOString()
      : "",
    lastTimestamp: raw.lastTimestamp
      ? new Date(raw.lastTimestamp).toISOString()
      : "",
    sourceComponent: source.component || "",
    sourceHost: source.host || "",
  };
}

function sortByLastTimestampDesc(events) {
  return events.sort((a, b) => {
    const ta = a.lastTimestamp || a.firstTimestamp || "";
    const tb = b.lastTimestamp || b.firstTimestamp || "";
    return tb.localeCompare(ta);
  });
}

async function writeEvents(events, context) {
  const handles = [];
  for (const ev of events) {
    const handle = await context.writeResource(
      "event",
      sanitizeInstanceName(ev.name),
      ev,
    );
    handles.push(handle);
  }
  return handles;
}

// --- Model ---

export const model = {
  type: "@john/event",
  version: "2026.02.27.1",
  globalArguments: K8sGlobalArgsSchema,
  resources: {
    event: {
      description:
        "Kubernetes event with type, reason, message, involved object, count, and timestamps",
      schema: EventSchema,
      lifetime: "1h",
      garbageCollection: 10,
    },
  },
  methods: {
    list: {
      description:
        "List all events in the namespace, sorted by lastTimestamp descending",
      arguments: z.object({ namespace: z.string().optional() }),
      execute: async (args, context) => {
        const { coreApi } = buildClient(context.globalArgs);
        const ns = args.namespace ?? context.globalArgs.namespace;

        const resp = await coreApi.listNamespacedEvent({ namespace: ns });
        const events = (resp.items || []).map(normalizeEvent);
        const sorted = sortByLastTimestampDesc(events);

        context.logger.info("Found {count} events in {ns}", {
          count: sorted.length,
          ns,
        });

        const handles = await writeEvents(sorted, context);
        return { dataHandles: handles };
      },
    },

    getForPod: {
      description:
        "Get events for a specific pod, sorted by lastTimestamp descending",
      arguments: z.object({
        podName: z.string(),
        namespace: z.string().optional(),
      }),
      execute: async (args, context) => {
        const { coreApi } = buildClient(context.globalArgs);
        const ns = args.namespace ?? context.globalArgs.namespace;

        const resp = await coreApi.listNamespacedEvent({
          namespace: ns,
          fieldSelector:
            `involvedObject.name=${args.podName},involvedObject.kind=Pod`,
        });
        const events = (resp.items || []).map(normalizeEvent);
        const sorted = sortByLastTimestampDesc(events);

        context.logger.info("Found {count} events for pod {pod}", {
          count: sorted.length,
          pod: args.podName,
        });

        const handles = await writeEvents(sorted, context);
        return { dataHandles: handles };
      },
    },

    getForDeployment: {
      description:
        "Get events for a specific deployment, sorted by lastTimestamp descending",
      arguments: z.object({
        deploymentName: z.string(),
        namespace: z.string().optional(),
      }),
      execute: async (args, context) => {
        const { coreApi } = buildClient(context.globalArgs);
        const ns = args.namespace ?? context.globalArgs.namespace;

        const resp = await coreApi.listNamespacedEvent({
          namespace: ns,
          fieldSelector:
            `involvedObject.name=${args.deploymentName},involvedObject.kind=Deployment`,
        });
        const events = (resp.items || []).map(normalizeEvent);
        const sorted = sortByLastTimestampDesc(events);

        context.logger.info("Found {count} events for deployment {dep}", {
          count: sorted.length,
          dep: args.deploymentName,
        });

        const handles = await writeEvents(sorted, context);
        return { dataHandles: handles };
      },
    },

    getForService: {
      description:
        "Get events for a specific service, sorted by lastTimestamp descending",
      arguments: z.object({
        serviceName: z.string(),
        namespace: z.string().optional(),
      }),
      execute: async (args, context) => {
        const { coreApi } = buildClient(context.globalArgs);
        const ns = args.namespace ?? context.globalArgs.namespace;

        const resp = await coreApi.listNamespacedEvent({
          namespace: ns,
          fieldSelector:
            `involvedObject.name=${args.serviceName},involvedObject.kind=Service`,
        });
        const events = (resp.items || []).map(normalizeEvent);
        const sorted = sortByLastTimestampDesc(events);

        context.logger.info("Found {count} events for service {svc}", {
          count: sorted.length,
          svc: args.serviceName,
        });

        const handles = await writeEvents(sorted, context);
        return { dataHandles: handles };
      },
    },

    getWarnings: {
      description:
        "Get only Warning-type events in the namespace, sorted by lastTimestamp descending",
      arguments: z.object({ namespace: z.string().optional() }),
      execute: async (args, context) => {
        const { coreApi } = buildClient(context.globalArgs);
        const ns = args.namespace ?? context.globalArgs.namespace;

        const resp = await coreApi.listNamespacedEvent({
          namespace: ns,
          fieldSelector: "type=Warning",
        });
        const events = (resp.items || []).map(normalizeEvent);
        const sorted = sortByLastTimestampDesc(events);

        context.logger.info("Found {count} warning events in {ns}", {
          count: sorted.length,
          ns,
        });

        const handles = await writeEvents(sorted, context);
        return { dataHandles: handles };
      },
    },
  },
};
