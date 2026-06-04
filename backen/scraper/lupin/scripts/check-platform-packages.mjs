import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

const rootDir = process.cwd();
const runSmoke = process.argv.includes("--smoke");
const packageDirs = [
  "packages/platform-instagram",
  "packages/platform-tiktok",
  "packages/platform-x",
  "packages/platform-youtube",
];
const requiredFiles = ["README.md", "index.js", "lupin.platform.json", "package.json"];

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || rootDir,
      env: {
        ...process.env,
        ...(options.env || {}),
      },
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });

    let stdout = "";
    let stderr = "";
    if (options.capture) {
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
    }

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`${command} ${args.join(" ")} exited with signal ${signal}`));
        return;
      }
      if (code !== 0) {
        const details = stderr || stdout;
        reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code}${details ? `\n${details}` : ""}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function readManifest(packageDir) {
  const manifestPath = path.join(rootDir, packageDir, "lupin.platform.json");
  return JSON.parse(await fs.readFile(manifestPath, "utf8"));
}

async function checkPack(packageDir) {
  const { stdout } = await run("npm", ["pack", "--dry-run", "--json"], {
    cwd: path.join(rootDir, packageDir),
    capture: true,
  });
  const [packResult] = JSON.parse(stdout);
  const files = new Set(packResult.files.map((file) => file.path));
  const providerFiles = packResult.files.filter((file) => file.path.startsWith("providers/"));
  const missing = requiredFiles.filter((file) => !files.has(file));

  if (missing.length) {
    throw new Error(`${packageDir} package is missing required files: ${missing.join(", ")}`);
  }
  if (providerFiles.length === 0) {
    throw new Error(`${packageDir} package does not include provider implementation files.`);
  }

  const manifest = await readManifest(packageDir);
  if (!Array.isArray(manifest.smokeTests) || manifest.smokeTests.length === 0) {
    throw new Error(`${packageDir} manifest must declare at least one smoke test.`);
  }

  console.log(
    `ok ${packageDir}: ${packResult.files.length} files, ${providerFiles.length} provider files, ${manifest.smokeTests.length} smoke tests`
  );
}

async function runLiveSmoke() {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "lupin-platform-smoke-"));
  for (const packageDir of packageDirs) {
    await run(process.execPath, ["./bin/lupin.js", "platform", "install", `./${packageDir}`, "--json"], {
      env: { LUPIN_STATE_DIR: stateDir },
      capture: true,
    });
  }

  await run(process.execPath, ["./bin/lupin.js", "platform", "doctor", "--all", "--smoke"], {
    env: { LUPIN_STATE_DIR: stateDir },
  });
}

for (const packageDir of packageDirs) {
  await checkPack(packageDir);
}

if (runSmoke) {
  await runLiveSmoke();
}
