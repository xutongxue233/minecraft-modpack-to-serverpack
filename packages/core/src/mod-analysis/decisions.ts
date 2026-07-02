import type { ModDecision, ModDecisionOverride, ModDecisionValue, ModFileDescriptor } from "@mcsp/shared";
import type { JarModMetadata } from "./jar-metadata";

export interface DecideModsOptions {
  unknownPolicy?: ModDecisionValue;
  metadataByFile?: Map<ModFileDescriptor, JarModMetadata>;
  overrides?: ModDecisionOverride[];
}

export function decideMods(files: ModFileDescriptor[], options: DecideModsOptions = {}): ModDecision[] {
  const unknownPolicy = options.unknownPolicy ?? "include";
  const overrideIndex = buildOverrideIndex(options.overrides ?? []);
  const decisions = files.map((file) => {
    const jarMetadata = options.metadataByFile?.get(file);
    const override = findOverride(file, jarMetadata, overrideIndex);
    if (override) {
      return {
        fileName: file.fileName,
        decision: override.decision,
        reason: override.reason?.trim() || `规则：${override.decision === "include" ? "保留" : "排除"}`,
        source: override.decisionSource ?? "user-rule"
      };
    }
    return decideMod(file, unknownPolicy, jarMetadata);
  });

  return applyDependencyExclusions(files, decisions, options.metadataByFile);
}

export function decideMod(
  file: ModFileDescriptor,
  unknownPolicy: ModDecisionValue = "include",
  jarMetadata?: JarModMetadata
): ModDecision {
  if (file.env?.server === "unsupported") {
    const source = file.envSource === "platform-api" ? "platform-api" : "manifest";
    return {
      fileName: file.fileName,
      decision: "exclude",
      reason: `${source === "platform-api" ? "platform api" : "manifest"} env.server=unsupported`,
      source
    };
  }

  if (file.env?.server === "required" || file.env?.server === "optional") {
    const source = file.envSource === "platform-api" ? "platform-api" : "manifest";
    return {
      fileName: file.fileName,
      decision: "include",
      reason: `${source === "platform-api" ? "platform api" : "manifest"} env.server=${file.env.server}`,
      source
    };
  }

  if (jarMetadata?.env?.server === "unsupported") {
    return {
      fileName: file.fileName,
      decision: "exclude",
      reason: `${jarMetadata.source} env.server=unsupported`,
      source: "jar-metadata"
    };
  }

  if (jarMetadata?.env?.server === "required" || jarMetadata?.env?.server === "optional") {
    return {
      fileName: file.fileName,
      decision: "include",
      reason: `${jarMetadata.source} env.server=${jarMetadata.env.server}`,
      source: "jar-metadata"
    };
  }

  return {
    fileName: file.fileName,
    decision: unknownPolicy,
    reason: "缺少明确服务端环境声明",
    source: "unknown"
  };
}

function buildOverrideIndex(overrides: ModDecisionOverride[]): Map<string, ModDecisionOverride> {
  const index = new Map<string, ModDecisionOverride>();
  for (const override of overrides) {
    for (const key of decisionOverrideKeys(override)) {
      index.set(key, override);
    }
  }
  return index;
}

function findOverride(
  file: ModFileDescriptor,
  jarMetadata: JarModMetadata | undefined,
  index: Map<string, ModDecisionOverride>
): ModDecisionOverride | undefined {
  for (const key of decisionFileKeys(file, jarMetadata)) {
    const override = index.get(key);
    if (override) {
      return override;
    }
  }
  return undefined;
}

