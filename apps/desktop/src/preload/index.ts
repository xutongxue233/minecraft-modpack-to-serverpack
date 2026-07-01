import { contextBridge, ipcRenderer, webUtils } from "electron";
import type {
  AnalyzeRequest,
  AnalyzeResult,
  ConversionRequest,
  ConversionSettings,
  InputSelection,
  JobEvent,
  JobId,
  ModDecisionOverride,
  OpenPathResult,
  SettingsUpdateRequest
} from "@mcsp/shared";

const api = {
  selectInput: (): Promise<InputSelection | null> => ipcRenderer.invoke("dialog:select-input"),
  selectInputDirectory: (): Promise<InputSelection | null> => ipcRenderer.invoke("dialog:select-input-directory"),
  selectOutputDir: (): Promise<string | null> => ipcRenderer.invoke("dialog:select-output-dir"),
  selectJavaHome: (): Promise<string | null> => ipcRenderer.invoke("dialog:select-java-home"),
  selectModRulesFile: (): Promise<string | null> => ipcRenderer.invoke("dialog:select-mod-rules-file"),
  analyzeInput: (request: AnalyzeRequest): Promise<AnalyzeResult> => ipcRenderer.invoke("job:analyze", request),
  startConversion: (request: ConversionRequest): Promise<JobId> => ipcRenderer.invoke("job:start", request),
  cancelJob: (jobId: string): Promise<boolean> => ipcRenderer.invoke("job:cancel", { id: jobId }),
  onJobEvent: (handler: (event: JobEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: JobEvent): void => handler(payload);
    ipcRenderer.on("job:event", listener);
    return () => ipcRenderer.off("job:event", listener);
  },
  getSettings: (): Promise<ConversionSettings> => ipcRenderer.invoke("settings:get"),
  updateSettings: (settings: SettingsUpdateRequest): Promise<ConversionSettings> =>
    ipcRenderer.invoke("settings:update", settings),
  loadModRules: (path: string): Promise<ModDecisionOverride[]> => ipcRenderer.invoke("rules:load", { path }),
  openPath: (targetPath: string): Promise<OpenPathResult> => ipcRenderer.invoke("path:open", { path: targetPath }),
  resolveDroppedFile: (file: File): string => webUtils.getPathForFile(file),
  minimizeWindow: (): Promise<void> => ipcRenderer.invoke("window:minimize"),
  closeWindow: (): Promise<void> => ipcRenderer.invoke("window:close")
};

contextBridge.exposeInMainWorld("serverpack", api);
