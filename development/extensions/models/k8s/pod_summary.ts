import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({
  sourceName: z.string().default("cluster-pods"),
});

const SummarySchema = z.object({
  totalPods: z.number(),
  podsByPhase: z.record(z.string(), z.number()),
  podsByNode: z.record(z.string(), z.number()),
  totalRestarts: z.number(),
  highRestartPods: z.array(z.string()),
  healthyPods: z.number(),
  unhealthyPods: z.number(),
  namespaces: z.array(z.string()),
  collectedAt: z.string(),
}).passthrough();

export const model = {
  type: "@john/pod-summary",
  version: "2026.02.26.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    summary: {
      description:
        "Aggregated pod counts by phase, node, restart totals, high-restart pods, and healthy/unhealthy breakdown",
      schema: SummarySchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
  },
  methods: {
    summarize: {
      description:
        "Read pod resources from a @john/pod instance and compute counts by phase, node, restart totals, and healthy/unhealthy breakdown",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const sourceName = context.globalArgs.sourceName;

        // Use definitionRepository to resolve the source model by name
        const result = await context.definitionRepository.findByNameGlobal(
          sourceName,
        );
        if (!result) {
          throw new Error(
            `Could not find model instance named '${sourceName}'`,
          );
        }

        const sourceType = result.type;
        const sourceId = result.definition.id;

        context.logger.info("Resolved {source} → {type} ({id})", {
          source: sourceName,
          type: sourceType.toString(),
          id: sourceId,
        });

        // Use dataRepository with the real ModelType object
        const allData = await context.dataRepository.findAllForModel(
          sourceType,
          sourceId,
        );

        // Filter to only pod spec resources
        const podEntries = allData.filter((d) =>
          d.tags?.specName === "pod" && d.tags?.type === "resource"
        );

        context.logger.info("Found {count} pod resources from {source}", {
          count: podEntries.length,
          source: sourceName,
        });

        // Read content for each pod entry
        const pods = [];
        for (const entry of podEntries) {
          const content = await context.dataRepository.getContent(
            sourceType,
            sourceId,
            entry.name,
          );
          if (content) {
            pods.push(JSON.parse(new TextDecoder().decode(content)));
          }
        }

        // Compute aggregated stats
        const podsByPhase = {};
        const podsByNode = {};
        const namespacesSet = new Set();
        let totalRestarts = 0;
        const highRestartPods = [];
        let healthyPods = 0;
        let unhealthyPods = 0;

        for (const pod of pods) {
          const phase = pod.phase || "Unknown";
          podsByPhase[phase] = (podsByPhase[phase] || 0) + 1;

          const node = pod.nodeName || "unscheduled";
          podsByNode[node] = (podsByNode[node] || 0) + 1;

          if (pod.namespace) namespacesSet.add(pod.namespace);

          const restarts = pod.restartCount || 0;
          totalRestarts += restarts;
          if (restarts > 5) highRestartPods.push(pod.name);

          if (phase === "Running" || phase === "Succeeded") {
            healthyPods++;
          } else {
            unhealthyPods++;
          }
        }

        const summary = {
          totalPods: pods.length,
          podsByPhase,
          podsByNode,
          totalRestarts,
          highRestartPods,
          healthyPods,
          unhealthyPods,
          namespaces: Array.from(namespacesSet),
          collectedAt: new Date().toISOString(),
        };

        const handle = await context.writeResource(
          "summary",
          "latest",
          summary,
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
