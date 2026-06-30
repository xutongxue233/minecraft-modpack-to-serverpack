import fs from "node:fs/promises";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { AnalyzeResult, appError, LoaderType, ModFileDescriptor, PackMetadata } from "@mcsp/shared";
import { listZipEntries, readZipText } from "./archive/zip";

type UnknownRecord = Record<string, unknown>;

export async function analyzeInput(inputPath: string): Promise<AnalyzeResult> {
  const stat = await statInput(inputPath);

  if (stat.isDirectory()) {
    return analyzeDirectory(inputPath);
  }

  if (!stat.isFile()) {
    throw appError("E_INPUT_FORMAT", "输入不是文件或目录。", {
      suggestion: "请选择 CurseForge zip、Modrinth mrpack 或 packwiz 目录。"
    });
  }

  return analyzeZipLikeFile(inputPath);
}

async function statInput(inputPath: string) {
  try {
    return await fs.stat(inputPath);
  } catch {
    throw appError("E_INPUT_NOT_FOUND", "输入文件或目录不存在。", {
      detail: inputPath,
      suggestion: "请重新选择整合包文件或目录。"
    });
  }
}

async function analyzeZipLikeFile(inputPath: string): Promise<AnalyzeResult> {
  const entries = await listZipEntries(inputPath);
  const entryNames = new Set(entries.map((entry) => entry.fileName));

  if (entryNames.has("modrinth.index.json")) {
    const text = await readZipText(inputPath, "modrinth.index.json");
    if (!text) {
      throw appError("E_INPUT_FORMAT", "Modrinth 整合包缺少 modrinth.index.json。");
    }
    return parseModrinthIndex(text, entries.map((entry) => entry.fileName));
  }

  if (entryNames.has("manifest.json")) {
    const text = await readZipText(inputPath, "manifest.json");
    if (!text) {
      throw appError("E_INPUT_FORMAT", "CurseForge 整合包缺少 manifest.json。");
    }
    return parseCurseForgeManifest(text, entries.map((entry) => entry.fileName));
  }

  throw appError("E_INPUT_FORMAT", "无法识别整合包格式。", {
    suggestion: "MVP 支持 CurseForge zip、Modrinth mrpack 和 packwiz 目录。"
  });
}

