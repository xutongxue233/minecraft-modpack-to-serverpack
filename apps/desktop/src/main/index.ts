import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from "electron";
import {
  AnalyzeRequestSchema,
  ConversionRequestSchema,
  JobIdSchema,
  OpenPathRequestSchema,
  UpdateSettingsRequestSchema,
  appError,
  ConversionRequest,
  ConversionSettings,
  SettingsUpdateRequest,
  unknownToAppError
} from "@mcsp/shared";
import { defaultRemoteModRulesUrl } from "@mcsp/core";
import { WorkerJobManager } from "./worker-job-manager";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appDisplayName = "整合包转服务端包工具";
const appUserModelId = "com.mcsp.converter";

let mainWindow: BrowserWindow | null = null;
let jobManager: WorkerJobManager | null = null;

type StoredSettings = Partial<
  Omit<ConversionSettings, "curseForgeApiKeyConfigured" | "modRulesPath" | "remoteRulesEnabled" | "remoteRulesUrl">
> & {
  curseForgeApiKey?: string;
  curseForgeApiKeyEncrypted?: string;
};

const defaultSettings: ConversionSettings = {
  downloadConcurrent: 4,
  downloadTimeoutSeconds: 60,
  downloadRetry: 3,
  unknownPolicy: "include",
  downloadServerCore: false,
  testStartScript: true,
  startupTestTimeoutSeconds: 60,
  remoteRulesEnabled: true,
  remoteRulesUrl: defaultRemoteModRulesUrl,
  outputZip: false,
  generateOptimizedStartScript: false,
  theme: "system",
  curseForgeApiKeyConfigured: false
};

app.setName(appDisplayName);
if (process.platform === "win32") {
  app.setAppUserModelId(appUserModelId);
}

async function createWindow(): Promise<void> {
  const windowIcon = resolveWindowIconPath();
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 1180,
    minHeight: 800,
    useContentSize: true,
    frame: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: "#151814",
    title: appDisplayName,
    ...(windowIcon === undefined ? {} : { icon: windowIcon }),
    webPreferences: {
      preload: resolvePreloadPath(),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });

  mainWindow.removeMenu();
  lockWindowZoom(mainWindow);

  if (process.env.ELECTRON_RENDERER_URL) {
    await mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    await mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
}

