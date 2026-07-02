import { describe, expect, it } from "vitest";
import type { AnalyzeResult } from "@mcsp/shared";
import { enrichAnalysisWithPlatformMetadata } from "../../src/metadata/platform-metadata";

describe("enrichAnalysisWithPlatformMetadata", () => {
  it("enriches CurseForge files with project name, filename, hashes and download urls", async () => {
    const analysis = baseAnalysis({
      type: "curseforge",
      files: [
        {
          id: "1234:5678",
          projectId: "1234",
          fileId: "5678",
          fileName: "5678.jar",
          source: "curseforge",
          downloadUrls: [],
          expectedHashes: {},
          metadataSource: "manifest"
        }
      ]
    });

    const result = await enrichAnalysisWithPlatformMetadata(analysis, {
      curseForgeApiKey: "test-key",
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.endsWith("/mods/files")) {
          return jsonResponse({
            data: [
              {
                id: 5678,
                modId: 1234,
                displayName: "Example Mod 1.0",
                fileName: "example-mod.jar",
                downloadUrl: "https://edge.forgecdn.net/files/5678/example-mod.jar",
                hashes: [{ algo: 1, value: "abc123" }]
              }
            ]
          });
        }
        if (url.endsWith("/mods")) {
          return jsonResponse({
            data: [
              {
                id: 1234,
                name: "Example Mod",
                slug: "example-mod",
                links: { websiteUrl: "https://www.curseforge.com/minecraft/mc-mods/example-mod" }
              }
            ]
          });
        }
        throw new Error(`Unexpected URL: ${url}`);
      }
    });

    expect(result.files[0]).toMatchObject({
      name: "Example Mod",
      slug: "example-mod",
      fileName: "example-mod.jar",
      expectedHashes: { sha1: "abc123" },
      metadataSource: "curseforge-api"
    });
    expect(result.files[0]?.downloadUrls).toContain("https://mod.mcimirror.top/files/5678/example-mod.jar");
    expect(result.files[0]?.downloadUrls).toContain("https://edge.forgecdn.net/files/5678/example-mod.jar");
  });

  it("builds CurseForge CDN fallback urls from file id and filename when downloadUrl is missing", async () => {
    const analysis = baseAnalysis({
      type: "curseforge",
      files: [
        {
          id: "224770:4486512",
          projectId: "224770",
          fileId: "4486512",
          fileName: "4486512.jar",
          source: "curseforge",
          downloadUrls: [],
          expectedHashes: {},
          metadataSource: "manifest"
        }
      ]
    });

    const result = await enrichAnalysisWithPlatformMetadata(analysis, {
      curseForgeApiKey: "test-key",
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.endsWith("/mods/files")) {
          return jsonResponse({
            data: [
              {
                id: 4486512,
                modId: 224770,
                displayName: "Lycanites Mobs 2.0.8.9",
                fileName: "lycanitesmobs-1.12.2-2.0.8.9.jar",
                hashes: []
              }
            ]
          });
        }
        if (url.endsWith("/mods")) {
          return jsonResponse({
            data: [{ id: 224770, name: "Lycanites Mobs", slug: "lycanites-mobs" }]
          });
        }
        throw new Error(`Unexpected URL: ${url}`);
      }
    });

    expect(result.files[0]).toMatchObject({
      fileName: "lycanitesmobs-1.12.2-2.0.8.9.jar",
      metadataSource: "curseforge-api"
    });
    expect(result.files[0]?.downloadUrls).toEqual([
      "https://mod.mcimirror.top/files/4486/512/lycanitesmobs-1.12.2-2.0.8.9.jar",
      "https://mediafilez.forgecdn.net/files/4486/512/lycanitesmobs-1.12.2-2.0.8.9.jar",
      "https://edge.forgecdn.net/files/4486/512/lycanitesmobs-1.12.2-2.0.8.9.jar",
      "https://media.forgecdn.net/files/4486/512/lycanitesmobs-1.12.2-2.0.8.9.jar"
    ]);
  });

  it("enriches Modrinth files with project title and server side metadata", async () => {
    const analysis = baseAnalysis({
      type: "modrinth",
      files: [
        {
          fileName: "placeholder.jar",
          source: "modrinth",
          downloadUrls: ["https://cdn.modrinth.com/data/project/versions/version/example.jar"],
          expectedHashes: { sha1: "abc123" },
          pathInPack: "mods/placeholder.jar",
          metadataSource: "manifest"
        }
      ]
    });

    const result = await enrichAnalysisWithPlatformMetadata(analysis, {
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.endsWith("/version_files")) {
          return jsonResponse({
            abc123: {
              id: "version-id",
              project_id: "project-id",
              name: "Example Mod 1.0",
              version_number: "1.0.0",
              files: [
                {
                  filename: "example-mod.jar",
                  url: "https://cdn.modrinth.com/data/project-id/versions/version-id/example-mod.jar",
                  hashes: { sha1: "abc123", sha512: "def456" }
                }
              ]
            }
          });
        }
        if (url.startsWith("https://api.modrinth.com/v2/projects?")) {
          return jsonResponse([
            {
              id: "project-id",
              title: "Example Mod",
              slug: "example-mod",
              client_side: "optional",
              server_side: "required"
            }
          ]);
        }
        throw new Error(`Unexpected URL: ${url}`);
      }
    });

    expect(result.files[0]).toMatchObject({
      id: "project-id",
      versionId: "version-id",
      name: "Example Mod",
      fileName: "example-mod.jar",
      env: { client: "optional", server: "required" },
      envSource: "platform-api",
      metadataSource: "modrinth-api"
    });
    expect(result.files[0]?.downloadUrls).toContain("https://mod.mcimirror.top/data/project-id/versions/version-id/example-mod.jar");
  });
});

function baseAnalysis({ type, files }: Pick<AnalyzeResult["metadata"], "type"> & Pick<AnalyzeResult, "files">): AnalyzeResult {
  return {
    metadata: {
      type,
      name: "Example Pack"
    },
    files,
    overrides: { common: 0, server: 0, client: 0 },
    warnings: []
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" }
  });
}
