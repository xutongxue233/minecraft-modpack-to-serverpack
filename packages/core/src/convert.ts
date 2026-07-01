import fs from "node:fs/promises";
import path from "node:path";
import {
  type AppError,
  type ConversionReport,
  type ConversionRequest,
  type ConversionResult,
  type JobEvent,
  type ModDecision,
  type ModFileDescriptor,
  appError,
  unknownToAppError
} from "@mcsp/shared";
import { analyzeInput } from "./analyze";
import { type DownloadOptions, type DownloadResult, downloadFileToCache } from "./download/download";
import { enrichAnalysisWithPlatformMetadata } from "./metadata/platform-metadata";
import { decideMods } from "./mod-analysis/decisions";
import { inferModNameFromFile, scanDownloadedJarMetadata, type JarModMetadata } from "./mod-analysis/jar-metadata";
import {
  defaultRemoteModRulesUrl,
  loadModDecisionRules,
  loadRemoteModDecisionRules,
  ruleContextFromMetadata
} from "./mod-analysis/user-rules";
import { prepareServerCore, skippedServerCoreInstallResult, type ServerCoreInstallResult } from "./serverpack/core-installer";
import { selectServerCore } from "./serverpack/server-core";
import { generateServerpack, type ServerpackGenerationResult } from "./serverpack/serverpack";
import {
  runServerpackStartupTest,
  type RunStartupTestOptions,
  type StartupTestResult
} from "./serverpack/startup-test";
import { createServerpackZip } from "./serverpack/zip-output";

type ReportDownloadStatus = ConversionReport["files"][number]["downloadStatus"];

export interface RunConversionOptions {
  jobId?: string;
  cacheDir?: string;
  curseForgeApiKey?: string;
  fetchImpl?: typeof fetch;
  onEvent?: (event: JobEvent) => void;
  now?: () => Date;
  startupTestRunner?: (options: RunStartupTestOptions) => Promise<StartupTestResult>;
}

