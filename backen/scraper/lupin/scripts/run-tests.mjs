import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

const mode = process.argv[2] || "default";
const rootDir = process.cwd();
const testDir = path.join(rootDir, "test");

function isLiveTest(fileName) {
  return fileName.startsWith("live-");
}

function selectTests(files, selectedMode) {
  switch (selectedMode) {
    case "live":
      return files.filter(isLiveTest);
    case "all":
      return files;
    case "default":
      return files.filter((fileName) => !isLiveTest(fileName));
    default:
      throw new Error(`Unsupported test mode: ${selectedMode}`);
  }
}

const files = (await fs.readdir(testDir))
  .filter((fileName) => fileName.endsWith(".test.js"))
  .sort();
const selectedFiles = selectTests(files, mode);

if (selectedFiles.length === 0) {
  throw new Error(`No test files matched mode "${mode}".`);
}

const child = spawn(
  process.execPath,
  ["--test", ...selectedFiles.map((fileName) => path.join("test", fileName))],
  {
    cwd: rootDir,
    stdio: "inherit",
  }
);

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 1);
});
