import path from "node:path";
import { parse as parseToml } from "smol-toml";
import type { LoaderType, ModFileDescriptor } from "@mcsp/shared";
import { readZipText } from "../archive/zip";

type UnknownRecord = Record<string, unknown>;
type RawJarModMetadata = Omit<JarModMetadata, "modId" | "name" | "version" | "loader" | "env"> & {
  modId?: string | undefined;
  name?: string | undefined;
  version?: string | undefined;
  loader?: LoaderType | undefined;
  env?: ModFileDescriptor["env"] | undefined;
};

export interface JarModMetadata {
  modId?: string;
  name?: string;
  version?: string;
  loader?: LoaderType;
  env?: ModFileDescriptor["env"];
  source: "fabric.mod.json" | "quilt.mod.json" | "mods.toml" | "neoforge.mods.toml" | "mcmod.info";
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
  entries: Array<{ file: ModFileDescriptor; cachePath: string }>
): Promise<Map<ModFileDescriptor, JarModMetadata>> {
  const metadataByFile = new Map<ModFileDescriptor, JarModMetadata>();

  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.file.fileName.toLowerCase().endsWith(".jar") && !entry.cachePath.toLowerCase().endsWith(".jar")) {
        return;
      }

      const metadata = await scanJarMetadata(entry.cachePath);
      if (metadata) {
        metadataByFile.set(entry.file, metadata);
      }
    })
  );

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

  return pruneMetadata({
    modId: asString(primaryMod.modId),
    name: asString(primaryMod.displayName) ?? asString(primaryMod.modId),
    version: asString(primaryMod.version),
    loader,
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

function pruneMetadata(metadata: RawJarModMetadata): JarModMetadata {
  return {
    ...(metadata.modId === undefined ? {} : { modId: metadata.modId }),
    ...(metadata.name === undefined ? {} : { name: metadata.name }),
    ...(metadata.version === undefined ? {} : { version: metadata.version }),
    ...(metadata.loader === undefined ? {} : { loader: metadata.loader }),
    ...(metadata.env === undefined ? {} : { env: metadata.env }),
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

export function inferModNameFromFile(file: ModFileDescriptor): string {
  return file.name ?? path.basename(file.fileName, path.extname(file.fileName));
}
