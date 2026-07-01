import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent } from "react";
import {
  AlertTriangle,
  Ban,
  Box,
  Check,
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
  RotateCcw,
  Search,
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
  JobProgressGroup,
  ModDecisionOverride,
  ModDecisionValue,
  ModFileDescriptor
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

type FinalModDecision = Exclude<ModDecisionValue, "manual-review">;
type ReviewFilter = "all" | "manual-review" | "include" | "exclude" | "changed";

const reviewFilters: Array<{ value: ReviewFilter; label: string }> = [
  { value: "all", label: "全部" },
  { value: "manual-review", label: "待复核" },
  { value: "include", label: "保留" },
  { value: "exclude", label: "排除" },
  { value: "changed", label: "已改" }
];

interface ModReviewRow {
  file: ModFileDescriptor;
  index: number;
  key: string;
  automaticDecision: ModDecisionValue;
  effectiveDecision: ModDecisionValue;
  userDecision?: FinalModDecision;
}

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
  const [modRuleOverrides, setModRuleOverrides] = useState<ModDecisionOverride[]>([]);
  const [remoteRuleOverrides, setRemoteRuleOverrides] = useState<ModDecisionOverride[]>([]);
  const [reviewDecisions, setReviewDecisions] = useState<Record<string, FinalModDecision>>({});
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>("all");
  const [reviewSearch, setReviewSearch] = useState("");
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

  useEffect(() => {
    let active = true;
    setModRuleOverrides([]);

    const rulesPath = settings?.modRulesPath;
    if (!rulesPath || !window.serverpack) {
      return () => {
        active = false;
      };
    }

    void window.serverpack
      .loadModRules(rulesPath)
      .then((rules) => {
        if (active) {
          setModRuleOverrides(rules);
        }
      })
      .catch((rawError: unknown) => {
        if (active) {
          setError(formatError(rawError));
        }
      });

    return () => {
      active = false;
    };
  }, [settings?.modRulesPath]);

  useEffect(() => {
    let active = true;
    setRemoteRuleOverrides([]);

    if (!analysis || !settings?.remoteRulesEnabled || !window.serverpack) {
      return () => {
        active = false;
      };
    }

    void window.serverpack
      .loadRemoteModRules(analysis.metadata)
      .then((rules) => {
        if (active) {
          setRemoteRuleOverrides(rules);
        }
      })
      .catch((rawError: unknown) => {
        if (active) {
          setError(formatError(rawError));
        }
      });

    return () => {
      active = false;
    };
  }, [analysis, settings?.remoteRulesEnabled, settings?.remoteRulesUrl]);

  const totalMods = analysis?.files.length ?? 0;
  const loaderLabel = analysis?.metadata.loader ?? "未识别";
  const packTypeLabel = analysis ? sourceName[analysis.metadata.type] ?? analysis.metadata.type : "等待输入";
  const bridgeOnline = Boolean(window.serverpack);
  const analysisWarnings = analysis?.warnings ?? [];
  const targetOutputDir = outputDir || settings?.defaultOutputDir || "";

  const modRuleIndex = useMemo(
    () => buildRuleIndex([...remoteRuleOverrides, ...modRuleOverrides]),
    [modRuleOverrides, remoteRuleOverrides]
  );

  const reviewRows = useMemo<ModReviewRow[]>(() => {
    return (analysis?.files ?? []).map((file, index) => {
      const key = modFileKey(file, index);
      const automaticDecision =
        findRuleDecision(file, modRuleIndex) ?? previewServerDecision(file, settings?.unknownPolicy ?? "manual-review");
      const userDecision = reviewDecisions[key];
      return {
        file,
        index,
        key,
        automaticDecision,
        effectiveDecision: userDecision ?? automaticDecision,
        ...(userDecision === undefined ? {} : { userDecision })
      };
    });
  }, [analysis?.files, modRuleIndex, reviewDecisions, settings?.unknownPolicy]);

  const reviewSummary = useMemo(() => {
    return {
      include: reviewRows.filter((row) => row.effectiveDecision === "include").length,
      exclude: reviewRows.filter((row) => row.effectiveDecision === "exclude").length,
      manualReview: reviewRows.filter((row) => row.effectiveDecision === "manual-review").length,
      changed: reviewRows.filter((row) => row.userDecision !== undefined).length
    };
  }, [reviewRows]);

  const filteredReviewRows = useMemo(() => {
    const query = reviewSearch.trim().toLowerCase();
    return reviewRows.filter((row) => {
      const matchesFilter =
        reviewFilter === "all" ||
        (reviewFilter === "changed" && row.userDecision !== undefined) ||
        row.effectiveDecision === reviewFilter;
      if (!matchesFilter) {
        return false;
      }
      if (!query) {
        return true;
      }
      const haystack = [
        row.file.fileName,
        row.file.name,
        row.file.slug,
        row.file.projectId,
        row.file.fileId,
        row.file.versionId,
        row.file.pathInPack,
        row.file.source
      ]
        .filter((value): value is string => typeof value === "string" && value.length > 0)
        .join(" ")
        .toLowerCase();
      return haystack.includes(query);
    });
  }, [reviewFilter, reviewRows, reviewSearch]);

  const manualReviewCount = reviewSummary.manualReview;

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

  const modRulesPath = useMemo(() => {
    if (!settings?.modRulesPath) {
      return "未配置，使用自动判断和本次人工复核";
    }
    return compactPath(settings.modRulesPath, 64);
  }, [settings?.modRulesPath]);

  const applyInputSelection = useCallback((selected: InputSelection) => {
    setInput(selected);
    setAnalysis(null);
    setReviewDecisions({});
    setReviewFilter("all");
    setReviewSearch("");
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
      setReviewDecisions({});
      setReviewFilter("all");
      setReviewSearch("");
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
    if (manualReviewCount > 0) {
      setError(`还有 ${manualReviewCount} 个 Mod 需要复核，请先选择保留或排除。`);
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
          ...(settings?.unknownPolicy === undefined ? {} : { unknownPolicy: settings.unknownPolicy }),
          ...(settings?.downloadServerCore === undefined ? {} : { downloadServerCore: settings.downloadServerCore }),
          testStartScript: Boolean(settings?.downloadServerCore && (settings.testStartScript ?? true)),
          ...(settings?.startupTestTimeoutSeconds === undefined
            ? {}
            : { startupTestTimeoutSeconds: settings.startupTestTimeoutSeconds }),
          ...(settings?.remoteRulesEnabled === undefined ? {} : { remoteRulesEnabled: settings.remoteRulesEnabled }),
          ...(settings?.remoteRulesUrl === undefined ? {} : { remoteRulesUrl: settings.remoteRulesUrl }),
          ...(settings?.outputZip === undefined ? {} : { outputZip: settings.outputZip }),
          ...(settings?.javaHome === undefined ? {} : { javaHome: settings.javaHome }),
          ...(settings?.modRulesPath === undefined ? {} : { modRulesPath: settings.modRulesPath }),
          ...(reviewRows.some((row) => row.userDecision !== undefined)
            ? { modDecisions: reviewRows.filter(hasUserDecision).map(toDecisionOverride) }
            : {})
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
  }, [input, manualReviewCount, reviewRows, settings, targetOutputDir]);

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

  const updateRemoteRulesEnabled = useCallback(
    async (value: boolean) => {
      if (!settings) {
        return;
      }

      const next = await window.serverpack.updateSettings({ remoteRulesEnabled: value });
      setSettings(next);
    },
    [settings]
  );

  const updateUnknownModReview = useCallback(
    async (value: boolean) => {
      if (!settings) {
        return;
      }

      setError(null);
      try {
        const next = await window.serverpack.updateSettings({ unknownPolicy: value ? "manual-review" : "exclude" });
        setSettings(next);
        setSettingsMessage(value ? "未知 Mod 将进入人工复核" : "未知 Mod 将默认排除");
      } catch (rawError) {
        setError(formatError(rawError));
      }
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

  const selectModRulesFile = useCallback(async () => {
    if (!settings) {
      return;
    }

    setError(null);
    setSettingsMessage(null);
    try {
      const selected = await window.serverpack.selectModRulesFile();
      if (!selected) {
        return;
      }
      const next = await window.serverpack.updateSettings({ modRulesPath: selected });
      setSettings(next);
      setSettingsMessage("Mod 规则文件已保存");
    } catch (rawError) {
      setError(formatError(rawError));
    }
  }, [settings]);

  const clearModRulesFile = useCallback(async () => {
    if (!settings) {
      return;
    }

    setError(null);
    setSettingsMessage(null);
    try {
      const next = await window.serverpack.updateSettings({ modRulesPath: null });
      setSettings(next);
      setSettingsMessage("Mod 规则文件已清除");
    } catch (rawError) {
      setError(formatError(rawError));
    }
  }, [settings]);

  const updateReviewDecision = useCallback((key: string, decision: FinalModDecision | null) => {
    setReviewDecisions((current) => {
      const next = { ...current };
      if (decision === null) {
        delete next[key];
      } else {
        next[key] = decision;
      }
      return next;
    });
  }, []);

  const applyBulkDecision = useCallback(
    (decision: FinalModDecision) => {
      const keys = filteredReviewRows
        .filter((row) => row.effectiveDecision === "manual-review" || row.userDecision !== undefined)
        .map((row) => row.key);
      if (keys.length === 0) {
        return;
      }
      setReviewDecisions((current) => {
        const next = { ...current };
        for (const key of keys) {
          next[key] = decision;
        }
        return next;
      });
    },
    [filteredReviewRows]
  );

  const resetReviewDecisions = useCallback(() => {
    setReviewDecisions({});
  }, []);

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

            {analysis && manualReviewCount > 0 && (
              <div className="review-warning" role="status">
                <AlertTriangle size={16} />
                <span>{manualReviewCount} 个 Mod 需要复核后才能生成服务端包。</span>
              </div>
            )}

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
                  checked={settings?.remoteRulesEnabled ?? true}
                  onChange={(event) => void updateRemoteRulesEnabled(event.currentTarget.checked)}
                />
                <span>远程规则库</span>
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={settings?.outputZip ?? false}
                  onChange={(event) => void updateOutputZip(event.currentTarget.checked)}
                />
                <span>输出 zip</span>
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={(settings?.unknownPolicy ?? "manual-review") === "manual-review"}
                  disabled={!settings}
                  onChange={(event) => void updateUnknownModReview(event.currentTarget.checked)}
                />
                <span>未知 Mod 进入复核</span>
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

            <div className="rules-panel">
              <div className="rules-title">
                <FileText size={16} />
                <span>Mod 规则文件</span>
                <strong className={settings?.modRulesPath ? "configured" : ""}>
                  {settings?.modRulesPath ? "已启用" : "未启用"}
                </strong>
              </div>
              <div className="rules-row">
                <output title={settings?.modRulesPath || undefined}>{modRulesPath}</output>
                <button type="button" onClick={selectModRulesFile}>
                  <FolderOpen size={15} />
                  选择规则
                </button>
                {settings?.modRulesPath && (
                  <button className="ghost" type="button" onClick={clearModRulesFile}>
                    清除
                  </button>
                )}
              </div>
              <p className="settings-message">支持 JSON/YAML，规则会优先于自动判断；本次人工复核优先级最高。</p>
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
                disabled={!input || !targetOutputDir || converting || !bridgeOnline || manualReviewCount > 0}
              >
                {converting ? <Loader2 className="spin" size={18} /> : <Play size={18} />}
                {converting ? "任务运行中" : manualReviewCount > 0 ? "等待复核完成" : "生成服务端包"}
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
                <h2 id="mods-title">Mod 复核清单</h2>
                <p>确认未知 Mod 是否进入服务端包。</p>
              </div>
            </div>

            {analysis && (
              <div className="review-toolbar" aria-label="Mod 复核工具栏">
                <div className="review-stats">
                  <span>保留 {reviewSummary.include}</span>
                  <span>排除 {reviewSummary.exclude}</span>
                  <span className={manualReviewCount > 0 ? "attention" : ""}>复核 {manualReviewCount}</span>
                  <span>已改 {reviewSummary.changed}</span>
                </div>

                <div className="review-controls">
                  <label className="review-search">
                    <Search size={14} />
                    <input
                      type="search"
                      value={reviewSearch}
                      placeholder="搜索 Mod"
                      onChange={(event) => setReviewSearch(event.currentTarget.value)}
                    />
                  </label>

                  <div className="review-filter" role="tablist" aria-label="复核筛选">
                    {reviewFilters.map((filter) => (
                      <button
                        key={filter.value}
                        type="button"
                        className={reviewFilter === filter.value ? "active" : ""}
                        onClick={() => setReviewFilter(filter.value)}
                      >
                        {filter.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="review-bulk-actions">
                  <button type="button" onClick={() => applyBulkDecision("include")}>
                    <Check size={14} />
                    当前保留
                  </button>
                  <button type="button" onClick={() => applyBulkDecision("exclude")}>
                    <Ban size={14} />
                    当前排除
                  </button>
                  <button type="button" onClick={resetReviewDecisions} disabled={reviewSummary.changed === 0}>
                    <RotateCcw size={14} />
                    重置
                  </button>
                </div>
              </div>
            )}

            <div className="ledger-table" role="table" aria-label="Mod 清单">
              <div className="ledger-row header" role="row">
                <span role="columnheader">Mod</span>
                <span role="columnheader">来源</span>
                <span role="columnheader">自动判断</span>
                <span role="columnheader">人工复核</span>
              </div>
              {filteredReviewRows.map((row) => (
                <ModRow
                  key={row.key}
                  row={row}
                  onDecision={(decision) => updateReviewDecision(row.key, decision)}
                  onReset={() => updateReviewDecision(row.key, null)}
                />
              ))}
              {analysis && reviewRows.length === 0 && <div className="empty-line">清单里没有远程 Mod 文件。</div>}
              {analysis && reviewRows.length > 0 && filteredReviewRows.length === 0 && (
                <div className="empty-line">没有匹配当前筛选的 Mod。</div>
              )}
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

function ModRow({
  row,
  onDecision,
  onReset
}: {
  row: ModReviewRow;
  onDecision: (decision: FinalModDecision) => void;
  onReset: () => void;
}) {
  return (
    <div className="ledger-row" role="row">
      <span role="cell" title={row.file.fileName}>
        <strong>{row.file.fileName}</strong>
        {row.file.name && row.file.name !== row.file.fileName && <small>{row.file.name}</small>}
      </span>
      <span role="cell">{row.file.source}</span>
      <span role="cell" className={`decision-cell ${row.automaticDecision}`}>
        {decisionLabel(row.automaticDecision)}
      </span>
      <span role="cell" className={`review-cell ${row.userDecision ? "changed" : ""}`}>
        <button
          className={row.effectiveDecision === "include" ? "active include" : ""}
          type="button"
          title="保留到服务端包"
          onClick={() => onDecision("include")}
        >
          <Check size={13} />
          保留
        </button>
        <button
          className={row.effectiveDecision === "exclude" ? "active exclude" : ""}
          type="button"
          title="从服务端包排除"
          onClick={() => onDecision("exclude")}
        >
          <Ban size={13} />
          排除
        </button>
        {row.userDecision && (
          <button className="reset" type="button" title="恢复自动判断" onClick={onReset}>
            <RotateCcw size={13} />
          </button>
        )}
      </span>
    </div>
  );
}

function hasUserDecision(row: ModReviewRow): row is ModReviewRow & { userDecision: FinalModDecision } {
  return row.userDecision !== undefined;
}

function toDecisionOverride(row: ModReviewRow & { userDecision: FinalModDecision }): ModDecisionOverride {
  return {
    fileName: row.file.fileName,
    decision: row.userDecision,
    reason: `用户复核：${decisionLabel(row.userDecision)}`,
    ...(row.file.pathInPack === undefined ? {} : { pathInPack: row.file.pathInPack }),
    source: row.file.source,
    ...(row.file.projectId === undefined ? {} : { projectId: row.file.projectId }),
    ...(row.file.fileId === undefined ? {} : { fileId: row.file.fileId }),
    ...(row.file.versionId === undefined ? {} : { versionId: row.file.versionId })
  };
}

function modFileKey(file: ModFileDescriptor, index: number): string {
  return [
    index,
    file.source,
    file.pathInPack ?? "",
    file.projectId ?? "",
    file.fileId ?? "",
    file.versionId ?? "",
    file.fileName
  ].join("|");
}

function buildRuleIndex(overrides: ModDecisionOverride[]): Map<string, FinalModDecision> {
  const index = new Map<string, FinalModDecision>();
  for (const override of overrides) {
    for (const key of modDecisionOverrideKeys(override)) {
      index.set(key, override.decision);
    }
  }
  return index;
}

function findRuleDecision(
  file: ModFileDescriptor,
  index: Map<string, FinalModDecision>
): FinalModDecision | undefined {
  for (const key of modDecisionFileKeys(file)) {
    const decision = index.get(key);
    if (decision) {
      return decision;
    }
  }
  return undefined;
}

function modDecisionFileKeys(file: ModFileDescriptor): string[] {
  return [
    ...(file.pathInPack ? [`path:${file.pathInPack}`] : []),
    ...(file.projectId && file.fileId ? [`platform:${file.source}:${file.projectId}:${file.fileId}`] : []),
    ...(file.projectId ? [`project:${file.source}:${file.projectId}`] : []),
    ...(file.versionId ? [`version:${file.source}:${file.versionId}`] : []),
    ...(file.slug ? [`slug:${file.source}:${normalizeRuleValue(file.slug)}`, `slug:${normalizeRuleValue(file.slug)}`] : []),
    `file:${file.fileName}`
  ];
}

function modDecisionOverrideKeys(override: ModDecisionOverride): string[] {
  return [
    ...(override.pathInPack ? [`path:${override.pathInPack}`] : []),
    ...(override.source && override.projectId && override.fileId
      ? [`platform:${override.source}:${override.projectId}:${override.fileId}`]
      : []),
    ...(override.source && override.projectId ? [`project:${override.source}:${override.projectId}`] : []),
    ...(override.source && override.versionId ? [`version:${override.source}:${override.versionId}`] : []),
    ...(override.modId ? [`modid:${normalizeRuleValue(override.modId)}`] : []),
    ...(override.slug
      ? [
          ...(override.source ? [`slug:${override.source}:${normalizeRuleValue(override.slug)}`] : []),
          `slug:${normalizeRuleValue(override.slug)}`
        ]
      : []),
    ...(override.fileName ? [`file:${override.fileName}`] : [])
  ];
}

function normalizeRuleValue(value: string): string {
  return value.trim().toLowerCase();
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

function previewServerDecision(
  file: ModFileDescriptor,
  unknownPolicy: ConversionSettings["unknownPolicy"]
): "include" | "exclude" | "manual-review" {
  if (file.env?.server === "unsupported") {
    return "exclude";
  }
  if (file.env?.server === "required" || file.env?.server === "optional") {
    return "include";
  }
  return unknownPolicy;
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
