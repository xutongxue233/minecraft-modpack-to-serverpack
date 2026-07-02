import { describe, expect, it } from "vitest";
import { ConversionRequestSchema, UpdateSettingsRequestSchema } from "../src/schemas";

describe("conversion schemas", () => {
  it("accepts optimized start script settings", () => {
    expect(
      ConversionRequestSchema.parse({
        inputPath: "pack.mrpack",
        outputDir: "serverpack",
        settings: {
          unknownPolicy: "include",
          generateOptimizedStartScript: true
        }
      })
    ).toMatchObject({
      settings: {
        unknownPolicy: "include",
        generateOptimizedStartScript: true
      }
    });
  });

  it("rejects legacy manual review unknown policy values", () => {
    expect(() =>
      ConversionRequestSchema.parse({
        inputPath: "pack.mrpack",
        outputDir: "serverpack",
        settings: {
          unknownPolicy: "manual-review"
        }
      })
    ).toThrow();

    expect(() => UpdateSettingsRequestSchema.parse({ unknownPolicy: "manual-review" })).toThrow();
  });
});
