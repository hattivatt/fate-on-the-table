/**
 * Node tests for the `challenge-contest` Macro compendium pack.
 *
 * The pack ships as a **LevelDB directory** (`packs/challenge-contest/`),
 * never as a legacy NeDB `.db`. Why this matters: Foundry v11+ migrates a
 * `<path>.db` sibling to LevelDB *once*, then serves the migrated copy — so a
 * module that keeps shipping only the `.db` silently desyncs after the first
 * load (the user saw a stale macro on the hotbar). Shipping the LevelDB pack
 * directly removes that one-time-migration trap.
 *
 * Human-readable source of truth:
 *   - `packs/challenge-contest.macro.js` — the readable thin-launcher source;
 *   - `packs/challenge-contest.jsonl`    — one serialized Macro document per
 *     line, the input to `scripts/buildPacks.js` (`npm run build:packs`).
 *
 * Architecture contract (regression guard for the time-capsule desync):
 *   - the PACKED macro is a thin launcher that only calls
 *     `module.api.challengeContest.run()`; it never imports the pure helpers
 *     directly, so a world copy dragged to the hotbar always runs the live
 *     module code (`challengeDrawingData is not a function` can never ship
 *     again);
 *   - the whole flow lives in `scripts/challengeContestMacro.js`, wired into
 *     `module.js` under the `challengeContest` API namespace.
 *
 * These tests:
 *   - validate the manifest registration and the LevelDB directory shape;
 *   - validate the JSONL build source and guard drift between its `command`
 *     and the readable `packs/challenge-contest.macro.js`;
 *   - assert the packed macro calls the module API and imports nothing;
 *   - assert `module.js` imports/exposes the API glue;
 *   - smoke-import the API glue in Node (Foundry-free) and check every setting
 *     key it reads is registered in `settings.js`;
 *   - check every `challenge.*` i18n key used by the macro AND the API resolves
 *     in both language files;
 *   - assert the release workflow includes `packs/` and excludes dev tooling.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MODULE_ID = "fate-on-the-table";
const LEVELDB_DIR = join(ROOT, "packs/challenge-contest");
const LEGACY_DB = join(ROOT, "packs/challenge-contest.db");
const JSONL_PATH = join(ROOT, "packs/challenge-contest.jsonl");
const SRC_PATH = join(ROOT, "packs/challenge-contest.macro.js");
const BUILD_PATH = join(ROOT, "scripts/buildPacks.js");
const API_PATH = join(ROOT, "scripts/challengeContestMacro.js");
const MODULE_PATH = join(ROOT, "scripts/module.js");
const SETTINGS_PATH = join(ROOT, "scripts/settings.js");

const moduleJson = JSON.parse(readFileSync(join(ROOT, "module.json"), "utf8"));
const packageJson = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const en = JSON.parse(readFileSync(join(ROOT, "languages/en.json"), "utf8"));
const ru = JSON.parse(readFileSync(join(ROOT, "languages/ru.json"), "utf8"));

/** Parses the JSONL pack source into an array of documents. */
function readJsonlDocs(path) {
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

test("module.json registers the challenge-contest Macro pack", () => {
  const pack = (moduleJson.packs ?? []).find(
    (entry) => entry.name === "challenge-contest",
  );
  assert.ok(pack, "pack `challenge-contest` is registered");
  assert.equal(pack.type, "Macro");
  assert.equal(pack.label, "Challenge / Contest");
  // Extensionless path: Foundry v11+ reads/persists the LevelDB directory at
  // exactly this path. A `<path>.db` sibling would trigger the one-shot NeDB
  // migration trap, so it must not be shipped.
  assert.equal(pack.path, "packs/challenge-contest");
});

test("the pack ships a valid LevelDB directory and no legacy NeDB file", () => {
  assert.ok(
    !existsSync(LEGACY_DB),
    "legacy packs/challenge-contest.db must not ship (Foundry desktop ignores it after first migration)",
  );
  assert.ok(
    existsSync(LEVELDB_DIR),
    "packs/challenge-contest/ (LevelDB directory) exists",
  );
  assert.ok(
    existsSync(join(LEVELDB_DIR, "CURRENT")),
    "LevelDB CURRENT pointer exists",
  );

  // A LevelDB directory is a CURRENT file naming a MANIFEST plus table/log
  // files. Follow CURRENT and make sure the pointed-at manifest is real.
  const current = readFileSync(join(LEVELDB_DIR, "CURRENT"), "utf8").trim();
  assert.ok(current.length > 0, "CURRENT is non-empty");
  assert.ok(
    existsSync(join(LEVELDB_DIR, current)),
    `CURRENT points at an existing file (${current})`,
  );
  const entries = readdirSync(LEVELDB_DIR);
  assert.ok(
    entries.some((name) => name.startsWith("MANIFEST-")),
    "a MANIFEST-* file is present",
  );
  assert.ok(
    entries.some((name) => /\.(ldb|log)$/.test(name)),
    "at least one .ldb/.log table file is present",
  );
});

test("the JSONL pack source exists and every line is valid JSON", () => {
  assert.ok(existsSync(JSONL_PATH), "packs/challenge-contest.jsonl exists");
  const raw = readFileSync(JSONL_PATH, "utf8");
  const lines = raw.split(/\r?\n/).filter((line) => line.trim() !== "");
  assert.ok(lines.length >= 1, "at least one document line");
  for (const [index, line] of lines.entries()) {
    assert.doesNotThrow(
      () => JSON.parse(line),
      `line ${index + 1} must parse as JSON`,
    );
  }
});

test("the JSONL holds one valid script Macro document", () => {
  const docs = readJsonlDocs(JSONL_PATH);
  assert.equal(docs.length, 1);
  const [macro] = docs;
  assert.match(macro._id, /^[A-Za-z0-9]{16}$/, "16-char document id");
  assert.equal(macro.name, "Challenge / Contest");
  assert.equal(macro.type, "script");
  assert.equal(macro.scope, "global");
  assert.equal(typeof macro.command, "string");
  assert.ok(macro.command.trim().length > 0, "command is not empty");
  assert.ok(typeof macro.img === "string" && macro.img.length > 0);
});

test("the JSONL command is in sync with the readable macro source", () => {
  const source = readFileSync(SRC_PATH, "utf8");
  const [macro] = readJsonlDocs(JSONL_PATH);
  assert.equal(
    macro.command,
    source,
    "regenerate packs/challenge-contest.jsonl and run `npm run build:packs` after editing packs/challenge-contest.macro.js",
  );
  // Thin launcher: stays a handful of lines (regression guard against the
  // whole flow creeping back into the packed macro).
  assert.ok(
    source.split("\n").length <= 20,
    "the packed macro source stays a ~16-line thin launcher",
  );
});

test("buildPacks compiles the JSONL source into the LevelDB pack", () => {
  const build = readFileSync(BUILD_PATH, "utf8");
  assert.ok(
    build.includes("compilePack"),
    "scripts/buildPacks.js uses @foundryvtt/foundryvtt-cli compilePack",
  );
  assert.ok(
    build.includes("challenge-contest.jsonl"),
    "the build reads the JSONL source",
  );
  assert.ok(
    build.includes("challenge-contest"),
    "the build writes the LevelDB pack directory",
  );
  assert.equal(
    packageJson.scripts?.["build:packs"],
    "node scripts/buildPacks.js",
    "package.json exposes `npm run build:packs`",
  );
  assert.ok(
    packageJson.devDependencies?.["@foundryvtt/foundryvtt-cli"],
    "@foundryvtt/foundryvtt-cli is a devDependency",
  );
});

test("the packed macro is a thin launcher for the module API", () => {
  const source = readFileSync(SRC_PATH, "utf8");
  // No time capsule: the macro must not carry the pure helpers itself.
  assert.ok(
    !source.includes("challengeContest.js"),
    "the packed macro must not import the pure challengeContest helpers",
  );
  assert.ok(
    !/^\s*import\b/m.test(source),
    "the packed macro must not use static imports",
  );
  assert.ok(
    !/\bimport\s*\(/.test(source),
    "the packed macro must not use dynamic imports",
  );
  // It must resolve the live module API and call it.
  assert.ok(
    source.includes("challengeContest"),
    "the packed macro references the challengeContest API namespace",
  );
  assert.ok(/\.run\s*\(/.test(source), "the packed macro calls `api.run()`");
});

test("module.js imports the API glue and exposes it under game.modules api", () => {
  const source = readFileSync(MODULE_PATH, "utf8");
  assert.ok(
    source.includes('from "./challengeContestMacro.js"'),
    "module.js imports ./challengeContestMacro.js",
  );
  assert.ok(
    source.includes("runChallengeContest"),
    "module.js imports the runChallengeContest export",
  );
  assert.ok(
    /challengeContest\s*:\s*\{/.test(source),
    "module.js registers the `challengeContest` API namespace",
  );
  assert.ok(
    /run\s*\(\s*\)\s*\{/.test(source),
    "the API namespace exposes `run()`",
  );
});

test("the API glue imports cleanly in Node and exports runChallengeContest", async () => {
  // No top-level `foundry`/`game`/`canvas` access: this import itself is the
  // node-safety contract for `scripts/challengeContestMacro.js`.
  const glue = await import("../scripts/challengeContestMacro.js");
  assert.equal(
    typeof glue.runChallengeContest,
    "function",
    "runChallengeContest is exported as an async function",
  );
});

test("every settings key the API reads is registered in settings.js", async () => {
  const { CHALLENGE_CONTEST_SETTING_KEYS } = await import(
    "../scripts/challengeContest.js"
  );
  const settingsSource = readFileSync(SETTINGS_PATH, "utf8");
  // The API reads each challenge/contest default key plus the module-wide
  // `scale` setting. A key renamed on only one side fails here.
  const keys = [...CHALLENGE_CONTEST_SETTING_KEYS, "scale"];
  const problems = [];
  for (const key of keys) {
    const registered = settingsSource.includes(
      `game.settings.register(MODULE_ID, "${key}"`,
    );
    if (!registered) problems.push(`not registered in settings.js: ${key}`);
  }
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("every challenge.* key used by the macro and the API resolves in both languages", () => {
  const sources = [
    readFileSync(SRC_PATH, "utf8"),
    // The flow now lives in the API glue; scan it too so a moved UI string
    // with a missing translation still fails here.
    readFileSync(API_PATH, "utf8"),
  ];
  const keys = new Set();
  for (const source of sources) {
    const re = /challenge\.[A-Za-z][A-Za-z0-9]*/g;
    let match;
    while ((match = re.exec(source)) !== null) keys.add(match[0]);
  }
  assert.ok(
    keys.has("challenge.moduleNotActive"),
    "the thin macro's `module not active` key is present",
  );
  assert.ok(keys.size >= 10, `expected many challenge.* keys, got ${keys.size}`);
  const problems = [];
  for (const rel of keys) {
    const key = `${MODULE_ID}.${rel}`;
    if (!(key in en)) problems.push(`missing in en.json: ${key}`);
    if (!(key in ru)) problems.push(`missing in ru.json: ${key}`);
  }
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("the release workflow includes packs/ and excludes dev tooling", () => {
  const workflow = readFileSync(
    join(ROOT, ".github/workflows/release.yml"),
    "utf8",
  );
  assert.ok(
    !/--exclude\s+["']?packs/.test(workflow),
    "release.yml must not exclude packs/",
  );
  assert.ok(
    /--exclude\s+["']?node_modules/.test(workflow),
    "release.yml must exclude node_modules/ from module.zip",
  );
});
