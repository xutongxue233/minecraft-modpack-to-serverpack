import path from "node:path";
import type { AnalyzeResult, ModFileDescriptor } from "@mcsp/shared";

type UnknownRecord = Record<string, unknown>;
type LooseDescriptor = {
  [K in keyof ModFileDescriptor]?: ModFileDescriptor[K] | undefined;
} & Pick<ModFileDescriptor, "fileName" | "source" | "downloadUrls" | "expectedHashes">;

export interface PlatformMetadataOptions {
  fetchImpl?: typeof fetch;
  curseForgeApiKey?: string;
  onWarning?: (message: string) => void;
}

interface CurseForgeIds {
  projectId: string;
  fileId: string;
}

interface CurseForgeFileInfo {
  id: string;
  projectId?: string;
  fileName?: string;
  displayName?: string;
  downloadUrl?: string;
  hashes: Record<string, string>;
}

interface CurseForgeProjectInfo {
  id: string;
  name?: string;
  slug?: string;
  links?: {
    websiteUrl?: string;
  };
}

interface ModrinthVersionInfo {
  id?: string;
  projectId?: string;
  name?: string;
  versionNumber?: string;
  fileName?: string;
  fileUrl?: string;
  hashes: Record<string, string>;
}

interface ModrinthProjectInfo {
  id: string;
  title?: string;
  slug?: string;
  clientSide?: ModSide;
  serverSide?: ModSide;
}

type ModSide = "required" | "optional" | "unsupported";

const curseForgeApiBase = "https://api.curseforge.com/v1";
const modrinthApiBase = "https://api.modrinth.com/v2";

export async function enrichAnalysisWithPlatformMetadata(
  analysis: AnalyzeResult,
  options: PlatformMetadataOptions = {}
): Promise<AnalyzeResult> {
  const warnings = [...analysis.warnings];
  const addWarning = (message: string): void => {
    warnings.push(message);
    options.onWarning?.(message);
  };

  const fetchImpl = options.fetchImpl ?? fetch;
  const enrichedByFile = new Map<ModFileDescriptor, ModFileDescriptor>();

  await Promise.all([
    enrichCurseForgeFiles(analysis.files, fetchImpl, options.curseForgeApiKey ?? readCurseForgeApiKeyFromEnv(), addWarning).then(
      (files) => {
        for (const [source, enriched] of files) {
          enrichedByFile.set(source, enriched);
        }
      }
    ),
    enrichModrinthFiles(analysis.files, fetchImpl, addWarning).then((files) => {
      for (const [source, enriched] of files) {
        enrichedByFile.set(source, enriched);
      }
    })
  ]);

  return {
    ...analysis,
    files: analysis.files.map((file) => enrichedByFile.get(file) ?? file),
    warnings
  };
}

export function readCurseForgeApiKeyFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env.CURSEFORGE_API_KEY ?? env.CF_API_KEY;
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

