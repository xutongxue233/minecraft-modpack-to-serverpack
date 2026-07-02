import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import yazl from "yazl";
import { scanDownloadedJarMetadata, scanJarMetadata } from "../../src/mod-analysis/jar-metadata";

describe("scanJarMetadata", () => {
  it("reads Fabric metadata and maps client environment to server unsupported", async () => {
    const jarPath = await createJar({
      "fabric.mod.json": JSON.stringify({
        schemaVersion: 1,
        id: "modmenu",
        name: "Mod Menu",
        version: "9.0.0",
        environment: "client"
      })
    });

    await expect(scanJarMetadata(jarPath)).resolves.toMatchObject({
      modId: "modmenu",
      name: "Mod Menu",
      version: "9.0.0",
      loader: "fabric",
      env: {
        client: "required",
        server: "unsupported"
      },
      source: "fabric.mod.json"
    });
  });

  it("reads Forge displayName from mods.toml", async () => {
    const jarPath = await createJar({
      "META-INF/mods.toml": [
        'modLoader = "javafml"',
        'loaderVersion = "[47,)"',
        "",
        "[[mods]]",
        'modId = "examplemod"',
        'version = "1.2.3"',
        'displayName = "Example Mod"'
      ].join("\n")
    });

    await expect(scanJarMetadata(jarPath)).resolves.toMatchObject({
      modId: "examplemod",
      name: "Example Mod",
      version: "1.2.3",
      loader: "forge",
      source: "mods.toml"
    });
  });

  it("reads mandatory Forge mod dependencies from mods.toml", async () => {
    const jarPath = await createJar({
      "META-INF/mods.toml": [
        'modLoader = "javafml"',
        'loaderVersion = "[47,)"',
        "",
        "[[mods]]",
        'modId = "exampleaddon"',
        'displayName = "Example Addon"',
        "",
        "[[dependencies.exampleaddon]]",
        'modId = "minecraft"',
        "mandatory = true",
        'versionRange = "[1.20.1]"',
        'side = "BOTH"',
        "",
        "[[dependencies.exampleaddon]]",
        'modId = "jade"',
        "mandatory = true",
        'versionRange = "[11.9.0,)"',
        'side = "BOTH"'
      ].join("\n")
    });

    await expect(scanJarMetadata(jarPath)).resolves.toMatchObject({
      modId: "exampleaddon",
      dependencies: [
        {
          modId: "minecraft",
          mandatory: true,
          versionRange: "[1.20.1]",
          side: "BOTH"
        },
        {
          modId: "jade",
          mandatory: true,
          versionRange: "[11.9.0,)",
          side: "BOTH"
        }
      ]
    });
  });

  it("maps Forge client-side runtime dependencies to server unsupported", async () => {
    const jarPath = await createJar({
      "META-INF/mods.toml": [
        'modLoader = "javafml"',
        'loaderVersion = "[47,)"',
        "",
        "[[mods]]",
        'modId = "dynamic_fps"',
        'displayName = "Dynamic FPS"',
        "",
        "[[dependencies.dynamic_fps]]",
        'modId = "minecraft"',
        'mandatory = true',
        'versionRange = "[1.20.1,)"',
        'side = "CLIENT"'
      ].join("\n")
    });

    await expect(scanJarMetadata(jarPath)).resolves.toMatchObject({
      modId: "dynamic_fps",
      name: "Dynamic FPS",
      loader: "forge",
      env: {
        client: "required",
        server: "unsupported"
      },
      source: "mods.toml"
    });
  });

  it("skips malformed downloaded jar metadata and reports an aggregated warning", async () => {
    const goodJarPath = await createJar({
      "META-INF/mods.toml": [
        'modLoader = "javafml"',
        'loaderVersion = "[47,)"',
        "",
        "[[mods]]",
        'modId = "goodmod"',
        'displayName = "Good Mod"'
      ].join("\n")
    });
    const badJarPath = await createJar({
      "mcmod.info": '{ "modList": [{ "name": "bad\nmetadata" }] }'
    });
    const warnings: string[] = [];
    const goodFile = modFile("good.jar");
    const badFile = modFile("bad.jar");

    const result = await scanDownloadedJarMetadata(
      [
        { file: goodFile, cachePath: goodJarPath },
        { file: badFile, cachePath: badJarPath }
      ],
      { onWarning: (message) => warnings.push(message) }
    );

    expect(result.get(goodFile)).toMatchObject({
      modId: "goodmod",
      name: "Good Mod"
    });
    expect(result.has(badFile)).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("1 个 Mod 的 JAR 元数据无法解析");
    expect(warnings[0]).toContain("bad.jar");
  });
});

async function createJar(entries: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcsp-jar-metadata-"));
  const jarPath = path.join(dir, "mod.jar");
  await writeZip(jarPath, entries);
  return jarPath;
}

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

function modFile(fileName: string) {
  return {
    fileName,
    source: "modrinth" as const,
    downloadUrls: ["https://example.invalid/mod.jar"],
    expectedHashes: {}
  };
}
