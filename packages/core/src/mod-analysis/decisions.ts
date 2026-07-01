import type { ModDecision, ModDecisionOverride, ModDecisionValue, ModFileDescriptor } from "@mcsp/shared";
import type { JarModMetadata } from "./jar-metadata";

export interface DecideModsOptions {
  unknownPolicy?: ModDecisionValue;
  metadataByFile?: Map<ModFileDescriptor, JarModMetadata>;
  overrides?: ModDecisionOverride[];
}

export function decideMods(files: ModFileDescriptor[], options: DecideModsOptions = {}): ModDecision[] {
  const unknownPolicy = options.unknownPolicy ?? "manual-review";
  const overrideIndex = buildOverrideIndex(options.overrides ?? []);
  return files.map((file) => {
    const override = findOverride(file, overrideIndex);
    if (override) {
      return {
        fileName: file.fileName,
        decision: override.decision,
        reason: override.reason?.trim() || `用户复核：${override.decision === "include" ? "保留" : "排除"}`,
        source: "user-rule"
      };
    }
    return decideMod(file, unknownPolicy, options.metadataByFile?.get(file));
  });
}

export function decideMod(
  file: ModFileDescriptor,
  unknownPolicy: ModDecisionValue = "manual-review",
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
  index: Map<string, ModDecisionOverride>
): ModDecisionOverride | undefined {
  for (const key of decisionFileKeys(file)) {
    const override = index.get(key);
    if (override) {
      return override;
    }
  }
  return undefined;
}

function decisionFileKeys(file: ModFileDescriptor): string[] {
  return [
    ...(file.pathInPack ? [`path:${file.pathInPack}`] : []),
    ...(file.projectId && file.fileId ? [`platform:${file.source}:${file.projectId}:${file.fileId}`] : []),
    ...(file.versionId ? [`version:${file.source}:${file.versionId}`] : []),
    `file:${file.fileName}`
  ];
}

function decisionOverrideKeys(override: ModDecisionOverride): string[] {
  return [
    ...(override.pathInPack ? [`path:${override.pathInPack}`] : []),
    ...(override.source && override.projectId && override.fileId
      ? [`platform:${override.source}:${override.projectId}:${override.fileId}`]
      : []),
    ...(override.source && override.versionId ? [`version:${override.source}:${override.versionId}`] : []),
    ...(override.fileName ? [`file:${override.fileName}`] : [])
  ];
}