async function enrichCurseForgeFiles(
  files: ModFileDescriptor[],
  fetchImpl: typeof fetch,
  apiKey: string | undefined,
  addWarning: (message: string) => void
): Promise<Array<[ModFileDescriptor, ModFileDescriptor]>> {
  const curseForgeFiles = files
    .filter((file) => file.source === "curseforge")
    .map((file) => ({ file, ids: getCurseForgeIds(file) }))
    .filter((entry): entry is { file: ModFileDescriptor; ids: CurseForgeIds } => entry.ids !== null);

  if (curseForgeFiles.length === 0) {
    return [];
  }

  if (!apiKey) {
    addWarning("CurseForge 文件需要 API Key 才能补全名称和下载地址。请设置 CURSEFORGE_API_KEY 或 CF_API_KEY。");
    return [];
  }

  try {
    const uniqueFileIds = unique(curseForgeFiles.map((entry) => entry.ids.fileId));
    const uniqueProjectIds = unique(curseForgeFiles.map((entry) => entry.ids.projectId));
    const [fileInfos, projectInfos] = await Promise.all([
      fetchCurseForgeFiles(fetchImpl, apiKey, uniqueFileIds),
      fetchCurseForgeProjects(fetchImpl, apiKey, uniqueProjectIds)
    ]);

    const fileInfoById = new Map(fileInfos.map((info) => [info.id, info]));
    const projectInfoById = new Map(projectInfos.map((info) => [info.id, info]));
    const result: Array<[ModFileDescriptor, ModFileDescriptor]> = [];

    for (const entry of curseForgeFiles) {
      const fileInfo = fileInfoById.get(entry.ids.fileId);
      const projectInfo = projectInfoById.get(entry.ids.projectId);
      if (!fileInfo) {
        addWarning(`CurseForge 未返回文件 ${entry.ids.projectId}:${entry.ids.fileId} 的元数据，已保留清单占位。`);
        continue;
      }

      const apiFileName = fileInfo.fileName ?? fileInfo.displayName ?? entry.file.fileName;
      const outputFileName = path.basename(apiFileName);
      const downloadUrls = mergeUnique([
        ...curseForgeDownloadCandidates({
          downloadUrl: fileInfo.downloadUrl,
          fileId: fileInfo.id,
          fileName: outputFileName
        }),
        ...entry.file.downloadUrls
      ]);

      result.push([
        entry.file,
        pruneFileDescriptor({
          ...entry.file,
          id: `${entry.ids.projectId}:${entry.ids.fileId}`,
          projectId: entry.ids.projectId,
          fileId: entry.ids.fileId,
          name: projectInfo?.name ?? fileInfo.displayName ?? entry.file.name,
          slug: projectInfo?.slug ?? entry.file.slug,
          fileName: outputFileName,
          downloadUrls: withModMirrorCandidates(downloadUrls),
          expectedHashes: { ...fileInfo.hashes, ...entry.file.expectedHashes },
          metadataSource: "curseforge-api",
          pageUrl: projectInfo?.links?.websiteUrl ?? entry.file.pageUrl
        })
      ]);
    }

    return result;
  } catch (error) {
    addWarning(`CurseForge 元数据补全失败：${formatError(error)}。`);
    return [];
  }
}

async function enrichModrinthFiles(
  files: ModFileDescriptor[],
  fetchImpl: typeof fetch,
  addWarning: (message: string) => void
): Promise<Array<[ModFileDescriptor, ModFileDescriptor]>> {
  const modrinthFiles = files.filter((file) => file.source === "modrinth");
  const hashEntries = modrinthFiles
    .map((file) => ({ file, sha1: findHash(file.expectedHashes, "sha1") }))
    .filter((entry): entry is { file: ModFileDescriptor; sha1: string } => Boolean(entry.sha1));

  if (hashEntries.length === 0) {
    return [];
  }

  try {
    const versionsByHash = await fetchModrinthVersionsBySha1(
      fetchImpl,
      unique(hashEntries.map((entry) => entry.sha1))
    );
    const projectIds = unique(
      Array.from(versionsByHash.values()).flatMap((version) => (version.projectId ? [version.projectId] : []))
    );
    const projects = projectIds.length > 0 ? await fetchModrinthProjects(fetchImpl, projectIds) : [];
    const projectInfoById = new Map(projects.map((project) => [project.id, project]));
    const result: Array<[ModFileDescriptor, ModFileDescriptor]> = [];

    for (const entry of hashEntries) {
      const version = versionsByHash.get(entry.sha1);
      if (!version) {
        continue;
      }

      const project = version.projectId ? projectInfoById.get(version.projectId) : undefined;
      const platformEnv = modrinthProjectEnv(project);
      result.push([
        entry.file,
        pruneFileDescriptor({
          ...entry.file,
          id: version.projectId ?? entry.file.id,
          projectId: version.projectId ?? entry.file.projectId,
          versionId: version.id ?? entry.file.versionId,
          slug: project?.slug ?? entry.file.slug,
          name: project?.title ?? version.name ?? entry.file.name,
          fileName: path.basename(version.fileName ?? entry.file.fileName),
          downloadUrls: withModMirrorCandidates(
            mergeUnique([...(version.fileUrl ? [version.fileUrl] : []), ...entry.file.downloadUrls])
          ),
          expectedHashes: { ...version.hashes, ...entry.file.expectedHashes },
          metadataSource: "modrinth-api",
          pageUrl: project?.slug ? `https://modrinth.com/mod/${project.slug}` : entry.file.pageUrl,
          envSource: entry.file.env?.server ? entry.file.envSource : platformEnv?.server ? "platform-api" : entry.file.envSource,
          env: mergeEnv(entry.file.env, platformEnv)
        })
      ]);
    }

    return result;
  } catch (error) {
    addWarning(`Modrinth 元数据补全失败：${formatError(error)}。`);
    return [];
  }
}