export async function runConversion(
  request: ConversionRequest,
  options: RunConversionOptions = {}
): Promise<ConversionResult> {
  const jobId = options.jobId ?? "conversion";
  const emit = (event: JobEvent): void => options.onEvent?.(event);

  emit({ type: "phase", jobId, phase: "analyzing", message: "正在解析整合包" });
  const parsedAnalysis = await analyzeInput(request.inputPath);
  const analysis = await enrichAnalysisWithPlatformMetadata(parsedAnalysis, {
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.curseForgeApiKey === undefined ? {} : { curseForgeApiKey: options.curseForgeApiKey }),
    onWarning: (message) => emit({ type: "log", jobId, level: "warn", message })
  });

  const outputDir = path.join(request.outputDir, `${sanitizePathSegment(analysis.metadata.name)}-serverpack`);
  const zipPath = request.settings?.outputZip ? `${outputDir}.zip` : undefined;
  const reportPath = path.join(outputDir, "conversion-report.json");
  const readmePath = path.join(outputDir, "README.md");
  const cacheDir =
    request.settings?.cacheDir ?? options.cacheDir ?? path.join(request.outputDir, ".mcsp-cache", "downloads");
  const warnings = [...analysis.warnings];

  await fs.mkdir(outputDir, { recursive: true });

  const missingUrlFiles = analysis.files.filter((file) => file.downloadUrls.length === 0);
  for (const file of missingUrlFiles) {
    warnings.push(`${file.fileName} 没有下载地址，当前报告会标记为 missing-url。`);
  }

  const ruleContext = ruleContextFromMetadata(analysis.metadata);
  const fileRules = await loadModDecisionRules(request.settings?.modRulesPath, ruleContext);
  if (fileRules.length > 0) {
    emit({ type: "log", jobId, level: "info", message: `已读取 ${fileRules.length} 条用户规则。` });
  }
  const remoteRulesEnabled = request.settings?.remoteRulesEnabled ?? false;
  const remoteRules = remoteRulesEnabled
    ? await loadRemoteModDecisionRules({
        url: request.settings?.remoteRulesUrl ?? defaultRemoteModRulesUrl,
        cacheDir:
          request.settings?.remoteRulesCacheDir ??
          path.join(request.outputDir, ".mcsp-cache", "rules"),
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
        context: ruleContext,
        onLog: (message) => emit({ type: "log", jobId, level: "info", message }),
        onWarning: (message) => {
          warnings.push(message);
          emit({ type: "log", jobId, level: "warn", message });
        }
      })
    : [];
  if (remoteRules.length > 0) {
    emit({ type: "log", jobId, level: "info", message: `已加载 ${remoteRules.length} 条远程项目规则。` });
  }

  const downloadableFiles = analysis.files.filter((file) => file.downloadUrls.length > 0);
  const downloadResultsByFile = new Map<ModFileDescriptor, DownloadResult>();
  const downloadErrorsByFile = new Map<ModFileDescriptor, string>();
  let jarMetadataByFile = new Map<ModFileDescriptor, JarModMetadata>();
  const serverCore = selectServerCore(analysis.metadata, { hasMods: analysis.files.length > 0 });
  const shouldDownloadServerCore = request.settings?.downloadServerCore ?? false;
  const shouldTestStartScript = request.settings?.testStartScript ?? shouldDownloadServerCore;
  const coreInstallPromise = shouldDownloadServerCore
    ? prepareServerCore({
        outputDir,
        core: serverCore,
        enabled: true,
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
        ...(request.settings?.downloadTimeoutSeconds === undefined
          ? {}
          : { timeoutSeconds: request.settings.downloadTimeoutSeconds }),
        ...(request.settings?.javaHome === undefined ? {} : { javaHome: request.settings.javaHome }),
        onProgress: (event) => {
          emit({
            type: "progress",
            jobId,
            group: "core",
            current: event.current,
            total: event.total,
            label: event.label,
            ...(event.percent === undefined ? {} : { percent: event.percent }),
            ...(event.receivedBytes === undefined ? {} : { receivedBytes: event.receivedBytes }),
            ...(event.totalBytes === undefined ? {} : { totalBytes: event.totalBytes })
          });
        },
        onLog: (message) => emit({ type: "log", jobId, level: "info", message })
      })
    : Promise.resolve(skippedServerCoreInstallResult());
  let coreInstall: ServerCoreInstallResult = skippedServerCoreInstallResult();

  if (downloadableFiles.length > 0 || shouldDownloadServerCore) {
    const downloadMessage =
      downloadableFiles.length > 0 && shouldDownloadServerCore
        ? "正在并行下载 Mod 文件和服务端核心"
        : shouldDownloadServerCore
          ? "正在下载服务端核心"
          : "正在下载并校验 Mod 文件";
    emit({ type: "phase", jobId, phase: "downloading", message: downloadMessage });
  }

  if (downloadableFiles.length > 0) {
    let completedDownloadFiles = 0;
    const downloadResults = await downloadFilesBestEffort(downloadableFiles, {
      cacheDir,
      ...(request.settings?.downloadConcurrent === undefined ? {} : { concurrent: request.settings.downloadConcurrent }),
      ...(request.settings?.downloadRetry === undefined ? {} : { retry: request.settings.downloadRetry }),
      ...(request.settings?.downloadTimeoutSeconds === undefined
        ? {}
        : { timeoutSeconds: request.settings.downloadTimeoutSeconds }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      onProgress: (event) => {
        if (event.type === "retry") {
          emit({
            type: "log",
            jobId,
            level: "warn",
            message: `${event.fileName} 下载失败，正在重试 ${event.attempt}/${event.maxAttempts}。`
          });
        }
        if (event.type === "file-start") {
          emit({
            type: "progress",
            jobId,
            group: "mods",
            current: completedDownloadFiles,
            total: downloadableFiles.length,
            label: `正在下载 ${event.fileName}`,
            percent: Math.round((completedDownloadFiles / downloadableFiles.length) * 100)
          });
        }
        if (event.type === "file-progress") {
          emit({
            type: "progress",
            jobId,
            group: "mods",
            current: completedDownloadFiles,
            total: downloadableFiles.length,
            label: `正在下载 ${event.fileName}`,
            percent: Math.round((completedDownloadFiles / downloadableFiles.length) * 100)
          });
        }
      }
    }, (completedFiles) => {
      completedDownloadFiles = completedFiles;
      emit({
        type: "progress",
        jobId,
        group: "mods",
        current: completedFiles,
        total: downloadableFiles.length,
        label: `Mod 文件 ${completedFiles}/${downloadableFiles.length}`,
        percent: Math.round((completedFiles / downloadableFiles.length) * 100)
      });
    });

    for (const result of downloadResults.results) {
      downloadResultsByFile.set(result.file, result);
    }
    for (const failure of downloadResults.failures) {
      downloadErrorsByFile.set(failure.file, failure.error);
      warnings.push(`${failure.file.fileName} 下载失败：${failure.error}`);
      emit({
        type: "log",
        jobId,
        level: "warn",
        message: `${failure.file.fileName} 下载失败，报告将标记为 failed。`
      });
    }

    emit({ type: "phase", jobId, phase: "verifying", message: "正在读取 Mod 元数据" });
    jarMetadataByFile = await scanDownloadedJarMetadata(downloadResults.results);
  }

  coreInstall = await coreInstallPromise;
  if (coreInstall.status === "failed" && coreInstall.error) {
    warnings.push(`服务端核心直接下载失败：${coreInstall.error}`);
    emit({ type: "log", jobId, level: "warn", message: `服务端核心直接下载失败：${coreInstall.error}` });
  }

  emit({ type: "phase", jobId, phase: "reviewing", message: "正在生成服务端 Mod 决策" });
  const decisions = decideMods(analysis.files, {
    unknownPolicy: request.settings?.unknownPolicy ?? "include",
    metadataByFile: jarMetadataByFile,
    overrides: [...remoteRules, ...fileRules]
  });

  emit({ type: "phase", jobId, phase: "packaging", message: "正在生成服务端目录、脚本和 overrides" });
  const serverpack = await generateServerpack({
    inputPath: request.inputPath,
    outputDir,
    analysis,
    decisions,
    downloadResultsByFile,
    core: serverCore,
    coreInstall,
    ...(request.settings?.javaHome === undefined ? {} : { javaHome: request.settings.javaHome }),
    ...(request.settings?.generateOptimizedStartScript === undefined
      ? {}
      : { generateOptimizedStartScript: request.settings.generateOptimizedStartScript })
  });
  warnings.push(...serverpack.warnings);

  let startupTest: StartupTestResult = {
    enabled: shouldTestStartScript,
    status: "skipped",
    reason: shouldTestStartScript ? "服务端核心未直接安装，跳过启动脚本测试。" : "未启用启动脚本测试。"
  };
  let deferredFailure: AppError | undefined;

  if (shouldTestStartScript && coreInstall.status === "installed") {
    emit({ type: "phase", jobId, phase: "testing", message: "正在运行启动脚本测试" });
    const startupTestRunner = options.startupTestRunner ?? runServerpackStartupTest;
    try {
      startupTest = await startupTestRunner({
        outputDir,
        ...(request.settings?.startupTestTimeoutSeconds === undefined
          ? {}
          : { timeoutSeconds: request.settings.startupTestTimeoutSeconds }),
        ...(request.settings?.javaHome === undefined ? {} : { javaHome: request.settings.javaHome }),
        onLog: (level, message) => emit({ type: "log", jobId, level, message })
      });
    } catch (error) {
      deferredFailure = unknownToAppError(error, "E_STARTUP_TEST_FAILED");
      startupTest = {
        enabled: true,
        status: "failed",
        reason: deferredFailure.message
      };
      warnings.push(`启动脚本测试失败：${deferredFailure.message}`);
      emit({ type: "log", jobId, level: "error", message: `启动脚本测试失败：${deferredFailure.message}` });
    }
  } else if (shouldTestStartScript) {
    deferredFailure = appError("E_STARTUP_TEST_SKIPPED", "已启用启动脚本测试，但服务端核心未安装成功。", {
      detail: { coreInstallStatus: coreInstall.status, coreInstallError: coreInstall.error },
      suggestion: "请开启“直接下载核心”并确认核心安装成功，或关闭“启动脚本测试”后只生成服务端包文件。"
    });
    startupTest = {
      enabled: true,
      status: "failed",
      reason: deferredFailure.message
    };
    warnings.push(`启动脚本测试跳过：${deferredFailure.message}`);
    emit({ type: "log", jobId, level: "error", message: deferredFailure.message });
  }

  const finalZipPath = deferredFailure === undefined ? zipPath : undefined;
  const report = buildConversionReport({
    request,
    analysis,
    decisions,
    downloadResultsByFile,
    downloadErrorsByFile,
    jarMetadataByFile,
    serverpack,
    startupTest,
    ...(finalZipPath === undefined ? {} : { zipPath: finalZipPath }),
    warnings,
    ...(deferredFailure === undefined ? {} : { errors: [deferredFailure] }),
    now: options.now ?? (() => new Date())
  });

  emit({ type: "phase", jobId, phase: "packaging", message: "正在写入报告和部署说明" });
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
  await fs.writeFile(readmePath, renderReadme(report), "utf8");

  if (zipPath && deferredFailure === undefined) {
    emit({ type: "phase", jobId, phase: "packaging", message: "正在打包服务端 zip" });
    await createServerpackZip(outputDir, zipPath);
  }

  if (deferredFailure !== undefined) {
    throw withFailureOutputDetail(deferredFailure, outputDir, reportPath);
  }

  emit({ type: "completed", jobId, outputDir, reportPath, ...(zipPath === undefined ? {} : { zipPath }) });
  return {
    outputDir,
    reportPath,
    readmePath,
    ...(zipPath === undefined ? {} : { zipPath }),
    report
  };
}

