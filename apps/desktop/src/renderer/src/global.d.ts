import type {
  AnalyzeRequest,
  AnalyzeResult,
  ConversionRequest,
  ConversionSettings,
  InputSelection,
  JobEvent,
  JobId,
  OpenPathResult,
  SettingsUpdateRequest
} from "@mcsp/shared";

declare global {
  interface Window {
    serverpack: {
      selectInput: () => Promise<InputSelection | null>;
      selectInputDirectory: () => Promise<InputSelection | null>;
      selectOutputDir: () => Promise<string | null>;
      selectJavaHome: () => Promise<string | null>;
      analyzeInput: (request: AnalyzeRequest) => Promise<AnalyzeResult>;
      startConversion: (request: ConversionRequest) => Promise<JobId>;
      cancelJob: (jobId: string) => Promise<boolean>;
      onJobEvent: (handler: (event: JobEvent) => void) => () => void;
      getSettings: () => Promise<ConversionSettings>;
      updateSettings: (settings: SettingsUpdateRequest) => Promise<ConversionSettings>;
      openPath: (path: string) => Promise<OpenPathResult>;
      resolveDroppedFile: (file: File) => string;
      minimizeWindow: () => Promise<void>;
      closeWindow: () => Promise<void>;
    };
  }
}

export {};
