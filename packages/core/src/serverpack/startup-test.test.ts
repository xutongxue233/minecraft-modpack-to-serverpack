import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runServerpackStartupTest } from "./startup-test";

describe("runServerpackStartupTest", () => {
  it("treats an EULA gate as a passed startup script test", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcsp-startup-test-"));
    await writeFakeStartScript(dir);
    await fs.writeFile(path.join(dir, "eula.txt"), "eula=true\n", "utf8");
    const logs: string[] = [];

    const result = await runServerpackStartupTest({
      outputDir: dir,
      timeoutSeconds: 5,
      onLog: (_level, message) => logs.push(message)
    });

    expect(result).toMatchObject({
      enabled: true,
      status: "passed"
    });
    expect(logs.join("\n")).toContain("EULA");
    await expect(fs.readFile(path.join(dir, "eula.txt"), "utf8")).resolves.toBe("eula=true\n");
  });
});

async function writeFakeStartScript(dir: string): Promise<void> {
  if (process.platform === "win32") {
    await fs.writeFile(
      path.join(dir, "start.ps1"),
      ["Write-Host 'You need to agree to the EULA in order to run the server.'", "exit 1", ""].join("\n"),
      "utf8"
    );
    return;
  }

  const scriptPath = path.join(dir, "start.sh");
  await fs.writeFile(
    scriptPath,
    [
      "#!/usr/bin/env bash",
      "echo 'You need to agree to the EULA in order to run the server.'",
      "exit 1",
      ""
    ].join("\n"),
    "utf8"
  );
  await fs.chmod(scriptPath, 0o755);
}
