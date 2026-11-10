import {
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_ID = "fate-on-the-table";
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const options = {
    unlink: false,
    force: false,
    data:
      process.env.FOUNDRY_DATA ??
      join(homedir(), ".local/share/FoundryVTT/v14/Data"),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--unlink") {
      options.unlink = true;
    } else if (arg === "--force") {
      options.force = true;
    } else if (arg === "--data") {
      options.data = argv[index + 1];
      index += 1;
    } else if (arg.startsWith("--data=")) {
      options.data = arg.slice("--data=".length);
    } else if (arg.startsWith("-")) {
      throw new Error(`unknown option: ${arg}`);
    } else {
      options.data = arg;
    }
  }

  if (!options.data) throw new Error("--data needs a path");
  return { ...options, data: resolve(options.data) };
}

function linkTarget(dataDir) {
  return join(dataDir, "modules", MODULE_ID);
}

function isOurLink(target) {
  if (!lstatSync(target).isSymbolicLink()) return false;
  return resolve(dirname(target), readlinkSync(target)) === REPO_ROOT;
}

function unlink(options) {
  const target = linkTarget(options.data);
  if (!existsSync(target)) {
    console.log(`nothing to unlink at ${target}`);
    return;
  }
  if (!lstatSync(target).isSymbolicLink()) {
    throw new Error(`${target} is not a symlink; refusing to remove it`);
  }
  rmSync(target);
  console.log(`removed ${target}`);
}

function link(options) {
  if (!existsSync(options.data)) {
    throw new Error(`Foundry data directory does not exist: ${options.data}`);
  }

  mkdirSync(join(options.data, "modules"), { recursive: true });
  const target = linkTarget(options.data);

  if (existsSync(target)) {
    if (isOurLink(target)) {
      console.log(`already linked: ${target} -> ${REPO_ROOT}`);
      return;
    }
    if (!options.force) {
      throw new Error(
        `${target} already exists; move it away or pass --force to back it up`,
      );
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backup = `${target}.backup-${stamp}`;
    renameSync(target, backup);
    console.log(`moved existing ${target} -> ${backup}`);
  }

  symlinkSync(
    REPO_ROOT,
    target,
    process.platform === "win32" ? "junction" : "dir",
  );
  console.log(`linked ${target} -> ${REPO_ROOT}`);
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.unlink) unlink(options);
  else link(options);
} catch (error) {
  console.error(`link-foundry: ${error.message}`);
  process.exitCode = 1;
}
