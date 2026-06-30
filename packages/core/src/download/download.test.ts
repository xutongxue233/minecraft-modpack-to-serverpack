import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ModFileDescriptor } from "@mcsp/shared";
import { calculateFileHash, downloadFileToCache, validateDownloadUrl, verifyFileHash } from "./download";

describe("download safety", () => {
  it("accepts HTTPS URLs and rejects unsafe protocols by default", () => {
    expect(validateDownloadUrl("https://example.invalid/mod.jar")).toBe("https://example.invalid/mod.jar");
    expect(() => validateDownloadUrl("http://example.invalid/mod.jar")).toThrow();
    expect(() => validateDownloadUrl("ftp://example.invalid/mod.jar")).toThrow();
    expect(() => validateDownloadUrl("https://token@example.invalid/mod.jar")).toThrow();
  });
});

describe("hash verification", () => {
  it("calculates and verifies sha1, sha256 and sha512 hashes", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcsp-hash-"));
    const filePath = path.join(dir, "example.jar");
    await fs.writeFile(filePath, "hello", "utf8");

    expect(await calculateFileHash(filePath, "sha1")).toBe(hash("sha1", "hello"));
    await expect(verifyFileHash(filePath, { sha1: hash("sha1", "hello") })).resolves.toMatchObject({
      algorithm: "sha1"
    });
    await expect(verifyFileHash(filePath, { sha256: hash("sha256", "hello") })).resolves.toMatchObject({
      algorithm: "sha256"
    });
    await expect(verifyFileHash(filePath, { sha512: hash("sha512", "hello") })).resolves.toMatchObject({
      algorithm: "sha512"
    });
  });

  it("fails when the expected hash does not match the file", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcsp-hash-mismatch-"));
    const filePath = path.join(dir, "example.jar");
    await fs.writeFile(filePath, "hello", "utf8");

    await expect(verifyFileHash(filePath, { sha1: hash("sha1", "other") })).rejects.toMatchObject({
      code: "E_DOWNLOAD_HASH_MISMATCH"
    });
  });
});

describe("downloadFileToCache", () => {
  it("downloads a file, verifies the declared hash and reuses cache on the next call", async () => {
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcsp-download-cache-"));
    const payload = "downloaded jar bytes";
    const descriptor = modFile({
      downloadUrls: ["https://example.invalid/mod.jar"],
      expectedHashes: { sha1: hash("sha1", payload) }
    });
    let fetchCount = 0;
    const fetchImpl: typeof fetch = async () => {
      fetchCount += 1;
      return new Response(payload, {
        headers: { "content-length": String(Buffer.byteLength(payload)) }
      });
    };

    const first = await downloadFileToCache(descriptor, { cacheDir, fetchImpl });
    const second = await downloadFileToCache(descriptor, { cacheDir, fetchImpl });

    expect(first.fromCache).toBe(false);
    expect(second.fromCache).toBe(true);
    expect(first.cachePath).toBe(second.cachePath);
    expect(fetchCount).toBe(1);
    await expect(fs.readFile(first.cachePath, "utf8")).resolves.toBe(payload);
  });

  it("removes a failed temporary download when hash verification fails", async () => {
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcsp-download-fail-"));
    const descriptor = modFile({
      downloadUrls: ["https://example.invalid/mod.jar"],
      expectedHashes: { sha1: hash("sha1", "expected") }
    });
    const fetchImpl: typeof fetch = async () => new Response("actual");

    await expect(downloadFileToCache(descriptor, { cacheDir, fetchImpl, retry: 0 })).rejects.toMatchObject({
      code: "E_DOWNLOAD_HASH_MISMATCH"
    });

    const files = await listFiles(cacheDir);
    expect(files).toEqual([]);
  });
});

function modFile(overrides: Partial<ModFileDescriptor> = {}): ModFileDescriptor {
  return {
    fileName: "example.jar",
    source: "modrinth",
    downloadUrls: [],
    expectedHashes: {},
    ...overrides
  };
}

function hash(algorithm: "sha1" | "sha256" | "sha512", value: string): string {
  return createHash(algorithm).update(value).digest("hex");
}

async function listFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  async function walk(current: string): Promise<void> {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
      } else {
        result.push(path.relative(root, entryPath).replaceAll("\\", "/"));
      }
    }
  }
  await walk(root);
  return result.sort();
}
