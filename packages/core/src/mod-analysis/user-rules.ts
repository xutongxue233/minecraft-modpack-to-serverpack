import fs from "node:fs/promises";
import path from "node:path";
import {
  appError,
  ModDecisionOverrideSchema,
  type LoaderType,
  type ModDecisionOverride,
  type PackMetadata,
  type RuleDecisionSource
} from "@mcsp/shared";
import { parse as parseYaml } from "yaml";

type RuleBucket = "include" | "exclude";
type UnknownRecord = Record<string, unknown>;

interface NormalizeOptions {
  decisionSource: RuleDecisionSource;
  context?: RuleContext | undefined;
}

export interface RuleContext {
  minecraftVersion?: string | undefined;
  loader?: LoaderType | undefined;
}

export interface RemoteRuleLoadOptions {
  url?: string | undefined;
  cacheDir: string;
  fetchImpl?: typeof fetch | undefined;
  context?: RuleContext | undefined;
  onLog?: (message: string) => void;
  onWarning?: (message: string) => void;
}

interface RemoteRuleCacheMeta {
  url?: string;
  etag?: string;
  lastModified?: string;
}

export const defaultRemoteModRulesUrl =
  "https://raw.githubusercontent.com/xutongxue233/minecraft-modpack-to-serverpack/main/rules/client-mod-rules.json";

export async function loadModDecisionRules(
  filePath?: string,
  context?: RuleContext
): Promise<ModDecisionOverride[]> {
  const normalizedPath = filePath?.trim();
  if (!normalizedPath) {
    return [];
  }

  const text = await fs.readFile(normalizedPath, "utf8");
  const raw = parseRulesFile(text, normalizedPath);
  return normalizeRulesFile(raw, normalizedPath, { decisionSource: "user-rule", context });
}

