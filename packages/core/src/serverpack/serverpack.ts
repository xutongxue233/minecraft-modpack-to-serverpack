import fs from "node:fs/promises";
import path from "node:path";
import type { AnalyzeResult, ModDecision, ModFileDescriptor } from "@mcsp/shared";
import { extractZipEntries } from "../archive/zip";
import type { DownloadResult } from "../download/download";
import { selectServerCore, type ServerCorePlan } from "./server-core";

export interface ServerpackGenerationResult {
  core: ServerCorePlan;
  writtenModFiles: number;
  skippedModFiles: number;
  mergedOverrideFiles: number;
  installScripts: string[];
  startScripts: string[];
  supportFiles: string[];
  warnings: string[];
}

export interface GenerateServerpackOptions {
  inputPath: string;
  outputDir: string;
  analysis: AnalyzeResult;
  decisions: ModDecision[];
  downloadResultsByFile: Map<ModFileDescriptor, DownloadResult>;
}

const installScripts = ["install-server.ps1", "install-server.bat", "install-server.sh"] as const;
const startScripts = ["start.ps1", "start.bat", "start.sh"] as const;
const supportFiles = ["server-core.json", "user_jvm_args.txt", "eula.txt", "server.properties"] as const;

export async function generateServerpack(options: GenerateServerpackOptions): Promise<ServerpackGenerationResult> {
  const warnings: string[] = [];
  const core = selectServerCore(options.analysis.metadata, { hasMods: options.analysis.files.length > 0 });
  warnings.push(...core.warnings);

  const writtenModFiles = await writeIncludedMods({
    outputDir: options.outputDir,
    files: options.analysis.files,
    decisions: options.decisions,
    downloadResultsByFile: options.downloadResultsByFile,
    warnings
  });
  const skippedModFiles = Math.max(0, options.analysis.files.length - writtenModFiles);
  const mergedOverrideFiles = await mergeOverrides({
    inputPath: options.inputPath,
    outputDir: options.outputDir,
    analysis: options.analysis,
    warnings
  });

  await writeServerCoreFile(options.outputDir, core);
  await writeSupportFiles(options.outputDir);
  await writeInstallScripts(options.outputDir, core);
  await writeStartScripts(options.outputDir);

  return {
    core,
    writtenModFiles,
    skippedModFiles,
    mergedOverrideFiles,
    installScripts: [...installScripts],
    startScripts: [...startScripts],
    supportFiles: [...supportFiles],
    warnings
  };
}

async function writeIncludedMods({
  outputDir,
  files,
  decisions,
  downloadResultsByFile,
  warnings
}: {
  outputDir: string;
  files: ModFileDescriptor[];
  decisions: ModDecision[];
  downloadResultsByFile: Map<ModFileDescriptor, DownloadResult>;
  warnings: string[];
}): Promise<number> {
  const modsDir = path.join(outputDir, "mods");
  await fs.rm(modsDir, { recursive: true, force: true });
  await fs.mkdir(modsDir, { recursive: true });

  const usedNames = new Set<string>();
  let written = 0;

  for (const [index, file] of files.entries()) {
    const decision = decisions[index];
    if (decision?.decision !== "include") {
      continue;
    }

    const downloadResult = downloadResultsByFile.get(file);
    if (!downloadResult) {
      warnings.push(`${file.fileName} 已判定需要进入服务端，但没有可复制的下载文件。`);
      continue;
    }

    const fileName = uniqueFileName(sanitizeFileName(file.fileName), usedNames);
    await fs.copyFile(downloadResult.cachePath, path.join(modsDir, fileName));
    written += 1;
  }

  return written;
}

