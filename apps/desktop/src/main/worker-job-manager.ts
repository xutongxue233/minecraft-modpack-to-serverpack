import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import type { AnalyzeRequest, AnalyzeResult, AppError, ConversionRequest, ConversionResult, JobEvent, JobId } from "@mcsp/shared";
import { appError, unknownToAppError } from "@mcsp/shared";

interface WorkerJobManagerOptions {
  workerPath: string;
  emitToRenderer: (channel: string, payload: unknown) => void;
}

interface WorkerEnvelope<T = unknown> {
  id: string;
  type: "analyze" | "convert";
  payload: T;
}

type WorkerMessage =
  | { id: string; type: "result"; payload: AnalyzeResult | ConversionResult }
  | { id: string; type: "event"; payload: JobEvent }
  | { id: string; type: "error"; error: AppError };

export class WorkerJobManager {
  private readonly workerPath: string;
  private readonly emitToRenderer: (channel: string, payload: unknown) => void;
  private readonly activeJobs = new Map<string, () => void>();

  constructor(options: WorkerJobManagerOptions) {
    this.workerPath = options.workerPath;
    this.emitToRenderer = options.emitToRenderer;
  }

  analyze(request: AnalyzeRequest): Promise<AnalyzeResult> {
    const id = randomUUID();
    return this.runWorker<AnalyzeRequest, AnalyzeResult>({ id, type: "analyze", payload: request });
  }

  startConversion(request: ConversionRequest): JobId {
    const id = randomUUID();
    this.runManagedWorker<ConversionRequest, ConversionResult>({ id, type: "convert", payload: request });
    return { id };
  }

  cancelJob(jobId: string): boolean {
    const cancel = this.activeJobs.get(jobId);
    if (!cancel) {
      return false;
    }
    cancel();
    return true;
  }

  private runWorker<TPayload, TResult>(message: WorkerEnvelope<TPayload>): Promise<TResult> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(this.workerPath);

      const cleanup = (): void => {
        worker.off("message", onMessage);
        worker.off("error", onError);
        worker.off("exit", onExit);
      };

      const onMessage = (rawMessage: WorkerMessage): void => {
        if (rawMessage.id !== message.id) {
          return;
        }

        if (rawMessage.type === "event") {
          this.emitToRenderer("job:event", rawMessage.payload);
          return;
        }

        cleanup();
        void worker.terminate();

        if (rawMessage.type === "result") {
          resolve(rawMessage.payload as TResult);
          return;
        }

        reject(rawMessage.error);
      };

      const onError = (error: Error): void => {
        cleanup();
        reject(unknownToAppError(error, "E_WORKER_FAILED"));
      };

      const onExit = (code: number): void => {
        if (code !== 0) {
          cleanup();
          reject(appError("E_WORKER_FAILED", `后台任务异常退出，退出码 ${code}。`));
        }
      };

      worker.on("message", onMessage);
      worker.on("error", onError);
      worker.on("exit", onExit);
      worker.postMessage(message);
    });
  }

  private runManagedWorker<TPayload, TResult>(message: WorkerEnvelope<TPayload>): void {
    const worker = new Worker(this.workerPath);

    const cleanup = (): void => {
      worker.off("message", onMessage);
      worker.off("error", onError);
      worker.off("exit", onExit);
      this.activeJobs.delete(message.id);
    };

    const fail = (error: AppError): void => {
      cleanup();
      const reportPath = reportPathFromError(error);
      this.emitToRenderer("job:event", {
        type: "failed",
        jobId: message.id,
        error,
        ...(reportPath === undefined ? {} : { reportPath })
      });
      void worker.terminate();
    };

    const onMessage = (rawMessage: WorkerMessage): void => {
      if (rawMessage.id !== message.id) {
        return;
      }

      if (rawMessage.type === "event") {
        this.emitToRenderer("job:event", rawMessage.payload);
        return;
      }

      if (rawMessage.type === "result") {
        cleanup();
        void worker.terminate();
        return;
      }

      fail(rawMessage.error);
    };

    const onError = (error: Error): void => {
      fail(unknownToAppError(error, "E_WORKER_FAILED"));
    };

    const onExit = (code: number): void => {
      if (code !== 0) {
        fail(appError("E_WORKER_FAILED", `后台任务异常退出，退出码 ${code}。`));
      }
    };

    this.activeJobs.set(message.id, () => {
      cleanup();
      this.emitToRenderer("job:event", { type: "cancelled", jobId: message.id });
      void worker.terminate();
    });

    worker.on("message", onMessage);
    worker.on("error", onError);
    worker.on("exit", onExit);
    worker.postMessage(message);
  }
}

function reportPathFromError(error: AppError): string | undefined {
  const detail = error.detail;
  if (typeof detail !== "object" || detail === null || Array.isArray(detail)) {
    return undefined;
  }

  const reportPath = (detail as { reportPath?: unknown }).reportPath;
  return typeof reportPath === "string" && reportPath.trim().length > 0 ? reportPath : undefined;
}
