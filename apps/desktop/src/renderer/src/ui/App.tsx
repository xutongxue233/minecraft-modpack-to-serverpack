import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent } from "react";
import {
  AlertTriangle,
  Box,
  CheckCircle2,
  FileArchive,
  FileText,
  FolderOpen,
  HardDriveDownload,
  KeyRound,
  Loader2,
  Minus,
  PackageOpen,
  Play,
  ShieldCheck,
  Square,
  Terminal,
  Upload,
  X
} from "lucide-react";
import type {
  AnalyzeResult,
  ConversionPhase,
  ConversionSettings,
  InputSelection,
  JobProgressGroup
} from "@mcsp/shared";

const sourceName: Record<string, string> = {
  modrinth: "Modrinth",
  curseforge: "CurseForge",
  packwiz: "packwiz",
  instance: "实例目录"
};

interface ProgressSnapshot {
  current: number;
  total: number;
  label?: string;
  percent?: number;
  receivedBytes?: number;
  totalBytes?: number;
}

interface JobLogEntry {
  id: number;
  level: "debug" | "info" | "warn" | "error";
  message: string;
}

const progressGroupLabel: Record<JobProgressGroup, string> = {
  mods: "Mod 下载",
  core: "核心下载",
  package: "打包"
};

export function App() {
  const [input, setInput] = useState<InputSelection | null>(null);
  const [outputDir, setOutputDir] = useState<string>("");
  const [settings, setSettings] = useState<ConversionSettings | null>(null);
  const [analysis, setAnalysis] = useState<AnalyzeResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [converting, setConverting] = useState(false);
  const [conversionJobId, setConversionJobId] = useState<string | null>(null);
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [apiKeySaving, setApiKeySaving] = useState(false);
  const [settingsMessage, setSettingsMessage] = useState<string | null>(null);
  const [jobPhase, setJobPhase] = useState<ConversionPhase>("idle");
  const [jobMessage, setJobMessage] = useState("等待任务");
  const [jobProgressGroups, setJobProgressGroups] = useState<Partial<Record<JobProgressGroup, ProgressSnapshot>>>({});
  const [jobLogs, setJobLogs] = useState<JobLogEntry[]>([]);
  const [conversionOutput, setConversionOutput] = useState<{
    outputDir: string;
    reportPath: string;
    zipPath?: string;
  } | null>(null);
  const conversionJobIdRef = useRef<string | null>(null);
  const conversionPendingRef = useRef(false);
  const jobLogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!window.serverpack) {
      setError("本地桥接 API 未加载。请重新安装最新构建。");
      return;
    }

    void window.serverpack
      .getSettings()
      .then((nextSettings) => {
        setSettings(nextSettings);
        setOutputDir((current) => current || nextSettings.defaultOutputDir || "");
      })
      .catch((settingsError: unknown) => {
        setError(formatError(settingsError));
      });
  }, []);

  useEffect(() => {
    if (!window.serverpack) {
      return undefined;
    }

    return window.serverpack.onJobEvent((event) => {
      const activeJobId = conversionJobIdRef.current;
      if (!activeJobId && conversionPendingRef.current) {
        conversionJobIdRef.current = event.jobId;
        setConversionJobId(event.jobId);
      } else if (!activeJobId || event.jobId !== activeJobId) {
        return;
      }

      if (event.type === "phase") {
        setJobPhase(event.phase);
        setJobMessage(event.message);
        return;
      }

      if (event.type === "log") {
        setJobLogs((current) => [
          ...current.slice(-240),
          {
            id: Date.now() + current.length,
            level: event.level,
            message: event.message
          }
        ]);
        return;
      }

      if (event.type === "progress") {
        const group = event.group ?? "mods";
        setJobProgressGroups((current) => ({
          ...current,
          [group]: {
            current: event.current,
            total: event.total,
            ...(event.label === undefined ? {} : { label: event.label }),
            ...(event.percent === undefined ? {} : { percent: event.percent }),
            ...(event.receivedBytes === undefined ? {} : { receivedBytes: event.receivedBytes }),
            ...(event.totalBytes === undefined ? {} : { totalBytes: event.totalBytes })
          }
        }));
        return;
      }

      if (event.type === "completed") {
        setConverting(false);
        setConversionJobId(null);
        conversionJobIdRef.current = null;
        conversionPendingRef.current = false;
        setJobPhase("completed");
        setJobMessage(event.zipPath ? "服务端包和 zip 已生成" : "服务端包已生成");
        setConversionOutput({
          outputDir: event.outputDir,
          reportPath: event.reportPath,
          ...(event.zipPath === undefined ? {} : { zipPath: event.zipPath })
        });
        return;
      }

      if (event.type === "failed") {
        setConverting(false);
        setConversionJobId(null);
        conversionJobIdRef.current = null;
        conversionPendingRef.current = false;
        setJobPhase("failed");
        setJobMessage("任务失败");
        setError(formatError(event.error));
        return;
      }

      if (event.type === "cancelled") {
        setConverting(false);
        setConversionJobId(null);
        conversionJobIdRef.current = null;
        conversionPendingRef.current = false;
        setJobPhase("cancelled");
        setJobMessage("任务已取消");
      }
    });
  }, []);

  useEffect(() => {
    if (jobLogRef.current) {
      jobLogRef.current.scrollTop = jobLogRef.current.scrollHeight;
    }
  }, [jobLogs]);

  const totalMods = analysis?.files.length ?? 0;
  const loaderLabel = analysis?.metadata.loader ?? "未识别";
  const packTypeLabel = analysis ? sourceName[analysis.metadata.type] ?? analysis.metadata.type : "等待输入";
  const bridgeOnline = Boolean(window.serverpack);
  const analysisWarnings = analysis?.warnings ?? [];
  const targetOutputDir = outputDir || settings?.defaultOutputDir || "";
  const overrideTotal = analysis ? analysis.overrides.common + analysis.overrides.server : 0;
  const packName = analysis?.metadata.name ?? "等待解析";
  const minecraftLabel = analysis?.metadata.minecraftVersion ?? "未指定";
  const loaderSummary =
    analysis?.metadata.loader === undefined
      ? "未识别加载器"
      : `${analysis.metadata.loader}${analysis.metadata.loaderVersion ? ` ${analysis.metadata.loaderVersion}` : ""}`;
  const ruleModeLabel = "远程规则库";
  const coreModeLabel = settings?.downloadServerCore ? "直接下载核心" : "生成安装脚本";
  const outputModeLabel = settings?.outputZip ? "目录 + zip" : "仅输出目录";
  const optimizedScriptLabel = settings?.generateOptimizedStartScript ? "生成优化脚本" : "标准启动脚本";
  const blueprintSteps = [
    {
      label: "输入",
      value: input ? "已选择整合包" : "等待导入",
      tone: input ? "ready" : "idle"
    },
    {
      label: "解析",
      value: analysis ? `${totalMods} 个远程文件` : input ? "可开始解析" : "等待输入",
      tone: analysis ? "ready" : input ? "active" : "idle"
    },
    {
      label: "规则",
      value: ruleModeLabel,
      tone: "ready"
    },
    {
      label: "输出",
      value: targetOutputDir ? outputModeLabel : "选择目录",
      tone: targetOutputDir ? "ready" : "idle"
    }
  ] as const;
  const readinessItems = [
    {
      label: "桥接状态",
      value: bridgeOnline ? "本地桥接可用" : "桥接未加载",
      state: bridgeOnline ? "ready" : "blocked"
    },
    {
      label: "输入包",
      value: input ? compactPath(input.path, 48) : "尚未选择",
      state: input ? "ready" : "idle"
    },
    {
      label: "输出目录",
      value: targetOutputDir ? compactPath(targetOutputDir, 48) : "尚未选择",
      state: targetOutputDir ? "ready" : "idle"
    },
    {
      label: "运行核心",
      value: `${coreModeLabel} / ${optimizedScriptLabel}`,
      state: "ready"
    },
    {
      label: "Java",
      value: settings?.javaHome ? "已指定 JDK" : "使用系统 PATH",
      state: settings?.downloadServerCore && !settings?.javaHome ? "active" : "ready"
    }
  ] as const;

  const selectedPath = useMemo(() => {
    if (!input) {
      return "尚未选择整合包";
    }
    return compactPath(input.path, 82);
  }, [input]);

  const outputPath = useMemo(() => {
    if (!outputDir) {
      return "尚未选择输出目录";
    }
    return compactPath(outputDir, 64);
  }, [outputDir]);

  const javaHomePath = useMemo(() => {
    if (!settings?.javaHome) {
      return "未配置，使用系统 PATH 中的 java";
    }
    return compactPath(settings.javaHome, 64);
  }, [settings?.javaHome]);

  const applyInputSelection = useCallback((selected: InputSelection) => {
    setInput(selected);
    setAnalysis(null);
  }, []);

  const selectInput = useCallback(async () => {
    setError(null);
    const selected = await window.serverpack.selectInput();
    if (selected) {
      applyInputSelection(selected);
    }
  }, [applyInputSelection]);

  const selectInputDirectory = useCallback(async () => {
    setError(null);
    const selected = await window.serverpack.selectInputDirectory();
    if (selected) {
      applyInputSelection(selected);
    }
  }, [applyInputSelection]);

  const selectOutputDir = useCallback(async () => {
    setError(null);
    const selected = await window.serverpack.selectOutputDir();
    if (selected) {
      setOutputDir(selected);
    }
  }, []);

  const analyze = useCallback(async () => {
    if (!input) {
      return;
    }

    setBusy(true);
    setError(null);

    try {
      const result = await window.serverpack.analyzeInput({ inputPath: input.path });
      setAnalysis(result);
    } catch (rawError) {
      setError(formatError(rawError));
    } finally {
      setBusy(false);
    }
  }, [input]);

  const startConversion = useCallback(async () => {
    if (!input) {
      setError("请先选择整合包。");
      return;
    }
    if (!targetOutputDir) {
      setError("请先选择输出目录。");
      return;
    }

    setError(null);
    setConverting(true);
    setConversionOutput(null);
    setJobPhase("analyzing");
    setJobMessage("正在创建转换任务");
    setJobProgressGroups({});
    setJobLogs([]);
    conversionPendingRef.current = true;

    try {
      const started = await window.serverpack.startConversion({
        inputPath: input.path,
        outputDir: targetOutputDir,
        settings: {
          ...(settings?.downloadServerCore === undefined ? {} : { downloadServerCore: settings.downloadServerCore }),
          testStartScript: Boolean(settings?.downloadServerCore && (settings.testStartScript ?? true)),
          ...(settings?.startupTestTimeoutSeconds === undefined
            ? {}
            : { startupTestTimeoutSeconds: settings.startupTestTimeoutSeconds }),
          ...(settings?.outputZip === undefined ? {} : { outputZip: settings.outputZip }),
          ...(settings?.javaHome === undefined ? {} : { javaHome: settings.javaHome }),
          ...(settings?.generateOptimizedStartScript === undefined
            ? {}
            : { generateOptimizedStartScript: settings.generateOptimizedStartScript })
        }
      });
      if (conversionPendingRef.current) {
        conversionPendingRef.current = false;
        conversionJobIdRef.current = started.id;
        setConversionJobId(started.id);
      }
    } catch (rawError) {
      setConverting(false);
      setConversionJobId(null);
      conversionJobIdRef.current = null;
      conversionPendingRef.current = false;
      setJobPhase("failed");
      setJobMessage("任务创建失败");
      setError(formatError(rawError));
    }
  }, [input, settings, targetOutputDir]);

  const cancelConversion = useCallback(async () => {
    if (!conversionJobId) {
      return;
    }

    await window.serverpack.cancelJob(conversionJobId);
  }, [conversionJobId]);

  const updateOutputZip = useCallback(
    async (value: boolean) => {
      if (!settings) {
        return;
      }

      const next = await window.serverpack.updateSettings({ outputZip: value });
      setSettings(next);
    },
    [settings]
  );

  const updateDownloadServerCore = useCallback(
    async (value: boolean) => {
      if (!settings) {
        return;
      }

      const next = await window.serverpack.updateSettings({ downloadServerCore: value });
      setSettings(next);
    },
    [settings]
  );

  const updateTestStartScript = useCallback(
    async (value: boolean) => {
      if (!settings) {
        return;
      }

      const next = await window.serverpack.updateSettings({ testStartScript: value });
      setSettings(next);
    },
    [settings]
  );

  const updateGenerateOptimizedStartScript = useCallback(
    async (value: boolean) => {
      if (!settings) {
        return;
      }

      const next = await window.serverpack.updateSettings({ generateOptimizedStartScript: value });
      setSettings(next);
    },
    [settings]
  );

  const selectJavaHome = useCallback(async () => {
    if (!settings) {
      return;
    }

    setError(null);
    setSettingsMessage(null);
    try {
      const selected = await window.serverpack.selectJavaHome();
      if (!selected) {
        return;
      }
      const next = await window.serverpack.updateSettings({ javaHome: selected });
      setSettings(next);
      setSettingsMessage("Java Home 已保存");
    } catch (rawError) {
      setError(formatError(rawError));
    }
  }, [settings]);

  const clearJavaHome = useCallback(async () => {
    if (!settings) {
      return;
    }

    setError(null);
    setSettingsMessage(null);
    try {
      const next = await window.serverpack.updateSettings({ javaHome: null });
      setSettings(next);
      setSettingsMessage("Java Home 已清除，将使用系统 PATH");
    } catch (rawError) {
      setError(formatError(rawError));
    }
  }, [settings]);

  const saveCurseForgeApiKey = useCallback(async () => {
    const nextKey = apiKeyDraft.trim();
    if (!nextKey) {
      setError("请输入 CurseForge API Key。");
      return;
    }

    setApiKeySaving(true);
    setError(null);
    setSettingsMessage(null);
    try {
      const next = await window.serverpack.updateSettings({ curseForgeApiKey: nextKey });
      setSettings(next);
      setApiKeyDraft("");
      setSettingsMessage("CurseForge API Key 已保存");
      if (analysis?.metadata.type === "curseforge") {
        setAnalysis(null);
      }
    } catch (rawError) {
      setError(formatError(rawError));
    } finally {
      setApiKeySaving(false);
    }
  }, [analysis?.metadata.type, apiKeyDraft]);

  const clearCurseForgeApiKey = useCallback(async () => {
    setApiKeySaving(true);
    setError(null);
    setSettingsMessage(null);
    try {
      const next = await window.serverpack.updateSettings({ curseForgeApiKey: null });
      setSettings(next);
      setApiKeyDraft("");
      setSettingsMessage("CurseForge API Key 已清除");
    } catch (rawError) {
      setError(formatError(rawError));
    } finally {
      setApiKeySaving(false);
    }
  }, []);

  const handleDrop = useCallback(
    (event: DragEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      setDragging(false);
      setError(null);

      const droppedFile = event.dataTransfer.files.item(0);
      if (!droppedFile) {
        setError("没有读取到拖入文件。");
        return;
      }

      const droppedPath = window.serverpack.resolveDroppedFile(droppedFile);
      if (!droppedPath) {
        setError("无法读取拖入文件路径，请使用“选择整合包”。");
        return;
      }

      applyInputSelection({
        path: droppedPath,
        kind: inferInputKind(droppedPath)
      });
    },
    [applyInputSelection]
  );

  return (
    <main className="app-shell">
      <header className="window-bar">
        <div className="window-identity" aria-label="应用窗口">
          <Box size={16} strokeWidth={1.9} />
          <span>整合包转服务端包工具</span>
        </div>
        <div className="window-drag-zone" aria-hidden="true" />
        <div className="window-controls">
          <button type="button" title="最小化" onClick={() => void window.serverpack.minimizeWindow()}>
            <Minus size={15} />
          </button>
          <button className="close" type="button" title="关闭" onClick={() => void window.serverpack.closeWindow()}>
            <X size={15} />
          </button>
        </div>
      </header>

      <section className="workbench">
        <header className="command-header">
          <div className="command-title">
            <span className="header-rune" aria-hidden="true">
              <Box size={20} />
            </span>
            <div className="title-stack">
              <p className="eyebrow">服务端包转换 / 本地工作台</p>
              <h1>整合包转换台</h1>
            </div>
          </div>

          <div className="command-meta" aria-label="当前任务状态">
            <span className="header-chip">{packTypeLabel}</span>
            <span className="header-chip">{totalMods} Mods</span>
            <span className={bridgeOnline ? "bridge-chip online" : "bridge-chip offline"}>
              <span className="signal" />
              {bridgeOnline ? "bridge online" : "bridge offline"}
            </span>
          </div>
        </header>

        <section className="console-grid">
          <section className="source-console" aria-labelledby="source-title">
            <div className="section-heading">
              <Upload size={20} />
              <div>
                <h2 id="source-title">输入源</h2>
                <p>读取 `.mrpack`、CurseForge `.zip` 或 packwiz 目录。</p>
              </div>
            </div>

            <button
              className={`drop-bay ${dragging ? "dragging" : ""}`}
              type="button"
              onClick={selectInput}
              onDragEnter={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = "copy";
                setDragging(true);
              }}
              onDragLeave={(event) => {
                event.preventDefault();
                setDragging(false);
              }}
              onDrop={handleDrop}
            >
              <FileArchive size={34} />
              <span>{dragging ? "释放以导入" : input ? "已锁定整合包" : "选择或拖入整合包"}</span>
              <strong>{selectedPath}</strong>
            </button>

            <div className="path-row">
              <button className="utility-button" type="button" onClick={selectOutputDir}>
                <FolderOpen size={17} />
                选择输出目录
              </button>
              <output title={outputDir || undefined}>{outputPath}</output>
            </div>

            <button className="directory-button" type="button" onClick={selectInputDirectory}>
              <PackageOpen size={17} />
              选择 packwiz 目录
            </button>

            <div className="switchboard">
              <label>
                <input
                  type="checkbox"
                  checked={settings?.downloadServerCore ?? false}
                  onChange={(event) => void updateDownloadServerCore(event.currentTarget.checked)}
                />
                <span>直接下载核心</span>
              </label>
              <label className={settings?.downloadServerCore ? "" : "disabled"}>
                <input
                  type="checkbox"
                  checked={Boolean(settings?.downloadServerCore && (settings?.testStartScript ?? true))}
                  disabled={!settings?.downloadServerCore}
                  onChange={(event) => void updateTestStartScript(event.currentTarget.checked)}
                />
                <span>启动脚本测试</span>
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={settings?.generateOptimizedStartScript ?? false}
                  disabled={!settings}
                  onChange={(event) => void updateGenerateOptimizedStartScript(event.currentTarget.checked)}
                />
                <span>优化启动脚本</span>
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={settings?.outputZip ?? false}
                  onChange={(event) => void updateOutputZip(event.currentTarget.checked)}
                />
                <span>输出 zip</span>
              </label>
            </div>

            <div className="java-home-panel">
              <div className="java-home-title">
                <Terminal size={16} />
                <span>Java 运行环境</span>
                <strong className={settings?.javaHome ? "configured" : ""}>
                  {settings?.javaHome ? "已配置" : "系统默认"}
                </strong>
              </div>
              <div className="java-home-row">
                <output title={settings?.javaHome || undefined}>{javaHomePath}</output>
                <button type="button" onClick={selectJavaHome}>
                  <FolderOpen size={15} />
                  选择 JDK
                </button>
                {settings?.javaHome && (
                  <button className="ghost" type="button" onClick={clearJavaHome}>
                    清除
                  </button>
                )}
              </div>
              <p className="settings-message">用于直接下载核心时运行 Forge、Fabric、Quilt 安装器。</p>
            </div>

            <div className="api-key-panel">
              <div className="api-key-title">
                <KeyRound size={16} />
                <span>CurseForge API Key</span>
                <strong className={settings?.curseForgeApiKeyConfigured ? "configured" : ""}>
                  {settings?.curseForgeApiKeyConfigured ? "已配置" : "未配置"}
                </strong>
              </div>
              <div className="api-key-row">
                <input
                  type="password"
                  value={apiKeyDraft}
                  placeholder={settings?.curseForgeApiKeyConfigured ? "输入新 key 可覆盖" : "粘贴 API Key"}
                  onChange={(event) => setApiKeyDraft(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      void saveCurseForgeApiKey();
                    }
                  }}
                />
                <button type="button" onClick={saveCurseForgeApiKey} disabled={apiKeySaving || !apiKeyDraft.trim()}>
                  {apiKeySaving ? <Loader2 className="spin" size={15} /> : <KeyRound size={15} />}
                  保存
                </button>
                {settings?.curseForgeApiKeyConfigured && (
                  <button className="ghost" type="button" onClick={clearCurseForgeApiKey} disabled={apiKeySaving}>
                    清除
                  </button>
                )}
              </div>
              {settingsMessage && <p className="settings-message">{settingsMessage}</p>}
            </div>

            <div className="primary-actions">
              <button className="run-button" type="button" onClick={analyze} disabled={!input || busy || !bridgeOnline}>
                {busy ? <Loader2 className="spin" size={18} /> : <HardDriveDownload size={18} />}
                {busy ? "正在解析" : "解析整合包"}
              </button>

              <button
                className="convert-button"
                type="button"
                onClick={startConversion}
                disabled={!input || !targetOutputDir || converting || !bridgeOnline}
              >
                {converting ? <Loader2 className="spin" size={18} /> : <Play size={18} />}
                {converting ? "任务运行中" : "生成服务端包"}
              </button>
            </div>

            {(converting || jobPhase !== "idle" || conversionOutput) && (
              <div className="job-console" aria-live="polite">
                <div className="job-head">
                  <span className={`job-light ${jobPhase}`} />
                  <strong>{phaseLabel(jobPhase)}</strong>
                  <small>{jobMessage}</small>
                </div>
                {Object.entries(jobProgressGroups).length > 0 && (
                  <div className="job-progress-stack" aria-label="任务进度">
                    {Object.entries(jobProgressGroups).map(([group, progress]) => (
                      <ProgressBar key={group} group={group as JobProgressGroup} progress={progress} />
                    ))}
                  </div>
                )}
                {jobLogs.length > 0 && (
                  <div className="job-log-panel">
                    <div className="job-log-title">
                      <Terminal size={14} />
                      <strong>任务日志</strong>
                    </div>
                    <div className="job-log-lines" ref={jobLogRef} role="log" aria-live="polite">
                      {jobLogs.map((line) => (
                        <p key={line.id} className={line.level}>
                          <span>{formatLogLevel(line.level)}</span>
                          <code>{line.message}</code>
                        </p>
                      ))}
                    </div>
                  </div>
                )}
                <div className="job-actions">
                  {converting && (
                    <button type="button" onClick={cancelConversion}>
                      <Square size={15} />
                      取消任务
                    </button>
                  )}
                  {conversionOutput && (
                    <>
                      <button type="button" onClick={() => void window.serverpack.openPath(conversionOutput.outputDir)}>
                        <CheckCircle2 size={15} />
                        打开输出
                      </button>
                      <button type="button" onClick={() => void window.serverpack.openPath(conversionOutput.reportPath)}>
                        <FileText size={15} />
                        打开报告
                      </button>
                      {conversionOutput.zipPath && (
                        <button type="button" onClick={() => void window.serverpack.openPath(conversionOutput.zipPath!)}>
                          <FileArchive size={15} />
                          打开 zip
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>
            )}

            {error && (
              <div className="error-box" role="alert">
                <AlertTriangle size={18} />
                <span>{error}</span>
              </div>
            )}

            {analysisWarnings.length > 0 && (
              <div className="warning-box" role="status">
                <AlertTriangle size={18} />
                <span>{analysisWarnings[0]}</span>
              </div>
            )}
          </section>

          <section className="overview-board" aria-labelledby="overview-title">
            <div className="blueprint-hero">
              <div className="terrain-strip" aria-hidden="true">
                {blueprintSteps.map((step) => (
                  <span key={step.label} className={step.tone} />
                ))}
              </div>
              <div className="blueprint-copy">
                <p className="panel-kicker">Serverpack blueprint</p>
                <h2 id="overview-title">生成蓝图</h2>
                <p>
                  {packName} / {minecraftLabel} / {loaderSummary}
                </p>
              </div>
            </div>

            <div className="blueprint-steps" aria-label="转换准备状态">
              {blueprintSteps.map((step) => (
                <BlueprintStep key={step.label} label={step.label} value={step.value} tone={step.tone} />
              ))}
            </div>

            <div className="overview-section">
              <div className="overview-section-title">
                <ShieldCheck size={18} />
                <div>
                  <h3>Manifest 读数</h3>
                  <p>解析后用于选择核心和输出内容。</p>
                </div>
              </div>
              <dl className="readout-grid">
                <Readout label="来源" value={packTypeLabel} />
                <Readout label="包名" value={analysis?.metadata.name ?? "未解析"} />
                <Readout label="版本" value={analysis?.metadata.version ?? "未指定"} />
                <Readout label="Minecraft" value={minecraftLabel} />
                <Readout label="加载器" value={loaderLabel} />
                <Readout label="加载器版本" value={analysis?.metadata.loaderVersion ?? "未指定"} />
                <Readout label="远程文件" value={`${totalMods}`} />
                <Readout label="overrides" value={String(overrideTotal)} />
              </dl>
            </div>

            <div className="overview-section">
              <div className="overview-section-title">
                <Terminal size={18} />
                <div>
                  <h3>启动方案</h3>
                  <p>生成前确认脚本、核心和规则来源。</p>
                </div>
              </div>
              <div className="readiness-list">
                {readinessItems.map((item) => (
                  <ReadinessItem key={item.label} label={item.label} value={item.value} state={item.state} />
                ))}
              </div>
            </div>

            {conversionOutput && (
              <div className="output-receipt">
                <strong>最近生成</strong>
                <span>{compactPath(conversionOutput.outputDir, 64)}</span>
              </div>
            )}
          </section>

        </section>
      </section>
    </main>
  );
}

function Readout({ label, value, wide = false }: { label: string; value: string; wide?: boolean }) {
  return (
    <div className={wide ? "readout wide" : "readout"}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function BlueprintStep({
  label,
  value,
  tone
}: {
  label: string;
  value: string;
  tone: "ready" | "active" | "idle";
}) {
  return (
    <div className={`blueprint-step ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function ReadinessItem({
  label,
  value,
  state
}: {
  label: string;
  value: string;
  state: "ready" | "active" | "idle" | "blocked";
}) {
  return (
    <div className={`readiness-item ${state}`}>
      <span aria-hidden="true" />
      <div>
        <strong>{label}</strong>
        <small>{value}</small>
      </div>
    </div>
  );
}

function ProgressBar({ group, progress }: { group: JobProgressGroup; progress: ProgressSnapshot }) {
  const countPercent = progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0;
  const percent = Math.max(0, Math.min(100, progress.percent ?? countPercent));
  const byteLabel =
    group !== "mods" && progress.receivedBytes !== undefined
      ? progress.totalBytes === undefined
        ? formatBytes(progress.receivedBytes)
        : `${formatBytes(progress.receivedBytes)} / ${formatBytes(progress.totalBytes)}`
      : null;
  const countLabel = `${progress.current}/${progress.total}`;

  return (
    <div className="job-progress-item">
      <div className="job-progress-meta">
        <strong>{progressGroupLabel[group]}</strong>
        <span>{progress.label ?? `${progress.current}/${progress.total}`}</span>
        <em>{group === "mods" ? countLabel : byteLabel ?? countLabel}</em>
      </div>
      <div className="job-progress" aria-label={`${progressGroupLabel[group]}进度`}>
        <span style={{ width: `${percent}%` }} />
        <em>{percent}%</em>
      </div>
    </div>
  );
}

function compactPath(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  const head = Math.max(16, Math.floor(maxLength * 0.38));
  const tail = Math.max(18, maxLength - head - 3);
  return `${value.slice(0, head)}...${value.slice(-tail)}`;
}

function inferInputKind(filePath: string): InputSelection["kind"] {
  const lowerPath = filePath.toLowerCase();
  return lowerPath.endsWith(".mrpack") || lowerPath.endsWith(".zip") ? "file" : "directory";
}

function phaseLabel(phase: ConversionPhase): string {
  switch (phase) {
    case "analyzing":
      return "解析";
    case "downloading":
      return "下载";
    case "verifying":
      return "校验";
    case "reviewing":
      return "决策";
    case "packaging":
      return "写入";
    case "testing":
      return "测试";
    case "completed":
      return "完成";
    case "failed":
      return "失败";
    case "cancelled":
      return "取消";
    default:
      return "待机";
  }
}

function formatLogLevel(level: JobLogEntry["level"]): string {
  switch (level) {
    case "debug":
      return "DEBUG";
    case "warn":
      return "WARN";
    case "error":
      return "ERR";
    default:
      return "INFO";
  }
}

function formatError(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return "操作失败。请检查输入文件并重试。";
}

function formatBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }

  const units = ["KB", "MB", "GB"];
  let size = value / 1024;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(size >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}
