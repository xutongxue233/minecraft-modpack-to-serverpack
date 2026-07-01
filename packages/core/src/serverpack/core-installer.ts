import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { appError, unknownToAppError } from "@mcsp/shared";
import type { ServerCorePlan } from "./server-core";

const execFileAsync = promisify(execFile);

export interface ServerCoreInstallResult {
  enabled: boolean;
  status: "skipped" | "installed" | "failed";
  files: string[];
  warnings: string[];
  error?: string;
}

export interface CoreInstallProgressEvent {
  current: number;
  total: number;
  label: string;
  percent?: number;
  receivedBytes?: number;
  totalBytes?: number;
}

export interface PrepareServerCoreOptions {
  outputDir: string;
  core: ServerCorePlan;
  enabled: boolean;
  javaHome?: string;
  fetchImpl?: typeof fetch;
  timeoutSeconds?: number;
  onProgress?: (event: CoreInstallProgressEvent) => void;
  onLog?: (message: string) => void;
}

interface DownloadFileOptions {
  fetchImpl: typeof fetch;
  timeoutSeconds: number;
  onProgress: (event: Omit<CoreInstallProgressEvent, "current" | "total">) => void;
}

type UnknownRecord = Record<string, unknown>;

export async function prepareServerCore(options: PrepareServerCoreOptions): Promise<ServerCoreInstallResult> {
  if (!options.enabled) {
    return {
      enabled: false,
      status: "skipped",
      files: [],
      warnings: []
    };
  }

  try {
    assertInstallableCore(options.core);
    await fs.mkdir(options.outputDir, { recursive: true });
    options.onProgress?.({ current: 0, total: taskCountForCore(options.core.type), label: "准备服务端核心" });
    await cleanServerCoreArtifacts(options.outputDir);

    switch (options.core.type) {
      case "vanilla":
        await installVanilla(options);
        break;
      case "fabric":
        await installFabric(options);
        break;
      case "quilt":
        await installQuilt(options);
        break;
      case "forge":
        await installForge(options);
        break;
      case "neoforge":
        await installNeoForge(options);
        break;
    }

    await assertInstalledCoreIsLaunchable(options.outputDir, options.core);
    const installedFiles = await collectInstalledCoreFiles(options.outputDir);
    return {
      enabled: true,
      status: "installed",
      files: installedFiles,
      warnings: []
    };
  } catch (error) {
    const appLevelError = unknownToAppError(error, "E_SERVER_CORE_INSTALL_FAILED");
    return {
      enabled: true,
      status: "failed",
      files: await collectInstalledCoreFiles(options.outputDir).catch(() => []),
      warnings: [appLevelError.message],
      error: appLevelError.message
    };
  }
}

export function skippedServerCoreInstallResult(): ServerCoreInstallResult {
  return {
    enabled: false,
    status: "skipped",
    files: [],
    warnings: []
  };
}

async function installVanilla(options: PrepareServerCoreOptions): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const minecraftVersion = options.core.minecraftVersion!;
  const manifest = await fetchJson(fetchImpl, "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json");
  const versions = asArray(manifest.versions).map(asRecord);
  const versionInfo = versions.find((version) => version.id === minecraftVersion);
  const versionUrl = asString(versionInfo?.url);
  if (!versionUrl) {
    throw appError("E_SERVER_CORE_INSTALL_FAILED", `找不到 Minecraft ${minecraftVersion} 的官方服务端下载信息。`);
  }

  const versionManifest = await fetchJson(fetchImpl, versionUrl);
  const serverUrl = asString(asRecord(asRecord(versionManifest.downloads).server).url);
  if (!serverUrl) {
    throw appError("E_SERVER_CORE_INSTALL_FAILED", `Minecraft ${minecraftVersion} 没有官方 server.jar 下载地址。`);
  }

  const total = taskCountForCore(options.core.type);
  await downloadFile(serverUrl, path.join(options.outputDir, "server.jar"), {
    fetchImpl,
    timeoutSeconds: options.timeoutSeconds ?? 120,
    onProgress: (event) => options.onProgress?.({ current: 0, total, ...event })
  });
  options.onProgress?.({ current: 1, total, label: "server.jar 下载完成", percent: 100 });
}

