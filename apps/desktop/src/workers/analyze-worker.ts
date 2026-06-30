import { parentPort } from "node:worker_threads";
import { analyzeInput, enrichAnalysisWithPlatformMetadata, readCurseForgeApiKeyFromEnv, runConversion } from "@mcsp/core";
import { AnalyzeRequestSchema, ConversionRequestSchema, unknownToAppError } from "@mcsp/shared";

if (!parentPort) {
  throw new Error("analyze-worker must run inside a Worker thread.");
}

parentPort.on("message", async (message: { id: string; type: "analyze" | "convert"; payload: unknown }) => {
  if (message.type !== "analyze" && message.type !== "convert") {
    return;
  }

  const jobId = message.id;

  try {
    if (message.type === "convert") {
      const request = ConversionRequestSchema.parse(message.payload);
      const curseForgeApiKey = readCurseForgeApiKeyFromEnv();
      const result = await runConversion(request, {
        jobId,
        ...(curseForgeApiKey === undefined ? {} : { curseForgeApiKey }),
        onEvent: (event) => {
          parentPort?.postMessage({
            id: jobId,
            type: "event",
            payload: event
          });
        }
      });

      parentPort?.postMessage({
        id: jobId,
        type: "result",
        payload: result
      });
      return;
    }

    parentPort?.postMessage({
      id: jobId,
      type: "event",
      payload: { type: "phase", jobId, phase: "analyzing", message: "正在解析整合包" }
    });

    const request = AnalyzeRequestSchema.parse(message.payload);
    const parsed = await analyzeInput(request.inputPath);
    const curseForgeApiKey = readCurseForgeApiKeyFromEnv();
    const result = await enrichAnalysisWithPlatformMetadata(parsed, {
      ...(curseForgeApiKey === undefined ? {} : { curseForgeApiKey }),
      onWarning: (warning) => {
        parentPort?.postMessage({
          id: jobId,
          type: "event",
          payload: { type: "log", jobId, level: "warn", message: warning }
        });
      }
    });

    parentPort?.postMessage({
      id: jobId,
      type: "result",
      payload: result
    });
  } catch (error) {
    parentPort?.postMessage({
      id: jobId,
      type: "error",
      error: unknownToAppError(error, "E_ANALYZE_FAILED")
    });
  }
});