export async function loadRemoteModDecisionRules(options: RemoteRuleLoadOptions): Promise<ModDecisionOverride[]> {
  const url = options.url?.trim() || defaultRemoteModRulesUrl;
  const fetchImpl = options.fetchImpl ?? fetch;
  const cacheFile = path.join(options.cacheDir, "client-mod-rules.json");
  const metaFile = path.join(options.cacheDir, "client-mod-rules.meta.json");
  const meta = await readCacheMeta(metaFile);

  try {
    await fs.mkdir(options.cacheDir, { recursive: true });
    const response = await fetchImpl(url, {
      headers: {
        accept: "application/json, text/yaml, text/plain",
        "user-agent": "MinecraftServerpackTool/0.1.0",
        ...(meta?.etag ? { "if-none-match": meta.etag } : {}),
        ...(meta?.lastModified ? { "if-modified-since": meta.lastModified } : {})
      }
    });

    if (response.status === 304) {
      const cached = await fs.readFile(cacheFile, "utf8");
      options.onLog?.("远程规则库未更新，使用本地缓存。");
      return normalizeRulesFile(parseRulesFile(cached, url), url, {
        decisionSource: "remote-rule",
        context: options.context
      });
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text().catch(() => "")}`);
    }

    const text = await response.text();
    await fs.writeFile(cacheFile, text, "utf8");
    await fs.writeFile(
      metaFile,
      `${JSON.stringify(
        {
          url,
          etag: response.headers.get("etag") ?? undefined,
          lastModified: response.headers.get("last-modified") ?? undefined
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    options.onLog?.("远程规则库已更新。");
    return normalizeRulesFile(parseRulesFile(text, url), url, {
      decisionSource: "remote-rule",
      context: options.context
    });
  } catch (error) {
    const cached = await fs.readFile(cacheFile, "utf8").catch(() => undefined);
    if (cached !== undefined) {
      options.onWarning?.(`远程规则库拉取失败，已使用本地缓存：${formatError(error)}。`);
      return normalizeRulesFile(parseRulesFile(cached, url), url, {
        decisionSource: "remote-rule",
        context: options.context
      });
    }

    options.onWarning?.(`远程规则库拉取失败，已跳过远程规则：${formatError(error)}。`);
    return [];
  }
}

export function ruleContextFromMetadata(metadata: PackMetadata): RuleContext {
  return {
    ...(metadata.minecraftVersion === undefined ? {} : { minecraftVersion: metadata.minecraftVersion }),
    ...(metadata.loader === undefined ? {} : { loader: metadata.loader })
  };
}

function parseRulesFile(text: string, filePath: string): unknown {
  const isRemote = filePath.startsWith("http");
  const extension = path.extname(isRemote ? new URL(filePath).pathname : filePath).toLowerCase();
  try {
    if (extension === ".json" || (isRemote && extension !== ".yaml" && extension !== ".yml")) {
      return JSON.parse(text) as unknown;
    }
    if (extension === ".yaml" || extension === ".yml") {
      return parseYaml(text) as unknown;
    }
  } catch (error) {
    throw appError("E_RULES_FILE_PARSE_FAILED", "规则文件解析失败。", {
      detail: error instanceof Error ? error.message : error,
      suggestion: "请检查规则文件是否为合法 JSON、YAML 或 YML。"
    });
  }

  throw appError("E_RULES_FILE_FORMAT_UNSUPPORTED", "规则文件格式不受支持。", {
    detail: { filePath, extension },
    suggestion: "请使用 .json、.yaml 或 .yml 规则文件。"
  });
}

function normalizeRulesFile(
  raw: unknown,
  filePath: string,
  options: NormalizeOptions
): ModDecisionOverride[] {
  if (Array.isArray(raw)) {
    return raw.flatMap((entry, index) => normalizeRule(entry, undefined, filePath, `rules[${index}]`, options));
  }

  if (!isRecord(raw)) {
    throw invalidRulesFile(filePath, "根节点必须是规则数组，或包含 rules/include/exclude 的对象。");
  }

  const rules: ModDecisionOverride[] = [];
  const explicitRules = raw["rules"];
  if (explicitRules !== undefined) {
    if (!Array.isArray(explicitRules)) {
      throw invalidRulesFile(filePath, "rules 必须是数组。");
    }
    rules.push(
      ...explicitRules.flatMap((entry, index) =>
        normalizeRule(entry, undefined, filePath, `rules[${index}]`, options)
      )
    );
  }

  appendBucketRules(rules, raw, "include", filePath, options);
  appendBucketRules(rules, raw, "exclude", filePath, options);

  return rules;
}

function appendBucketRules(
  rules: ModDecisionOverride[],
  raw: Record<string, unknown>,
  bucket: RuleBucket,
  filePath: string,
  options: NormalizeOptions
): void {
  const entries = raw[bucket];
  if (entries === undefined) {
    return;
  }
  if (!Array.isArray(entries)) {
    throw invalidRulesFile(filePath, `${bucket} 必须是数组。`);
  }
  rules.push(...entries.flatMap((entry, index) => normalizeRule(entry, bucket, filePath, `${bucket}[${index}]`, options)));
}

function normalizeRule(
  entry: unknown,
  bucket: RuleBucket | undefined,
  filePath: string,
  location: string,
  options: NormalizeOptions
): ModDecisionOverride[] {
  if (isRecord(entry) && isRecord(entry.match)) {
    return normalizeProjectRule(entry, bucket, filePath, location, options);
  }

  const candidate =
    typeof entry === "string"
      ? { fileName: entry, decision: bucket, decisionSource: options.decisionSource }
      : isRecord(entry)
        ? { ...entry, ...(bucket === undefined ? {} : { decision: bucket }), decisionSource: options.decisionSource }
        : entry;

  const parsed = ModDecisionOverrideSchema.safeParse(candidate);
  if (!parsed.success) {
    throw invalidRule(filePath, location, parsed.error.issues);
  }

  return [parsed.data];
}

function normalizeProjectRule(
  entry: UnknownRecord,
  bucket: RuleBucket | undefined,
  filePath: string,
  location: string,
  options: NormalizeOptions
): ModDecisionOverride[] {
  if (!ruleAppliesToContext(entry, options.context)) {
    return [];
  }

  const decision = normalizeDecision(asString(entry.decision) ?? bucket ?? decisionFromSide(asString(entry.side)));
  if (!decision) {
    throw invalidRulesFile(filePath, `${location} 缺少 decision。`);
  }

  const match = asRecord(entry.match);
  const ruleId = asString(entry.id);
  const reason = asString(entry.reason) ?? formatProjectRuleReason(ruleId, options.decisionSource, decision);
  const source = normalizeSource(asString(match.source));
  const base = {
    decision,
    reason,
    ...(ruleId === undefined ? {} : { ruleId }),
    decisionSource: options.decisionSource
  };

  const candidates: ModDecisionOverride[] = [
    ...stringArray(match.modrinthProjectIds).map((projectId) => ({ ...base, source: "modrinth" as const, projectId })),
    ...stringArray(match.curseforgeProjectIds).map((projectId) => ({ ...base, source: "curseforge" as const, projectId })),
    ...stringArray(match.modIds).map((modId) => ({ ...base, modId })),
    ...stringArray(match.slugs).map((slug) => ({ ...base, ...(source === undefined ? {} : { source }), slug })),
    ...stringArray(match.fileNames).map((fileName) => ({ ...base, fileName })),
    ...stringArray(match.pathsInPack).map((pathInPack) => ({ ...base, pathInPack }))
  ];

  if (candidates.length === 0) {
    throw invalidRulesFile(filePath, `${location} 的 match 没有可用匹配字段。`);
  }

  return candidates.map((candidate, index) => {
    const parsed = ModDecisionOverrideSchema.safeParse(candidate);
    if (!parsed.success) {
      throw invalidRule(filePath, `${location}.match[${index}]`, parsed.error.issues);
    }
    return parsed.data;
  });
}

function ruleAppliesToContext(rule: UnknownRecord, context: RuleContext | undefined): boolean {
  const loaders = stringArray(rule.loaders).filter(isLoaderType);
  if (loaders.length > 0 && (!context?.loader || !loaders.includes(context.loader))) {
    return false;
  }

  const minecraftVersions = stringArray(rule.minecraftVersions);
  if (
    minecraftVersions.length > 0 &&
    (!context?.minecraftVersion || !minecraftVersions.some((range) => matchesMinecraftVersion(range, context.minecraftVersion!)))
  ) {
    return false;
  }

  return true;
}

function matchesMinecraftVersion(range: string, version: string): boolean {
  const normalized = range.trim();
  const operator = normalized.match(/^(>=|<=|>|<|=)\s*(.+)$/);
  if (operator) {
    const comparison = compareVersions(version, operator[2]!.trim());
    switch (operator[1]) {
      case ">=":
        return comparison >= 0;
      case "<=":
        return comparison <= 0;
      case ">":
        return comparison > 0;
      case "<":
        return comparison < 0;
      case "=":
        return comparison === 0;
    }
  }

  if (normalized.endsWith(".x") || normalized.endsWith(".*")) {
    return version.startsWith(normalized.slice(0, -2));
  }

  return version === normalized;
}

function compareVersions(left: string, right: string): number {
  const leftParts = versionParts(left);
  const rightParts = versionParts(right);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (diff !== 0) {
      return diff > 0 ? 1 : -1;
    }
  }
  return 0;
}

function versionParts(value: string): number[] {
  return value
    .split(/[.+-]/)
    .map((part) => Number.parseInt(part.replace(/\D/g, ""), 10))
    .filter((part) => Number.isFinite(part));
}

async function readCacheMeta(filePath: string): Promise<RemoteRuleCacheMeta | undefined> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as RemoteRuleCacheMeta;
  } catch {
    return undefined;
  }
}

