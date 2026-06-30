import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";
import { appError, isAppError, type ModFileDescriptor } from "@mcsp/shared";

export const supportedHashAlgorithms = ["sha512", "sha256", "sha1", "md5"] as const;

export type SupportedHashAlgorithm = (typeof supportedHashAlgorithms)[number];

export interface HashVerification {
  algorithm: SupportedHashAlgorithm;
  expected: string;
  actual: string;
}

export type DownloadProgressEvent =
  | { type: "cache-hit"; fileName: string; cachePath: string }
  | { type: "file-start"; fileName: string; url: string }
  | { type: "file-progress"; fileName: string; receivedBytes: number; totalBytes?: number }
  | { type: "file-complete"; fileName: string; cachePath: string; sizeBytes: number }
  | { type: "retry"; fileName: string; url: string; attempt: number; maxAttempts: number; error: string };

export interface DownloadOptions {
  cacheDir: string;
  concurrent?: number;
  retry?: number;
  timeoutSeconds?: number;
  allowInsecureHttp?: boolean;
  fetchImpl?: typeof fetch;
  onProgress?: (event: DownloadProgressEvent) => void;
}

export interface DownloadResult {
  file: ModFileDescriptor;
  cachePath: string;
  sizeBytes: number;
  fromCache: boolean;
  url?: string;
  hash?: HashVerification;
}

const defaultDownloadOptions = {
  concurrent: 4,
  retry: 3,
  timeoutSeconds: 60,
  allowInsecureHttp: false
};

export async function downloadFilesToCache(
  files: ModFileDescriptor[],
  options: DownloadOptions
): Promise<DownloadResult[]> {
  const concurrent = Math.max(1, Math.min(options.concurrent ?? defaultDownloadOptions.concurrent, 16));
  const results = new Array<DownloadResult>(files.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < files.length) {
      const index = nextIndex;
      nextIndex += 1;
      const file = files[index];
      if (!file) {
        continue;
      }
      results[index] = await downloadFileToCache(file, options);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrent, files.length) }, () => worker()));
  return results;
}

export async function downloadFileToCache(file: ModFileDescriptor, options: DownloadOptions): Promise<DownloadResult> {
  if (file.downloadUrls.length === 0) {
    throw appError("E_DOWNLOAD_FAILED", "文件没有可用下载地址。", {
      detail: { fileName: file.fileName, source: file.source },
      suggestion: "请检查整合包清单，或为 CurseForge 文件配置 API key 后再转换。"
    });
  }

  const expectedCachePath = cachePathForExpectedHash(options.cacheDir, file);
  if (expectedCachePath) {
    const cacheHit = await readVerifiedCacheHit(expectedCachePath, file);
    if (cacheHit) {
      options.onProgress?.({ type: "cache-hit", fileName: file.fileName, cachePath: expectedCachePath });
      return {
        file,
        cachePath: expectedCachePath,
        sizeBytes: cacheHit.sizeBytes,
        fromCache: true,
        ...(cacheHit.hash === undefined ? {} : { hash: cacheHit.hash })
      };
    }
  }

  let lastError: unknown;
  for (const rawUrl of file.downloadUrls) {
    const url = validateDownloadUrl(rawUrl, options.allowInsecureHttp ?? defaultDownloadOptions.allowInsecureHttp);
    const maxAttempts = (options.retry ?? defaultDownloadOptions.retry) + 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await downloadUrlToCache(file, url, options);
      } catch (error) {
        lastError = error;
        if (attempt < maxAttempts) {
          options.onProgress?.({
            type: "retry",
            fileName: file.fileName,
            url,
            attempt,
            maxAttempts,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
    }
  }

  if (isAppError(lastError)) {
    throw lastError;
  }

  throw appError("E_DOWNLOAD_FAILED", "下载失败。", {
    detail: lastError,
    suggestion: "请检查网络连接、下载地址和整合包来源。"
  });
}

export function validateDownloadUrl(rawUrl: string, allowInsecureHttp = false): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw appError("E_DOWNLOAD_FAILED", "下载地址无效。", {
      detail: rawUrl,
      suggestion: "请检查整合包清单中的下载地址。"
    });
  }

  if (parsed.username || parsed.password) {
    throw appError("E_DOWNLOAD_FAILED", "下载地址不能包含用户名或密码。", {
      detail: redactUrlCredentials(parsed),
      suggestion: "请使用不含凭据的下载地址，API key 应通过配置传递。"
    });
  }

  if (parsed.protocol === "https:" || (allowInsecureHttp && parsed.protocol === "http:")) {
    return parsed.href;
  }

  throw appError("E_DOWNLOAD_FAILED", "下载地址必须使用 HTTPS。", {
    detail: rawUrl,
    suggestion: "请更换可信来源，或在高级设置中显式允许不安全 HTTP。"
  });
}

