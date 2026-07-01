import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadModDecisionRules, loadRemoteModDecisionRules } from "./user-rules";

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
        decision: "include",
        decisionSource: "user-rule"
      },
      {
        source: "curseforge",
        projectId: "1234",
        fileId: "5678",
        decision: "exclude",
        reason: "client-only",
        decisionSource: "user-rule"
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
        reason: "local audit",
        decisionSource: "user-rule"
      },
      {
        source: "modrinth",
        versionId: "abcdef",
        decision: "exclude",
        decisionSource: "user-rule"
      }
    ]);
  });

  it("expands project-level rules into stable match overrides", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcsp-rules-project-"));
    const rulesPath = path.join(dir, "rules.json");
    await fs.writeFile(
      rulesPath,
      JSON.stringify({
        rules: [
          {
            id: "modmenu",
            side: "client",
            reason: "client menu",
            match: {
              modrinthProjectIds: ["mOgUt4GM"],
              curseforgeProjectIds: ["308702"],
              modIds: ["modmenu"],
              slugs: ["modmenu"]
            },
            loaders: ["fabric"],
            minecraftVersions: [">=1.16"]
          }
        ]
      }),
      "utf8"
    );

    await expect(loadModDecisionRules(rulesPath, { loader: "fabric", minecraftVersion: "1.20.1" })).resolves.toEqual([
      {
        source: "modrinth",
        projectId: "mOgUt4GM",
        decision: "exclude",
        reason: "client menu",
        ruleId: "modmenu",
        decisionSource: "user-rule"
      },
      {
        source: "curseforge",
        projectId: "308702",
        decision: "exclude",
        reason: "client menu",
        ruleId: "modmenu",
        decisionSource: "user-rule"
      },
      {
        modId: "modmenu",
        decision: "exclude",
        reason: "client menu",
        ruleId: "modmenu",
        decisionSource: "user-rule"
      },
      {
        slug: "modmenu",
        decision: "exclude",
        reason: "client menu",
        ruleId: "modmenu",
        decisionSource: "user-rule"
      }
    ]);
  });

  it("loads remote rules and falls back to cache", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcsp-rules-remote-"));
    const payload = JSON.stringify({
      rules: [
        {
          id: "sodium",
          side: "client",
          match: {
            modrinthProjectIds: ["AANobbMI"]
          }
        }
      ]
    });
    let online = true;

    const first = await loadRemoteModDecisionRules({
      url: "https://example.invalid/rules.json",
      cacheDir: dir,
      context: { loader: "fabric", minecraftVersion: "1.20.1" },
      fetchImpl: async () =>
        online
          ? new Response(payload, { headers: { etag: '"v1"' } })
          : new Response("offline", { status: 503 })
    });
    online = false;
    const second = await loadRemoteModDecisionRules({
      url: "https://example.invalid/rules.json",
      cacheDir: dir,
      context: { loader: "fabric", minecraftVersion: "1.20.1" },
      fetchImpl: async () => new Response("offline", { status: 503 })
    });

    expect(first).toEqual([
      {
        source: "modrinth",
        projectId: "AANobbMI",
        decision: "exclude",
        reason: "远程项目规则 sodium：排除",
        ruleId: "sodium",
        decisionSource: "remote-rule"
      }
    ]);
    expect(second).toEqual(first);
  });
});
