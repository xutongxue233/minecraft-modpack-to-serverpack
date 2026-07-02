import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ServerCorePlan } from "./server-core";

const execFileAsync = promisify(execFile);

export type JavaExecFileImpl = (
  file: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; timeout?: number; windowsHide?: boolean }
) => Promise<{ stdout: string; stderr: string }>;

export type JavaRuntimeSource = "configured" | "java-home" | "path" | "common";

export interface JavaRuntime {
  javaHome?: string | undefined;
  javaCommand: string;
  version: string;
  major: number;
  update?: number | undefined;
  isJdk: boolean;
  is64Bit: boolean;
  source: JavaRuntimeSource;
}

export interface JavaRuntimeRequirement {
  minMajor: number;
  maxMajor?: number | undefined;
  preferredMajor: number;
  label: string;
}

export interface JavaRuntimeSelection {
  selected?: JavaRuntime;
  requirement: JavaRuntimeRequirement;
  candidates: JavaRuntime[];
  compatible: JavaRuntime[];
  warnings: string[];
}

export interface JavaRuntimeDiscoveryOptions {
  configuredJavaHome?: string | undefined;
  searchRoots?: string[] | undefined;
  includeDefaultSearchRoots?: boolean | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  platform?: NodeJS.Platform | undefined;
  execFileImpl?: JavaExecFileImpl | undefined;
}

interface JavaHomeCandidate {
  javaHome?: string;
  javaCommand: string;
  source: JavaRuntimeSource;
}

interface JavaSearchRoot {
  root: string;
  fullSearch: boolean;
}

const javaSearchDirectoryKeywords = [
  "java",
  "jdk",
  "jre",
  "env",
  "环境",
  "run",
  "软件",
  "mc",
  "dragon",
  "well",
  "bin",
  "sdk",
  "candidate",
  "current",
  "software",
  "cache",
  "temp",
  "runtime",
  "corretto",
  "roaming",
  "users",
  "craft",
  "program",
  "世界",
  "net",
  "游戏",
  "game",
  "file",
  "data",
  "jvm",
  "服务",
  "server",
  "客户",
  "client",
  "整合",
  "应用",
  "运行",
  "前置",
  "官启",
  "官方",
  "新建文件夹",
  "eclipse",
  "hotspot",
  "x86",
  "x64",
  "arm",
  "forge",
  "原版",
  "optifine",
  "启动",
  "hmcl",
  "mod",
  "fabric",
  "download",
  "launch",
  "程序",
  "version",
  "baka",
  "pcl",
  "zulu",
  "temurin",
  "adoptium",
  "microsoft",
  "oracle",
  "graal",
  "semeru",
  "dragonwell",
  "liberica",
  "mojang",
  "minecraft",
  "environment",
  "sdkman",
  "jdks",
  "jbr",
  "local",
  "packages",
  "4297127d64ec6",
  "1."
];

export async function selectJavaRuntimeForCore(
  core: ServerCorePlan,
  options: JavaRuntimeDiscoveryOptions = {}
): Promise<JavaRuntimeSelection> {
  const requirement = javaRuntimeRequirementForCore(core);
  const candidates = await discoverJavaRuntimes(options);
  const compatible = candidates
    .filter((candidate) => isJavaRuntimeCompatible(candidate, requirement))
    .sort((left, right) => compareJavaRuntimePreference(left, right, requirement));
  const warnings: string[] = [];

  const configured = options.configuredJavaHome
    ? candidates.find((candidate) => samePath(candidate.javaHome, options.configuredJavaHome))
    : undefined;
  const configuredCompatible = configured ? compatible.find((candidate) => samePath(candidate.javaHome, configured.javaHome)) : undefined;
  if (configured && !configuredCompatible) {
    warnings.push(
      `已配置的 Java ${describeJavaRuntime(configured)} 不满足当前服务端核心要求（${requirement.label}），将尝试自动选择。`
    );
  }

  const selected = configuredCompatible ?? compatible[0];
  if (!selected && candidates.length > 0) {
    warnings.push(`已发现 ${candidates.length} 个 Java，但没有符合要求的版本（${requirement.label}）。`);
  }
  if (!selected && candidates.length === 0) {
    warnings.push(`未发现可用 Java，当前服务端核心要求：${requirement.label}。`);
  }

  return {
    ...(selected === undefined ? {} : { selected }),
    requirement,
    candidates,
    compatible,
    warnings
  };
}