export async function verifyFileHash(
  filePath: string,
  expectedHashes: Record<string, string>
): Promise<HashVerification | undefined> {
  const selectedHash = selectExpectedHash(expectedHashes);
  if (!selectedHash) {
    if (Object.keys(expectedHashes).length > 0) {
      throw appError("E_DOWNLOAD_HASH_MISMATCH", "不支持整合包声明的哈希算法。", {
        detail: { filePath, algorithms: Object.keys(expectedHashes) },
        suggestion: "MVP 当前支持 md5、sha1、sha256 和 sha512。"
      });
    }
    return undefined;
  }

  const actual = await calculateFileHash(filePath, selectedHash.algorithm);
  if (actual !== selectedHash.expected) {
    throw appError("E_DOWNLOAD_HASH_MISMATCH", "下载文件哈希不匹配。", {
      detail: {
        filePath,
        algorithm: selectedHash.algorithm,
        expected: selectedHash.expected,
        actual
      },
      suggestion: "请重试下载；如果持续失败，请确认整合包清单和下载源是否匹配。"
    });
  }

  return {
    algorithm: selectedHash.algorithm,
    expected: selectedHash.expected,
    actual
  };
}

export async function calculateFileHash(filePath: string, algorithm: SupportedHashAlgorithm): Promise<string> {
  const hash = createHash(algorithm);
  const stream = createReadStream(filePath);

  await new Promise<void>((resolve, reject) => {
    stream.on("data", (chunk: string | Buffer) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });

  return hash.digest("hex");
}

async function downloadUrlToCache(
  file: ModFileDescriptor,
  url: string,
  options: DownloadOptions
): Promise<DownloadResult> {
  await fs.mkdir(options.cacheDir, { recursive: true });

  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeoutMs = (options.timeoutSeconds ?? defaultDownloadOptions.timeoutSeconds) * 1000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const tempPath = path.join(options.cacheDir, ".tmp", `${process.pid}-${randomUUID()}.download`);

  try {
    options.onProgress?.({ type: "file-start", fileName: file.fileName, url });
    await fs.mkdir(path.dirname(tempPath), { recursive: true });

    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) {
      throw appError("E_DOWNLOAD_FAILED", `下载失败：HTTP ${response.status}。`, {
        detail: { fileName: file.fileName, url, status: response.status },
        suggestion: "请检查网络连接或下载源状态。"
      });
    }

    const totalBytes = parseContentLength(response.headers.get("content-length"));
    const sizeBytes = await writeResponseBody(response, tempPath, (receivedBytes) => {
      options.onProgress?.({
        type: "file-progress",
        fileName: file.fileName,
        receivedBytes,
        ...(totalBytes === undefined ? {} : { totalBytes })
      });
    });
    const hash = await verifyFileHash(tempPath, file.expectedHashes);
    const finalHash = hash ?? {
      algorithm: "sha256" as const,
      expected: await calculateFileHash(tempPath, "sha256"),
      actual: await calculateFileHash(tempPath, "sha256")
    };
    const cachePath = cachePathForHash(options.cacheDir, finalHash.algorithm, finalHash.expected, file.fileName);
    await moveIntoCache(tempPath, cachePath);

    options.onProgress?.({ type: "file-complete", fileName: file.fileName, cachePath, sizeBytes });
    return {
      file,
      cachePath,
      sizeBytes,
      fromCache: false,
      url,
      ...(hash === undefined ? {} : { hash })
    };
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    if (error instanceof Error && error.name === "AbortError") {
      throw appError("E_DOWNLOAD_FAILED", "下载超时。", {
        detail: { fileName: file.fileName, url, timeoutSeconds: options.timeoutSeconds },
        suggestion: "请检查网络连接，或调高下载超时时间。"
      });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function writeResponseBody(
  response: Response,
  filePath: string,
  onProgress: (receivedBytes: number) => void
): Promise<number> {
  if (!response.body) {
    throw appError("E_DOWNLOAD_FAILED", "下载响应没有文件内容。");
  }

  const reader = response.body.getReader();
  const output = createWriteStream(filePath, { flags: "wx" });
  let receivedBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      if (!value) {
        continue;
      }

      receivedBytes += value.byteLength;
      if (!output.write(Buffer.from(value))) {
        await once(output, "drain");
      }
      onProgress(receivedBytes);
    }

    output.end();
    await once(output, "finish");
    return receivedBytes;
  } catch (error) {
    output.destroy();
    throw error;
  } finally {
    reader.releaseLock();
  }
}

async function readVerifiedCacheHit(
  cachePath: string,
  file: ModFileDescriptor
): Promise<{ sizeBytes: number; hash?: HashVerification } | null> {
  try {
    const stat = await fs.stat(cachePath);
    const hash = await verifyFileHash(cachePath, file.expectedHashes);
    return {
      sizeBytes: stat.size,
      ...(hash === undefined ? {} : { hash })
    };
  } catch (error) {
    if (isAppError(error) && error.code === "E_DOWNLOAD_HASH_MISMATCH") {
      await fs.rm(cachePath, { force: true }).catch(() => undefined);
      return null;
    }
    return null;
  }
}

function cachePathForExpectedHash(cacheDir: string, file: ModFileDescriptor): string | null {
  const expectedHash = selectExpectedHash(file.expectedHashes);
  if (!expectedHash) {
    return null;
  }
  return cachePathForHash(cacheDir, expectedHash.algorithm, expectedHash.expected, file.fileName);
}

function cachePathForHash(
  cacheDir: string,
  algorithm: SupportedHashAlgorithm,
  hash: string,
  fileName: string
): string {
  return path.join(cacheDir, algorithm, `${hash}-${sanitizeCacheFileName(fileName)}`);
}

function selectExpectedHash(
  expectedHashes: Record<string, string>
): { algorithm: SupportedHashAlgorithm; expected: string } | undefined {
  const normalizedHashes = new Map(
    Object.entries(expectedHashes).map(([algorithm, hash]) => [normalizeHashAlgorithm(algorithm), hash.toLowerCase()])
  );

  for (const algorithm of supportedHashAlgorithms) {
    const expected = normalizedHashes.get(algorithm);
    if (expected) {
      return { algorithm, expected };
    }
  }

  return undefined;
}

function normalizeHashAlgorithm(algorithm: string): string {
  return algorithm.toLowerCase().replaceAll("-", "");
}

function sanitizeCacheFileName(fileName: string): string {
  const basename = path.basename(fileName).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 120);
  return basename || "downloaded-file.jar";
}

function parseContentLength(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

async function moveIntoCache(tempPath: string, cachePath: string): Promise<void> {
  await fs.mkdir(path.dirname(cachePath), { recursive: true });

  if (await exists(cachePath)) {
    await fs.rm(tempPath, { force: true });
    return;
  }

  try {
    await fs.rename(tempPath, cachePath);
  } catch (error) {
    if (isNodeError(error) && error.code === "EXDEV") {
      await fs.copyFile(tempPath, cachePath);
      await fs.rm(tempPath, { force: true });
      return;
    }
    throw error;
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function redactUrlCredentials(url: URL): string {
  const copy = new URL(url.href);
  copy.username = "";
  copy.password = "";
  return copy.href;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
