import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";
import { appError } from "@mcsp/shared";
import { assertSafeArchiveEntry, resolveInsideRoot } from "../security/paths";

export interface ArchiveLimits {
  maxFileCount: number;
  maxExpandedSizeBytes: number;
  maxSingleFileBytes: number;
}

export interface ZipEntryInfo {
  fileName: string;
  uncompressedSize: number;
  compressedSize: number;
  directory: boolean;
}

export interface ExtractZipOptions {
  prefixes?: string[];
  stripPrefix?: string;
  limits?: Partial<ArchiveLimits>;
  shouldExtract?: (relativePath: string, entryName: string) => boolean;
  onFile?: (file: ExtractedZipFile) => void;
}

export interface ExtractedZipFile {
  entryName: string;
  outputPath: string;
  sizeBytes: number;
}

const defaultLimits: ArchiveLimits = {
  maxFileCount: 20_000,
  maxExpandedSizeBytes: 4 * 1024 * 1024 * 1024,
  maxSingleFileBytes: 512 * 1024 * 1024
};

export async function listZipEntries(zipPath: string, limits: Partial<ArchiveLimits> = {}): Promise<ZipEntryInfo[]> {
  const mergedLimits = { ...defaultLimits, ...limits };

  return withZip(zipPath, async (zipFile) => {
    const entries: ZipEntryInfo[] = [];
    let totalExpandedSize = 0;

    while (true) {
      const entry = await readNextEntry(zipFile);
      if (!entry) {
        break;
      }

      const fileName = assertSafeArchiveEntry(entry.fileName);
      const directory = fileName.endsWith("/");

      if (!directory) {
        totalExpandedSize += entry.uncompressedSize;
      }

      if (entries.length + 1 > mergedLimits.maxFileCount) {
        throw appError("E_ARCHIVE_LIMIT_EXCEEDED", "压缩包文件数量超过限制。", {
          detail: { limit: mergedLimits.maxFileCount },
          suggestion: "请检查整合包是否异常膨胀。"
        });
      }

      if (entry.uncompressedSize > mergedLimits.maxSingleFileBytes) {
        throw appError("E_ARCHIVE_LIMIT_EXCEEDED", "压缩包内单个文件超过限制。", {
          detail: { fileName, limit: mergedLimits.maxSingleFileBytes },
          suggestion: "请检查整合包是否包含异常大文件。"
        });
      }

      if (totalExpandedSize > mergedLimits.maxExpandedSizeBytes) {
        throw appError("E_ARCHIVE_LIMIT_EXCEEDED", "压缩包展开后总大小超过限制。", {
          detail: { limit: mergedLimits.maxExpandedSizeBytes },
          suggestion: "请调高安全限制或检查整合包来源。"
        });
      }

      entries.push({
        fileName,
        uncompressedSize: entry.uncompressedSize,
        compressedSize: entry.compressedSize,
        directory
      });
    }

    return entries;
  });
}

export async function readZipText(zipPath: string, entryName: string): Promise<string | null> {
  const requested = assertSafeArchiveEntry(entryName);

  return withZip(zipPath, async (zipFile) => {
    while (true) {
      const entry = await readNextEntry(zipFile);
      if (!entry) {
        return null;
      }

      const fileName = assertSafeArchiveEntry(entry.fileName);
      if (fileName !== requested) {
        continue;
      }

      const chunks = await readEntryChunks(zipFile, entry);
      return Buffer.concat(chunks).toString("utf8");
    }
  });
}

export async function extractZipEntries(
  zipPath: string,
  targetRoot: string,
  options: ExtractZipOptions = {}
): Promise<ExtractedZipFile[]> {
  const mergedLimits = { ...defaultLimits, ...options.limits };
  const prefixes = options.prefixes?.map(normalizePrefix);
  const stripPrefix = options.stripPrefix ? normalizePrefix(options.stripPrefix) : undefined;
  const extractedFiles: ExtractedZipFile[] = [];
  let scannedFileCount = 0;
  let totalExpandedSize = 0;

  await fs.mkdir(targetRoot, { recursive: true });

  return withZip(zipPath, async (zipFile) => {
    while (true) {
      const entry = await readNextEntry(zipFile);
      if (!entry) {
        break;
      }

      const fileName = assertSafeArchiveEntry(entry.fileName);
      const directory = fileName.endsWith("/");
      assertExtractableEntry(entry, fileName);

      if (!directory) {
        scannedFileCount += 1;
        totalExpandedSize += entry.uncompressedSize;
      }

      assertArchiveLimits(fileName, {
        fileCount: scannedFileCount,
        totalExpandedSize,
        singleFileSize: entry.uncompressedSize,
        directory,
        limits: mergedLimits
      });

      if (prefixes && !prefixes.some((prefix) => isWithinPrefix(fileName, prefix))) {
        continue;
      }

      const outputRelativePath = stripPrefix && isWithinPrefix(fileName, stripPrefix) ? fileName.slice(stripPrefix.length) : fileName;
      if (!outputRelativePath) {
        continue;
      }

      if (options.shouldExtract && !options.shouldExtract(outputRelativePath, fileName)) {
        continue;
      }

      const outputPath = resolveInsideRoot(targetRoot, outputRelativePath);
      if (directory) {
        await fs.mkdir(outputPath, { recursive: true });
        continue;
      }

      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      const stream = await openEntryReadStream(zipFile, entry);
      await pipeline(stream, createWriteStream(outputPath, { flags: "w" }));

      const extracted = {
        entryName: fileName,
        outputPath,
        sizeBytes: entry.uncompressedSize
      };
      extractedFiles.push(extracted);
      options.onFile?.(extracted);
    }

    return extractedFiles;
  });
}