function withFailureOutputDetail(error: AppError, outputDir: string, reportPath: string): AppError {
  const originalDetail =
    typeof error.detail === "object" && error.detail !== null && !Array.isArray(error.detail)
      ? error.detail
      : error.detail === undefined
        ? {}
        : { cause: error.detail };

  return {
    ...error,
    detail: {
      ...originalDetail,
      outputDir,
      reportPath
    }
  };
}

async function downloadFilesBestEffort(
  files: ModFileDescriptor[],
  options: DownloadOptions,
  onSettled: (completedFiles: number) => void
): Promise<{ results: DownloadResult[]; failures: Array<{ file: ModFileDescriptor; error: string }> }> {
  const concurrent = Math.max(1, Math.min(options.concurrent ?? 4, 16));
  const results: DownloadResult[] = [];
  const failures: Array<{ file: ModFileDescriptor; error: string }> = [];
  let nextIndex = 0;
  let completedFiles = 0;

  async function worker(): Promise<void> {
    while (nextIndex < files.length) {
      const index = nextIndex;
      nextIndex += 1;
      const file = files[index];
      if (!file) {
        continue;
      }

      try {
        results.push(await downloadFileToCache(file, options));
      } catch (error) {
        failures.push({
          file,
          error: unknownToAppError(error, "E_DOWNLOAD_FAILED").message
        });
      } finally {
        completedFiles += 1;
        onSettled(completedFiles);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrent, files.length) }, () => worker()));
  return { results, failures };
}

