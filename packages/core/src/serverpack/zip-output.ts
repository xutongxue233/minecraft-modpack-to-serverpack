import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import yazl from "yazl";

export async function createServerpackZip(sourceDir: string, zipPath: string): Promise<void> {
  const tempPath = path.join(path.dirname(zipPath), `.tmp-${process.pid}-${randomUUID()}.zip`);
  const zip = new yazl.ZipFile();
  const output = createWriteStream(tempPath, { flags: "wx" });

  try {
    zip.outputStream.pipe(output);
    await addDirectory(zip, sourceDir, sourceDir);
    zip.end();

    await Promise.race([
      once(output, "close"),
      once(output, "error").then(([error]) => {
        throw error;
      }),
      once(zip.outputStream, "error").then(([error]) => {
        throw error;
      })
    ]);

    await fs.rm(zipPath, { force: true });
    await fs.rename(tempPath, zipPath);
  } catch (error) {
    output.destroy();
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function addDirectory(zip: yazl.ZipFile, rootDir: string, currentDir: string): Promise<void> {
  const entries = await fs.readdir(currentDir, { withFileTypes: true });

  for (const entry of entries) {
    const absolutePath = path.join(currentDir, entry.name);
    const relativePath = toZipPath(path.relative(rootDir, absolutePath));

    if (entry.isSymbolicLink()) {
      continue;
    }

    if (entry.isDirectory()) {
      zip.addEmptyDirectory(relativePath);
      await addDirectory(zip, rootDir, absolutePath);
      continue;
    }

    if (entry.isFile()) {
      zip.addFile(absolutePath, relativePath);
    }
  }
}

function toZipPath(value: string): string {
  return value.split(path.sep).join("/");
}
