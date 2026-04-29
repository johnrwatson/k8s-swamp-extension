import { z } from "npm:zod@4";
import {
  buildClient,
  K8sGlobalArgsSchema,
  normalizeMeta,
  sanitizeInstanceName,
} from "./_helpers.ts";

// --- Schemas ---

const PvcSchema = z.object({
  name: z.string(),
  namespace: z.string(),
  uid: z.string(),
  phase: z.string(),
  storageClassName: z.string(),
  volumeName: z.string(),
  requestedStorage: z.string(),
  capacityStorage: z.string(),
  accessModes: z.array(z.string()),
  volumeMode: z.string(),
  labels: z.record(z.string(), z.string()),
  annotations: z.record(z.string(), z.string()),
  createdAt: z.string(),
}).passthrough();

const PvSchema = z.object({
  name: z.string(),
  uid: z.string(),
  phase: z.string(),
  storageClassName: z.string(),
  capacity: z.string(),
  accessModes: z.array(z.string()),
  reclaimPolicy: z.string(),
  volumeMode: z.string(),
  claimRef: z.string(),
  source: z.string(),
  createdAt: z.string(),
}).passthrough();

// --- Helpers ---

function normalizePvc(raw) {
  const meta = normalizeMeta(raw);
  const spec = raw.spec || {};
  const status = raw.status || {};
  const resources = spec.resources || {};
  const requests = resources.requests || {};

  return {
    ...meta,
    phase: status.phase || "Pending",
    storageClassName: spec.storageClassName || "",
    volumeName: spec.volumeName || "",
    requestedStorage: requests.storage || "",
    capacityStorage: (status.capacity || {}).storage || "",
    accessModes: spec.accessModes || [],
    volumeMode: spec.volumeMode || "Filesystem",
  };
}

function normalizePv(raw) {
  const meta = normalizeMeta(raw);
  const spec = raw.spec || {};
  const status = raw.status || {};
  const capacity = spec.capacity || {};
  const claimRef = spec.claimRef || {};

  // Determine volume source type
  let source = "unknown";
  if (spec.hostPath) source = `hostPath:${spec.hostPath.path}`;
  else if (spec.nfs) source = `nfs:${spec.nfs.server}:${spec.nfs.path}`;
  else if (spec.csi) source = `csi:${spec.csi.driver}`;
  else if (spec.local) source = `local:${spec.local.path}`;
  else if (spec.awsElasticBlockStore) {
    source = `ebs:${spec.awsElasticBlockStore.volumeID}`;
  } else if (spec.gcePersistentDisk) {
    source = `gce-pd:${spec.gcePersistentDisk.pdName}`;
  }

  return {
    name: meta.name,
    uid: meta.uid,
    phase: status.phase || "Available",
    storageClassName: spec.storageClassName || "",
    capacity: capacity.storage || "",
    accessModes: spec.accessModes || [],
    reclaimPolicy: spec.persistentVolumeReclaimPolicy || "Retain",
    volumeMode: spec.volumeMode || "Filesystem",
    claimRef: claimRef.name ? `${claimRef.namespace}/${claimRef.name}` : "",
    source,
    labels: meta.labels,
    annotations: meta.annotations,
    createdAt: meta.createdAt,
  };
}

// --- Model ---

export const model = {
  type: "@john/pvc",
  version: "2026.02.27.1",
  globalArguments: K8sGlobalArgsSchema,
  resources: {
    pvc: {
      description:
        "PersistentVolumeClaim with phase, storage class, capacity, access modes, and bound volume",
      schema: PvcSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    pv: {
      description:
        "PersistentVolume with phase, capacity, reclaim policy, and volume source",
      schema: PvSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    list: {
      description:
        "List all PersistentVolumeClaims in the namespace with binding status, storage class, and capacity",
      arguments: z.object({ namespace: z.string().optional() }),
      execute: async (args, context) => {
        const { coreApi } = buildClient(context.globalArgs);
        const ns = args.namespace ?? context.globalArgs.namespace;
        const labels = context.globalArgs.labels;

        const resp = await coreApi.listNamespacedPersistentVolumeClaim({
          namespace: ns,
          labelSelector: labels,
        });
        const pvcs = resp.items || [];

        context.logger.info("Found {count} PVCs in {ns}", {
          count: pvcs.length,
          ns,
        });

        const handles = [];
        for (const pvc of pvcs) {
          const normalized = normalizePvc(pvc);
          const handle = await context.writeResource(
            "pvc",
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
        "Get a PVC's binding status, storage class, requested vs actual capacity, and access modes",
      arguments: z.object({
        pvcName: z.string(),
        namespace: z.string().optional(),
      }),
      execute: async (args, context) => {
        const { coreApi } = buildClient(context.globalArgs);
        const ns = args.namespace ?? context.globalArgs.namespace;

        const pvc = await coreApi.readNamespacedPersistentVolumeClaim({
          name: args.pvcName,
          namespace: ns,
        });
        const normalized = normalizePvc(pvc);

        const handle = await context.writeResource(
          "pvc",
          sanitizeInstanceName(normalized.name),
          normalized,
        );
        return { dataHandles: [handle] };
      },
    },

    create: {
      description:
        "Create a PVC with storage class, access mode, and requested capacity",
      arguments: z.object({
        pvcName: z.string(),
        storageClassName: z.string(),
        storage: z.string(),
        accessModes: z.array(z.string()).default(["ReadWriteOnce"]),
        namespace: z.string().optional(),
      }),
      execute: async (args, context) => {
        const { coreApi } = buildClient(context.globalArgs);
        const ns = args.namespace ?? context.globalArgs.namespace;

        const body = {
          metadata: { name: args.pvcName, namespace: ns },
          spec: {
            storageClassName: args.storageClassName,
            accessModes: args.accessModes,
            resources: { requests: { storage: args.storage } },
          },
        };

        const created = await coreApi.createNamespacedPersistentVolumeClaim({
          namespace: ns,
          body,
        });
        const normalized = normalizePvc(created);

        context.logger.info("Created PVC {name} in {ns}", {
          name: args.pvcName,
          ns,
        });

        const handle = await context.writeResource(
          "pvc",
          sanitizeInstanceName(normalized.name),
          normalized,
        );
        return { dataHandles: [handle] };
      },
    },

    delete: {
      description: "Delete a PersistentVolumeClaim",
      arguments: z.object({
        pvcName: z.string(),
        namespace: z.string().optional(),
      }),
      execute: async (args, context) => {
        const { coreApi } = buildClient(context.globalArgs);
        const ns = args.namespace ?? context.globalArgs.namespace;

        await coreApi.deleteNamespacedPersistentVolumeClaim({
          name: args.pvcName,
          namespace: ns,
        });

        context.logger.info("Deleted PVC {name} in {ns}", {
          name: args.pvcName,
          ns,
        });
        return { dataHandles: [] };
      },
    },

    listVolumes: {
      description:
        "List all PersistentVolumes in the cluster with phase, capacity, reclaim policy, and source",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { coreApi } = buildClient(context.globalArgs);

        const resp = await coreApi.listPersistentVolume();
        const pvs = resp.items || [];

        context.logger.info("Found {count} PersistentVolumes", {
          count: pvs.length,
        });

        const handles = [];
        for (const pv of pvs) {
          const normalized = normalizePv(pv);
          const handle = await context.writeResource(
            "pv",
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
