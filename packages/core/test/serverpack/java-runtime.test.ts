import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  javaRuntimeRequirementForCore,
  selectJavaRuntimeForCore
} from "../../src/serverpack/java-runtime";
import type { ServerCorePlan } from "../../src/serverpack/server-core";

describe("java runtime selection", () => {
  it("requires Java 8 for legacy Forge 1.12.2", () => {
    expect(javaRuntimeRequirementForCore(forge1122Core())).toMatchObject({
      minMajor: 8,
      maxMajor: 8,
      preferredMajor: 8,
      label: "Java 8"
    });
  });

  it("auto-selects a compatible Java when the configured Java is incompatible", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcsp-java-search-"));
    const jdk8 = path.join(root, "Environment", "JDK8");
    const jdk17 = path.join(root, "Environment", "JDK17");
    await createJavaHome(jdk8);
    await createJavaHome(jdk17);

    const result = await selectJavaRuntimeForCore(forge1122Core(), {
      configuredJavaHome: jdk17,
      searchRoots: [root],
      includeDefaultSearchRoots: false,
      env: { PATH: "", Path: "", JAVA_HOME: "" },
      execFileImpl: async (file) => ({
        stdout: "",
        stderr: file.includes("JDK8")
          ? 'java version "1.8.0_202"\nJava HotSpot(TM) 64-Bit Server VM'
          : 'java version "17.0.10"\nJava HotSpot(TM) 64-Bit Server VM'
      })
    });

    expect(result.selected?.javaHome).toBe(jdk8);
    expect(result.compatible.map((runtime) => runtime.major)).toEqual([8]);
    expect(result.warnings.join("\n")).toContain("不满足当前服务端核心要求");
  });
});

function forge1122Core(): ServerCorePlan {
  return {
    type: "forge",
    minecraftVersion: "1.12.2",
    loaderVersion: "14.23.5.2860",
    javaMajor: 8,
    notes: [],
    warnings: []
  };
}

async function createJavaHome(javaHome: string): Promise<void> {
  await fs.mkdir(path.join(javaHome, "bin"), { recursive: true });
  await fs.writeFile(path.join(javaHome, "bin", process.platform === "win32" ? "java.exe" : "java"), "", "utf8");
  await fs.writeFile(path.join(javaHome, "bin", process.platform === "win32" ? "javac.exe" : "javac"), "", "utf8");
}
