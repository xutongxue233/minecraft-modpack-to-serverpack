import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import yazl from "yazl";
import { listZipEntries } from "./archive/zip";
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
      "overrides/config/example.toml": "enabled = false",
      "server-overrides/config/example.toml": "enabled = true",
      "overrides/options.txt": "gamma:1.0",
      "overrides/mods/local-client.jar": "not reviewed",
      "client-overrides/config/client-only.toml": "client = true"
    });

    const result = await runConversion(
      {
        inputPath,
        outputDir,
        settings: {
          cacheDir,
          unknownPolicy: "manual-review",
          outputZip: true
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
    expect(result.report.serverpack).toMatchObject({
      writtenModFiles: 1,
      skippedModFiles: 1,
      mergedOverrideFiles: 2,
      coreInstall: {
        enabled: false,
        status: "skipped"
      },
      core: {
        type: "fabric",
        minecraftVersion: "1.20.1",
        loaderVersion: "0.15.11",
        javaMajor: 17
      }
    });
    await expect(fs.readFile(path.join(result.outputDir, "mods", "server.jar"))).resolves.toEqual(payload);
    await expect(fs.readFile(path.join(result.outputDir, "config", "example.toml"), "utf8")).resolves.toBe(
      "enabled = true"
    );
    await expect(fs.access(path.join(result.outputDir, "options.txt"))).rejects.toThrow();
    await expect(fs.access(path.join(result.outputDir, "mods", "local-client.jar"))).rejects.toThrow();
    await expect(fs.access(path.join(result.outputDir, "install-server.ps1"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(result.outputDir, "install-server.bat"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(result.outputDir, "start.ps1"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(result.outputDir, "start.bat"))).resolves.toBeUndefined();
    await expect(fs.readFile(path.join(result.outputDir, "eula.txt"), "utf8")).resolves.toContain("eula=false");
    await expect(fs.readFile(path.join(result.outputDir, "server-core.json"), "utf8")).resolves.toContain(
      '"type": "fabric"'
    );
    expect(result.zipPath).toBe(`${result.outputDir}.zip`);
    await expect(fs.access(result.zipPath!)).resolves.toBeUndefined();
    await expect(listZipEntries(result.zipPath!)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fileName: "mods/server.jar" }),
        expect.objectContaining({ fileName: "install-server.ps1" }),
        expect.objectContaining({ fileName: "start.bat" }),
        expect.objectContaining({ fileName: "conversion-report.json" })
      ])
    );
    await expect(fs.readFile(result.reportPath, "utf8")).resolves.toContain('"schemaVersion": 1');
    await expect(fs.readFile(result.reportPath, "utf8")).resolves.toContain('"serverpack"');
    await expect(fs.readFile(result.reportPath, "utf8")).resolves.toContain('"zipPath"');
    await expect(fs.readFile(result.readmePath, "utf8")).resolves.toContain("Minecraft: 1.20.1");
    await expect(fs.readFile(result.readmePath, "utf8")).resolves.toContain("install-server.ps1");
    await expect(fs.readFile(path.join(result.outputDir, "install-server.ps1"), "utf8")).resolves.toContain(
      "Resolve-JavaCommand"
    );
    const startPowerShell = await fs.readFile(path.join(result.outputDir, "start.ps1"), "utf8");
    expect(startPowerShell).toContain("$LaunchArgs");
    expect(startPowerShell).not.toContain('& $JavaCmd "@user_jvm_args.txt"');
    await expect(fs.readFile(path.join(result.outputDir, "start.bat"), "utf8")).resolves.toContain("JAVA_HOME");
    await expect(fs.readFile(path.join(result.outputDir, "start.sh"), "utf8")).resolves.toContain("JAVA_CMD");
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
    await expect(fs.access(path.join(result.outputDir, "mods", "missing.jar"))).rejects.toThrow();
    await expect(fs.access(path.join(result.outputDir, "start.ps1"))).resolves.toBeUndefined();
    await expect(fs.readFile(result.reportPath, "utf8")).resolves.toContain('"downloadStatus": "failed"');
  });

  it("uses manual review decisions when writing the serverpack", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcsp-convert-user-decision-"));
    const inputPath = path.join(dir, "pack.mrpack");
    const outputDir = path.join(dir, "out");
    const payload = await createJarBuffer({
      "META-INF/mods.toml": 'modLoader="javafml"\n[[mods]]\nmodId="reviewed"\ndisplayName="Reviewed Mod"\n'
    });

    await writeZip(inputPath, {
      "modrinth.index.json": JSON.stringify({
        formatVersion: 1,
        name: "Reviewed Pack",
        dependencies: {
          minecraft: "1.20.1",
          fabric: "0.15.11"
        },
        files: [
          {
            path: "mods/reviewed.jar",
            hashes: { sha1: hash("sha1", payload) },
            downloads: ["https://example.invalid/reviewed.jar"]
          }
        ]
      })
    });

    const result = await runConversion(
      {
        inputPath,
        outputDir,
        settings: {
          unknownPolicy: "manual-review",
          modDecisions: [
            {
              fileName: "reviewed.jar",
              pathInPack: "mods/reviewed.jar",
              source: "modrinth",
              decision: "include",
              reason: "用户复核：测试保留"
            }
          ]
        }
      },
      {
        fetchImpl: async () => new Response(payload)
      }
    );

    expect(result.report.summary).toMatchObject({
      includedFiles: 1,
      manualReviewFiles: 0
    });
    expect(result.report.files[0]).toMatchObject({
      fileName: "reviewed.jar",
      decision: "include",
      decisionReason: "用户复核：测试保留",
      decisionSource: "user-rule"
    });
    await expect(fs.readFile(path.join(result.outputDir, "mods", "reviewed.jar"))).resolves.toEqual(payload);
  });

  it("uses a user rule file when writing the serverpack", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcsp-convert-rule-file-"));
    const inputPath = path.join(dir, "pack.mrpack");
    const outputDir = path.join(dir, "out");
    const rulesPath = path.join(dir, "rules.json");
    const payload = await createJarBuffer({
      "META-INF/mods.toml": 'modLoader="javafml"\n[[mods]]\nmodId="ruled"\ndisplayName="Ruled Mod"\n'
    });

    await writeZip(inputPath, {
      "modrinth.index.json": JSON.stringify({
        formatVersion: 1,
        name: "Rule File Pack",
        dependencies: {
          minecraft: "1.20.1",
          forge: "47.4.10"
        },
        files: [
          {
            path: "mods/ruled.jar",
            hashes: { sha1: hash("sha1", payload) },
            downloads: ["https://example.invalid/ruled.jar"]
          }
        ]
      })
    });
    await fs.writeFile(
      rulesPath,
      JSON.stringify({
        include: [
          {
            pathInPack: "mods/ruled.jar",
            reason: "规则文件：服务端需要"
          }
        ]
      }),
      "utf8"
    );

    const result = await runConversion(
      {
        inputPath,
        outputDir,
        settings: {
          unknownPolicy: "manual-review",
          modRulesPath: rulesPath
        }
      },
      {
        fetchImpl: async () => new Response(payload)
      }
    );

    expect(result.report.summary).toMatchObject({
      includedFiles: 1,
      manualReviewFiles: 0
    });
    expect(result.report.files[0]).toMatchObject({
      fileName: "ruled.jar",
      decision: "include",
      decisionReason: "规则文件：服务端需要",
      decisionSource: "user-rule"
    });
    await expect(fs.readFile(path.join(result.outputDir, "mods", "ruled.jar"))).resolves.toEqual(payload);
  });

  it("uses remote project rules when deciding mods", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcsp-convert-remote-rules-"));
    const inputPath = path.join(dir, "pack.zip");
    const outputDir = path.join(dir, "out");
    const remoteRulesCacheDir = path.join(dir, "rules-cache");

    await writeZip(inputPath, {
      "manifest.json": JSON.stringify({
        manifestType: "minecraftModpack",
        name: "Remote Rule Pack",
        version: "1.0.0",
        minecraft: {
          version: "1.20.1",
          modLoaders: [{ id: "forge-47.2.0", primary: true }]
        },
        files: [{ projectID: 1234, fileID: 5678 }]
      })
    });

    const result = await runConversion(
      {
        inputPath,
        outputDir,
        settings: {
          remoteRulesEnabled: true,
          remoteRulesUrl: "https://example.invalid/client-mod-rules.json",
          remoteRulesCacheDir
        }
      },
      {
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              rules: [
                {
                  id: "client-cf-project",
                  side: "client",
                  match: {
                    curseforgeProjectIds: ["1234"]
                  }
                }
              ]
            })
          )
      }
    );

    expect(result.report.summary).toMatchObject({
      excludedFiles: 1,
      manualReviewFiles: 0
    });
    expect(result.report.files[0]).toMatchObject({
      fileName: "5678.jar",
      decision: "exclude",
      decisionSource: "remote-rule"
    });
  });

  it("can download a vanilla server core directly into the serverpack", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcsp-convert-core-"));
    const inputPath = path.join(dir, "vanilla.mrpack");
    const outputDir = path.join(dir, "out");
    const serverJar = Buffer.from("server-jar");
    const progressGroups: string[] = [];
    const logMessages: string[] = [];

    await writeZip(inputPath, {
      "modrinth.index.json": JSON.stringify({
        formatVersion: 1,
        name: "Vanilla Pack",
        dependencies: {
          minecraft: "1.20.1"
        },
        files: []
      })
    });

    const result = await runConversion(
      {
        inputPath,
        outputDir,
        settings: {
          downloadServerCore: true,
          testStartScript: true
        }
      },
      {
        fetchImpl: async (input) => {
          const url = String(input);
          if (url.endsWith("version_manifest_v2.json")) {
            return new Response(
              JSON.stringify({
                versions: [{ id: "1.20.1", url: "https://example.invalid/1.20.1.json" }]
              })
            );
          }
          if (url.endsWith("1.20.1.json")) {
            return new Response(
              JSON.stringify({
                downloads: {
                  server: {
                    url: "https://example.invalid/server.jar"
                  }
                }
              })
            );
          }
          if (url.endsWith("server.jar")) {
            return new Response(serverJar, {
              headers: {
                "content-length": String(serverJar.length)
              }
            });
          }
          return new Response("not found", { status: 404 });
        },
        onEvent: (event) => {
          if (event.type === "progress" && event.group) {
            progressGroups.push(event.group);
          }
          if (event.type === "log") {
            logMessages.push(event.message);
          }
        },
        startupTestRunner: async ({ onLog }) => {
          onLog?.("info", "fake startup script reached EULA check");
          return {
            enabled: true,
            status: "passed",
            exitCode: 1,
            reason: "启动脚本测试通过：服务端已运行到 EULA 检查。"
          };
        }
      }
    );

    await expect(fs.readFile(path.join(result.outputDir, "server.jar"))).resolves.toEqual(serverJar);
    expect(result.report.serverpack.coreInstall).toMatchObject({
      enabled: true,
      status: "installed",
      files: ["server.jar"]
    });
    expect(result.report.serverpack.startupTest).toMatchObject({
      enabled: true,
      status: "passed",
      exitCode: 1
    });
    const startPowerShell = await fs.readFile(path.join(result.outputDir, "start.ps1"), "utf8");
    expect(startPowerShell).toContain('$LaunchArgs = @("@user_jvm_args.txt", "-jar", $Jar, "nogui")');
    expect(startPowerShell).toContain("& $JavaCmd @LaunchArgs");
    await expect(fs.readFile(result.readmePath, "utf8")).resolves.toContain("服务端核心已准备完成");
    expect(progressGroups).toContain("core");
    expect(logMessages).toContain("fake startup script reached EULA check");
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
