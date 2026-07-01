import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { appError } from "@mcsp/shared";

export interface StartupTestResult {
  enabled: boolean;
  status: "skipped" | "passed" | "failed";
  exitCode?: number | undefined;
  reason?: string | undefined;
}

export interface RunStartupTestOptions {
  outputDir: string;
  timeoutSeconds?: number | undefined;
  javaHome?: string | undefined;
  onLog?: (level: "info" | "warn" | "error", message: string) => void;
}

const outputTailLimit = 24_000;

export async function runServerpackStartupTest(options: RunStartupTestOptions): Promise<StartupTestResult> {
  const command = await resolveStartupCommand(options.outputDir);
  const restoreEula = await writeTemporaryEulaFalse(options.outputDir);

  try {
    options.onLog?.("info", `启动脚本测试：${command.displayName}`);
    const result = await runStartupProcess(command, options);
    options.onLog?.("info", result.reason ?? "启动脚本测试通过。");
    return result;
  } finally {
    await restoreEula();
  }
}

async function resolveStartupCommand(outputDir: string): Promise<{
  command: string;
  args: string[];
  displayName: string;
}> {
  if (process.platform === "win32") {
    // Prefer optimized scripts because users are expected to run them directly when generated.
    const optimizedBatchScript = path.join(outputDir, "start-optimized.bat");
    const batchScript = path.join(outputDir, "start.bat");
    const powerShellScript = path.join(outputDir, "start.ps1");
    if (await pathExists(optimizedBatchScript)) {
      return {
        command: "cmd.exe",
        args: ["/d", "/s", "/c", "call", optimizedBatchScript],
        displayName: "start-optimized.bat"
      };
    }
    if (await pathExists(batchScript)) {
      return {
        command: "cmd.exe",
        args: ["/d", "/s", "/c", "call", batchScript],
        displayName: "start.bat"
      };
    }
    if (await pathExists(powerShellScript)) {
      return {
        command: "powershell.exe",
        args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", powerShellScript],
        displayName: "start.ps1"
      };
    }
  }

  const optimizedShellScript = path.join(outputDir, "start-optimized.sh");
  if (await pathExists(optimizedShellScript)) {
    return {
      command: "bash",
      args: [optimizedShellScript],
      displayName: "start-optimized.sh"
    };
  }

  const shellScript = path.join(outputDir, "start.sh");
  if (await pathExists(shellScript)) {
    return {
      command: "bash",
      args: [shellScript],
      displayName: "start.sh"
    };
  }

  throw appError("E_STARTUP_TEST_SCRIPT_MISSING", "没有找到可运行的启动脚本。", {
    detail: { outputDir },
    suggestion: "请重新生成服务端包，确认输出目录包含 start.ps1、start.bat 或 start.sh。"
  });
}