export async function discoverJavaRuntimes(options: JavaRuntimeDiscoveryOptions = {}): Promise<JavaRuntime[]> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const execFileImpl = options.execFileImpl ?? execFileAsync;
  const candidates = await collectJavaHomeCandidates({
    ...(options.configuredJavaHome === undefined ? {} : { configuredJavaHome: options.configuredJavaHome }),
    ...(options.searchRoots === undefined ? {} : { searchRoots: options.searchRoots }),
    ...(options.includeDefaultSearchRoots === undefined ? {} : { includeDefaultSearchRoots: options.includeDefaultSearchRoots }),
    env,
    platform
  });

  const runtimes = await Promise.all(
    candidates.map((candidate) =>
      detectJavaRuntime(candidate, { env, platform, execFileImpl }).catch(() => undefined)
    )
  );

  return runtimes.filter((runtime): runtime is JavaRuntime => runtime !== undefined).sort((left, right) =>
    compareJavaRuntimePreference(left, right, javaRuntimeRequirementForCore({ type: "vanilla", javaMajor: 17, notes: [], warnings: [] }))
  );
}

export async function detectJavaRuntime(
  candidate: JavaHomeCandidate | string | undefined,
  options: Pick<JavaRuntimeDiscoveryOptions, "env" | "platform" | "execFileImpl"> = {}
): Promise<JavaRuntime | undefined> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const execFileImpl = options.execFileImpl ?? execFileAsync;
  const normalizedCandidate =
    typeof candidate === "object"
      ? candidate
      : javaHomeCandidateFromHome(candidate, "configured", platform);
  if (!normalizedCandidate) {
    return undefined;
  }

  const result = await execFileImpl(normalizedCandidate.javaCommand, ["-version"], {
    env: buildJavaEnv(normalizedCandidate.javaHome, env),
    timeout: 10_000,
    windowsHide: true
  }).catch((error: unknown) => {
    const maybeOutput = error as { stdout?: unknown; stderr?: unknown };
    const stdout = typeof maybeOutput.stdout === "string" ? maybeOutput.stdout : "";
    const stderr = typeof maybeOutput.stderr === "string" ? maybeOutput.stderr : "";
    if (!stdout && !stderr) {
      throw error;
    }
    return { stdout, stderr };
  });

  const output = `${result.stdout}\n${result.stderr}`;
  const parsed = parseJavaVersion(output);
  if (!parsed) {
    return undefined;
  }

  const javaHome = normalizedCandidate.javaHome;
  const javacPath = javaHome ? path.join(javaHome, "bin", platform === "win32" ? "javac.exe" : "javac") : undefined;
  const isJdk = javacPath ? await pathExists(javacPath) : false;
  return {
    ...(javaHome === undefined ? {} : { javaHome }),
    javaCommand: normalizedCandidate.javaCommand,
    version: parsed.version,
    major: parsed.major,
    ...(parsed.update === undefined ? {} : { update: parsed.update }),
    isJdk,
    is64Bit: parseJavaIs64Bit(output),
    source: normalizedCandidate.source
  };
}