async function analyzeDirectory(inputPath: string): Promise<AnalyzeResult> {
  const packTomlPath = path.join(inputPath, "pack.toml");
  const indexTomlPath = path.join(inputPath, "index.toml");

  if (!(await exists(packTomlPath)) || !(await exists(indexTomlPath))) {
    throw appError("E_INPUT_FORMAT", "目录不是有效的 packwiz 整合包。", {
      suggestion: "请选择包含 pack.toml 和 index.toml 的目录。"
    });
  }

  const [packText, indexText] = await Promise.all([fs.readFile(packTomlPath, "utf8"), fs.readFile(indexTomlPath, "utf8")]);
  return parsePackwiz(packText, indexText);
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function parseModrinthIndex(text: string, entryNames: string[]): AnalyzeResult {
  const index = JSON.parse(text) as UnknownRecord;
  const dependencies = asRecord(index.dependencies);
  const files = asArray(index.files);
  const metadata: PackMetadata = {
    type: "modrinth",
    name: asString(index.name) ?? "Modrinth 整合包",
    ...optionalProp("version", asString(index.versionId) ?? asString(index.version)),
    ...optionalProp("minecraftVersion", asString(dependencies.minecraft)),
    ...extractModrinthLoader(dependencies)
  };

  return {
    metadata,
    files: files.map(parseModrinthFile),
    overrides: countOverrides(entryNames),
    warnings: []
  };
}

function parseModrinthFile(file: unknown): ModFileDescriptor {
  const record = asRecord(file);
  const pathInPack = asString(record.path) ?? "unknown.jar";
  const hashes = asRecord(record.hashes);
  const env = asRecord(record.env);
  const clientEnv = typeof env.client === "string" ? normalizeEnv(env.client) : undefined;
  const serverEnv = typeof env.server === "string" ? normalizeEnv(env.server) : undefined;

  return {
    ...optionalProp("id", asString(record.project_id) ?? asString(record.projectId) ?? asString(record.id)),
    ...optionalProp("versionId", asString(record.version_id) ?? asString(record.versionId)),
    fileName: path.basename(pathInPack),
    source: "modrinth",
    downloadUrls: asArray(record.downloads).flatMap((value) => (typeof value === "string" ? [value] : [])),
    expectedHashes: Object.fromEntries(
      Object.entries(hashes).flatMap(([key, value]) => (typeof value === "string" ? [[key, value]] : []))
    ),
    pathInPack,
    metadataSource: "manifest",
    envSource: "manifest",
    env: {
      ...optionalProp("client", clientEnv),
      ...optionalProp("server", serverEnv)
    }
  };
}

function parseCurseForgeManifest(text: string, entryNames: string[]): AnalyzeResult {
  const manifest = JSON.parse(text) as UnknownRecord;
  const minecraft = asRecord(manifest.minecraft);
  const modLoaders = asArray(minecraft.modLoaders);
  const primaryLoader = modLoaders.map(asRecord).find((loader) => loader.primary === true) ?? asRecord(modLoaders[0]);
  const files = asArray(manifest.files);
  const loaderInfo = parseCurseForgeLoader(asString(primaryLoader.id));

  return {
    metadata: {
      type: "curseforge",
      name: asString(manifest.name) ?? "CurseForge 整合包",
      ...optionalProp("version", asString(manifest.version)),
      ...optionalProp("minecraftVersion", asString(minecraft.version)),
      ...loaderInfo
    },
    files: files.map((file) => {
      const record = asRecord(file);
      const projectId = numberToString(record.projectID ?? record.projectId);
      const fileId = numberToString(record.fileID ?? record.fileId);
      return {
        ...optionalProp("id", projectId && fileId ? `${projectId}:${fileId}` : undefined),
        ...optionalProp("projectId", projectId),
        ...optionalProp("fileId", fileId),
        fileName: fileId ? `${fileId}.jar` : "curseforge-file.jar",
        source: "curseforge",
        downloadUrls: [],
        expectedHashes: {},
        metadataSource: "manifest"
      };
    }),
    overrides: countOverrides(entryNames),
    warnings: []
  };
}

function parsePackwiz(packText: string, indexText: string): AnalyzeResult {
  const pack = parseToml(packText) as UnknownRecord;
  const index = parseToml(indexText) as UnknownRecord;
  const versions = asRecord(pack.versions);
  const files = asArray(index.files);
  const loader = extractPackwizLoader(versions);

  return {
    metadata: {
      type: "packwiz",
      name: asString(pack.name) ?? "packwiz 整合包",
      ...optionalProp("version", asString(pack.version)),
      ...optionalProp("minecraftVersion", asString(versions.minecraft)),
      ...loader
    },
    files: files.map((file) => {
      const record = asRecord(file);
      const filePath = asString(record.file) ?? "unknown";
      const hash = asString(record.hash);
      const hashFormat = asString(record.hash_format) ?? asString(record.hashFormat);

      return {
        fileName: path.basename(filePath),
        source: "direct",
        downloadUrls: [],
        expectedHashes: hash && hashFormat ? { [hashFormat]: hash } : {},
        pathInPack: filePath
      };
    }),
    overrides: { common: 0, server: 0, client: 0 },
    warnings: []
  };
}

function extractModrinthLoader(dependencies: UnknownRecord): Pick<PackMetadata, "loader" | "loaderVersion"> {
  for (const loader of ["fabric", "quilt", "forge", "neoforge"] as LoaderType[]) {
    const value = dependencies[loader];
    if (typeof value === "string") {
      return { loader, loaderVersion: value };
    }
  }

  return {};
}

function extractPackwizLoader(versions: UnknownRecord): Pick<PackMetadata, "loader" | "loaderVersion"> {
  for (const loader of ["fabric", "quilt", "forge", "neoforge"] as LoaderType[]) {
    const value = versions[loader];
    if (typeof value === "string") {
      return { loader, loaderVersion: value };
    }
  }

  return {};
}

function parseCurseForgeLoader(value: string | undefined): Pick<PackMetadata, "loader" | "loaderVersion"> {
  if (!value) {
    return {};
  }

  const [loaderName, ...versionParts] = value.split("-");
  const loader = normalizeLoader(loaderName);
  return {
    ...(loader ? { loader } : {}),
    ...(versionParts.length > 0 ? { loaderVersion: versionParts.join("-") } : {})
  };
}

function normalizeLoader(value: string | undefined): LoaderType | undefined {
  if (value === "forge" || value === "neoforge" || value === "fabric" || value === "quilt") {
    return value;
  }

  return undefined;
}

function normalizeEnv(value: string): "required" | "optional" | "unsupported" | undefined {
  if (value === "required" || value === "optional" || value === "unsupported") {
    return value;
  }
  return undefined;
}

function countOverrides(entryNames: string[]) {
  return {
    common: entryNames.filter((entry) => entry.startsWith("overrides/") && !entry.endsWith("/")).length,
    server: entryNames.filter((entry) => entry.startsWith("server-overrides/") && !entry.endsWith("/")).length,
    client: entryNames.filter((entry) => entry.startsWith("client-overrides/") && !entry.endsWith("/")).length
  };
}

function asRecord(value: unknown): UnknownRecord {
  return typeof value === "object" && value !== null ? (value as UnknownRecord) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberToString(value: unknown): string | undefined {
  return typeof value === "number" ? String(value) : asString(value);
}

function optionalProp<TKey extends string, TValue>(
  key: TKey,
  value: TValue | undefined
): TValue extends undefined ? Record<TKey, never> : Partial<Record<TKey, TValue>> {
  return (value === undefined ? {} : { [key]: value }) as TValue extends undefined
    ? Record<TKey, never>
    : Partial<Record<TKey, TValue>>;
}
