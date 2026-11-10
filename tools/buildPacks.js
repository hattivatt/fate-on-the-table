/**
 * buildPacks — compile the human-readable JSONL pack sources into the
 * Foundry v11+ LevelDB compendium directories that the module actually ships.
 *
 * Why: Foundry v11+ migrates a legacy NeDB `packs/<name>.db` file to a
 * LevelDB directory **once**, then serves and writes the LevelDB copy. If a
 * module keeps shipping only the `.db`, every update after that first
 * migration is silently ignored (the stale migrated macro stays on the
 * user's hotbar). Shipping the LevelDB directory `packs/challenge-contest/`
 * directly removes that one-time-migration trap.
 *
 * Input format: `packs/challenge-contest.jsonl` — one serialized Macro
 * document per line (the same shape Foundry exports). The `_key` required by
 * `@foundryvtt/foundryvtt-cli` `compilePack` is derived from the document
 * `_id` (`!macros!<id>`), so the JSONL stays clean, diffable JSON.
 *
 * Output: `packs/challenge-contest/` (CURRENT, LOG, MANIFEST-*.ldb, *.ldb, …).
 *
 * Usage: `npm run build:packs`.
 */

import { compilePack } from "@foundryvtt/foundryvtt-cli";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = join(ROOT, "packs/challenge-contest.jsonl");
const DEST = join(ROOT, "packs/challenge-contest");

/** Reads the JSONL source and returns one parsed document per non-empty line. */
function readDocuments(path) {
  const raw = readFileSync(path, "utf8");
  return raw
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line, index) => {
      let doc;
      try {
        doc = JSON.parse(line);
      } catch (err) {
        throw new Error(`invalid JSON on line ${index + 1} of ${path}: ${err.message}`);
      }
      if (typeof doc._id !== "string" || doc._id.length === 0) {
        throw new Error(`line ${index + 1} of ${path} has no _id`);
      }
      return doc;
    });
}

const docs = readDocuments(SOURCE);
if (docs.length === 0) throw new Error(`no documents found in ${SOURCE}`);

// `compilePack` consumes a directory of independent `.json` files, each
// carrying the NeDB-style `_key` (`!<collection>!<id>`) that names the entry.
const staging = mkdtempSync(join(tmpdir(), "fate-packs-"));
try {
  for (const doc of docs) {
    // The `!macros!<id>` key names the entry in the LevelDB pack. It is
    // derived here so the committed JSONL stays free of implementation keys.
    writeFileSync(join(staging, `${doc._id}.json`), JSON.stringify({ _key: `!macros!${doc._id}`, ...doc }));
  }
  await compilePack(staging, DEST, { log: true });
  console.log(`\nBuilt LevelDB pack: ${DEST} (${docs.length} document(s))`);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
