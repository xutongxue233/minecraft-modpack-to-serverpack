import { z } from "zod";

export const AnalyzeRequestSchema = z.object({
  inputPath: z.string().min(1)
});

export const ConversionRequestSchema = z.object({
  inputPath: z.string().min(1),
  outputDir: z.string().min(1),
  settings: z
    .object({
      cacheDir: z.string().optional(),
      downloadConcurrent: z.number().int().min(1).max(16).optional(),
      downloadTimeoutSeconds: z.number().int().min(5).max(600).optional(),
      downloadRetry: z.number().int().min(0).max(10).optional(),
      unknownPolicy: z.enum(["manual-review", "include", "exclude"]).optional(),
      downloadServerCore: z.boolean().optional(),
      outputZip: z.boolean().optional(),
      javaHome: z.string().optional()
    })
    .optional()
});

export const JobIdSchema = z.object({
  id: z.string().min(1)
});

export const UpdateSettingsRequestSchema = z.object({
  defaultOutputDir: z.string().optional(),
  cacheDir: z.string().optional(),
  downloadConcurrent: z.number().int().min(1).max(16).optional(),
  downloadTimeoutSeconds: z.number().int().min(5).max(600).optional(),
  downloadRetry: z.number().int().min(0).max(10).optional(),
  maxExpandedSizeBytes: z.number().int().positive().optional(),
  maxFileCount: z.number().int().positive().optional(),
  unknownPolicy: z.enum(["manual-review", "include", "exclude"]).optional(),
  outputMode: z.enum(["package-only", "installable-server"]).optional(),
  downloadServerCore: z.boolean().optional(),
  outputZip: z.boolean().optional(),
  javaHome: z.string().nullable().optional(),
  theme: z.enum(["system", "light", "dark"]).optional(),
  curseForgeApiKey: z.string().nullable().optional()
});

export const OpenPathRequestSchema = z.object({
  path: z.string().min(1)
});
