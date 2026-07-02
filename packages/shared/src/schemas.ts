import { z } from "zod";

export const ModDecisionOverrideSchema = z
  .object({
    fileName: z.string().min(1).optional(),
    decision: z.enum(["include", "exclude"]),
    reason: z.string().optional(),
    pathInPack: z.string().optional(),
    source: z.enum(["curseforge", "modrinth", "direct", "local"]).optional(),
    projectId: z.string().optional(),
    fileId: z.string().optional(),
    versionId: z.string().optional(),
    modId: z.string().optional(),
    slug: z.string().optional(),
    ruleId: z.string().optional(),
    decisionSource: z.enum(["user-rule", "remote-rule"]).optional()
  })
  .refine(
    (rule) =>
      Boolean(
        rule.fileName ||
          rule.pathInPack ||
          rule.modId ||
          rule.slug ||
          (rule.source && rule.projectId) ||
          (rule.source && rule.projectId && rule.fileId) ||
          (rule.source && rule.versionId)
      ),
    {
      message:
        "Mod decision override requires fileName, pathInPack, modId, slug, source/projectId, source/projectId/fileId, or source/versionId."
    }
  );

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
      unknownPolicy: z.enum(["include", "exclude"]).optional(),
      downloadServerCore: z.boolean().optional(),
      testStartScript: z.boolean().optional(),
      startupTestTimeoutSeconds: z.number().int().min(5).max(600).optional(),
      remoteRulesEnabled: z.boolean().optional(),
      remoteRulesUrl: z.string().url().optional(),
      remoteRulesCacheDir: z.string().optional(),
      outputZip: z.boolean().optional(),
      generateOptimizedStartScript: z.boolean().optional(),
      javaHome: z.string().optional(),
      modRulesPath: z.string().optional()
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
  unknownPolicy: z.enum(["include", "exclude"]).optional(),
  downloadServerCore: z.boolean().optional(),
  testStartScript: z.boolean().optional(),
  startupTestTimeoutSeconds: z.number().int().min(5).max(600).optional(),
  remoteRulesEnabled: z.boolean().optional(),
  remoteRulesUrl: z.string().url().optional(),
  outputZip: z.boolean().optional(),
  generateOptimizedStartScript: z.boolean().optional(),
  javaHome: z.string().nullable().optional(),
  modRulesPath: z.string().nullable().optional(),
  theme: z.enum(["system", "light", "dark"]).optional(),
  curseForgeApiKey: z.string().nullable().optional()
});

export const OpenPathRequestSchema = z.object({
  path: z.string().min(1)
});
