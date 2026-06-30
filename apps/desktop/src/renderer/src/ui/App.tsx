import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent } from "react";
import {
  AlertTriangle,
  Box,
  CheckCircle2,
  Database,
  FileArchive,
  FileText,
  FolderOpen,
  HardDriveDownload,
  KeyRound,
  Loader2,
  Minus,
  PackageOpen,
  Play,
  Settings,
  ShieldCheck,
  Square,
  Upload,
  X
} from "lucide-react";
import type { AnalyzeResult, ConversionPhase, ConversionSettings, InputSelection, ModFileDescriptor } from "@mcsp/shared";

type StepKey = "input" | "analyze" | "review" | "output";

const steps: Array<{ key: StepKey; label: string; detail: string }> = [
  { key: "input", label: "导入", detail: "选择包" },
  { key: "analyze", label: "解析", detail: "读取清单" },
  { key: "review", label: "复核", detail: "筛选 Mod" },
  { key: "output", label: "输出", detail: "生成服务端包" }
];

const sourceName: Record<string, string> = {
  modrinth: "Modrinth",
  curseforge: "CurseForge",
  packwiz: "packwiz",
  instance: "实例目录"
};

export function App() {
  const [input, setInput] = useState<InputSelection | null>(null);
  const [outputDir, setOutputDir] = useState<string>("");
  const [settings, setSettings] = useState<ConversionSettings | null>(null);
  const [analysis, setAnalysis] = useState<AnalyzeResult | null>(null);
  const [activeStep, setActiveStep] = useState<StepKey>("input");
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
  const [jobProgress, setJobProgress] = useState<{ current: number; total: number } | null>(null);
  const [conversionOutput, setConversionOutput] = useState<{
    outputDir: string;
    reportPath: string;
    zipPath?: string;
  } | null>(null);
  const conversionJobIdRef = useRef<string | null>(null);
  const conversionPendingRef = useRef(false);

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

      if (event.type === "progress") {
        setJobProgress({ current: event.current, total: event.total });
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
        setActiveStep("output");
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

  const totalMods = analysis?.files.length ?? 0;
  const loaderLabel = analysis?.metadata.loader ?? "未识别";
  const packTypeLabel = analysis ? sourceName[analysis.metadata.type] ?? analysis.metadata.type : "等待输入";
  const bridgeOnline = Boolean(window.serverpack);
  const analysisWarnings = analysis?.warnings ?? [];
  const targetOutputDir = outputDir || settings?.defaultOutputDir || "";

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

  const applyInputSelection = useCallback((selected: InputSelection) => {
    setInput(selected);
    setAnalysis(null);
    setActiveStep("input");
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
    setActiveStep("analyze");

    try {
      const result = await window.serverpack.analyzeInput({ inputPath: input.path });
      setAnalysis(result);
      setActiveStep("review");
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
    setJobProgress(null);
    setActiveStep("output");
    conversionPendingRef.current = true;

    try {
      const started = await window.serverpack.startConversion({
        inputPath: input.path,
        outputDir: targetOutputDir,
        settings: {
          ...(settings?.unknownPolicy === undefined ? {} : { unknownPolicy: settings.unknownPolicy }),
          ...(settings?.outputZip === undefined ? {} : { outputZip: settings.outputZip })
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
          <span>Minecraft Serverpack Tool</span>
        </div>
        <div className="window-drag-note">local desktop build</div>
        <div className="window-controls">
          <button type="button" title="最小化" onClick={() => void window.serverpack.minimizeWindow()}>
            <Minus size={15} />
          </button>
          <button className="close" type="button" title="关闭" onClick={() => void window.serverpack.closeWindow()}>
            <X size={15} />
          </button>
        </div>
      </header>

      <aside className="rail" aria-label="应用导航">
        <div className="brand-block" aria-label="Minecraft Serverpack Tool">
          <Box size={24} strokeWidth={1.8} />
          <span>MS</span>
        </div>

        <nav className="rail-steps" aria-label="转换阶段">
          {steps.map((step, index) => (
            <button
              key={step.key}
              className={`rail-step ${activeStep === step.key ? "active" : ""}`}
              type="button"
              title={`${step.label}：${step.detail}`}
              onClick={() => setActiveStep(step.key)}
            >
              <span>{String(index + 1).padStart(2, "0")}</span>
              {step.label}
            </button>
          ))}
        </nav>

        <button className="rail-tool" type="button" title="设置">
          <Settings size={18} />
        </button>
      </aside>

      <section className="workbench">
        <header className="command-header">
          <div className="command-title">
            <span className="header-rune" aria-hidden="true">
              <Box size={20} />
            </span>
            <div className="title-stack">
              <p className="eyebrow">Serverpack converter / local workstation</p>
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

        <section className="chunk-strip" aria-label="转换流水线">
          {steps.map((step) => (
            <button
              key={step.key}
              type="button"
              className={`chunk ${activeStep === step.key ? "active" : ""} ${isStepComplete(step.key, analysis) ? "done" : ""}`}
              onClick={() => setActiveStep(step.key)}
            >
              <span>{step.label}</span>
              <strong>{step.detail}</strong>
            </button>
          ))}
        </section>

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
                  checked={settings?.outputZip ?? false}
                  onChange={(event) => void updateOutputZip(event.currentTarget.checked)}
                />
                <span>输出 zip</span>
              </label>
              <label>
                <input type="checkbox" checked readOnly />
                <span>未知 Mod 进入复核</span>
              </label>
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
                {converting ? "任务运行中" : "生成初版报告"}
              </button>
            </div>

            {(converting || jobPhase !== "idle" || conversionOutput) && (
              <div className="job-console" aria-live="polite">
                <div className="job-head">
                  <span className={`job-light ${jobPhase}`} />
                  <strong>{phaseLabel(jobPhase)}</strong>
                  <small>{jobMessage}</small>
                </div>
                {jobProgress && (
                  <div className="job-progress" aria-label="任务进度">
                    <span style={{ width: `${Math.min(100, Math.round((jobProgress.current / jobProgress.total) * 100))}%` }} />
                    <em>
                      {jobProgress.current}/{jobProgress.total}
                    </em>
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

          <section className="manifest-board" aria-labelledby="manifest-title">
            <div className="section-heading">
              <ShieldCheck size={20} />
              <div>
                <h2 id="manifest-title">Manifest 读数</h2>
                <p>解析后的版本、加载器和 overrides 统计。</p>
              </div>
            </div>

            <dl className="readout-grid">
              <Readout label="来源" value={packTypeLabel} />
              <Readout label="包名" value={analysis?.metadata.name ?? "未解析"} />
              <Readout label="版本" value={analysis?.metadata.version ?? "未指定"} />
              <Readout label="Minecraft" value={analysis?.metadata.minecraftVersion ?? "未指定"} />
              <Readout label="加载器" value={loaderLabel} />
              <Readout label="加载器版本" value={analysis?.metadata.loaderVersion ?? "未指定"} />
              <Readout label="远程文件" value={`${totalMods}`} />
              <Readout
                label="overrides"
                value={analysis ? String(analysis.overrides.common + analysis.overrides.server) : "0"}
              />
            </dl>
          </section>

          <section className="mod-ledger" aria-labelledby="mods-title">
            <div className="section-heading">
              <Database size={20} />
              <div>
                <h2 id="mods-title">Mod 清单预览</h2>
                <p>展示清单来源和初步服务端决策。</p>
              </div>
            </div>

            <div className="ledger-table" role="table" aria-label="Mod 清单">
              <div className="ledger-row header" role="row">
                <span role="columnheader">Mod</span>
                <span role="columnheader">来源</span>
                <span role="columnheader">服务端决策</span>
              </div>
              {(analysis?.files ?? []).map((file, index) => (
                <ModRow key={`${file.fileName}-${index}`} file={file} />
              ))}
              {analysis && analysis.files.length === 0 && <div className="empty-line">清单里没有远程 Mod 文件。</div>}
              {!analysis && (
                <div className="empty-ledger">
                  <PackageOpen size={28} />
                  <span>导入整合包后显示 Mod 文件。</span>
                </div>
              )}
            </div>
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

function ModRow({ file }: { file: ModFileDescriptor }) {
  const decision = previewServerDecision(file);

  return (
    <div className="ledger-row" role="row">
      <span role="cell" title={file.fileName}>
        <strong>{file.fileName}</strong>
        {file.name && file.name !== file.fileName && <small>{file.name}</small>}
      </span>
      <span role="cell">{file.source}</span>
      <span role="cell" className={`decision-cell ${decision}`}>
        {decisionLabel(decision)}
      </span>
    </div>
  );
}

function isStepComplete(step: StepKey, analysis: AnalyzeResult | null): boolean {
  if (step === "input") {
    return true;
  }
  if (step === "analyze" || step === "review") {
    return Boolean(analysis);
  }
  return false;
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

function previewServerDecision(file: ModFileDescriptor): "include" | "exclude" | "manual-review" {
  if (file.env?.server === "unsupported") {
    return "exclude";
  }
  if (file.env?.server === "required" || file.env?.server === "optional") {
    return "include";
  }
  return "manual-review";
}

function decisionLabel(decision: "include" | "exclude" | "manual-review"): string {
  if (decision === "include") {
    return "保留";
  }
  if (decision === "exclude") {
    return "排除";
  }
  return "复核";
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

function formatError(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return "操作失败。请检查输入文件并重试。";
}