async function fetchCurseForgeFiles(
  fetchImpl: typeof fetch,
  apiKey: string,
  fileIds: string[]
): Promise<CurseForgeFileInfo[]> {
  if (fileIds.length === 0) {
    return [];
  }

  const json = await fetchJson(fetchImpl, `${curseForgeApiBase}/mods/files`, {
    method: "POST",
    headers: curseForgeHeaders(apiKey),
    body: JSON.stringify({ fileIds: fileIds.map(Number) })
  });
  return asArray(asRecord(json).data).map(parseCurseForgeFileInfo).filter((value): value is CurseForgeFileInfo => value !== null);
}

async function fetchCurseForgeProjects(
  fetchImpl: typeof fetch,
  apiKey: string,
  projectIds: string[]
): Promise<CurseForgeProjectInfo[]> {
  if (projectIds.length === 0) {
    return [];
  }

  const json = await fetchJson(fetchImpl, `${curseForgeApiBase}/mods`, {
    method: "POST",
    headers: curseForgeHeaders(apiKey),
    body: JSON.stringify({ modIds: projectIds.map(Number) })
  });
  return asArray(asRecord(json).data)
    .map(parseCurseForgeProjectInfo)
    .filter((value): value is CurseForgeProjectInfo => value !== null);
}

async function fetchModrinthVersionsBySha1(
  fetchImpl: typeof fetch,
  hashes: string[]
): Promise<Map<string, ModrinthVersionInfo>> {
  const result = new Map<string, ModrinthVersionInfo>();
  if (hashes.length === 0) {
    return result;
  }

  const json = await fetchJson(fetchImpl, `${modrinthApiBase}/version_files`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ hashes, algorithm: "sha1" })
  });

  for (const [sha1, value] of Object.entries(asRecord(json))) {
    const version = parseModrinthVersionInfo(value, sha1);
    if (version) {
      result.set(sha1.toLowerCase(), version);
    }
  }

  return result;
}

async function fetchModrinthProjects(fetchImpl: typeof fetch, projectIds: string[]): Promise<ModrinthProjectInfo[]> {
  if (projectIds.length === 0) {
    return [];
  }

  const ids = encodeURIComponent(JSON.stringify(projectIds));
  const json = await fetchJson(fetchImpl, `${modrinthApiBase}/projects?ids=${ids}`, {
    headers: defaultHeaders()
  });
  return asArray(json).map(parseModrinthProjectInfo).filter((value): value is ModrinthProjectInfo => value !== null);
}

