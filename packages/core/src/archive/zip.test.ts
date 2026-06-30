import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import yazl from "yazl";
import { extractZipEntries } from "./zip";

describe("extractZipEntries", () => {
  it("extracts only matching prefixes and strips the selected prefix", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcsp-extract-"));
    const archivePath = path.join(dir, "pack.mrpack");
    const outputRoot = path.join(dir, "serverpack");

    await writeZip(archivePath, {
      "overrides/config/common.toml": "common = true",
      "server-overrides/config/server.toml": "server = true",
      "client-overrides/options.txt": "gamma:1.0"
    });

    const extracted = await extractZipEntries(archivePath, outputRoot, {
      prefixes: ["server-overrides/"],
      stripPrefix: "server-overrides/"
    });

    expect(extracted.map((file) => file.entryName)).toEqual(["server-overrides/config/server.toml"]);
    await expect(fs.readFile(path.join(outputRoot, "config", "server.toml"), "utf8")).resolves.toBe("server = true");
    await expect(fs.access(path.join(outputRoot, "config", "common.toml"))).rejects.toThrow();
    await expect(fs.access(path.join(outputRoot, "options.txt"))).rejects.toThrow();
  });

  it("checks archive limits while scanning entries", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcsp-extract-limit-"));
    const archivePath = path.join(dir, "pack.zip");
    const outputRoot = path.join(dir, "serverpack");

    await writeZip(archivePath, {
      "overrides/config/a.toml": "a = true",
      "overrides/config/b.toml": "b = true"
    });

    await expect(
      extractZipEntries(archivePath, outputRoot, {
        prefixes: ["overrides/"],
        stripPrefix: "overrides/",
        limits: { maxFileCount: 1 }
      })
    ).rejects.toMatchObject({ code: "E_ARCHIVE_LIMIT_EXCEEDED" });
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