async function mergeOverrides({
  inputPath,
  outputDir,
  analysis,
  warnings
}: {
  inputPath: string;
  outputDir: string;
  analysis: AnalyzeResult;
  warnings: string[];
}): Promise<number> {
  if (analysis.overrides.client > 0) {
    warnings.push(`检测到 ${analysis.overrides.client} 个 client-overrides 文件，已按服务端包规则忽略。`);
  }

  if (analysis.metadata.type === "modrinth") {
    const common = await extractZipEntries(inputPath, outputDir, {
      prefixes: ["overrides/"],
      stripPrefix: "overrides/",
      shouldExtract: makeServerOverrideFilter(warnings)
    });
    const server = await extractZipEntries(inputPath, outputDir, {
      prefixes: ["server-overrides/"],
      stripPrefix: "server-overrides/",
      shouldExtract: makeServerOverrideFilter(warnings)
    });
    return common.length + server.length;
  }

  if (analysis.metadata.type === "curseforge") {
    const common = await extractZipEntries(inputPath, outputDir, {
      prefixes: ["overrides/"],
      stripPrefix: "overrides/",
      shouldExtract: makeServerOverrideFilter(warnings)
    });
    return common.length;
  }

  if (analysis.metadata.type === "packwiz") {
    warnings.push("packwiz 目录的远程 metafile 下载与 overrides 合并仍在开发中，本次仅生成核心脚本、报告和已下载文件。");
    return 0;
  }

  return 0;
}

async function writeServerCoreFile(outputDir: string, core: ServerCorePlan): Promise<void> {
  await fs.writeFile(path.join(outputDir, "server-core.json"), `${JSON.stringify(core, null, 2)}\n`, "utf8");
}

async function writeSupportFiles(outputDir: string): Promise<void> {
  await writeTextIfMissing(
    path.join(outputDir, "user_jvm_args.txt"),
    ["-Xms1G", "-Xmx4G", ""].join("\n")
  );
  await writeTextIfMissing(
    path.join(outputDir, "eula.txt"),
    ["# Set eula=true after reading https://aka.ms/MinecraftEULA", "eula=false", ""].join("\n")
  );
  await writeTextIfMissing(
    path.join(outputDir, "server.properties"),
    [
      "motd=Minecraft Serverpack Tool",
      "online-mode=true",
      "enable-command-block=false",
      "view-distance=10",
      "simulation-distance=10",
      ""
    ].join("\n")
  );
}

async function writeInstallScripts(outputDir: string, core: ServerCorePlan): Promise<void> {
  await fs.writeFile(path.join(outputDir, "install-server.ps1"), renderInstallPowerShell(core), "utf8");
  await fs.writeFile(path.join(outputDir, "install-server.bat"), renderInstallBatch(), "utf8");
  const shellPath = path.join(outputDir, "install-server.sh");
  await fs.writeFile(shellPath, renderInstallShell(core), "utf8");
  await chmodExecutable(shellPath);
}

async function writeStartScripts(outputDir: string): Promise<void> {
  await fs.writeFile(path.join(outputDir, "start.ps1"), renderStartPowerShell(), "utf8");
  await fs.writeFile(path.join(outputDir, "start.bat"), renderStartBatch(), "utf8");
  const shellPath = path.join(outputDir, "start.sh");
  await fs.writeFile(shellPath, renderStartShell(), "utf8");
  await chmodExecutable(shellPath);
}

async function writeTextIfMissing(filePath: string, content: string): Promise<void> {
  try {
    await fs.writeFile(filePath, content, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      return;
    }
    throw error;
  }
}

function makeServerOverrideFilter(warnings: string[]): (relativePath: string, entryName: string) => boolean {
  const warned = new Set<string>();

  return (relativePath, entryName) => {
    const reason = getOverrideSkipReason(relativePath);
    if (!reason) {
      return true;
    }

    const warningKey = `${reason}:${entryName}`;
    if (!warned.has(warningKey)) {
      warned.add(warningKey);
      warnings.push(`已跳过服务端不需要的 override：${entryName}（${reason}）。`);
    }
    return false;
  };
}

function getOverrideSkipReason(relativePath: string): string | null {
  const normalized = relativePath.replaceAll("\\", "/").replace(/^\/+/, "");
  const lower = normalized.toLowerCase();

  if (!lower || lower.endsWith("/")) {
    return null;
  }

  const exactClientFiles = new Set([
    "options.txt",
    "optionsof.txt",
    "servers.dat",
    "servers.dat_old",
    "launcher_profiles.json",
    "realms_persistence.json",
    "hotkeys.ini",
    "optionsshaders.txt"
  ]);

  if (exactClientFiles.has(lower)) {
    return "客户端本地配置";
  }

  const clientDirs = [
    "shaderpacks/",
    "resourcepacks/",
    "screenshots/",
    "saves/",
    "logs/",
    "crash-reports/",
    "versions/",
    "mods/"
  ];

  if (clientDirs.some((dir) => lower.startsWith(dir))) {
    return "客户端目录或未审计 Mod 文件";
  }

  const clientConfigPrefixes = [
    "config/iris",
    "config/sodium",
    "config/oculus",
    "config/xaero",
    "config/journeymap",
    "config/roughlyenoughitems",
    "config/emi",
    "config/jei-client",
    "config/voicechat-client",
    "config/fancymenu",
    "config/konkrete"
  ];

  if (clientConfigPrefixes.some((prefix) => lower.startsWith(prefix))) {
    return "常见客户端 Mod 配置";
  }

  return null;
}

