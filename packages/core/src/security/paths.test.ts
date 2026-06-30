import { describe, expect, it } from "vitest";
import { assertSafeArchiveEntry } from "./paths";

describe("assertSafeArchiveEntry", () => {
  it("accepts normal relative paths", () => {
    expect(assertSafeArchiveEntry("overrides/config/example.toml")).toBe("overrides/config/example.toml");
  });

  it("rejects traversal paths", () => {
    expect(() => assertSafeArchiveEntry("../evil.txt")).toThrow();
    expect(() => assertSafeArchiveEntry("mods/../../evil.txt")).toThrow();
  });

  it("rejects absolute and drive paths", () => {
    expect(() => assertSafeArchiveEntry("/tmp/evil.txt")).toThrow();
    expect(() => assertSafeArchiveEntry("C:\\evil.txt")).toThrow();
  });
});
