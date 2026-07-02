import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createWriteStream } from "node:fs";
import { describe, expect, it } from "vitest";
import yazl from "yazl";
import { analyzeInput } from "../src/analyze";

describe("analyzeInput", () => {
  it("parses Modrinth mrpack metadata and files", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcsp-modrinth-"));
    const archivePath = path.join(dir, "pack.mrpack");

    await writeZip(archivePath, {
      "modrinth.index.json": JSON.stringify({
        formatVersion: 1,
        name: "Example MR Pack",
        versionId: "1.0.0",
        dependencies: {
          minecraft: "1.20.1",
          fabric: "0.15.11"
        },
        files: [
          {
            path: "mods/example.jar",
            hashes: { sha1: "abc" },
            downloads: ["https://example.invalid/example.jar"],
            env: { client: "required", server: "unsupported" }
          }
        ]
      }),
      "overrides/config/example.toml": "enabled = true",
      "server-overrides/server.properties": "online-mode=true"
    });

    const result = await analyzeInput(archivePath);

    expect(result.metadata).toMatchObject({
      type: "modrinth",
      name: "Example MR Pack",
      version: "1.0.0",
      minecraftVersion: "1.20.1",
      loader: "fabric",
      loaderVersion: "0.15.11"
    });
    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.env?.server).toBe("unsupported");
    expect(result.overrides).toMatchObject({ common: 1, server: 1, client: 0 });
  });

  it("parses CurseForge manifest metadata and files", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcsp-curseforge-"));
    const archivePath = path.join(dir, "pack.zip");

    await writeZip(archivePath, {
      "manifest.json": JSON.stringify({
        manifestType: "minecraftModpack",
        name: "Example CF Pack",
        version: "2.0.0",
        minecraft: {
          version: "1.20.1",
          modLoaders: [{ id: "forge-47.2.0", primary: true }]
        },
        files: [{ projectID: 1234, fileID: 5678 }]
      }),
      "overrides/config/example.toml": "enabled = true"
    });

    const result = await analyzeInput(archivePath);

    expect(result.metadata).toMatchObject({
      type: "curseforge",
      name: "Example CF Pack",
      version: "2.0.0",
      minecraftVersion: "1.20.1",
      loader: "forge",
      loaderVersion: "47.2.0"
    });
    expect(result.files[0]?.id).toBe("1234:5678");
    expect(result.overrides.common).toBe(1);
  });

  it("treats CurseForge override jars as local mod files", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcsp-curseforge-local-mods-"));
    const archivePath = path.join(dir, "pack.zip");

    await writeZip(archivePath, {
      "manifest.json": JSON.stringify({
        manifestType: "minecraftModpack",
        name: "Local Overrides Pack",
        minecraft: {
          version: "1.20.1",
          modLoaders: [{ id: "forge-47.2.0", primary: true }]
        },
        files: []
      }),
      "overrides/mods/local-server.jar": "fake jar",
      "overrides/config/example.toml": "enabled = true"
    });

    const result = await analyzeInput(archivePath);

    expect(result.files).toEqual([
      expect.objectContaining({
        fileName: "local-server.jar",
        source: "local",
        pathInPack: "overrides/mods/local-server.jar",
        downloadUrls: []
      })
    ]);
    expect(result.overrides.common).toBe(2);
  });

  it("does not parse override json files while analyzing a CurseForge pack", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcsp-curseforge-overrides-"));
    const archivePath = path.join(dir, "pack.zip");

    await writeZip(archivePath, {
      "manifest.json": JSON.stringify({
        manifestType: "minecraftModpack",
        name: "Legacy Config Pack",
        minecraft: {
          version: "1.12.2",
          modLoaders: [{ id: "forge-14.23.5.2860", primary: true }]
        },
        files: []
      }),
      "overrides/config/qualitytools/Quailities/boots.json": '{ "name": "bad\nlegacy config" }',
      "overrides/config/roguelike_dungeons/settings/base/dungeon_base.json": "// legacy json-like config"
    });

    const result = await analyzeInput(archivePath);

    expect(result.metadata).toMatchObject({
      type: "curseforge",
      name: "Legacy Config Pack",
      minecraftVersion: "1.12.2",
      loader: "forge",
      loaderVersion: "14.23.5.2860"
    });
    expect(result.overrides.common).toBe(2);
  });

  it("wraps malformed root manifests in an input format error", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcsp-bad-manifest-"));
    const archivePath = path.join(dir, "pack.zip");

    await writeZip(archivePath, {
      "manifest.json": '{ "name": "broken\nmanifest" }'
    });

    await expect(analyzeInput(archivePath)).rejects.toMatchObject({
      code: "E_INPUT_FORMAT",
      message: "CurseForge 整合包清单不是合法 JSON。",
      detail: {
        entryName: "manifest.json"
      }
    });
  });

  it("parses packwiz directory metadata and index", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcsp-packwiz-"));
    await fs.writeFile(
      path.join(dir, "pack.toml"),
      [
        'name = "Example Packwiz Pack"',
        'version = "3.0.0"',
        "",
        "[versions]",
        'minecraft = "1.21.1"',
        'neoforge = "21.1.0"'
      ].join("\n"),
      "utf8"
    );
    await fs.writeFile(
      path.join(dir, "index.toml"),
      [
        "hash-format = \"sha256\"",
        "",
        "[[files]]",
        'file = "mods/example.pw.toml"',
        'hash = "abc"',
        'hash-format = "sha256"'
      ].join("\n"),
      "utf8"
    );

    const result = await analyzeInput(dir);

    expect(result.metadata).toMatchObject({
      type: "packwiz",
      name: "Example Packwiz Pack",
      version: "3.0.0",
      minecraftVersion: "1.21.1",
      loader: "neoforge",
      loaderVersion: "21.1.0"
    });
    expect(result.files[0]?.pathInPack).toBe("mods/example.pw.toml");
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
