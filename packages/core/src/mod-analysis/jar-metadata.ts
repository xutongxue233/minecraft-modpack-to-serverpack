import path from "node:path";
import { parse as parseToml } from "smol-toml";
import type { LoaderType, ModFileDescriptor } from "@mcsp/shared";
import { readZipText } from "../archive/zip";

type UnknownRecord = Record<string, unknown>;
type RawJarModMetadata = Omit<JarModMetadata, "modId" | "name" | "version" | "loader" | "env" | "dependencies"> & {
  modId?: string | undefined;
  name?: string | undefined;
  version?: string | undefined;
  loader?: LoaderType | undefined;
  env?: ModFileDescriptor["env"] | undefined;
  dependencies?: JarModDependency[] | undefined;
};

export interface JarModDependency {
  modId: string;
  mandatory: boolean;
  side?: "BOTH" | "CLIENT" | "SERVER";
  versionRange?: string;
}

export interface JarModMetadata {
  modId?: string;
  name?: string;
  version?: string;
  loader?: LoaderType;
  env?: ModFileDescriptor["env"];
  dependencies?: JarModDependency[];
  source: "fabric.mod.json" | "quilt.mod.json" | "mods.toml" | "neoforge.mods.toml" | "mcmod.info";
}

export interface ScanDownloadedJarMetadataOptions {
  onWarning?: (message: string) => void;
}

export async function scanJarMetadata(jarPath: string): Promise<JarModMetadata | null> {
  const fabric = await readZipText(jarPath, "fabric.mod.json");
  if (fabric) {
    return parseFabricModJson(fabric);
  }

  const quilt = await readZipText(jarPath, "quilt.mod.json");
  if (quilt) {
    return parseQuiltModJson(quilt);
  }

  const neoforge = await readZipText(jarPath, "META-INF/neoforge.mods.toml");
  if (neoforge) {
    return parseForgeLikeModsToml(neoforge, "neoforge");
  }

  const forge = await readZipText(jarPath, "META-INF/mods.toml");
  if (forge) {
    return parseForgeLikeModsToml(forge, "forge");
  }

  const mcmodInfo = await readZipText(jarPath, "mcmod.info");
  if (mcmodInfo) {
    return parseMcmodInfo(mcmodInfo);
  }

  return null;
}

export async function scanDownloadedJarMetadata(
  entries: Array<{ file: ModFileDescriptor; cachePath: string }>,
  options: ScanDownloadedJarMetadataOptions = {}
): Promise<Map<ModFileDescriptor, JarModMetadata>> {
  const metadataByFile = new Map<ModFileDescriptor, JarModMetadata>();
  const metadataErrors: Array<{ fileName: string; error: string }> = [];

  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.file.fileName.toLowerCase().endsWith(".jar") && !entry.cachePath.toLowerCase().endsWith(".jar")) {
        return;
      }

      try {
        const metadata = await scanJarMetadata(entry.cachePath);
        if (metadata) {
          metadataByFile.set(entry.file, metadata);
        }
      } catch (error) {
        metadataErrors.push({
          fileName: entry.file.fileName,
          error: formatError(error)
        });
      }
    })
  );

  if (metadataErrors.length > 0) {
    options.onWarning?.(formatMetadataErrorWarning(metadataErrors));
  }

  return metadataByFile;
}

function parseFabricModJson(text: string): JarModMetadata {
  const json = asRecord(JSON.parse(text));
  const environment = asString(json.environment);

  return pruneMetadata({
    modId: asString(json.id),
    name: asString(json.name) ?? asString(json.id),
    version: asString(json.version),
    loader: "fabric",
    env: environmentToEnv(environment),
    source: "fabric.mod.json"
  });
}

function parseQuiltModJson(text: string): JarModMetadata {
  const json = asRecord(JSON.parse(text));
  const loader = asRecord(json.quilt_loader);
  const metadata = asRecord(loader.metadata);
  const environment = asString(loader.environment) ?? asString(json.environment);

  return pruneMetadata({
    modId: asString(loader.id),
    name: asString(metadata.name) ?? asString(loader.id),
    version: asString(loader.version),
    loader: "quilt",
    env: environmentToEnv(environment),
    source: "quilt.mod.json"
  });
}

function parseForgeLikeModsToml(text: string, loader: "forge" | "neoforge"): JarModMetadata {
  const toml = parseToml(text) as UnknownRecord;
  const mods = asArray(toml.mods).map(asRecord);
  const primaryMod = mods[0] ?? {};
  const modId = asString(primaryMod.modId);

  return pruneMetadata({
    modId,
    name: asString(primaryMod.displayName) ?? modId,
    version: asString(primaryMod.version),
    loader,
    env: inferForgeEnvFromDependencies(toml, modId, loader),
    dependencies: parseForgeDependencies(toml, modId),
    source: loader === "neoforge" ? "neoforge.mods.toml" : "mods.toml"
  });
}