async function installFabric(options: PrepareServerCoreOptions): Promise<void> {
  await assertCompatibleJava(options);
  const fetchImpl = options.fetchImpl ?? fetch;
  const installerVersions = asArray(await fetchJson(fetchImpl, "https://meta.fabricmc.net/v2/versions/installer")).map(asRecord);
  const installerVersion = asString(installerVersions.find((item) => item.stable === true)?.version ?? installerVersions[0]?.version);
  if (!installerVersion) {
    throw appError("E_SERVER_CORE_INSTALL_FAILED", "找不到可用的 Fabric installer。");
  }

  const installerPath = path.join(options.outputDir, ".installer", `fabric-installer-${installerVersion}.jar`);
  const installerUrl = `https://maven.fabricmc.net/net/fabricmc/fabric-installer/${installerVersion}/fabric-installer-${installerVersion}.jar`;
  await downloadInstaller(options, installerUrl, installerPath, "Fabric installer");
  await runJavaInstaller(options, installerPath, [
    "server",
    "-mcversion",
    options.core.minecraftVersion!,
    "-loader",
    options.core.loaderVersion!,
    "-downloadMinecraft"
  ]);
}

async function installQuilt(options: PrepareServerCoreOptions): Promise<void> {
  await assertCompatibleJava(options);
  const fetchImpl = options.fetchImpl ?? fetch;
  const metadata = await fetchText(fetchImpl, "https://maven.quiltmc.org/repository/release/org/quiltmc/quilt-installer/maven-metadata.xml");
  const installerVersion = /<release>([^<]+)<\/release>/.exec(metadata)?.[1] ?? /<latest>([^<]+)<\/latest>/.exec(metadata)?.[1];
  if (!installerVersion) {
    throw appError("E_SERVER_CORE_INSTALL_FAILED", "找不到可用的 Quilt installer。");
  }

  const installerPath = path.join(options.outputDir, ".installer", `quilt-installer-${installerVersion}.jar`);
  const installerUrl = `https://maven.quiltmc.org/repository/release/org/quiltmc/quilt-installer/${installerVersion}/quilt-installer-${installerVersion}.jar`;
  await downloadInstaller(options, installerUrl, installerPath, "Quilt installer");
  await runJavaInstaller(options, installerPath, [
    "install",
    "server",
    options.core.minecraftVersion!,
    "--install-dir",
    options.outputDir,
    "--download-server",
    "--loader-version",
    options.core.loaderVersion!
  ]);
}

async function installForge(options: PrepareServerCoreOptions): Promise<void> {
  await assertCompatibleJava(options);
  const forgeVersion = normalizeMinecraftPrefixedVersion(options.core.minecraftVersion!, options.core.loaderVersion!);
  const installerPath = path.join(options.outputDir, ".installer", `forge-${forgeVersion}-installer.jar`);
  const installerUrl = `https://maven.minecraftforge.net/net/minecraftforge/forge/${forgeVersion}/forge-${forgeVersion}-installer.jar`;
  await downloadInstaller(options, installerUrl, installerPath, "Forge installer");
  await runJavaInstaller(options, installerPath, ["--installServer"]);
}

async function installNeoForge(options: PrepareServerCoreOptions): Promise<void> {
  await assertCompatibleJava(options);
  const minecraftVersion = options.core.minecraftVersion!;
  const loaderVersion = options.core.loaderVersion!;
  const legacy = loaderVersion.startsWith(`${minecraftVersion}-`) || minecraftVersion === "1.20.1";
  const neoForgeVersion = loaderVersion.startsWith(`${minecraftVersion}-`) ? loaderVersion : legacy ? `${minecraftVersion}-${loaderVersion}` : loaderVersion;
  const artifactPrefix = legacy ? "forge" : "neoforge";
  const modulePath = legacy ? "net/neoforged/forge" : "net/neoforged/neoforge";
  const installerName = `${artifactPrefix}-${neoForgeVersion}-installer.jar`;
  const installerPath = path.join(options.outputDir, ".installer", installerName);
  const installerUrl = `https://maven.neoforged.net/releases/${modulePath}/${neoForgeVersion}/${installerName}`;
  await downloadInstaller(options, installerUrl, installerPath, "NeoForge installer");
  await runJavaInstaller(options, installerPath, ["--installServer"]);
}

