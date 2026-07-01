import { describe, expect, it } from "vitest";
import type { ModFileDescriptor } from "@mcsp/shared";
import { decideMods } from "./decisions";

describe("decideMods", () => {
  it("uses manifest server env when available", () => {
    const decisions = decideMods([
      modFile("client-only.jar", { server: "unsupported" }),
      modFile("required.jar", { server: "required" }),
      modFile("optional.jar", { server: "optional" })
    ]);

    expect(decisions).toEqual([
      {
        fileName: "client-only.jar",
        decision: "exclude",
        reason: "manifest env.server=unsupported",
        source: "manifest"
      },
      {
        fileName: "required.jar",
        decision: "include",
        reason: "manifest env.server=required",
        source: "manifest"
      },
      {
        fileName: "optional.jar",
        decision: "include",
        reason: "manifest env.server=optional",
        source: "manifest"
      }
    ]);
  });

  it("includes unknown mods by default", () => {
    expect(decideMods([modFile("unknown.jar")])).toEqual([
      {
        fileName: "unknown.jar",
        decision: "include",
        reason: "缺少明确服务端环境声明",
        source: "unknown"
      }
    ]);
  });

  it("can apply a configured unknown policy", () => {
    expect(decideMods([modFile("unknown.jar")], { unknownPolicy: "exclude" })[0]?.decision).toBe("exclude");
    expect(decideMods([modFile("unknown.jar")], { unknownPolicy: "include" })[0]?.decision).toBe("include");
  });

  it("uses jar metadata when manifest env is missing", () => {
    const file = modFile("modmenu.jar");
    const metadataByFile = new Map([
      [
        file,
        {
          modId: "modmenu",
          name: "Mod Menu",
          loader: "fabric" as const,
          env: { server: "unsupported" as const },
          source: "fabric.mod.json" as const
        }
      ]
    ]);

    expect(decideMods([file], { metadataByFile })).toEqual([
      {
        fileName: "modmenu.jar",
        decision: "exclude",
        reason: "fabric.mod.json env.server=unsupported",
        source: "jar-metadata"
      }
    ]);
  });

  it("applies user rules before automatic rules", () => {
    const file = modFile("client-only.jar", { server: "unsupported" });

    expect(
      decideMods([file], {
        overrides: [
          {
            fileName: file.fileName,
            source: file.source,
            decision: "include",
            reason: "服主确认该文件服务端可用"
          }
        ]
      })
    ).toEqual([
      {
        fileName: "client-only.jar",
        decision: "include",
        reason: "服主确认该文件服务端可用",
        source: "user-rule"
      }
    ]);
  });

  it("applies project-level rules across file versions", () => {
    const file = modFile("modmenu-1.20.1-9.2.0.jar");
    file.projectId = "mOgUt4GM";

    expect(
      decideMods([file], {
        overrides: [
          {
            source: "modrinth",
            projectId: "mOgUt4GM",
            decision: "exclude",
            decisionSource: "remote-rule",
            reason: "远程项目规则 modmenu：排除"
          }
        ]
      })
    ).toEqual([
      {
        fileName: "modmenu-1.20.1-9.2.0.jar",
        decision: "exclude",
        reason: "远程项目规则 modmenu：排除",
        source: "remote-rule"
      }
    ]);
  });

  it("applies mod id rules from jar metadata", () => {
    const file = modFile("custom-name.jar");
    const metadataByFile = new Map([
      [
        file,
        {
          modId: "modmenu",
          source: "fabric.mod.json" as const
        }
      ]
    ]);

    expect(
      decideMods([file], {
        metadataByFile,
        overrides: [
          {
            modId: "modmenu",
            decision: "exclude",
            decisionSource: "remote-rule",
            reason: "远程项目规则 modmenu：排除"
          }
        ]
      })
    ).toEqual([
      {
        fileName: "custom-name.jar",
        decision: "exclude",
        reason: "远程项目规则 modmenu：排除",
        source: "remote-rule"
      }
    ]);
  });
});

function modFile(fileName: string, env?: ModFileDescriptor["env"]): ModFileDescriptor {
  return {
    fileName,
    source: "modrinth",
    downloadUrls: [],
    expectedHashes: {},
    ...(env === undefined ? {} : { env })
  };
}