function renderInstallPowerShell(core: ServerCorePlan): string {
  const minecraftVersion = core.minecraftVersion ?? "__MISSING_MINECRAFT_VERSION__";
  const loaderVersion = core.loaderVersion ?? "__MISSING_LOADER_VERSION__";

  return [
    "$ErrorActionPreference = \"Stop\"",
    "Set-Location $PSScriptRoot",
    "",
    `$MinecraftVersion = ${psString(minecraftVersion)}`,
    `$Loader = ${psString(core.type)}`,
    `$LoaderVersion = ${psString(loaderVersion)}`,
    "$InstallerDir = Join-Path $PSScriptRoot \".installer\"",
    "New-Item -ItemType Directory -Force -Path $InstallerDir | Out-Null",
    "",
    "function Assert-VersionValue {",
    "  param([string]$Name, [string]$Value)",
    "  if ([string]::IsNullOrWhiteSpace($Value) -or $Value.StartsWith(\"__MISSING_\")) {",
    "    throw \"$Name 缺失，请先编辑 install-server.ps1 或重新生成包含完整版本信息的服务端包。\"",
    "  }",
    "}",
    "",
    "function Download-File {",
    "  param([string]$Url, [string]$Destination)",
    "  Write-Host \"Downloading $Url\"",
    "  Invoke-WebRequest -Uri $Url -OutFile $Destination",
    "}",
    "",
    "Assert-VersionValue \"MinecraftVersion\" $MinecraftVersion",
    "",
    "switch ($Loader) {",
    "  \"vanilla\" {",
    "    $manifest = Invoke-RestMethod -Uri \"https://piston-meta.mojang.com/mc/game/version_manifest_v2.json\"",
    "    $versionInfo = $manifest.versions | Where-Object { $_.id -eq $MinecraftVersion } | Select-Object -First 1",
    "    if (-not $versionInfo) { throw \"找不到 Minecraft $MinecraftVersion 的官方服务端下载信息。\" }",
    "    $versionManifest = Invoke-RestMethod -Uri $versionInfo.url",
    "    $serverUrl = $versionManifest.downloads.server.url",
    "    if (-not $serverUrl) { throw \"Minecraft $MinecraftVersion 没有官方 server.jar 下载地址。\" }",
    "    Download-File $serverUrl (Join-Path $PSScriptRoot \"server.jar\")",
    "  }",
    "  \"fabric\" {",
    "    Assert-VersionValue \"LoaderVersion\" $LoaderVersion",
    "    $installerVersions = Invoke-RestMethod -Uri \"https://meta.fabricmc.net/v2/versions/installer\"",
    "    $installerVersion = ($installerVersions | Where-Object { $_.stable -eq $true } | Select-Object -First 1).version",
    "    if (-not $installerVersion) { throw \"找不到稳定版 Fabric installer。\" }",
    "    $installerPath = Join-Path $InstallerDir \"fabric-installer-$installerVersion.jar\"",
    "    Download-File \"https://maven.fabricmc.net/net/fabricmc/fabric-installer/$installerVersion/fabric-installer-$installerVersion.jar\" $installerPath",
    "    & java -jar $installerPath server -mcversion $MinecraftVersion -loader $LoaderVersion -downloadMinecraft",
    "  }",
    "  \"quilt\" {",
    "    Assert-VersionValue \"LoaderVersion\" $LoaderVersion",
    "    $metadataContent = (Invoke-WebRequest -Uri \"https://maven.quiltmc.org/repository/release/org/quiltmc/quilt-installer/maven-metadata.xml\").Content",
    "    [xml]$metadata = $metadataContent",
    "    $installerVersion = $metadata.metadata.versioning.release",
    "    if (-not $installerVersion) { throw \"找不到 Quilt installer 版本。\" }",
    "    $installerPath = Join-Path $InstallerDir \"quilt-installer-$installerVersion.jar\"",
    "    Download-File \"https://maven.quiltmc.org/repository/release/org/quiltmc/quilt-installer/$installerVersion/quilt-installer-$installerVersion.jar\" $installerPath",
    "    & java -jar $installerPath install server $MinecraftVersion --install-dir $PSScriptRoot --download-server --loader-version $LoaderVersion",
    "  }",
    "  \"forge\" {",
    "    Assert-VersionValue \"LoaderVersion\" $LoaderVersion",
    "    if ($LoaderVersion.StartsWith(\"$MinecraftVersion-\")) { $ForgeVersion = $LoaderVersion } else { $ForgeVersion = \"$MinecraftVersion-$LoaderVersion\" }",
    "    $installerPath = Join-Path $InstallerDir \"forge-$ForgeVersion-installer.jar\"",
    "    Download-File \"https://maven.minecraftforge.net/net/minecraftforge/forge/$ForgeVersion/forge-$ForgeVersion-installer.jar\" $installerPath",
    "    & java -jar $installerPath --installServer",
    "  }",
    "  \"neoforge\" {",
    "    Assert-VersionValue \"LoaderVersion\" $LoaderVersion",
    "    if ($LoaderVersion.StartsWith(\"$MinecraftVersion-\")) {",
    "      $NeoForgeVersion = $LoaderVersion",
    "      $installerName = \"forge-$NeoForgeVersion-installer.jar\"",
    "      $installerUrl = \"https://maven.neoforged.net/releases/net/neoforged/forge/$NeoForgeVersion/$installerName\"",
    "    } elseif ($MinecraftVersion -eq \"1.20.1\") {",
    "      $NeoForgeVersion = \"$MinecraftVersion-$LoaderVersion\"",
    "      $installerName = \"forge-$NeoForgeVersion-installer.jar\"",
    "      $installerUrl = \"https://maven.neoforged.net/releases/net/neoforged/forge/$NeoForgeVersion/$installerName\"",
    "    } else {",
    "      $NeoForgeVersion = $LoaderVersion",
    "      $installerName = \"neoforge-$NeoForgeVersion-installer.jar\"",
    "      $installerUrl = \"https://maven.neoforged.net/releases/net/neoforged/neoforge/$NeoForgeVersion/$installerName\"",
    "    }",
    "    $installerPath = Join-Path $InstallerDir $installerName",
    "    Download-File $installerUrl $installerPath",
    "    & java -jar $installerPath --installServer",
    "  }",
    "  default { throw \"不支持的服务端核心：$Loader\" }",
    "}",
    "",
    "Write-Host \"Server core installed. Review eula.txt, then run start.ps1 or start.bat.\"",
    ""
  ].join("\n");
}

