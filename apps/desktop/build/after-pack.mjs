import fs from "node:fs/promises";
import path from "node:path";
import { rcedit } from "rcedit";

const displayName = "整合包转服务端包工具";
const companyName = "Minecraft Serverpack Tool Contributors";

export default async function afterPack(context) {
  if (context.electronPlatformName !== "win32") {
    return;
  }

  const exePath = await findMainExecutable(context.appOutDir);
  const version = context.packager.appInfo.version;
  const iconPath = path.join(context.packager.projectDir, "build", "icon.ico");

  await rcedit(exePath, {
    "version-string": {
      CompanyName: companyName,
      FileDescription: displayName,
      InternalName: displayName,
      OriginalFilename: `${displayName}.exe`,
      ProductName: displayName
    },
    "file-version": version,
    "product-version": version,
    icon: iconPath
  });
}

async function findMainExecutable(appOutDir) {
  const entries = await fs.readdir(appOutDir);
  const exeName = entries.find((entry) => entry.toLowerCase().endsWith(".exe"));
  if (!exeName) {
    throw new Error(`No Windows executable found in ${appOutDir}`);
  }
  return path.join(appOutDir, exeName);
}