export function javaRuntimeRequirementForCore(core: ServerCorePlan): JavaRuntimeRequirement {
  const preferredMajor = core.javaMajor;
  let minMajor: number = core.javaMajor;
  let maxMajor: number | undefined;

  if (core.type === "forge") {
    if (compareMinecraftVersion(core.minecraftVersion, [1, 12, 2]) <= 0) {
      minMajor = 8;
      maxMajor = 8;
    } else if (compareMinecraftVersion(core.minecraftVersion, [1, 14, 999]) <= 0) {
      minMajor = Math.max(minMajor, 8);
      maxMajor = 10;
    } else if (compareMinecraftVersion(core.minecraftVersion, [1, 15, 999]) <= 0) {
      minMajor = Math.max(minMajor, 8);
      maxMajor = 15;
    } else if (compareMinecraftVersion(core.minecraftVersion, [1, 17, 1]) === 0 && inVersionRange(core.loaderVersion, "37.0.0", "37.0.79")) {
      maxMajor = 16;
    } else if (compareMinecraftVersion(core.minecraftVersion, [1, 20, 1]) <= 0 && inVersionRange(core.loaderVersion, "45.0.66", "47.4.8")) {
      maxMajor = 21;
    }
  }

  if (core.type === "neoforge" && compareMinecraftVersion(core.minecraftVersion, [1, 20, 1]) === 0) {
    maxMajor = 21;
  }

  return {
    minMajor,
    ...(maxMajor === undefined ? {} : { maxMajor }),
    preferredMajor,
    label: maxMajor === undefined || maxMajor >= 99 ? `Java ${minMajor}+` : minMajor === maxMajor ? `Java ${minMajor}` : `Java ${minMajor}-${maxMajor}`
  };
}

export function isJavaRuntimeCompatible(runtime: JavaRuntime, requirement: JavaRuntimeRequirement): boolean {
  if (runtime.major < requirement.minMajor) {
    return false;
  }
  return requirement.maxMajor === undefined || runtime.major <= requirement.maxMajor;
}

export function describeJavaRuntime(runtime: JavaRuntime): string {
  return `Java ${runtime.major} (${runtime.version})${runtime.javaHome ? `：${runtime.javaHome}` : `：${runtime.javaCommand}`}`;
}

export function resolveJavaCommand(javaHome?: string): string {
  const normalized = javaHome?.trim();
  if (!normalized) {
    return "java";
  }
  return path.join(normalized, "bin", process.platform === "win32" ? "java.exe" : "java");
}

export function buildJavaEnv(javaHome?: string, baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...baseEnv };
  const normalized = javaHome?.trim();
  if (!normalized) {
    return env;
  }

  env.JAVA_HOME = normalized;
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const currentPath = env[pathKey] ?? "";
  env[pathKey] = `${path.join(normalized, "bin")}${path.delimiter}${currentPath}`;
  return env;
}

function compareJavaRuntimePreference(
  left: JavaRuntime,
  right: JavaRuntime,
  requirement: JavaRuntimeRequirement
): number {
  const majorDistance = Math.abs(left.major - requirement.preferredMajor) - Math.abs(right.major - requirement.preferredMajor);
  if (majorDistance !== 0) {
    return majorDistance;
  }

  const source = javaSourcePriority(left.source) - javaSourcePriority(right.source);
  if (source !== 0) {
    return source;
  }

  if (left.is64Bit !== right.is64Bit) {
    return left.is64Bit ? -1 : 1;
  }

  if (left.isJdk !== right.isJdk) {
    return left.isJdk ? 1 : -1;
  }

  if (left.major !== right.major) {
    return left.major - right.major;
  }

  return (right.update ?? 0) - (left.update ?? 0);
}

function javaSourcePriority(source: JavaRuntimeSource): number {
  switch (source) {
    case "configured":
      return 0;
    case "java-home":
      return 1;
    case "path":
      return 2;
    case "common":
      return 3;
  }
}

