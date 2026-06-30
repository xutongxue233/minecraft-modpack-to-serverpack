import type { ModDecision, ModDecisionValue, ModFileDescriptor } from "@mcsp/shared";
import type { JarModMetadata } from "./jar-metadata";

export interface DecideModsOptions {
  unknownPolicy?: ModDecisionValue;
  metadataByFile?: Map<ModFileDescriptor, JarModMetadata>;
}

export function decideMods(files: ModFileDescriptor[], options: DecideModsOptions = {}): ModDecision[] {
  const unknownPolicy = options.unknownPolicy ?? "manual-review";
  return files.map((file) => decideMod(file, unknownPolicy, options.metadataByFile?.get(file)));
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
