import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { collectInstalledCoreFiles } from "../../src/serverpack/core-installer";

describe("collectInstalledCoreFiles", () => {
  it("includes legacy Forge launch jars without treating installers as launchable", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcsp-core-files-"));
    await fs.writeFile(path.join(dir, "forge-1.12.2-14.23.5.2860.jar"), "forge", "utf8");
    await fs.writeFile(path.join(dir, "forge-1.12.2-14.23.5.2860-installer.jar"), "installer", "utf8");
    await fs.writeFile(path.join(dir, "minecraft_server.1.12.2.jar"), "minecraft", "utf8");

    await expect(collectInstalledCoreFiles(dir)).resolves.toEqual([
      "forge-1.12.2-14.23.5.2860.jar",
      "minecraft_server.1.12.2.jar"
    ]);
  });
});