function runStartupProcess(
  command: { command: string; args: string[] },
  options: RunStartupTestOptions
): Promise<StartupTestResult> {
  const timeoutMs = Math.max(5, options.timeoutSeconds ?? 60) * 1000;

  return new Promise((resolve, reject) => {
    let outputTail = "";
    let stdoutTail = "";
    let stderrTail = "";
    let settled = false;
    const child = spawn(command.command, command.args, {
      cwd: options.outputDir,
      env: buildStartupEnv(options.javaHome),
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });

    const finish = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      callback();
    };

    const timeout = setTimeout(() => {
      finish(() => {
        void terminateProcessTree(child);
        if (isExpectedEulaGate(outputTail)) {
          resolve({
            enabled: true,
            status: "passed",
            reason: "启动脚本测试通过：服务端已运行到 EULA 检查。"
          });
          return;
        }
        reject(
          appError("E_STARTUP_TEST_TIMEOUT", "启动脚本测试超时。", {
            detail: { timeoutSeconds: timeoutMs / 1000, outputTail },
            suggestion: "请查看启动测试日志，确认 Java、服务端核心和 Mod 是否卡在启动阶段。"
          })
        );
      });
    }, timeoutMs);

    const appendOutput = (chunk: Buffer, level: "info" | "error"): void => {
      const text = chunk.toString("utf8");
      outputTail = keepTail(outputTail + text);
      if (level === "info") {
        stdoutTail = emitCompleteLines(stdoutTail + text, "info", options.onLog);
      } else {
        stderrTail = emitCompleteLines(stderrTail + text, "error", options.onLog);
      }
    };

    child.stdout.on("data", (chunk: Buffer) => appendOutput(chunk, "info"));
    child.stderr.on("data", (chunk: Buffer) => appendOutput(chunk, "error"));
    child.on("error", (error) => {
      finish(() => {
        reject(
          appError("E_STARTUP_TEST_FAILED", "无法运行启动脚本测试。", {
            detail: error.message,
            suggestion: "请确认 PowerShell、bash 或 Java 环境可用。"
          })
        );
      });
    });
    child.on("close", (code) => {
      finish(() => {
        emitBufferedLine(stdoutTail, "info", options.onLog);
        emitBufferedLine(stderrTail, "error", options.onLog);

        if (code === 0 || isExpectedEulaGate(outputTail)) {
          resolve({
            enabled: true,
            status: "passed",
            ...(code === null ? {} : { exitCode: code }),
            reason: isExpectedEulaGate(outputTail)
              ? "启动脚本测试通过：服务端已运行到 EULA 检查。"
              : "启动脚本测试通过：启动脚本正常退出。"
          });
          return;
        }

        reject(
          appError("E_STARTUP_TEST_FAILED", "启动脚本测试失败，服务端包未通过启动验证。", {
            detail: { exitCode: code, outputTail },
            suggestion: "请查看启动测试日志，优先检查 Java 版本、服务端核心和客户端 Mod 是否进入服务端。"
          })
        );
      });
    });
  });
}

async function writeTemporaryEulaFalse(outputDir: string): Promise<() => Promise<void>> {
  const eulaPath = path.join(outputDir, "eula.txt");
  const original = await fs.readFile(eulaPath, "utf8").catch((error: unknown) => {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  });

  await fs.writeFile(
    eulaPath,
    ["# Temporarily set by Minecraft Serverpack Tool startup test.", "eula=false", ""].join("\n"),
    "utf8"
  );

  return async () => {
    if (original === undefined) {
      await fs.rm(eulaPath, { force: true });
      return;
    }
    await fs.writeFile(eulaPath, original, "utf8");
  };
}

function emitCompleteLines(
  bufferedText: string,
  level: "info" | "error",
  onLog?: RunStartupTestOptions["onLog"]
): string {
  const lines = bufferedText.split(/\r?\n/);
  const tail = lines.pop() ?? "";
  for (const line of lines) {
    emitBufferedLine(line, level, onLog);
  }
  return tail;
}

function emitBufferedLine(
  line: string,
  level: "info" | "error",
  onLog?: RunStartupTestOptions["onLog"]
): void {
  const trimmed = line.trimEnd();
  if (trimmed) {
    onLog?.(level, trimmed);
  }
}

function buildStartupEnv(javaHome?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MCSP_STARTUP_TEST: "1"
  };
  if (javaHome?.trim()) {
    env.JAVA_HOME = javaHome.trim();
  }
  return env;
}

function isExpectedEulaGate(output: string): boolean {
  return /eula/i.test(output) && /(agree|license|eula=false|eula\.txt)/i.test(output);
}

function keepTail(value: string): string {
  return value.length <= outputTailLimit ? value : value.slice(-outputTailLimit);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function terminateProcessTree(child: ChildProcessWithoutNullStreams): Promise<void> {
  const pid = child.pid;
  if (!pid) {
    return;
  }

  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      execFile("taskkill", ["/pid", String(pid), "/t", "/f"], { windowsHide: true }, () => resolve());
    });
    return;
  }

  child.kill("SIGTERM");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
