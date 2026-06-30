import type { LoaderType, PackMetadata } from "@mcsp/shared";

export interface ServerCorePlan {
  type: LoaderType;
  minecraftVersion?: string;
  loaderVersion?: string;
  javaMajor: 8 | 16 | 17 | 21;
  notes: string[];
  warnings: string[];
}

export function selectServerCore(metadata: PackMetadata, options: { hasMods?: boolean } = {}): ServerCorePlan {
  const notes: string[] = [];
  const warnings: string[] = [];
  const type = metadata.loader ?? "vanilla";
  const javaMajor = recommendJavaMajor(metadata.minecraftVersion);

  if (!metadata.minecraftVersion) {
    warnings.push("整合包没有声明 Minecraft 版本，安装脚本会写入占位值，需要手动补全后再运行。");
  }

  if (!metadata.loader && options.hasMods) {
    warnings.push("整合包包含 Mod 但未声明加载器，已按 vanilla 生成服务端核心计划，请手动确认实际加载器。");
  }

  if (type !== "vanilla" && !metadata.loaderVersion) {
    warnings.push(`${displayLoader(type)} 未声明加载器版本，安装脚本会写入占位值，需要手动补全后再运行。`);
  }

  notes.push(`推荐 Java ${javaMajor}，请确保服务器运行环境的 JAVA_HOME 或 java 命令指向兼容版本。`);

  if (type === "forge" || type === "neoforge") {
    notes.push("Forge/NeoForge 安装器通常会生成 run.bat/run.sh，启动脚本会优先调用这些官方脚本。");
  }

  if (type === "fabric") {
    notes.push("Fabric 安装脚本会使用 Fabric Meta 获取稳定 installer，并按整合包声明的 loader 版本安装。");
  }

  if (type === "quilt") {
    notes.push("Quilt 安装脚本会下载 Quilt installer，并生成 quilt-server-launch.jar。");
  }

  return {
    type,
    ...(metadata.minecraftVersion === undefined ? {} : { minecraftVersion: metadata.minecraftVersion }),
    ...(metadata.loaderVersion === undefined ? {} : { loaderVersion: metadata.loaderVersion }),
    javaMajor,
    notes,
    warnings
  };
}

function recommendJavaMajor(minecraftVersion: string | undefined): 8 | 16 | 17 | 21 {
  if (!minecraftVersion) {
    return 17;
  }

  if (compareMinecraftVersion(minecraftVersion, [1, 20, 5]) >= 0) {
    return 21;
  }

  if (compareMinecraftVersion(minecraftVersion, [1, 18, 0]) >= 0) {
    return 17;
  }

  if (compareMinecraftVersion(minecraftVersion, [1, 17, 0]) >= 0) {
    return 16;
  }

  return 8;
}

function compareMinecraftVersion(version: string, target: readonly [number, number, number]): number {
  const parsed = parseMinecraftVersion(version);
  if (!parsed) {
    return 0;
  }

  for (let index = 0; index < target.length; index += 1) {
    const left = parsed[index] ?? 0;
    const right = target[index] ?? 0;
    if (left !== right) {
      return left - right;
    }
  }

  return 0;
}

function parseMinecraftVersion(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(version);
  if (!match) {
    return null;
  }

  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

function displayLoader(loader: LoaderType): string {
  switch (loader) {
    case "fabric":
      return "Fabric";
    case "forge":
      return "Forge";
    case "neoforge":
      return "NeoForge";
    case "quilt":
      return "Quilt";
    case "vanilla":
      return "Vanilla";
  }
}