async function collectJavaHomeCandidates(options: {
  configuredJavaHome?: string | undefined;
  searchRoots?: string[] | undefined;
  includeDefaultSearchRoots?: boolean | undefined;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
}): Promise<JavaHomeCandidate[]> {
  const candidates = new Map<string, JavaHomeCandidate>();
  const addCandidate = (candidate: JavaHomeCandidate | undefined): void => {
    if (!candidate) {
      return;
    }
    const key = normalizePathKey(candidate.javaHome ?? candidate.javaCommand);
    const existing = candidates.get(key);
    if (!existing || javaSourcePriority(candidate.source) < javaSourcePriority(existing.source)) {
      candidates.set(key, candidate);
    }
  };

  addCandidate(javaHomeCandidateFromHome(options.configuredJavaHome, "configured", options.platform));
  addCandidate(javaHomeCandidateFromHome(options.env.JAVA_HOME, "java-home", options.platform));

  for (const pathEntry of splitPathEntries(options.env)) {
    addCandidate(await javaHomeCandidateFromPathEntry(pathEntry, "path", options.platform));
  }

  for (const searchRoot of await javaSearchRoots(options)) {
    for (const candidate of await findJavaHomesUnderRoot(searchRoot, options.platform)) {
      addCandidate(candidate);
    }
  }

  return Array.from(candidates.values());
}

async function javaSearchRoots(options: {
  searchRoots?: string[] | undefined;
  includeDefaultSearchRoots?: boolean | undefined;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
}): Promise<JavaSearchRoot[]> {
  const roots = new Map<string, JavaSearchRoot>();
  const addRoot = (root: string, fullSearch: boolean): void => {
    const normalized = root.trim();
    if (!normalized) {
      return;
    }
    const key = normalizePathKey(normalized);
    const existing = roots.get(key);
    roots.set(key, { root: normalized, fullSearch: existing?.fullSearch || fullSearch });
  };

  for (const root of options.searchRoots ?? []) {
    addRoot(root, true);
  }

  if (options.includeDefaultSearchRoots === false) {
    return Array.from(roots.values());
  }

  if (options.platform === "win32") {
    const home = os.homedir();
    const localAppData = options.env.LOCALAPPDATA;
    for (const root of await windowsDriveRoots()) {
      addRoot(root, false);
    }
    addRoot(home, false);
    for (const root of [
      path.join(home, ".jdks"),
      path.join(home, ".sdkman", "candidates", "java"),
      ...(localAppData ? [path.join(localAppData, "Programs")] : []),
      "C:\\Program Files\\Java",
      "C:\\Program Files\\Eclipse Adoptium",
      "C:\\Program Files\\Microsoft",
      "C:\\Program Files\\Amazon Corretto",
      "C:\\Program Files\\Zulu",
      "C:\\Program Files\\BellSoft",
      "C:\\Program Files\\Semeru"
    ]) {
      addRoot(root, true);
    }

  } else {
    for (const root of [
      "/usr/lib/jvm",
      "/Library/Java/JavaVirtualMachines",
      path.join(os.homedir(), ".jdks"),
      path.join(os.homedir(), ".sdkman", "candidates", "java")
    ]) {
      addRoot(root, true);
    }
    addRoot(os.homedir(), false);
  }

  return Array.from(roots.values());
}

async function findJavaHomesUnderRoot(searchRoot: JavaSearchRoot, platform: NodeJS.Platform): Promise<JavaHomeCandidate[]> {
  const results: JavaHomeCandidate[] = [];
  const seen = new Set<string>();

  async function walk(current: string, depth: number): Promise<void> {
    const normalized = path.resolve(current);
    const key = normalizePathKey(normalized);
    if (seen.has(key) || depth < 0) {
      return;
    }
    seen.add(key);

    const homeCandidate = javaHomeCandidateFromHome(normalized, "common", platform);
    if (homeCandidate && (await pathExists(homeCandidate.javaCommand))) {
      results.push(homeCandidate);
    }

    const binCandidate = await javaHomeCandidateFromPathEntry(normalized, "common", platform);
    if (binCandidate) {
      results.push(binCandidate);
    }

    if (depth === 0) {
      return;
    }

    const entries = await fs.readdir(normalized, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        continue;
      }
      if (searchRoot.fullSearch || isJavaSearchDirectory(entry.name)) {
        await walk(path.join(normalized, entry.name), depth - 1);
      }
    }
  }

  await walk(searchRoot.root, 4);
  return results;
}

