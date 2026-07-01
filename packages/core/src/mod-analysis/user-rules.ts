import fs from "node:fs/promises";
import path from "node:path";
import { appError, ModDecisionOverrideSchema, type ModDecisionOverride } from "@mcsp/shared";
import { parse as parseYaml } from "yaml";

type RuleBucket = "include" | "exclude";

export async function loadModDecisionRules(filePath?: string): Promise<ModDecisionOverride[]> {
  const normalizedPath = filePath?.trim();
  if (!normalizedPath) {
    return [];
  }

  const text = await fs.readFile(normalizedPath, "utf8");
  const raw = parseRulesFile(text, normalizedPath);
  return normalizeRulesFile(raw, normalizedPath);
}

function parseRulesFile(text: string, filePath: string): unknown {
  const extension = path.extname(filePath).toLowerCase();
  try {
    if (extension === ".json") {
      return JSON.parse(text) as unknown;
    }
    if (extension === ".yaml" || extension === ".yml") {
      return parseYaml(text) as unknown;
    }
  } catch (error) {
    throw appError("E_RULES_FILE_PARSE_FAILED", "用户规则文件解析失败。", {
      detail: error instanceof Error ? error.message : error,
      suggestion: "请检查规则文件是否为合法 JSON、YAML 或 YML。"
    });
  }

  throw appError("E_RULES_FILE_FORMAT_UNSUPPORTED", "用户规则文件格式不受支持。", {
    detail: { filePath, extension },
    suggestion: "请使用 .json、.yaml 或 .yml 规则文件。"
  });
}

function normalizeRulesFile(raw: unknown, filePath: string): ModDecisionOverride[] {
  if (Array.isArray(raw)) {
    return raw.map((entry, index) => normalizeRule(entry, undefined, filePath, `rules[${index}]`));
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
    rules.push(...explicitRules.map((entry, index) => normalizeRule(entry, undefined, filePath, `rules[${index}]`)));
  }

  appendBucketRules(rules, raw, "include", filePath);
  appendBucketRules(rules, raw, "exclude", filePath);

  if (rules.length === 0) {
    throw invalidRulesFile(filePath, "规则文件里没有可用规则。");
  }

  return rules;
}

function appendBucketRules(
  rules: ModDecisionOverride[],
  raw: Record<string, unknown>,
  bucket: RuleBucket,
  filePath: string
): void {
  const entries = raw[bucket];
  if (entries === undefined) {
    return;
  }
  if (!Array.isArray(entries)) {
    throw invalidRulesFile(filePath, `${bucket} 必须是数组。`);
  }
  rules.push(...entries.map((entry, index) => normalizeRule(entry, bucket, filePath, `${bucket}[${index}]`)));
}

function normalizeRule(
  entry: unknown,
  bucket: RuleBucket | undefined,
  filePath: string,
  location: string
): ModDecisionOverride {
  const candidate =
    typeof entry === "string"
      ? { fileName: entry, decision: bucket }
      : isRecord(entry)
        ? { ...entry, ...(bucket === undefined ? {} : { decision: bucket }) }
        : entry;

  const parsed = ModDecisionOverrideSchema.safeParse(candidate);
  if (!parsed.success) {
    throw appError("E_RULES_FILE_INVALID", "用户规则文件格式不正确。", {
      detail: {
        filePath,
        location,
        errors: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message
        }))
      },
      suggestion: "每条规则需要 decision=include/exclude，并提供 fileName、pathInPack、source+projectId+fileId 或 source+versionId。"
    });
  }

  return parsed.data;
}

function invalidRulesFile(filePath: string, message: string): ReturnType<typeof appError> {
  return appError("E_RULES_FILE_INVALID", message, {
    detail: { filePath },
    suggestion: "规则文件可使用 { rules: [...], include: [...], exclude: [...] } 或规则数组格式。"
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
