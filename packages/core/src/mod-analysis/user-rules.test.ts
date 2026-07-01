import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadModDecisionRules } from "./user-rules";

describe("loadModDecisionRules", () => {
  it("loads JSON include and exclude buckets", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcsp-rules-json-"));
    const rulesPath = path.join(dir, "rules.json");
    await fs.writeFile(
      rulesPath,
      JSON.stringify({
        include: ["server-helper.jar"],
        exclude: [
          {
            source: "curseforge",
            projectId: "1234",
            fileId: "5678",
            reason: "client-only"
          }
        ]
      }),
      "utf8"
    );

    await expect(loadModDecisionRules(rulesPath)).resolves.toEqual([
      {
        fileName: "server-helper.jar",
        decision: "include"
      },
      {
        source: "curseforge",
        projectId: "1234",
        fileId: "5678",
        decision: "exclude",
        reason: "client-only"
      }
    ]);
  });

  it("loads YAML explicit rules", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcsp-rules-yaml-"));
    const rulesPath = path.join(dir, "rules.yaml");
    await fs.writeFile(
      rulesPath,
      [
        "rules:",
        "  - pathInPack: mods/server-required.jar",
        "    decision: include",
        "    reason: local audit",
        "  - source: modrinth",
        "    versionId: abcdef",
        "    decision: exclude"
      ].join("\n"),
      "utf8"
    );

    await expect(loadModDecisionRules(rulesPath)).resolves.toEqual([
      {
        pathInPack: "mods/server-required.jar",
        decision: "include",
        reason: "local audit"
      },
      {
        source: "modrinth",
        versionId: "abcdef",
        decision: "exclude"
      }
    ]);
  });
});