function buildConversionReport({
  request,
  analysis,
  decisions,
  downloadResultsByFile,
  downloadErrorsByFile,
  jarMetadataByFile,
  serverpack,
  startupTest,
  zipPath,
  warnings,
  errors = [],
  now
}: {
  request: ConversionRequest;
  analysis: Awaited<ReturnType<typeof analyzeInput>>;
  decisions: ModDecision[];
  downloadResultsByFile: Map<ModFileDescriptor, DownloadResult>;
  downloadErrorsByFile: Map<ModFileDescriptor, string>;
  jarMetadataByFile: Map<ModFileDescriptor, JarModMetadata>;
  serverpack: ServerpackGenerationResult;
  startupTest: StartupTestResult;
  zipPath?: string;
  warnings: string[];
  errors?: AppError[];
  now: () => Date;
}): ConversionReport {
  const files = analysis.files.map((file, index) => {
    const decision = decisions[index] ?? {
      fileName: file.fileName,
      decision: "include" as const,
      reason: "缺少决策结果，默认保留",
      source: "unknown" as const
    };
    const downloadResult = downloadResultsByFile.get(file);
    const downloadError = downloadErrorsByFile.get(file);
    const jarMetadata = jarMetadataByFile.get(file);
    const downloadStatus: ReportDownloadStatus =
      file.downloadUrls.length === 0
        ? "missing-url"
        : downloadError
          ? "failed"
          : downloadResult?.fromCache
            ? "cached"
            : downloadResult
              ? "downloaded"
              : "skipped";
    const displayName = jarMetadata?.name ?? file.name ?? inferModNameFromFile(file);
    const metadataSource = jarMetadata?.source ?? file.metadataSource;

    return {
      fileName: file.fileName,
      displayName,
      ...(jarMetadata?.modId === undefined ? {} : { modId: jarMetadata.modId }),
      ...(jarMetadata?.version === undefined ? {} : { version: jarMetadata.version }),
      source: file.source,
      ...(metadataSource === undefined ? {} : { metadataSource }),
      downloadStatus,
      ...(downloadError === undefined ? {} : { downloadError }),
      ...(downloadResult === undefined ? {} : { sizeBytes: downloadResult.sizeBytes }),
      hashes: file.expectedHashes,
      decision: decision.decision,
      decisionReason: decision.reason,
      decisionSource: decision.source
    };
  });

  const downloadedFiles = files.filter((file) => file.downloadStatus === "downloaded").length;
  const cachedFiles = files.filter((file) => file.downloadStatus === "cached").length;
  const missingUrlFiles = files.filter((file) => file.downloadStatus === "missing-url").length;
  const failedDownloadFiles = files.filter((file) => file.downloadStatus === "failed").length;
  const includedFiles = files.filter((file) => file.decision === "include").length;
  const excludedFiles = files.filter((file) => file.decision === "exclude").length;

  return {
    schemaVersion: 1,
    generatedAt: now().toISOString(),
    input: {
      path: request.inputPath,
      type: analysis.metadata.type,
      name: analysis.metadata.name,
      ...(analysis.metadata.version === undefined ? {} : { version: analysis.metadata.version })
    },
    target: {
      ...(analysis.metadata.minecraftVersion === undefined ? {} : { minecraftVersion: analysis.metadata.minecraftVersion }),
      ...(analysis.metadata.loader === undefined ? {} : { loader: analysis.metadata.loader }),
      ...(analysis.metadata.loaderVersion === undefined ? {} : { loaderVersion: analysis.metadata.loaderVersion })
    },
    overrides: analysis.overrides,
    files,
    summary: {
      totalFiles: files.length,
      downloadedFiles,
      cachedFiles,
      missingUrlFiles,
      failedDownloadFiles,
      includedFiles,
      excludedFiles
    },
    serverpack: {
      core: {
        type: serverpack.core.type,
        ...(serverpack.core.minecraftVersion === undefined ? {} : { minecraftVersion: serverpack.core.minecraftVersion }),
        ...(serverpack.core.loaderVersion === undefined ? {} : { loaderVersion: serverpack.core.loaderVersion }),
        javaMajor: serverpack.core.javaMajor,
        notes: serverpack.core.notes
      },
      writtenModFiles: serverpack.writtenModFiles,
      skippedModFiles: serverpack.skippedModFiles,
      mergedOverrideFiles: serverpack.mergedOverrideFiles,
      installScripts: serverpack.installScripts,
      startScripts: serverpack.startScripts,
      supportFiles: serverpack.supportFiles,
      coreInstall: {
        enabled: serverpack.coreInstall.enabled,
        status: serverpack.coreInstall.status,
        files: serverpack.coreInstall.files,
        ...(serverpack.coreInstall.error === undefined ? {} : { error: serverpack.coreInstall.error })
      },
      startupTest: {
        enabled: startupTest.enabled,
        status: startupTest.status,
        ...(startupTest.exitCode === undefined ? {} : { exitCode: startupTest.exitCode }),
        ...(startupTest.reason === undefined ? {} : { reason: startupTest.reason })
      },
      ...(zipPath === undefined ? {} : { zipPath })
    },
    warnings,
    errors
  };
}

