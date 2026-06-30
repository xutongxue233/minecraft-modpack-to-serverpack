import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
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
import { WorkerJobManager } from "./worker-job-manager";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | null = null;
let jobManager: WorkerJobManager | null = null;

type StoredSettings = Partial<Omit<ConversionSettings, "curseForgeApiKeyConfigured">> & {
  curseForgeApiKey?: string;
};

const defaultSettings: ConversionSettings = {
  downloadConcurrent: 4,
  downloadTimeoutSeconds: 60,
  downloadRetry: 3,
  maxExpandedSizeBytes: 4 * 1024 * 1024 * 1024,
  maxFileCount: 20_000,
  unknownPolicy: "manual-review",
  outputMode: "package-only",
  downloadServerCore: false,
  outputZip: false,
  theme: "system",
  curseForgeApiKeyConfigured: false
};

async function createWindow(): Promise<void> {
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
    title: "Minecraft Serverpack Tool",
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
      title: "选择整合包",
      properties: ["openFile"],
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
    const request = UpdateSettingsRequestSchema.parse(rawRequest) as SettingsUpdateRequest;
    const current = await readStoredSettings();
    const next = mergeStoredSettings(current, request);
    await writeStoredSettings(next);
    applyCurseForgeApiKeyToEnv(next);
    return toPublicSettings(next);
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
  try {
    const text = await fs.readFile(filePath, "utf8");
    return JSON.parse(text) as StoredSettings;
  } catch {
    return {};
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
      outputZip: request.settings?.outputZip ?? settings.outputZip
    }
  };
}

function toPublicSettings(stored: StoredSettings): ConversionSettings {
  const { curseForgeApiKey: _secret, ...publicStored } = stored;
  return withRuntimeSettingsState({
    ...defaultSettings,
    defaultOutputDir: app.getPath("desktop"),
    ...publicStored
  });
}

function mergeStoredSettings(current: StoredSettings, patch: SettingsUpdateRequest): StoredSettings {
  const { curseForgeApiKey, curseForgeApiKeyConfigured: _configured, ...publicPatch } = patch as SettingsUpdateRequest & {
    curseForgeApiKeyConfigured?: boolean;
  };
  const next = mergeDefined(current, publicPatch);
  if (curseForgeApiKey !== undefined) {
    const normalized = curseForgeApiKey?.trim() ?? "";
    if (normalized) {
      next.curseForgeApiKey = normalized;
    } else {
      delete next.curseForgeApiKey;
    }
  }
  return next;
}

function applyCurseForgeApiKeyToEnv(settings: StoredSettings): void {
  const key = settings.curseForgeApiKey?.trim();
  if (key) {
    process.env.CURSEFORGE_API_KEY = key;
  } else if (!process.env.CF_API_KEY?.trim()) {
    delete process.env.CURSEFORGE_API_KEY;
  }
}

function withRuntimeSettingsState(settings: ConversionSettings): ConversionSettings {
  return {
    ...settings,
    curseForgeApiKeyConfigured: Boolean(settings.curseForgeApiKeyConfigured || process.env.CURSEFORGE_API_KEY?.trim() || process.env.CF_API_KEY?.trim())
  };
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
