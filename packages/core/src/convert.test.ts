import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import yazl from "yazl";
import { runConversion } from "./convert";

describe("runConversion", () => {
  it("analyzes a Modrinth pack, downloads files and writes a conversion report", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcsp-convert-"));
    const inputPath = path.join(dir, "pack.mrpack");
    const outputDir = path.join(dir, "out");
    const cacheDir = path.join(dir, "cache");
    const payload = await createJarBuffer({
      "fabric.mod.json": JSON.stringify({
        schemaVersion: 1,
        id: "servermod",
        name: "Server Mod",
        version: "1.0.0",
        environment: "*"
      })
    });
    const events: string[] = [];

    await writeZip(inputPath, {
      "modrinth.index.json": JSON.stringify({
        formatVersion: 1,
        name: "Example Pack",
        versionId: "1.0.0",
        dependencies: {
          minecraft: "1.20.1",
          fabric: "0.15.11"
        },
        files: [
          {
            path: "mods/server.jar",
            hashes: { sha1: hash("sha1", payload) },
            downloads: ["https://example.invalid/server.jar"],
            env: { server: "required" }
          },
          {
            path: "mods/client.jar",
            hashes: { sha1: hash("sha1", "client") },
            downloads: [],
            env: { server: "unsupported" }
          }
        ]
      }),
      "overrides/config/example.toml": "enabled = true"
    });

    const result = await runConversion(
      {
        inputPath,
        outputDir,
        settings: {
          cacheDir,
          unknownPolicy: "manual-review"
        }
      },
      {
        now: () => new Date("2026-06-30T00:00:00.000Z"),
        fetchImpl: async () => new Response(payload),
        onEvent: (event) => events.push(event.type === "phase" ? event.phase : event.type)
      }
    );

    expect(result.report.generatedAt).toBe("2026-06-30T00:00:00.000Z");
    expect(result.report.summary).toMatchObject({
      totalFiles: 2,
      downloadedFiles: 1,
      missingUrlFiles: 1,
      includedFiles: 1,
      excludedFiles: 1,
      manualReviewFiles: 0
    });
    expect(result.report.files.map((file) => [file.fileName, file.downloadStatus, file.decision])).toEqual([
      ["server.jar", "downloaded", "include"],
      ["client.jar", "missing-url", "exclude"]
    ]);
    expect(result.report.files[0]).toMatchObject({
      displayName: "Server Mod",
      modId: "servermod",
      metadataSource: "fabric.mod.json"
    });
    await expect(fs.readFile(result.reportPath, "utf8")).resolves.toContain('"schemaVersion": 1');
    await expect(fs.readFile(result.readmePath, "utf8")).resolves.toContain("Minecraft: 1.20.1");
    expect(events).toContain("analyzing");
    expect(events).toContain("downloading");
    expect(events).toContain("completed");
  });

  it("writes a conversion report when one downloadable file fails", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcsp-convert-failed-download-"));
    const inputPath = path.join(dir, "pack.mrpack");
    const outputDir = path.join(dir, "out");

    await writeZip(inputPath, {
      "modrinth.index.json": JSON.stringify({
        formatVersion: 1,
        name: "Failure Tolerant Pack",
        dependencies: {
          minecraft: "1.20.1",
          fabric: "0.15.11"
        },
        files: [
          {
            path: "mods/missing.jar",
            hashes: { sha1: hash("sha1", "expected") },
            downloads: ["https://example.invalid/missing.jar"],
            env: { server: "required" }
          }
        ]
      })
    });

    const result = await runConversion(
      {
        inputPath,
        outputDir,
        settings: { downloadRetry: 0 }
      },
      {
        fetchImpl: async () => new Response("missing", { status: 404 })
      }
    );

    expect(result.report.summary).toMatchObject({
      totalFiles: 1,
      failedDownloadFiles: 1,
      includedFiles: 1
    });
    expect(result.report.files[0]).toMatchObject({
      fileName: "missing.jar",
      downloadStatus: "failed"
    });
    await expect(fs.readFile(result.reportPath, "utf8")).resolves.toContain('"downloadStatus": "failed"');
  });
});

function writeZip(filePath: string, entries: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    for (const [entryName, content] of Object.entries(entries)) {
      zip.addBuffer(Buffer.from(content, "utf8"), entryName);
    }
    zip.end();

    const output = createWriteStream(filePath);
    output.on("close", resolve);
    output.on("error", reject);
    zip.outputStream.on("error", reject);
    zip.outputStream.pipe(output);
  });
}

function createJarBuffer(entries: Record<string, string>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    const chunks: Buffer[] = [];
    for (const [entryName, content] of Object.entries(entries)) {
      zip.addBuffer(Buffer.from(content, "utf8"), entryName);
    }
    zip.end();

    zip.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.on("error", reject);
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

function hash(algorithm: "sha1", value: string | Buffer): string {
  return createHash(algorithm).update(value).digest("hex");
}