async function downloadInstaller(
  options: PrepareServerCoreOptions,
  url: string,
  installerPath: string,
  label: string
): Promise<void> {
  const total = taskCountForCore(options.core.type);
  await downloadFile(url, installerPath, {
    fetchImpl: options.fetchImpl ?? fetch,
    timeoutSeconds: options.timeoutSeconds ?? 120,
    onProgress: (event) => options.onProgress?.({ current: 0, total, ...event, label: event.label || label })
  });
  options.onProgress?.({ current: 1, total, label: `${label} 下载完成`, percent: 100 });
}

async function runJavaInstaller(options: PrepareServerCoreOptions, installerPath: string, args: string[]): Promise<void> {
  const total = taskCountForCore(options.core.type);
  const javaCommand = resolveJavaCommand(options.javaHome);
  options.onProgress?.({ current: 1, total, label: "运行服务端安装器" });
  options.onLog?.(`正在运行服务端安装器：${path.basename(installerPath)}`);

  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await execFileAsync(javaCommand, ["-jar", installerPath, ...args], {
        cwd: options.outputDir,
        env: buildJavaEnv(options.javaHome),
        timeout: (options.timeoutSeconds ?? 120) * 1000 * 10,
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true
      });
      options.onProgress?.({ current: total, total, label: "服务端核心安装完成", percent: 100 });
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 2) {
        options.onLog?.("服务端安装器执行失败，正在重试一次。");
      }
    }
  }

  throw appError("E_SERVER_CORE_INSTALL_FAILED", `服务端安装器执行失败：${formatExecError(lastError)}`, {
    suggestion: "请在应用内配置兼容的 Java Home，或取消“直接下载核心”后在服务器环境运行 install-server 脚本。"
  });
}

async function assertCompatibleJava(options: PrepareServerCoreOptions): Promise<void> {
  const core = options.core;
  const detected = await detectJavaMajor(options.javaHome);
  if (detected === null) {
    throw appError("E_SERVER_CORE_INSTALL_FAILED", "未检测到可用的 Java，无法直接安装服务端核心。", {
      suggestion: "请在应用内配置兼容的 Java Home，或取消“直接下载核心”后在服务器环境运行 install-server 脚本。"
    });
  }

  if (detected < core.javaMajor) {
    throw appError(
      "E_SERVER_CORE_INSTALL_FAILED",
      `当前 java 是 Java ${detected}，${core.type} ${core.minecraftVersion ?? ""} 需要 Java ${core.javaMajor} 或更高版本。`,
      {
        suggestion: "请在应用内配置兼容的 Java Home，或把 PATH 中的 java 切换到兼容版本。"
      }
    );
  }
}

async function detectJavaMajor(javaHome?: string): Promise<number | null> {
  const javaCommand = resolveJavaCommand(javaHome);
  try {
    const result = await execFileAsync(javaCommand, ["-version"], {
      env: buildJavaEnv(javaHome),
      timeout: 10_000,
      windowsHide: true
    });
    return parseJavaMajor(`${result.stdout}\n${result.stderr}`);
  } catch (error) {
    const maybeOutput = error as { stdout?: unknown; stderr?: unknown };
    const output = `${typeof maybeOutput.stdout === "string" ? maybeOutput.stdout : ""}\n${typeof maybeOutput.stderr === "string" ? maybeOutput.stderr : ""}`;
    return parseJavaMajor(output);
  }
}

function resolveJavaCommand(javaHome?: string): string {
  const normalized = javaHome?.trim();
  if (!normalized) {
    return "java";
  }
  return path.join(normalized, "bin", process.platform === "win32" ? "java.exe" : "java");
}

function buildJavaEnv(javaHome?: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const normalized = javaHome?.trim();
  if (!normalized) {
    return env;
  }

  env.JAVA_HOME = normalized;
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const currentPath = env[pathKey] ?? "";
  env[pathKey] = `${path.join(normalized, "bin")}${path.delimiter}${currentPath}`;
  return env;
}

function parseJavaMajor(output: string): number | null {
  const match = /version "(?<version>[^"]+)"/.exec(output) ?? /openjdk (?<version>\d+(?:\.\d+)?)/i.exec(output);
  const version = match?.groups?.version;
  if (!version) {
    return null;
  }

  const parts = version.split(".").map((part) => Number.parseInt(part, 10));
  const first = parts[0];
  const second = parts[1];
  if (first === undefined || !Number.isFinite(first)) {
    return null;
  }

  if (first === 1 && second !== undefined && Number.isFinite(second)) {
    return second;
  }

  return first;
}

