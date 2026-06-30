import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import yazl from "yazl";
import { scanJarMetadata } from "./jar-metadata";

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