async function withZip<T>(zipPath: string, action: (zipFile: yauzl.ZipFile) => Promise<T>): Promise<T> {
  const zipFile = await openZip(zipPath);
  try {
    return await action(zipFile);
  } finally {
    zipFile.close();
  }
}

function openZip(zipPath: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: false }, (error, zipFile) => {
      if (error) {
        reject(
          appError("E_INPUT_FORMAT", "无法读取压缩包。", {
            detail: error.message,
            suggestion: "请确认文件是有效的 zip 或 mrpack。"
          })
        );
        return;
      }

      if (!zipFile) {
        reject(appError("E_INPUT_FORMAT", "压缩包为空或无法打开。"));
        return;
      }

      resolve(zipFile);
    });
  });
}

function readNextEntry(zipFile: yauzl.ZipFile): Promise<yauzl.Entry | null> {
  return new Promise((resolve, reject) => {
    const onEntry = (entry: yauzl.Entry): void => {
      cleanup();
      resolve(entry);
    };

    const onEnd = (): void => {
      cleanup();
      resolve(null);
    };

    const onError = (error: Error): void => {
      cleanup();
      reject(
        appError("E_INPUT_FORMAT", "读取压缩包条目失败。", {
          detail: error.message
        })
      );
    };

    const cleanup = (): void => {
      zipFile.off("entry", onEntry);
      zipFile.off("end", onEnd);
      zipFile.off("error", onError);
    };

    zipFile.once("entry", onEntry);
    zipFile.once("end", onEnd);
    zipFile.once("error", onError);
    zipFile.readEntry();
  });
}

function readEntryChunks(zipFile: yauzl.ZipFile, entry: yauzl.Entry): Promise<Buffer[]> {
  return new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error) {
        reject(appError("E_INPUT_FORMAT", "读取压缩包文件失败。", { detail: error.message }));
        return;
      }

      if (!stream) {
        reject(appError("E_INPUT_FORMAT", "压缩包文件流为空。"));
        return;
      }

      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("error", (streamError) => {
        reject(appError("E_INPUT_FORMAT", "读取压缩包文件流失败。", { detail: streamError.message }));
      });
      stream.on("end", () => resolve(chunks));
    });
  });
}

function openEntryReadStream(zipFile: yauzl.ZipFile, entry: yauzl.Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error) {
        reject(appError("E_INPUT_FORMAT", "读取压缩包文件失败。", { detail: error.message }));
        return;
      }

      if (!stream) {
        reject(appError("E_INPUT_FORMAT", "压缩包文件流为空。"));
        return;
      }

      resolve(stream);
    });
  });
}

function assertArchiveLimits(
  fileName: string,
  state: {
    fileCount: number;
    totalExpandedSize: number;
    singleFileSize: number;
    directory: boolean;
    limits: ArchiveLimits;
  }
): void {
  if (state.fileCount > state.limits.maxFileCount) {
    throw appError("E_ARCHIVE_LIMIT_EXCEEDED", "压缩包文件数量超过限制。", {
      detail: { limit: state.limits.maxFileCount },
      suggestion: "请检查整合包是否异常膨胀。"
    });
  }

  if (!state.directory && state.singleFileSize > state.limits.maxSingleFileBytes) {
    throw appError("E_ARCHIVE_LIMIT_EXCEEDED", "压缩包内单个文件超过限制。", {
      detail: { fileName, limit: state.limits.maxSingleFileBytes },
      suggestion: "请检查整合包是否包含异常大文件。"
    });
  }

  if (state.totalExpandedSize > state.limits.maxExpandedSizeBytes) {
    throw appError("E_ARCHIVE_LIMIT_EXCEEDED", "压缩包展开后总大小超过限制。", {
      detail: { limit: state.limits.maxExpandedSizeBytes },
      suggestion: "请调高安全限制或检查整合包来源。"
    });
  }
}

function assertExtractableEntry(entry: yauzl.Entry, fileName: string): void {
  const unixMode = (entry.externalFileAttributes >>> 16) & 0o170000;
  if (unixMode === 0o120000) {
    throw appError("E_ARCHIVE_UNSAFE_PATH", "压缩包包含符号链接，已拒绝解压。", {
      detail: fileName,
      suggestion: "请检查整合包来源，或手动移除符号链接后重试。"
    });
  }
}

function normalizePrefix(prefix: string): string {
  const normalized = assertSafeArchiveEntry(prefix);
  return normalized.endsWith("/") ? normalized : `${normalized}/`;
}

function isWithinPrefix(fileName: string, prefix: string): boolean {
  return fileName === prefix || fileName.startsWith(prefix);
}