function formatExecError(error: unknown): string {
  const baseMessage = error instanceof Error ? error.message : String(error);
  const maybeOutput = error as { stdout?: unknown; stderr?: unknown };
  const output = [maybeOutput.stdout, maybeOutput.stderr]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n")
    .trim();

  if (!output) {
    return baseMessage;
  }

  return `${baseMessage}\n${output.slice(-4000)}`;
}

async function downloadFile(url: string, destination: string, options: DownloadFileOptions): Promise<void> {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutSeconds * 1000);

  try {
    const response = await options.fetchImpl(url, { signal: controller.signal });
    if (!response.ok) {
      throw appError("E_SERVER_CORE_INSTALL_FAILED", `服务端核心下载失败：HTTP ${response.status}。`, {
        detail: { url, status: response.status }
      });
    }

    if (!response.body) {
      throw appError("E_SERVER_CORE_INSTALL_FAILED", "服务端核心下载响应没有文件内容。");
    }

    const totalBytes = parseContentLength(response.headers.get("content-length"));
    const output = createWriteStream(destination, { flags: "w" });
    const reader = response.body.getReader();
    let receivedBytes = 0;
    const label = path.basename(destination);

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        if (!value) {
          continue;
        }

        receivedBytes += value.byteLength;
        if (!output.write(Buffer.from(value))) {
          await once(output, "drain");
        }
        options.onProgress({
          label,
          receivedBytes,
          ...(totalBytes === undefined ? {} : { totalBytes, percent: Math.round((receivedBytes / totalBytes) * 100) })
        });
      }

      output.end();
      await once(output, "finish");
    } catch (error) {
      output.destroy();
      throw error;
    } finally {
      reader.releaseLock();
    }
  } catch (error) {
    await fs.rm(destination, { force: true }).catch(() => undefined);
    if (error instanceof Error && error.name === "AbortError") {
      throw appError("E_SERVER_CORE_INSTALL_FAILED", "服务端核心下载超时。");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJson(fetchImpl: typeof fetch, url: string): Promise<UnknownRecord> {
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw appError("E_SERVER_CORE_INSTALL_FAILED", `读取服务端核心元数据失败：HTTP ${response.status}。`, {
      detail: { url, status: response.status }
    });
  }
  return asRecord(await response.json());
}

async function fetchText(fetchImpl: typeof fetch, url: string): Promise<string> {
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw appError("E_SERVER_CORE_INSTALL_FAILED", `读取服务端核心元数据失败：HTTP ${response.status}。`, {
      detail: { url, status: response.status }
    });
  }
  return response.text();
}

function assertInstallableCore(core: ServerCorePlan): void {
  if (!core.minecraftVersion) {
    throw appError("E_SERVER_CORE_INSTALL_FAILED", "缺少 Minecraft 版本，无法直接下载服务端核心。");
  }

  if (core.type !== "vanilla" && !core.loaderVersion) {
    throw appError("E_SERVER_CORE_INSTALL_FAILED", `缺少 ${core.type} 加载器版本，无法直接下载服务端核心。`);
  }
}

function taskCountForCore(type: ServerCorePlan["type"]): number {
  return type === "vanilla" ? 1 : 2;
}

function normalizeMinecraftPrefixedVersion(minecraftVersion: string, loaderVersion: string): string {
  return loaderVersion.startsWith(`${minecraftVersion}-`) ? loaderVersion : `${minecraftVersion}-${loaderVersion}`;
}

async function cleanServerCoreArtifacts(outputDir: string): Promise<void> {
  const artifacts = [
    ".installer",
    "libraries",
    "server.jar",
    "fabric-server-launch.jar",
    "quilt-server-launch.jar",
    "run.bat",
    "run.sh"
  ];

  await Promise.all(
    artifacts.map((artifact) =>
      fs.rm(path.join(outputDir, artifact), { recursive: true, force: true }).catch(() => undefined)
    )
  );

  const generatedLogs = await fs.readdir(outputDir).catch(() => []);
  await Promise.all(
    generatedLogs
      .filter((fileName) => /^.+-installer\.jar\.log$/i.test(fileName))
      .map((fileName) => fs.rm(path.join(outputDir, fileName), { force: true }).catch(() => undefined))
  );
}