function renderReadme(report: ConversionReport): string {
  const targetLines = [
    `Minecraft: ${report.target.minecraftVersion ?? "未指定"}`,
    `加载器: ${report.target.loader ?? "未指定"}`,
    `加载器版本: ${report.target.loaderVersion ?? "未指定"}`
  ];

  return [
    `# ${report.input.name} 服务端包`,
    "",
    "此目录由 Minecraft Serverpack Tool 生成。",
    "",
    "## 目标版本",
    "",
    ...targetLines.map((line) => `- ${line}`),
    "",
    "## 当前状态",
    "",
    `- 文件总数：${report.summary.totalFiles}`,
    `- 已下载：${report.summary.downloadedFiles}`,
    `- 缓存命中：${report.summary.cachedFiles}`,
    `- 缺少下载地址：${report.summary.missingUrlFiles}`,
    `- 下载失败：${report.summary.failedDownloadFiles}`,
    `- 已写入 mods：${report.serverpack.writtenModFiles}`,
    `- 已合并 overrides：${report.serverpack.mergedOverrideFiles}`,
    "",
    "## 服务端核心",
    "",
    `- 核心：${report.serverpack.core.type}`,
    `- 推荐 Java：${report.serverpack.core.javaMajor}`,
    ...report.serverpack.core.notes.map((line) => `- ${line}`),
    `- 核心直接下载：${formatCoreInstallStatus(report.serverpack.coreInstall.status)}`,
    `- 启动脚本测试：${formatStartupTestStatus(report.serverpack.startupTest.status)}`,
    "",
    "## 部署提示",
    "",
    report.serverpack.coreInstall.status === "installed"
      ? "- 服务端核心已准备完成，接受 EULA 后 Windows 可运行 `start.bat`，Linux/macOS 可运行 `start.sh`。"
      : "- 首次部署时运行 `install-server.ps1` 或 `install-server.bat` 下载并安装对应服务端核心。",
    "- 脚本会优先读取 `java-home.txt` 中的 Java Home；未配置时回退到 `JAVA_HOME` 和系统 `java`。",
    "- Linux/macOS 可尝试运行 `bash install-server.sh`，脚本依赖 `curl`、`python3` 和兼容 Java。",
    "- 安装完成后阅读并接受 Minecraft EULA，把 `eula.txt` 中的 `eula=false` 改为 `eula=true`。",
    ...(report.serverpack.startScripts.includes("start-optimized.bat")
      ? ["- 已生成优化启动脚本：Windows 可运行 `start-optimized.bat`，Linux/macOS 可运行 `start-optimized.sh`。"]
      : []),
    "- 启动服务端请运行 `start.ps1`、`start.bat` 或 `start.sh`。",
    "- 内存参数在 `user_jvm_args.txt` 中调整，默认 `-Xms1G`、`-Xmx4G`。",
    "- Minecraft EULA 必须由服主自行确认，本工具不会自动设置 eula=true。",
    "- 若报告中存在 missing-url 或 failed，请补齐下载文件或调整规则后重新生成最终服务端包。",
    ""
  ].join("\n");
}

function sanitizePathSegment(value: string): string {
  const sanitized = value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim();
  return sanitized || "serverpack";
}

function formatCoreInstallStatus(status: ConversionReport["serverpack"]["coreInstall"]["status"]): string {
  switch (status) {
    case "installed":
      return "已完成";
    case "failed":
      return "失败，需运行安装脚本或查看报告";
    case "skipped":
      return "未启用";
  }
}

function formatStartupTestStatus(status: ConversionReport["serverpack"]["startupTest"]["status"]): string {
  switch (status) {
    case "passed":
      return "已通过";
    case "failed":
      return "失败";
    case "skipped":
      return "未运行";
  }
}
