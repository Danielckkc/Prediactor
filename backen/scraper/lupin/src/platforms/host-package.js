import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOST_PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const HOST_PACKAGE_NAME = "lupin-cli";

export function getHostPackageRoot() {
  return HOST_PACKAGE_ROOT;
}

export function resolveNodeModulesDirForPlatformSource(source) {
  if (!source || source.kind !== "npm" || typeof source.root !== "string" || typeof source.packageName !== "string") {
    return null;
  }

  const segments = source.packageName.split("/").filter(Boolean);
  if (segments.length === 0) return null;
  return path.resolve(source.root, ...segments.map(() => ".."));
}

export async function ensureHostPackageLink(nodeModulesDir) {
  if (!nodeModulesDir) return;

  await fs.mkdir(nodeModulesDir, { recursive: true });
  const linkPath = path.join(nodeModulesDir, HOST_PACKAGE_NAME);

  try {
    await fs.access(linkPath);
    return;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  await fs.symlink(getHostPackageRoot(), linkPath, "junction");
}
