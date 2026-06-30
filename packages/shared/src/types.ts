export type PackType = "curseforge" | "modrinth" | "packwiz" | "instance";
export type LoaderType = "forge" | "neoforge" | "fabric" | "quilt" | "vanilla";
export type ModDecisionValue = "include" | "exclude" | "manual-review";

export interface PackMetadata {
  type: PackType;
  name: string;
  version?: string;
  minecraftVersion?: string;
  loader?: LoaderType;
  loaderVersion?: string;
}

export interface InputSelection {
  path: string;
  kind: "file" | "directory";
}

export interface ModFileDescriptor {
  id?: string;
  projectId?: string;
  fileId?: string;
  versionId?: string;
  slug?: string;
  name?: string;
  fileName: string;
  source: "curseforge" | "modrinth" | "direct" | "local";
  downloadUrls: string[];
  expectedHashes: Record<string, string>;
  pathInPack?: string;
  metadataSource?: "manifest" | "curseforge-api" | "modrinth-api" | "jar-metadata";
  pageUrl?: string;
  envSource?: "manifest" | "platform-api";
  env?: {
    client?: "required" | "optional" | "unsupported";
    server?: "required" | "optional" | "unsupported";
  };
}

export interface ModDecision {
  fileName: string;
  decision: ModDecisionValue;
  reason: string;
  source: "manifest" | "platform-api" | "jar-metadata" | "builtin-rule" | "user-rule" | "unknown";
}

export interface AnalyzeRequest {
  inputPath: string;
}

export interface ConversionRequestSettings {
  cacheDir?: string | undefined;
  downloadConcurrent?: number | undefined;
  downloadTimeoutSeconds?: number | undefined;
  downloadRetry?: number | undefined;
  unknownPolicy?: ConversionSettings["unknownPolicy"] | undefined;
  outputZip?: boolean | undefined;
}

export interface ConversionRequest {
  inputPath: string;
  outputDir: string;
  settings?: ConversionRequestSettings | undefined;
}

export interface AnalyzeResult {
  metadata: PackMetadata;
  files: ModFileDescriptor[];
  overrides: {
    common: number;
    server: number;
    client: number;
  };
  warnings: string[];
}

export interface ConversionReport {
  schemaVersion: 1;
  generatedAt: string;
  input: {
    path: string;
    type: PackType;
    name: string;
    version?: string;
  };
  target: {
    minecraftVersion?: string;
    loader?: LoaderType;
    loaderVersion?: string;
  };
  overrides: AnalyzeResult["overrides"];
  files: Array<{
    fileName: string;
    displayName?: string;
    modId?: string;
    version?: string;
    source: ModFileDescriptor["source"];
    metadataSource?: string;
    downloadStatus: "cached" | "downloaded" | "missing-url" | "failed" | "skipped";
    downloadError?: string;
    sizeBytes?: number;
    hashes: Record<string, string>;
    decision: ModDecisionValue;
    decisionReason: string;
    decisionSource: ModDecision["source"];
  }>;
  summary: {
    totalFiles: number;
    downloadedFiles: number;
    cachedFiles: number;
    missingUrlFiles: number;
    failedDownloadFiles: number;
    includedFiles: number;
    excludedFiles: number;
    manualReviewFiles: number;
  };
  serverpack: {
    core: {
      type: LoaderType;
      minecraftVersion?: string;
      loaderVersion?: string;
      javaMajor: 8 | 16 | 17 | 21;
      notes: string[];
    };
    writtenModFiles: number;
    skippedModFiles: number;
    mergedOverrideFiles: number;
    installScripts: string[];
    startScripts: string[];
    supportFiles: string[];
    zipPath?: string;
  };
  warnings: string[];
  errors: AppError[];
}

export interface ConversionResult {
  outputDir: string;
  reportPath: string;
  readmePath: string;
  zipPath?: string;
  report: ConversionReport;
}

export interface ConversionSettings {
  defaultOutputDir?: string;
  cacheDir?: string;
  downloadConcurrent: number;
  downloadTimeoutSeconds: number;
  downloadRetry: number;
  maxExpandedSizeBytes: number;
  maxFileCount: number;
  unknownPolicy: "manual-review" | "include" | "exclude";
  outputMode: "package-only" | "installable-server";
  outputZip: boolean;
  theme: "system" | "light" | "dark";
  curseForgeApiKeyConfigured: boolean;
}

export type SettingsUpdateRequest = Partial<Omit<ConversionSettings, "curseForgeApiKeyConfigured">> & {
  curseForgeApiKey?: string | null;
};

export type ConversionPhase =
  | "idle"
  | "analyzing"
  | "downloading"
  | "verifying"
  | "reviewing"
  | "packaging"
  | "completed"
  | "failed"
  | "cancelled";

export interface JobId {
  id: string;
}

export type JobEvent =
  | { type: "phase"; jobId: string; phase: ConversionPhase; message: string }
  | { type: "progress"; jobId: string; current: number; total: number; bytesPerSecond?: number }
  | { type: "log"; jobId: string; level: "debug" | "info" | "warn" | "error"; message: string }
  | { type: "completed"; jobId: string; outputDir: string; zipPath?: string; reportPath: string }
  | { type: "failed"; jobId: string; error: AppError; reportPath?: string }
  | { type: "cancelled"; jobId: string };

export interface AppError {
  code: string;
  message: string;
  detail?: unknown;
  suggestion?: string;
  recoverable: boolean;
}

export interface OpenPathResult {
  ok: boolean;
  message?: string;
}