function decisionFileKeys(file: ModFileDescriptor, jarMetadata?: JarModMetadata): string[] {
  return [
    ...(file.pathInPack ? [`path:${file.pathInPack}`] : []),
    ...(file.projectId && file.fileId ? [`platform:${file.source}:${file.projectId}:${file.fileId}`] : []),
    ...(file.projectId ? [`project:${file.source}:${file.projectId}`] : []),
    ...(file.versionId ? [`version:${file.source}:${file.versionId}`] : []),
    ...(jarMetadata?.modId ? [`modid:${normalizeRuleValue(jarMetadata.modId)}`] : []),
    ...(file.slug ? [`slug:${file.source}:${normalizeRuleValue(file.slug)}`, `slug:${normalizeRuleValue(file.slug)}`] : []),
    `file:${file.fileName}`
  ];
}

function decisionOverrideKeys(override: ModDecisionOverride): string[] {
  return [
    ...(override.pathInPack ? [`path:${override.pathInPack}`] : []),
    ...(override.source && override.projectId && override.fileId
      ? [`platform:${override.source}:${override.projectId}:${override.fileId}`]
      : []),
    ...(override.source && override.projectId ? [`project:${override.source}:${override.projectId}`] : []),
    ...(override.source && override.versionId ? [`version:${override.source}:${override.versionId}`] : []),
    ...(override.modId ? [`modid:${normalizeRuleValue(override.modId)}`] : []),
    ...(override.slug
      ? [
          ...(override.source ? [`slug:${override.source}:${normalizeRuleValue(override.slug)}`] : []),
          `slug:${normalizeRuleValue(override.slug)}`
        ]
      : []),
    ...(override.fileName ? [`file:${override.fileName}`] : [])
  ];
}

function applyDependencyExclusions(
  files: ModFileDescriptor[],
  decisions: ModDecision[],
  metadataByFile: Map<ModFileDescriptor, JarModMetadata> | undefined
): ModDecision[] {
  if (!metadataByFile) {
    return decisions;
  }

  const nextDecisions = decisions.map((decision) => ({ ...decision }));
  const runtimeDependencyIds = new Set([
    "java",
    "minecraft",
    "forge",
    "neoforge",
    "fabric",
    "fabricloader",
    "quilt_loader",
    "quilted_fabric_loader"
  ]);
  let changed = true;

  while (changed) {
    changed = false;
    const includedModIds = new Set<string>();
    const knownModIds = new Set<string>();
    const excludedByModId = new Map<string, ModDecision>();

    for (const [index, file] of files.entries()) {
      const modId = normalizeDependencyModId(metadataByFile.get(file)?.modId);
      if (!modId) {
        continue;
      }
      knownModIds.add(modId);
      const decision = nextDecisions[index];
      if (decision?.decision === "include") {
        includedModIds.add(modId);
      } else if (decision) {
        excludedByModId.set(modId, decision);
      }
    }

    for (const [index, file] of files.entries()) {
      const decision = nextDecisions[index];
      if (decision?.decision !== "include") {
        continue;
      }

      const jarMetadata = metadataByFile.get(file);
      const missingDependency = jarMetadata?.dependencies?.find((dependency) => {
        const dependencyModId = normalizeDependencyModId(dependency.modId);
        return (
          dependency.mandatory &&
          dependencyModId !== undefined &&
          !runtimeDependencyIds.has(dependencyModId) &&
          dependency.side !== "CLIENT" &&
          knownModIds.has(dependencyModId) &&
          !includedModIds.has(dependencyModId)
        );
      });

      if (!missingDependency) {
        continue;
      }

      const dependencyModId = normalizeDependencyModId(missingDependency.modId) ?? missingDependency.modId;
      const excludedDependency = excludedByModId.get(dependencyModId);
      nextDecisions[index] = {
        fileName: file.fileName,
        decision: "exclude",
        reason: excludedDependency
          ? `必需依赖 ${missingDependency.modId} 已被排除：${excludedDependency.reason}`
          : `必需依赖 ${missingDependency.modId} 未进入服务端`,
        source: "jar-metadata"
      };
      changed = true;
    }
  }

  return nextDecisions;
}

function normalizeDependencyModId(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized ? normalized : undefined;
}

function normalizeRuleValue(value: string): string {
  return value.trim().toLowerCase();
}