async function windowsDriveRoots(): Promise<string[]> {
  const roots: string[] = [];
  for (let code = 65; code <= 90; code += 1) {
    const root = `${String.fromCharCode(code)}:\\`;
    if (await pathExists(root)) {
      roots.push(root);
    }
  }
  return roots;
}

async function javaHomeCandidateFromPathEntry(
  entry: string,
  source: JavaRuntimeSource,
  platform: NodeJS.Platform
): Promise<JavaHomeCandidate | undefined> {
  const normalized = entry.trim().replace(/^"|"$/g, "");
  if (!normalized) {
    return undefined;
  }

  const javaCommand = path.join(normalized, platform === "win32" ? "java.exe" : "java");
  if (!(await pathExists(javaCommand))) {
    return undefined;
  }

  const javaHome = path.basename(normalized).toLowerCase() === "bin" ? path.dirname(normalized) : undefined;
  return {
    ...(javaHome === undefined ? {} : { javaHome }),
    javaCommand,
    source
  };
}

function javaHomeCandidateFromHome(
  javaHome: string | undefined,
  source: JavaRuntimeSource,
  platform: NodeJS.Platform
): JavaHomeCandidate | undefined {
  const normalized = javaHome?.trim();
  if (!normalized) {
    return undefined;
  }

  return {
    javaHome: normalized,
    javaCommand: path.join(normalized, "bin", platform === "win32" ? "java.exe" : "java"),
    source
  };
}

function splitPathEntries(env: NodeJS.ProcessEnv): string[] {
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  return (env[pathKey] ?? "").split(path.delimiter);
}

function parseJavaVersion(output: string): { version: string; major: number; update?: number } | undefined {
  const match = /version "(?<version>[^"]+)"/i.exec(output) ?? /openjdk (?<version>\d+(?:\.\d+){0,3})/i.exec(output);
  const rawVersion = match?.groups?.version;
  if (!rawVersion) {
    return undefined;
  }

  const normalized = rawVersion.replaceAll("_", ".").split("-")[0]!;
  const parts = normalized.split(".").map((part) => Number.parseInt(part, 10));
  const first = parts[0];
  const second = parts[1];
  if (first === undefined || !Number.isFinite(first)) {
    return undefined;
  }

  const major = first === 1 ? second : first;
  if (major === undefined || !Number.isFinite(major)) {
    return undefined;
  }

  const update = first === 1 ? parts[3] : parts[2];
  return {
    version: rawVersion,
    major,
    ...(update === undefined || !Number.isFinite(update) ? {} : { update })
  };
}

function parseJavaIs64Bit(output: string): boolean {
  return /64-bit|x86_64|amd64|aarch64/i.test(output);
}

function isJavaSearchDirectory(name: string): boolean {
  const lower = name.toLowerCase();
  return javaSearchDirectoryKeywords.some((keyword) => lower.includes(keyword)) || /^\d+/.test(lower);
}

function inVersionRange(version: string | undefined, min: string, max: string): boolean {
  return compareDottedVersion(version, min) >= 0 && compareDottedVersion(version, max) <= 0;
}

function compareDottedVersion(left: string | undefined, right: string): number {
  const leftParts = versionParts(left);
  const rightParts = versionParts(right);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const diff = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

function versionParts(version: string | undefined): number[] {
  return (version ?? "")
    .split(/[.+-]/)
    .map((part) => Number.parseInt(part, 10))
    .filter((part) => Number.isFinite(part));
}

function compareMinecraftVersion(version: string | undefined, target: readonly [number, number, number]): number {
  const parsed = parseMinecraftVersion(version);
  if (!parsed) {
    return 0;
  }

  for (let index = 0; index < target.length; index += 1) {
    const diff = (parsed[index] ?? 0) - (target[index] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

function parseMinecraftVersion(version: string | undefined): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(version ?? "");
  if (!match) {
    return null;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function samePath(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) {
    return false;
  }
  return normalizePathKey(left) === normalizePathKey(right);
}

function normalizePathKey(value: string): string {
  return path.resolve(value).replace(/[\\/]+$/, "").toLowerCase();
}