function registerIpc(): void {
  ipcMain.handle("dialog:select-input", async () => {
    const result = await dialog.showOpenDialog({
      title: "选择整合包或 packwiz 目录",
      properties: ["openFile", "openDirectory"],
      filters: [
        { name: "Minecraft 整合包", extensions: ["mrpack", "zip"] },
        { name: "全部文件", extensions: ["*"] }
      ]
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    const selectedPath = result.filePaths[0]!;
    const stat = await fs.stat(selectedPath);
    return {
      path: selectedPath,
      kind: stat.isDirectory() ? "directory" : "file"
    };
  });

  ipcMain.handle("dialog:select-input-directory", async () => {
    const result = await dialog.showOpenDialog({
      title: "选择 packwiz 目录",
      properties: ["openDirectory"]
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    return {
      path: result.filePaths[0]!,
      kind: "directory"
    };
  });

  ipcMain.handle("dialog:select-output-dir", async () => {
    const result = await dialog.showOpenDialog({
      title: "选择输出目录",
      properties: ["openDirectory", "createDirectory"]
    });

    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  ipcMain.handle("dialog:select-java-home", async () => {
    const result = await dialog.showOpenDialog({
      title: "选择 Java/JDK 目录",
      properties: ["openDirectory"]
    });

    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  ipcMain.handle("job:analyze", async (_event, rawRequest) => {
    try {
      const request = AnalyzeRequestSchema.parse(rawRequest);
      return await getJobManager().analyze(request);
    } catch (error) {
      throw unknownToAppError(error, "E_ANALYZE_FAILED");
    }
  });

  ipcMain.handle("job:start", async (_event, rawRequest) => {
    try {
      const request = ConversionRequestSchema.parse(rawRequest);
      const settings = await readSettings();
      return getJobManager().startConversion(withRuntimeConversionSettings(request, settings));
    } catch (error) {
      throw unknownToAppError(error, "E_CONVERSION_FAILED");
    }
  });

  ipcMain.handle("job:cancel", async (_event, rawRequest) => {
    const request = JobIdSchema.parse(rawRequest);
    return getJobManager().cancelJob(request.id);
  });

  ipcMain.handle("settings:get", async () => {
    return readSettings();
  });

  ipcMain.handle("settings:update", async (_event, rawRequest) => {
    try {
      const request = UpdateSettingsRequestSchema.parse(rawRequest) as SettingsUpdateRequest;
      const current = await readStoredSettings();
      const next = mergeStoredSettings(current, request);
      await writeStoredSettings(next);
      applyCurseForgeApiKeyToEnv(next);
      return toPublicSettings(next);
    } catch (error) {
      throw unknownToAppError(error, "E_SETTINGS_UPDATE_FAILED");
    }
  });

  ipcMain.handle("path:open", async (_event, rawRequest) => {
    try {
      const request = OpenPathRequestSchema.parse(rawRequest);
      const result = await shell.openPath(request.path);
      return result ? { ok: false, message: result } : { ok: true };
    } catch (error) {
      const appLevelError = unknownToAppError(error, "E_OPEN_PATH_FAILED");
      return { ok: false, message: appLevelError.message };
    }
  });

  ipcMain.handle("window:minimize", (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });

  ipcMain.handle("window:close", (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });
}

function getJobManager(): WorkerJobManager {
  if (!mainWindow) {
    throw appError("E_APP_NOT_READY", "主窗口尚未初始化。", { recoverable: true });
  }

  jobManager ??= new WorkerJobManager({
    workerPath: path.join(__dirname, "analyze-worker.js"),
    emitToRenderer: (channel, payload) => mainWindow?.webContents.send(channel, payload)
  });

  return jobManager;
}

async function readSettings(): Promise<ConversionSettings> {
  const stored = await readStoredSettings();
  applyCurseForgeApiKeyToEnv(stored);
  return toPublicSettings(stored);
}

async function readStoredSettings(): Promise<StoredSettings> {
  const filePath = settingsPath();
  let parsed: StoredSettings;
  try {
    const text = await fs.readFile(filePath, "utf8");
    parsed = JSON.parse(text) as StoredSettings;
  } catch {
    return {};
  }

  try {
    const migrated = migrateStoredSecrets(parsed);
    if (migrated.changed) {
      await writeStoredSettings(migrated.settings);
    }
    return migrated.settings;
  } catch {
    const sanitized = { ...parsed };
    delete sanitized.curseForgeApiKey;
    await writeStoredSettings(sanitized).catch(() => undefined);
    return sanitized;
  }
}

async function writeStoredSettings(settings: StoredSettings): Promise<void> {
  const filePath = settingsPath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(settings, null, 2), "utf8");
}

function settingsPath(): string {
  return path.join(app.getPath("userData"), "config.json");
}

function withRuntimeConversionSettings(request: ConversionRequest, settings: ConversionSettings): ConversionRequest {
  return {
    ...request,
    settings: {
      cacheDir: request.settings?.cacheDir ?? settings.cacheDir ?? path.join(app.getPath("userData"), "cache", "downloads"),
      downloadConcurrent: request.settings?.downloadConcurrent ?? settings.downloadConcurrent,
      downloadTimeoutSeconds: request.settings?.downloadTimeoutSeconds ?? settings.downloadTimeoutSeconds,
      downloadRetry: request.settings?.downloadRetry ?? settings.downloadRetry,
      unknownPolicy: request.settings?.unknownPolicy ?? settings.unknownPolicy,
      downloadServerCore: request.settings?.downloadServerCore ?? settings.downloadServerCore,
      testStartScript: request.settings?.testStartScript ?? settings.testStartScript,
      startupTestTimeoutSeconds: request.settings?.startupTestTimeoutSeconds ?? settings.startupTestTimeoutSeconds,
      remoteRulesEnabled: true,
      remoteRulesUrl: defaultRemoteModRulesUrl,
      remoteRulesCacheDir:
        request.settings?.remoteRulesCacheDir ?? path.join(app.getPath("userData"), "cache", "rules"),
      outputZip: request.settings?.outputZip ?? settings.outputZip,
      generateOptimizedStartScript:
        request.settings?.generateOptimizedStartScript ?? settings.generateOptimizedStartScript,
      ...(request.settings?.javaHome !== undefined || settings.javaHome !== undefined
        ? { javaHome: request.settings?.javaHome ?? settings.javaHome }
        : {})
    }
  };
}

function toPublicSettings(stored: StoredSettings): ConversionSettings {
  const {
    curseForgeApiKey: _secret,
    curseForgeApiKeyEncrypted: _encryptedSecret,
    modRulesPath: _modRulesPath,
    remoteRulesEnabled: _remoteRulesEnabled,
    remoteRulesUrl: _remoteRulesUrl,
    ...publicStored
  } = stored as StoredSettings & {
    modRulesPath?: string;
    remoteRulesEnabled?: boolean;
    remoteRulesUrl?: string;
  };
  return withRuntimeSettingsState({
    ...defaultSettings,
    defaultOutputDir: app.getPath("desktop"),
    ...publicStored,
    remoteRulesEnabled: true,
    remoteRulesUrl: defaultRemoteModRulesUrl,
    unknownPolicy: normalizeUnknownPolicy(publicStored.unknownPolicy)
  });
}

function mergeStoredSettings(current: StoredSettings, patch: SettingsUpdateRequest): StoredSettings {
  const {
    curseForgeApiKey,
    curseForgeApiKeyConfigured: _configured,
    javaHome,
    modRulesPath: _modRulesPath,
    remoteRulesEnabled: _remoteRulesEnabled,
    remoteRulesUrl: _remoteRulesUrl,
    ...publicPatch
  } = patch as SettingsUpdateRequest & {
    curseForgeApiKeyConfigured?: boolean;
    remoteRulesEnabled?: boolean;
    remoteRulesUrl?: string;
  };
  const next = mergeDefined(current, publicPatch);
  next.unknownPolicy = normalizeUnknownPolicy(next.unknownPolicy);
  const normalizedNext = next as StoredSettings & {
    modRulesPath?: string;
    remoteRulesEnabled?: boolean;
    remoteRulesUrl?: string;
  };
  delete normalizedNext.modRulesPath;
  delete normalizedNext.remoteRulesEnabled;
  delete normalizedNext.remoteRulesUrl;
  if (curseForgeApiKey !== undefined) {
    const normalized = curseForgeApiKey?.trim() ?? "";
    if (normalized) {
      next.curseForgeApiKeyEncrypted = encryptSecret(normalized);
      delete next.curseForgeApiKey;
    } else {
      delete next.curseForgeApiKey;
      delete next.curseForgeApiKeyEncrypted;
    }
  }
  if (javaHome !== undefined) {
    const normalized = normalizeJavaHome(javaHome);
    if (normalized) {
      next.javaHome = normalized;
    } else {
      delete next.javaHome;
    }
  }
  return next;
}

function normalizeJavaHome(javaHome: string | null): string | undefined {
  const normalized = javaHome?.trim() ?? "";
  if (!normalized) {
    return undefined;
  }

  const javaCommand = path.join(normalized, "bin", process.platform === "win32" ? "java.exe" : "java");
  if (!existsSync(javaCommand)) {
    throw appError("E_INVALID_JAVA_HOME", "选择的目录不是有效的 Java Home。", {
      detail: { javaHome: normalized, expectedJava: javaCommand },
      suggestion: "请选择 JDK/JRE 根目录，例如 D:\\Environment\\JDK17，而不是 bin 目录。"
    });
  }

  return normalized;
}

function normalizeUnknownPolicy(value: unknown): ConversionSettings["unknownPolicy"] {
  return value === "exclude" ? "exclude" : "include";
}

function applyCurseForgeApiKeyToEnv(settings: StoredSettings): void {
  const key = readStoredSecret(settings)?.trim();
  if (key) {
    process.env.CURSEFORGE_API_KEY = key;
  } else if (!process.env.CF_API_KEY?.trim()) {
    delete process.env.CURSEFORGE_API_KEY;
  }
}

function withRuntimeSettingsState(settings: ConversionSettings): ConversionSettings {
  return {
    ...settings,
    unknownPolicy: normalizeUnknownPolicy(settings.unknownPolicy),
    curseForgeApiKeyConfigured: Boolean(
      settings.curseForgeApiKeyConfigured ||
        readStoredSecret(settings)?.trim() ||
        process.env.CURSEFORGE_API_KEY?.trim() ||
        process.env.CF_API_KEY?.trim()
    )
  };
}

function migrateStoredSecrets(settings: StoredSettings): { settings: StoredSettings; changed: boolean } {
  const next = { ...settings };
  const legacyKey = next.curseForgeApiKey?.trim();
  if (!legacyKey) {
    if ("curseForgeApiKey" in next) {
      delete next.curseForgeApiKey;
      return { settings: next, changed: true };
    }
    return { settings: next, changed: false };
  }

  next.curseForgeApiKeyEncrypted = encryptSecret(legacyKey);
  delete next.curseForgeApiKey;
  return { settings: next, changed: true };
}

function encryptSecret(value: string): string {
  if (!safeStorage.isEncryptionAvailable()) {
    throw appError("E_SECRET_STORAGE_UNAVAILABLE", "当前系统不可用安全密钥存储，无法保存 CurseForge API Key。", {
      suggestion: "请使用环境变量 CF_API_KEY/CURSEFORGE_API_KEY，或在支持系统加密存储的环境中运行桌面程序。"
    });
  }

  return safeStorage.encryptString(value).toString("base64");
}

function readStoredSecret(settings: StoredSettings): string | undefined {
  const encrypted = settings.curseForgeApiKeyEncrypted?.trim();
  if (!encrypted) {
    return settings.curseForgeApiKey?.trim() || undefined;
  }

  try {
    return safeStorage.decryptString(Buffer.from(encrypted, "base64")).trim() || undefined;
  } catch {
    return undefined;
  }
}

function lockWindowZoom(window: BrowserWindow): void {
  window.webContents.setZoomFactor(1);
  void window.webContents.setVisualZoomLevelLimits(1, 1);
  window.webContents.on("did-finish-load", () => {
    window.webContents.setZoomFactor(1);
  });
  window.webContents.on("before-input-event", (event, input) => {
    const key = input.key.toLowerCase();
    if ((input.control || input.meta) && (key === "+" || key === "-" || key === "=" || key === "0")) {
      event.preventDefault();
    }
  });
  window.on("enter-full-screen", () => {
    window.setFullScreen(false);
  });
}

function resolvePreloadPath(): string {
  const candidates = [path.join(__dirname, "../preload/index.js"), path.join(__dirname, "../preload/index.mjs")];
  const preloadPath = candidates.find((candidate) => existsSync(candidate));

  if (!preloadPath) {
    throw appError("E_PRELOAD_NOT_FOUND", "找不到 preload 脚本。", {
      detail: candidates,
      suggestion: "请重新构建桌面程序。"
    });
  }

  return preloadPath;
}

function resolveWindowIconPath(): string | undefined {
  const candidates = [
    path.join(__dirname, "../../build/icon.ico"),
    path.join(process.cwd(), "build/icon.ico"),
    path.join(process.cwd(), "apps/desktop/build/icon.ico")
  ];

  return candidates.find((candidate) => existsSync(candidate));
}

type DefinedPatch<T> = {
  [K in keyof T]?: T[K] | undefined;
};

function mergeDefined<T extends object>(base: T, patch: DefinedPatch<T>): T {
  const next = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) {
      (next as Record<string, unknown>)[key] = value;
    }
  }
  return next;
}

app.whenReady().then(async () => {
  registerIpc();
  await createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