function parseMcmodInfo(text: string): JarModMetadata {
  const json = JSON.parse(text) as unknown;
  const list = Array.isArray(json) ? json : asArray(asRecord(json).modList);
  const primaryMod = asRecord(list[0]);

  return pruneMetadata({
    modId: asString(primaryMod.modid) ?? asString(primaryMod.modId),
    name: asString(primaryMod.name) ?? asString(primaryMod.modid),
    version: asString(primaryMod.version),
    loader: "forge",
    source: "mcmod.info"
  });
}

function environmentToEnv(environment: string | undefined): ModFileDescriptor["env"] | undefined {
  if (environment === "client") {
    return { client: "required", server: "unsupported" };
  }

  if (environment === "server") {
    return { client: "unsupported", server: "required" };
  }

  if (environment === "*" || environment === undefined) {
    return { client: "required", server: "required" };
  }

  return undefined;
}

function inferForgeEnvFromDependencies(
  toml: UnknownRecord,
  modId: string | undefined,
  loader: "forge" | "neoforge"
): ModFileDescriptor["env"] | undefined {
  if (!modId) {
    return undefined;
  }

  const dependencies = asRecord(toml.dependencies);
  const modDependencies = asArray(dependencies[modId]).map(asRecord);
  const runtimeDependencyIds = new Set(["minecraft", loader]);
  const runtimeSides = modDependencies
    .filter((dependency) => runtimeDependencyIds.has(asString(dependency.modId)?.toLowerCase() ?? ""))
    .map((dependency) => asString(dependency.side)?.toUpperCase());

  if (runtimeSides.includes("CLIENT")) {
    return { client: "required", server: "unsupported" };
  }

  if (runtimeSides.includes("SERVER")) {
    return { client: "unsupported", server: "required" };
  }

  return undefined;
}

function parseForgeDependencies(toml: UnknownRecord, modId: string | undefined): JarModDependency[] | undefined {
  if (!modId) {
    return undefined;
  }

  const dependencies = asRecord(toml.dependencies);
  const modDependencies = asArray(dependencies[modId]).map(asRecord);
  const parsedDependencies = modDependencies.flatMap((dependency) => {
    const dependencyModId = asString(dependency.modId);
    if (!dependencyModId) {
      return [];
    }

    return [
      {
        modId: dependencyModId,
        mandatory: dependency.mandatory === true,
        ...optionalProp("side", normalizeForgeDependencySide(asString(dependency.side))),
        ...optionalProp("versionRange", asString(dependency.versionRange))
      }
    ];
  });

  return parsedDependencies.length > 0 ? parsedDependencies : undefined;
}

function normalizeForgeDependencySide(value: string | undefined): JarModDependency["side"] | undefined {
  const upper = value?.toUpperCase();
  if (upper === "BOTH" || upper === "CLIENT" || upper === "SERVER") {
    return upper;
  }
  return undefined;
}

function pruneMetadata(metadata: RawJarModMetadata): JarModMetadata {
  return {
    ...(metadata.modId === undefined ? {} : { modId: metadata.modId }),
    ...(metadata.name === undefined ? {} : { name: metadata.name }),
    ...(metadata.version === undefined ? {} : { version: metadata.version }),
    ...(metadata.loader === undefined ? {} : { loader: metadata.loader }),
    ...(metadata.env === undefined ? {} : { env: metadata.env }),
    ...(metadata.dependencies === undefined ? {} : { dependencies: metadata.dependencies }),
    source: metadata.source
  };
}

function asRecord(value: unknown): UnknownRecord {
  return typeof value === "object" && value !== null ? (value as UnknownRecord) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed !== "${file.jarVersion}" ? trimmed : undefined;
}

function optionalProp<TKey extends string, TValue>(
  key: TKey,
  value: TValue | undefined
): TValue extends undefined ? Record<TKey, never> : Partial<Record<TKey, TValue>> {
  return (value === undefined ? {} : { [key]: value }) as TValue extends undefined
    ? Record<TKey, never>
    : Partial<Record<TKey, TValue>>;
}

export function inferModNameFromFile(file: ModFileDescriptor): string {
  return file.name ?? path.basename(file.fileName, path.extname(file.fileName));
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatMetadataErrorWarning(errors: Array<{ fileName: string; error: string }>): string {
  const samples = errors
    .slice(0, 3)
    .map((entry) => `${entry.fileName}（${entry.error}）`)
    .join("；");
  const suffix = errors.length > 3 ? " 等" : "";
  return `${errors.length} 个 Mod 的 JAR 元数据无法解析，已跳过元数据读取；这通常是旧版 Forge mcmod.info 非标准 JSON，不影响 Mod 文件复制。示例：${samples}${suffix}。`;
}