async function collectInstalledCoreFiles(outputDir: string): Promise<string[]> {
  const candidates = [
    "server.jar",
    "fabric-server-launch.jar",
    "quilt-server-launch.jar",
    "run.bat",
    "run.sh",
    "libraries/net/minecraft/server"
  ];
  const files: string[] = [];

  for (const candidate of candidates) {
    const absolutePath = path.join(outputDir, candidate);
    try {
      const stat = await fs.stat(absolutePath);
      if (stat.isFile() || stat.isDirectory()) {
        files.push(candidate.replaceAll("\\", "/"));
      }
    } catch {
      // Missing files are expected for other loaders.
    }
  }

  const forgeArgFiles = await collectForgeArgumentFiles(outputDir);
  files.push(...forgeArgFiles);
  return files;
}

async function assertInstalledCoreIsLaunchable(outputDir: string, core: ServerCorePlan): Promise<void> {
  switch (core.type) {
    case "vanilla":
      await requireFile(outputDir, "server.jar", "官方 server.jar 未生成。");
      return;
    case "fabric":
      await requireFile(outputDir, "fabric-server-launch.jar", "Fabric 服务端启动器未生成。");
      return;
    case "quilt":
      await requireFile(outputDir, "quilt-server-launch.jar", "Quilt 服务端启动器未生成。");
      return;
    case "forge":
    case "neoforge": {
      const forgeArgs = await collectForgeArgumentFiles(outputDir);
      if (forgeArgs.length > 0) {
        return;
      }
      throw appError(
        "E_SERVER_CORE_INSTALL_FAILED",
        `${core.type === "forge" ? "Forge" : "NeoForge"} 安装器执行结束，但没有生成可启动参数文件。`,
        {
          detail: {
            expectedFiles: [
              "libraries/net/minecraftforge/forge/*/win_args.txt",
              "libraries/net/minecraftforge/forge/*/unix_args.txt",
              "libraries/net/neoforged/forge/*/win_args.txt",
              "libraries/net/neoforged/forge/*/unix_args.txt",
              "libraries/net/neoforged/neoforge/*/win_args.txt",
              "libraries/net/neoforged/neoforge/*/unix_args.txt"
            ]
          },
          suggestion: "请删除当前输出目录后重新生成，并确认配置了兼容的 Java Home；也可以在输出目录手动运行 install-server.bat 查看安装器完整日志。"
        }
      );
    }
  }
}

async function requireFile(outputDir: string, relativePath: string, message: string): Promise<void> {
  const absolutePath = path.join(outputDir, relativePath);
  try {
    const stat = await fs.stat(absolutePath);
    if (stat.isFile()) {
      return;
    }
  } catch {
    // Handled below with a user-facing error.
  }

  throw appError("E_SERVER_CORE_INSTALL_FAILED", message, {
    detail: { expectedFile: relativePath },
    suggestion: "请删除当前输出目录后重新生成，并确认网络和 Java Home 配置可用。"
  });
}

async function collectForgeArgumentFiles(outputDir: string): Promise<string[]> {
  const roots = [
    path.join(outputDir, "libraries", "net", "minecraftforge", "forge"),
    path.join(outputDir, "libraries", "net", "neoforged", "forge"),
    path.join(outputDir, "libraries", "net", "neoforged", "neoforge")
  ];
  const files: string[] = [];

  for (const root of roots) {
    const versions = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
    for (const version of versions) {
      if (!version.isDirectory()) {
        continue;
      }
      for (const fileName of ["win_args.txt", "unix_args.txt"]) {
        const absolutePath = path.join(root, version.name, fileName);
        try {
          const stat = await fs.stat(absolutePath);
          if (stat.isFile()) {
            files.push(path.relative(outputDir, absolutePath).replaceAll("\\", "/"));
          }
        } catch {
          // Missing platform-specific args files are handled by validation.
        }
      }
    }
  }

  return files.sort();
}

function parseContentLength(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function asRecord(value: unknown): UnknownRecord {
  return typeof value === "object" && value !== null ? (value as UnknownRecord) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
