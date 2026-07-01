import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ModFileDescriptor } from "@mcsp/shared";
import { describe, expect, it } from "vitest";
import { decideMods } from "./decisions";
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

  it("excludes known Forge client-only mods from the bundled project rules", async () => {
    const rules = await loadModDecisionRules(path.resolve("rules/client-mod-rules.json"), {
      loader: "forge",
      minecraftVersion: "1.20.1"
    });
    const files = [
      modFile("oculus-mc1.20.1-1.8.0.jar", "oculus"),
      modFile("blur-forge-3.1.1.jar", "blur"),
      modFile("jecharacters-1.20.1-forge-4.6.1.jar", "jecharacters"),
      modFile("sound-physics-remastered-forge-1.20.1-1.5.1.jar", "sound_physics_remastered"),
      modFile("dynamic-fps-3.11.4+minecraft-1.20.0-forge.jar", "dynamic_fps"),
      modFile("PresenceFootsteps-1.20.1-1.9.1-beta.1.jar", "presencefootsteps"),
      modFile("ShoulderSurfing-Forge-1.20.1-4.15.0.jar", "shouldersurfing"),
      modFile("Controlling-forge-1.20.1-12.0.2.jar", "controlling"),
      modFile("configured-forge-1.20.1-2.2.3.jar", "configured"),
      modFile("Searchables-forge-1.20.1-1.0.3.jar", "searchables"),
      modFile("fancymenu_forge_3.7.0_MC_1.20.1.jar", "fancymenu"),
      modFile("drippyloadingscreen_forge_3.0.12_MC_1.20.1.jar", "drippyloadingscreen"),
      modFile("embeddium-0.3.31+mc1.20.1.jar", "embeddium"),
      modFile("sodiumdynamiclights-forge-1.0.10-1.20.1.jar", "sodiumdynamiclights"),
      modFile("MouseTweaks-forge-mc1.20.1-2.25.1.jar", "mousetweaks"),
      modFile("Xaeros_Minimap_25.3.2_Forge_1.20.jar", "xaerominimap"),
      modFile("XaerosWorldMap_1.40.2_Forge_1.20.jar", "xaeroworldmap"),
      modFile("jei-1.20.1-forge-15.20.0.112.jar", "jei"),
      modFile("Jade-1.20.1-Forge-11.13.2.jar", "jade"),
      modFile("CustomSkinLoader_ForgeActive-14.19.1.jar", "customskinloader"),
      modFile("AdvancedLootInfo-forge-1.20.1-1.12.0.jar", "ali"),
      modFile("tfc_support_indicator-1.0.3+mc1.20.1.jar", "tfc_support_indicator"),
      modFile("TFCWeldButton-1.20.1-1.1.jar", "tfcweldbutton"),
      modFile("konkrete_forge_1.8.0_MC_1.20-1.20.1.jar", "konkrete"),
      modFile("lightspeed-1.20.1-1.1.2hotfix.jar", "lightspeed")
    ];
    const metadataByFile = new Map(
      files.map((file) => [
        file,
        {
          modId: file.id!,
          source: "mods.toml" as const
        }
      ])
    );

    expect(decideMods(files, { overrides: rules, metadataByFile })).toEqual(
      files.map((file) =>
        expect.objectContaining({
          fileName: file.fileName,
          decision: "exclude",
          source: "user-rule"
        })
      )
    );
  });
});

function modFile(fileName: string, id = fileName.split("-")[0]!): ModFileDescriptor {
  return {
    id,
    fileName,
    source: "curseforge",
    downloadUrls: [],
    expectedHashes: {}
  };
}