function formatProjectRuleReason(
  ruleId: string | undefined,
  source: RuleDecisionSource,
  decision: RuleBucket
): string {
  const action = decision === "include" ? "保留" : "排除";
  return source === "remote-rule"
    ? `远程项目规则${ruleId ? ` ${ruleId}` : ""}：${action}`
    : `用户项目规则${ruleId ? ` ${ruleId}` : ""}：${action}`;
}

function decisionFromSide(side: string | undefined): RuleBucket | undefined {
  if (side === "client") {
    return "exclude";
  }
  if (side === "server" || side === "both") {
    return "include";
  }
  return undefined;
}

function normalizeDecision(value: string | undefined): RuleBucket | undefined {
  return value === "include" || value === "exclude" ? value : undefined;
}

function normalizeSource(value: string | undefined): ModDecisionOverride["source"] | undefined {
  if (value === "curseforge" || value === "modrinth" || value === "direct" || value === "local") {
    return value;
  }
  return undefined;
}

function isLoaderType(value: string): value is LoaderType {
  return value === "forge" || value === "neoforge" || value === "fabric" || value === "quilt" || value === "vanilla";
}

function invalidRule(filePath: string, location: string, issues: Array<{ path: Array<string | number>; message: string }>): never {
  throw appError("E_RULES_FILE_INVALID", "规则文件格式不正确。", {
    detail: {
      filePath,
      location,
      errors: issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message
      }))
    },
    suggestion:
      "规则需要 decision=include/exclude，并提供 fileName、pathInPack、modId、slug、source+projectId 或 source+versionId。"
  });
}

function invalidRulesFile(filePath: string, message: string): ReturnType<typeof appError> {
  return appError("E_RULES_FILE_INVALID", message, {
    detail: { filePath },
    suggestion: "规则文件可使用 { rules: [...], include: [...], exclude: [...] } 或规则数组格式。"
  });
}

function stringArray(value: unknown): string[] {
  if (typeof value === "string") {
    return [value.trim()].filter(Boolean);
  }
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => (typeof item === "string" && item.trim() ? [item.trim()] : []));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): UnknownRecord {
  return isRecord(value) ? value : {};
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