function renderInstallBatch(): string {
  return [
    "@echo off",
    "setlocal",
    "cd /d \"%~dp0\"",
    "powershell -NoProfile -ExecutionPolicy Bypass -File \"%~dp0install-server.ps1\"",
    "exit /b %ERRORLEVEL%",
    ""
  ].join("\r\n");
}

function renderInstallShell(core: ServerCorePlan): string {
  const minecraftVersion = shString(core.minecraftVersion ?? "__MISSING_MINECRAFT_VERSION__");
  const loader = shString(core.type);
  const loaderVersion = shString(core.loaderVersion ?? "__MISSING_LOADER_VERSION__");

  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "cd \"$(dirname \"$0\")\"",
    "",
    `MINECRAFT_VERSION=${minecraftVersion}`,
    `LOADER=${loader}`,
    `LOADER_VERSION=${loaderVersion}`,
    "INSTALLER_DIR=\".installer\"",
    "mkdir -p \"$INSTALLER_DIR\"",
    "",
    "require_value() {",
    "  local name=\"$1\"",
    "  local value=\"$2\"",
    "  if [[ -z \"$value\" || \"$value\" == __MISSING_* ]]; then",
    "    echo \"$name is missing. Edit install-server.sh or regenerate the serverpack with complete metadata.\" >&2",
    "    exit 1",
    "  fi",
    "}",
    "",
    "download() {",
    "  local url=\"$1\"",
    "  local destination=\"$2\"",
    "  echo \"Downloading $url\"",
    "  curl -fL \"$url\" -o \"$destination\"",
    "}",
    "",
    "require_value \"MINECRAFT_VERSION\" \"$MINECRAFT_VERSION\"",
    "",
    "case \"$LOADER\" in",
    "  vanilla)",
    "    server_url=$(python3 - \"$MINECRAFT_VERSION\" <<'PY'",
    "import json, sys, urllib.request",
    "mc = sys.argv[1]",
    "manifest = json.load(urllib.request.urlopen('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'))",
    "version = next((item for item in manifest['versions'] if item['id'] == mc), None)",
    "if version is None:",
    "    raise SystemExit(f'Minecraft {mc} was not found in Mojang version manifest')",
    "version_manifest = json.load(urllib.request.urlopen(version['url']))",
    "print(version_manifest['downloads']['server']['url'])",
    "PY",
    "    )",
    "    download \"$server_url\" \"server.jar\"",
    "    ;;",
    "  fabric)",
    "    require_value \"LOADER_VERSION\" \"$LOADER_VERSION\"",
    "    installer_version=$(python3 - <<'PY'",
    "import json, urllib.request",
    "versions = json.load(urllib.request.urlopen('https://meta.fabricmc.net/v2/versions/installer'))",
    "print(next(item['version'] for item in versions if item.get('stable')))",
    "PY",
    "    )",
    "    installer_path=\"$INSTALLER_DIR/fabric-installer-$installer_version.jar\"",
    "    download \"https://maven.fabricmc.net/net/fabricmc/fabric-installer/$installer_version/fabric-installer-$installer_version.jar\" \"$installer_path\"",
    "    java -jar \"$installer_path\" server -mcversion \"$MINECRAFT_VERSION\" -loader \"$LOADER_VERSION\" -downloadMinecraft",
    "    ;;",
    "  quilt)",
    "    require_value \"LOADER_VERSION\" \"$LOADER_VERSION\"",
    "    installer_version=$(python3 - <<'PY'",
    "import urllib.request, xml.etree.ElementTree as ET",
    "xml = urllib.request.urlopen('https://maven.quiltmc.org/repository/release/org/quiltmc/quilt-installer/maven-metadata.xml').read()",
    "print(ET.fromstring(xml).findtext('./versioning/release'))",
    "PY",
    "    )",
    "    installer_path=\"$INSTALLER_DIR/quilt-installer-$installer_version.jar\"",
    "    download \"https://maven.quiltmc.org/repository/release/org/quiltmc/quilt-installer/$installer_version/quilt-installer-$installer_version.jar\" \"$installer_path\"",
    "    java -jar \"$installer_path\" install server \"$MINECRAFT_VERSION\" --install-dir \"$PWD\" --download-server --loader-version \"$LOADER_VERSION\"",
    "    ;;",
    "  forge)",
    "    require_value \"LOADER_VERSION\" \"$LOADER_VERSION\"",
    "    if [[ \"$LOADER_VERSION\" == \"$MINECRAFT_VERSION-\"* ]]; then FORGE_VERSION=\"$LOADER_VERSION\"; else FORGE_VERSION=\"$MINECRAFT_VERSION-$LOADER_VERSION\"; fi",
    "    installer_path=\"$INSTALLER_DIR/forge-$FORGE_VERSION-installer.jar\"",
    "    download \"https://maven.minecraftforge.net/net/minecraftforge/forge/$FORGE_VERSION/forge-$FORGE_VERSION-installer.jar\" \"$installer_path\"",
    "    java -jar \"$installer_path\" --installServer",
    "    ;;",
    "  neoforge)",
    "    require_value \"LOADER_VERSION\" \"$LOADER_VERSION\"",
    "    if [[ \"$LOADER_VERSION\" == \"$MINECRAFT_VERSION-\"* ]]; then",
    "      NEOFORGE_VERSION=\"$LOADER_VERSION\"",
    "      installer_name=\"forge-$NEOFORGE_VERSION-installer.jar\"",
    "      installer_url=\"https://maven.neoforged.net/releases/net/neoforged/forge/$NEOFORGE_VERSION/$installer_name\"",
    "    elif [[ \"$MINECRAFT_VERSION\" == \"1.20.1\" ]]; then",
    "      NEOFORGE_VERSION=\"$MINECRAFT_VERSION-$LOADER_VERSION\"",
    "      installer_name=\"forge-$NEOFORGE_VERSION-installer.jar\"",
    "      installer_url=\"https://maven.neoforged.net/releases/net/neoforged/forge/$NEOFORGE_VERSION/$installer_name\"",
    "    else",
    "      NEOFORGE_VERSION=\"$LOADER_VERSION\"",
    "      installer_name=\"neoforge-$NEOFORGE_VERSION-installer.jar\"",
    "      installer_url=\"https://maven.neoforged.net/releases/net/neoforged/neoforge/$NEOFORGE_VERSION/$installer_name\"",
    "    fi",
    "    installer_path=\"$INSTALLER_DIR/$installer_name\"",
    "    download \"$installer_url\" \"$installer_path\"",
    "    java -jar \"$installer_path\" --installServer",
    "    ;;",
    "  *)",
    "    echo \"Unsupported server core: $LOADER\" >&2",
    "    exit 1",
    "    ;;",
    "esac",
    "",
    "echo \"Server core installed. Review eula.txt, then run start.sh.\"",
    ""
  ].join("\n");
}