async function fetchJson(fetchImpl: typeof fetch, url: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetchImpl(url, {
    ...init,
    headers: {
      ...defaultHeaders(),
      ...headersToRecord(init.headers)
    }
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status}${detail ? `: ${detail.slice(0, 180)}` : ""}`);
  }

  return JSON.parse(await response.text());
}

function parseCurseForgeFileInfo(value: unknown): CurseForgeFileInfo | null {
  const record = asRecord(value);
  const id = numberToString(record.id);
  if (!id) {
    return null;
  }

  return {
    id,
    ...optionalProp("projectId", numberToString(record.modId)),
    ...optionalProp("fileName", asString(record.fileName)),
    ...optionalProp("displayName", asString(record.displayName)),
    ...optionalProp("downloadUrl", asString(record.downloadUrl)),
    hashes: parseCurseForgeHashes(record.hashes)
  };
}

function parseCurseForgeProjectInfo(value: unknown): CurseForgeProjectInfo | null {
  const record = asRecord(value);
  const id = numberToString(record.id);
  if (!id) {
    return null;
  }

  return {
    id,
    ...optionalProp("name", asString(record.name)),
    ...optionalProp("slug", asString(record.slug)),
    links: {
      ...optionalProp("websiteUrl", asString(asRecord(record.links).websiteUrl))
    }
  };
}

function parseModrinthVersionInfo(value: unknown, sha1: string): ModrinthVersionInfo | null {
  const record = asRecord(value);
  const files = asArray(record.files).map(asRecord);
  const matchedFile = files.find((file) => normalizeHash(asString(asRecord(file.hashes).sha1)) === normalizeHash(sha1)) ?? files[0];
  const hashes = Object.fromEntries(
    Object.entries(asRecord(matchedFile?.hashes)).flatMap(([algorithm, hash]) =>
      typeof hash === "string" ? [[algorithm, hash]] : []
    )
  );

  return {
    ...optionalProp("id", asString(record.id)),
    ...optionalProp("projectId", asString(record.project_id)),
    ...optionalProp("name", asString(record.name)),
    ...optionalProp("versionNumber", asString(record.version_number)),
    ...optionalProp("fileName", asString(matchedFile?.filename)),
    ...optionalProp("fileUrl", asString(matchedFile?.url)),
    hashes
  };
}

function parseModrinthProjectInfo(value: unknown): ModrinthProjectInfo | null {
  const record = asRecord(value);
  const id = asString(record.id);
  if (!id) {
    return null;
  }

  return {
    id,
    ...optionalProp("title", asString(record.title)),
    ...optionalProp("slug", asString(record.slug)),
    ...optionalProp("clientSide", normalizeSide(asString(record.client_side))),
    ...optionalProp("serverSide", normalizeSide(asString(record.server_side)))
  };
}

function parseCurseForgeHashes(value: unknown): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const entry of asArray(value).map(asRecord)) {
    const algorithm = curseForgeHashAlgorithm(entry.algo);
    const hash = asString(entry.value);
    if (algorithm && hash) {
      hashes[algorithm] = hash;
    }
  }
  return hashes;
}

function curseForgeHashAlgorithm(value: unknown): "sha1" | "md5" | undefined {
  if (value === 1) {
    return "sha1";
  }
  if (value === 2) {
    return "md5";
  }
  return undefined;
}

function curseForgeDownloadCandidates(input: {
  downloadUrl?: string | undefined;
  fileId?: string | undefined;
  fileName?: string | undefined;
}): string[] {
  const candidates: string[] = [];
  if (input.downloadUrl) {
    candidates.push(
      input.downloadUrl
        .replace("-service.overwolf.wtf", ".forgecdn.net")
        .replace("://edge.", "://mediafilez.")
        .replace("://media.", "://mediafilez."),
      input.downloadUrl.replace("://edge.", "://mediafilez.").replace("://media.", "://mediafilez."),
      input.downloadUrl.replace("-service.overwolf.wtf", ".forgecdn.net"),
      input.downloadUrl.replace("://media.", "://edge."),
      input.downloadUrl
    );
  }

  candidates.push(...curseForgeCdnFallbackCandidates(input.fileId, input.fileName));
  return mergeUnique(candidates);
}

function withModMirrorCandidates(urls: string[]): string[] {
  const officialUrls = mergeUnique(urls);
  const mirrorUrls = officialUrls
    .map(modMirrorCandidate)
    .filter((url): url is string => typeof url === "string");
  return mergeUnique([...mirrorUrls, ...officialUrls]);
}

function modMirrorCandidate(url: string): string | undefined {
  const mapped = url
    .replace("api.modrinth.com", "mod.mcimirror.top/modrinth")
    .replace("staging-api.modrinth.com", "mod.mcimirror.top/modrinth")
    .replace("cdn.modrinth.com", "mod.mcimirror.top")
    .replace("api.curseforge.com", "mod.mcimirror.top/curseforge")
    .replace("edge.forgecdn.net", "mod.mcimirror.top")
    .replace("mediafilez.forgecdn.net", "mod.mcimirror.top")
    .replace("media.forgecdn.net", "mod.mcimirror.top");
  return mapped === url ? undefined : mapped;
}

function curseForgeCdnFallbackCandidates(fileId: string | undefined, fileName: string | undefined): string[] {
  const numericFileId = Number(fileId);
  if (!fileName || !Number.isSafeInteger(numericFileId) || numericFileId <= 0) {
    return [];
  }

  const directory = Math.floor(numericFileId / 1000);
  const tail = String(numericFileId % 1000).padStart(3, "0");
  const encodedFileName = encodeURIComponent(path.basename(fileName));
  const filePath = `files/${directory}/${tail}/${encodedFileName}`;
  return [
    `https://mediafilez.forgecdn.net/${filePath}`,
    `https://edge.forgecdn.net/${filePath}`,
    `https://media.forgecdn.net/${filePath}`
  ];
}

