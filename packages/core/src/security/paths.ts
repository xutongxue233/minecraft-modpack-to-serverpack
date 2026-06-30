import path from "node:path";
import { appError } from "@mcsp/shared";

const windowsDrivePattern = /^[a-zA-Z]:[\\/]/;

export function assertSafeArchiveEntry(entryName: string): string {
  const normalized = entryName.replaceAll("\\", "/");

  if (!normalized || normalized.includes("\0")) {
    throw appError("E_ARCHIVE_UNSAFE_PATH", "压缩包包含空路径或非法字符。", {
      detail: entryName,
      suggestion: "请检查整合包来源，避免使用损坏或恶意压缩包。"
    });
  }

  if (
    normalized.startsWith("/") ||
    normalized.startsWith("//") ||
    windowsDrivePattern.test(normalized) ||
    normalized.split("/").some((segment) => segment === "..")
  ) {
    throw appError("E_ARCHIVE_UNSAFE_PATH", "压缩包包含不安全路径。", {
      detail: entryName,
      suggestion: "请更换整合包文件，或手动检查压缩包内容。"
    });
  }

  return normalized;
}

export function resolveInsideRoot(root: string, relativePath: string): string {
  const safeRelativePath = assertSafeArchiveEntry(relativePath);
  const rootResolved = path.resolve(root);
  const target = path.resolve(rootResolved, safeRelativePath);

  if (target !== rootResolved && !target.startsWith(rootResolved + path.sep)) {
    throw appError("E_ARCHIVE_UNSAFE_PATH", "目标路径逃逸出工作目录。", {
      detail: { root, relativePath },
      suggestion: "请检查整合包中的文件路径。"
    });
  }

  return target;
}