function renderStartPowerShell(): string {
  return [
    "$ErrorActionPreference = \"Stop\"",
    "Set-Location $PSScriptRoot",
    "",
    "if (Test-Path \".\\run.bat\") {",
    "  & \".\\run.bat\"",
    "  exit $LASTEXITCODE",
    "}",
    "",
    "$Jar = @(\"fabric-server-launch.jar\", \"quilt-server-launch.jar\", \"server.jar\") | Where-Object { Test-Path $_ } | Select-Object -First 1",
    "if (-not $Jar) {",
    "  throw \"没有找到可启动的服务端核心。请先运行 install-server.ps1，或手动放入 server.jar。\"",
    "}",
    "",
    "& java \"@user_jvm_args.txt\" -jar $Jar nogui",
    "exit $LASTEXITCODE",
    ""
  ].join("\n");
}

function renderStartBatch(): string {
  return [
    "@echo off",
    "setlocal",
    "cd /d \"%~dp0\"",
    "if exist run.bat (",
    "  call run.bat",
    "  exit /b %ERRORLEVEL%",
    ")",
    "if exist fabric-server-launch.jar (",
    "  java @user_jvm_args.txt -jar fabric-server-launch.jar nogui",
    "  exit /b %ERRORLEVEL%",
    ")",
    "if exist quilt-server-launch.jar (",
    "  java @user_jvm_args.txt -jar quilt-server-launch.jar nogui",
    "  exit /b %ERRORLEVEL%",
    ")",
    "if exist server.jar (",
    "  java @user_jvm_args.txt -jar server.jar nogui",
    "  exit /b %ERRORLEVEL%",
    ")",
    "echo No server core found. Run install-server.bat first, or place server.jar in this directory.",
    "exit /b 1",
    ""
  ].join("\r\n");
}