function getCurseForgeIds(file: ModFileDescriptor): CurseForgeIds | null {
  if (file.projectId && file.fileId) {
    return { projectId: file.projectId, fileId: file.fileId };
  }

  const [projectId, fileId] = file.id?.split(":") ?? [];
  if (!projectId || !fileId) {
    return null;
  }

  return { projectId, fileId };
}

function modrinthProjectEnv(project: ModrinthProjectInfo | undefined): ModFileDescriptor["env"] | undefined {
  if (!project?.clientSide && !project?.serverSide) {
    return undefined;
  }

  return {
    ...optionalProp("client", project.clientSide),
    ...optionalProp("server", project.serverSide)
  };
}

function mergeEnv(
  manifestEnv: ModFileDescriptor["env"] | undefined,
  platformEnv: ModFileDescriptor["env"] | undefined
): ModFileDescriptor["env"] | undefined {
  if (!manifestEnv && !platformEnv) {
    return undefined;
  }

  return {
    ...platformEnv,
    ...manifestEnv
  };
}

function findHash(hashes: Record<string, string>, algorithm: string): string | undefined {
  const target = algorithm.toLowerCase().replaceAll("-", "");
  for (const [key, value] of Object.entries(hashes)) {
    if (key.toLowerCase().replaceAll("-", "") === target) {
      return value.toLowerCase();
    }
  }
  return undefined;
}

function normalizeSide(value: string | undefined): ModSide | undefined {
  if (value === "required" || value === "optional" || value === "unsupported") {
    return value;
  }
  return undefined;
}

function normalizeHash(value: string | undefined): string | undefined {
  return value?.trim().toLowerCase();
}

function curseForgeHeaders(apiKey: string): Record<string, string> {
  return {
    ...jsonHeaders(),
    "x-api-key": apiKey
  };
}

function jsonHeaders(): Record<string, string> {
  return {
    ...defaultHeaders(),
    "content-type": "application/json"
  };
}

function defaultHeaders(): Record<string, string> {
  return {
    accept: "application/json",
    "user-agent": "MinecraftServerpackTool/0.1.0"
  };
}

function headersToRecord(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) {
    return {};
  }
  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }
  return headers;
}

function mergeUnique(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.trim().length > 0)));
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function pruneFileDescriptor(file: LooseDescriptor): ModFileDescriptor {
  return Object.fromEntries(Object.entries(file).filter(([, value]) => value !== undefined)) as unknown as ModFileDescriptor;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  return trimmed ? trimmed : undefined;
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