function renderStartShell(): string {
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "cd \"$(dirname \"$0\")\"",
    "",
    "if [[ -f ./run.sh ]]; then",
    "  chmod +x ./run.sh",
    "  exec ./run.sh \"$@\"",
    "fi",
    "",
    "for jar in fabric-server-launch.jar quilt-server-launch.jar server.jar; do",
    "  if [[ -f \"$jar\" ]]; then",
    "    exec java @user_jvm_args.txt -jar \"$jar\" nogui",
    "  fi",
    "done",
    "",
    "echo \"No server core found. Run install-server.sh first, or place server.jar in this directory.\" >&2",
    "exit 1",
    ""
  ].join("\n");
}

function sanitizeFileName(fileName: string): string {
  const sanitized = path.basename(fileName).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim();
  return sanitized || "mod.jar";
}

function uniqueFileName(fileName: string, usedNames: Set<string>): string {
  if (!usedNames.has(fileName)) {
    usedNames.add(fileName);
    return fileName;
  }

  const extension = path.extname(fileName);
  const stem = extension ? fileName.slice(0, -extension.length) : fileName;
  let suffix = 2;

  while (true) {
    const candidate = `${stem}-${suffix}${extension}`;
    if (!usedNames.has(candidate)) {
      usedNames.add(candidate);
      return candidate;
    }
    suffix += 1;
  }
}

function psString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function shString(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function chmodExecutable(filePath: string): Promise<void> {
  await fs.chmod(filePath, 0o755).catch(() => undefined);
}
