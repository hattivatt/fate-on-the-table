/**
 * Node-only regression tests for the module i18n contract.
 *
 * Guards the exact failure mode reported for the module: users see raw
 * i18n keys ("fate-on-the-table.conflict.tool") instead of translations.
 * That happens whenever a looked-up key is missing from the active language
 * file OR the lookup produces a double namespace (e.g. a relative-key helper
 * that prepends the module id is fed an already fully-qualified key). No
 * Foundry runtime is needed: this test re-implements the module's lookup
 * helpers over the actual `languages/*.json` files and verifies every key
 * the scripts can look up exists in BOTH languages.
 *
 * The chosen contract (kept consistent across the module):
 *   - language JSON keys are fully qualified (`<moduleId>.<path>`);
 *   - direct Foundry calls use absolute keys built from `MODULE_ID`;
 *   - relative-key helpers (t("..."), add(icon, "key", ...)) never receive
 *     a key that already carries the `fate-on-the-table.` prefix.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MODULE_ID = "fate-on-the-table";
const SCRIPTS_DIR = join(ROOT, "scripts");

const moduleJson = JSON.parse(readFileSync(join(ROOT, "module.json"), "utf8"));
const en = JSON.parse(readFileSync(join(ROOT, "languages/en.json"), "utf8"));
const ru = JSON.parse(readFileSync(join(ROOT, "languages/ru.json"), "utf8"));

const enKeys = new Set(Object.keys(en));
const ruKeys = new Set(Object.keys(ru));

test("module.json id and language manifest match the file layout", () => {
  assert.equal(moduleJson.id, MODULE_ID);
  const langs = moduleJson.languages;
  assert.ok(Array.isArray(langs) && langs.length >= 2, "languages array present");
  for (const lang of langs) {
    assert.ok(lang.lang && lang.path, `language entry has lang+path (${lang.lang})`);
    assert.ok(
      existsSync(join(ROOT, lang.path)),
      `language file exists for ${lang.lang}: ${lang.path}`,
    );
  }
  const byLang = new Map(langs.map((l) => [l.lang, l.path]));
  assert.equal(byLang.get("en"), "languages/en.json");
  assert.equal(byLang.get("ru"), "languages/ru.json");
});

test("language JSON keys use the module-id namespace (no old or double id)", () => {
  for (const [name, data] of [
    ["en", en],
    ["ru", ru],
  ]) {
    for (const key of Object.keys(data)) {
      assert.ok(
        key.startsWith(`${MODULE_ID}.`),
        `${name}.json key "${key}" must be namespaced with "${MODULE_ID}."`,
      );
      assert.ok(
        !key.includes(`${MODULE_ID}.${MODULE_ID}.`),
        `${name}.json key "${key}" must not contain a double module-id namespace`,
      );
      assert.ok(
        !key.includes("chars-to-table"),
        `${name}.json key "${key}" must not reference the old module id`,
      );
    }
  }
});

test("no stale old-id references in the manifest or scripts", () => {
  const files = [
    join(ROOT, "module.json"),
    join(ROOT, "languages/en.json"),
    join(ROOT, "languages/ru.json"),
    ...readdirSync(SCRIPTS_DIR).filter((f) => f.endsWith(".js")),
  ];
  for (const file of files) {
    const path = file.startsWith(ROOT) ? file : join(SCRIPTS_DIR, file);
    const content = readFileSync(path, "utf8");
    assert.ok(
      !content.includes("chars-to-table"),
      `${path} must not reference the old module id`,
    );
  }
});

test("en and ru language files have identical key sets (parity)", () => {
  const onlyEn = [...enKeys].filter((k) => !ruKeys.has(k));
  const onlyRu = [...ruKeys].filter((k) => !enKeys.has(k));
  assert.deepEqual(onlyEn, [], "keys present in en but missing in ru");
  assert.deepEqual(onlyRu, [], "keys present in ru but missing in en");
});

test("no key is a dot-path prefix of another key (Foundry expandObject safety)", () => {
  // Foundry v14 expands flat JSON keys with foundry.utils.expandObject /
  // setProperty. A leaf key "a.b" that is ALSO a parent of "a.b.c" makes
  // setProperty try to write onto the string value of "a.b", which throws in
  // strict mode; Localization#_loadTranslationFile then discards the WHOLE
  // language file and every module key renders raw.
  for (const [name, data] of [
    ["en", en],
    ["ru", ru],
  ]) {
    const keys = Object.keys(data);
    const collisions = [];
    for (const parent of keys) {
      for (const child of keys) {
        if (parent !== child && child.startsWith(`${parent}.`)) {
          collisions.push(`"${parent}" collides with child "${child}"`);
        }
      }
    }
    assert.deepEqual(
      collisions,
      [],
      `${name}.json parent/child collisions (would break Foundry expandObject):\n` +
        collisions.join("\n"),
    );
  }
});

test("every i18n key looked up by the scripts resolves in both languages", () => {
  const problems = [];
  const seen = new Set();

  const check = (key, where) => {
    if (seen.has(key)) return;
    seen.add(key);
    if (!key.startsWith(`${MODULE_ID}.`)) {
      problems.push(`${where}: lookup "${key}" is not namespaced with "${MODULE_ID}."`);
    } else if (key.includes(`${MODULE_ID}.${MODULE_ID}.`)) {
      problems.push(`${where}: double module-id namespace in lookup "${key}"`);
    } else if (key.includes("chars-to-table")) {
      problems.push(`${where}: lookup "${key}" uses the old module id`);
    }
    if (!enKeys.has(key)) problems.push(`${where}: missing in en.json — "${key}"`);
    if (!ruKeys.has(key)) problems.push(`${where}: missing in ru.json — "${key}"`);
  };

  // Relative-key helper definitions: `const t = (key) => game.i18n.localize(
  // `...${MODULE_ID}.<prefix>${key}`)`. Tracks the last prefix per name so
  // calls resolve against the correct scope.
  const helperDef = /\b(?:const|let|var)\s+(\w+)\s*=\s*\(?\s*\w+\s*\)?\s*=>\s*game\.i18n\.localize\(`\$\{MODULE_ID\}\.([^`]*)`\)/;

  for (const file of readdirSync(SCRIPTS_DIR).filter((f) => f.endsWith(".js"))) {
    const lines = readFileSync(join(SCRIPTS_DIR, file), "utf8").split("\n");
    const prefixes = new Map();
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const where = `${file}:${i + 1}`;
      const def = helperDef.exec(line);
      if (def) {
        // Drop the trailing `${key}` interpolation from the captured prefix.
        prefixes.set(def[1], `${MODULE_ID}.` + def[2].replace(/\$\{[^}]*\}$/, ""));
      }

      // Direct game.i18n.localize / format calls with literal or
      // `${MODULE_ID}.<static>` keys.
      for (const re of [
        /game\.i18n\.localize\((`[^`]*`|"[^"]*"|'[^']*')\)/g,
        /game\.i18n\.format\((`[^`]*`|"[^"]*"|'[^']*')/g,
      ]) {
        let m;
        while ((m = re.exec(line)) !== null) {
          const key = resolveKeyLiteral(m[1]);
          if (key) check(key, where);
        }
      }

      // Relative helper calls: t("rel"), add("fa-x", "rel", fn).
      for (const re of [/\b(\w+)\("([^"]+)"\)/g]) {
        let m;
        while ((m = re.exec(line)) !== null) {
          const [name, rel] = [m[1], m[2]];
          const prefix = prefixes.get(name);
          if (!prefix) continue;
          // Ternary/conditional arguments resolved at runtime land on one of
          // these literal keys; every branch is covered separately below.
          if (!line.startsWith("const")) check(prefix + rel, where);
        }
      }

      // Conditional relative-helper calls of the form t(a ? "x" : "y").
      const ternary = /\((\w+)\s*\?\s*"([^"]+)"\s*:\s*"([^"]+)"\)/g;
      let t;
      while ((t = ternary.exec(line)) !== null) {
        const prefix = prefixes.get(t[1]);
        if (prefix) {
          check(prefix + t[2], where);
          check(prefix + t[3], where);
        }
      }

      // FatePointManager's `add(icon, key, fn, sep)` helper contract.
      const addCall = /add\(\s*"fa-[^"]+"\s*,\s*"([^"]+)"\s*,/g;
      let a;
      while ((a = addCall.exec(line)) !== null) {
        check(`${MODULE_ID}.${a[1]}`, where);
      }

      // Variable-passed full keys handed to localize at runtime (placement
      // hints/successes and ApplicationV2 window titles).
      const varKey = /(?:hintKey|successKey|title)\s*:\s*`([^`]*)`/g;
      let v;
      while ((v = varKey.exec(line)) !== null) {
        const key = resolveKeyLiteral("`" + v[1] + "`");
        if (key) check(key, where);
      }
    }
  }

  // layoutDisplayName(id) builds `${MODULE_ID}.layouts.<id>.name`.
  for (const id of ["default", "minimal", "full"]) {
    check(`${MODULE_ID}.layouts.${id}.name`, "layouts built-in display name");
  }

  // Widget header text resolvers (WidgetBuilder resolverCatalog) and the
  // auto-localized module title.
  for (const part of [
    "header.aspects",
    "header.fatePoints",
    "header.skills",
    "header.tracks",
    "header.consequences",
    "header.stunts",
    "header.extras",
  ]) {
    check(`${MODULE_ID}.${part}`, "WidgetBuilder header resolver");
  }
  check(`${MODULE_ID}.title`, "module auto-title");

  // Interactive stress box permission warning (StressBoxes routes by part).
  // There is no consequence checkbox anymore — consequences are text rows
  // edited by double-click, whose permission warning lives under
  // `consequence.notOwner` (checked above via the ConsequenceInteractions
  // double-click handler).
  check(`${MODULE_ID}.stressBoxes.notOwner`, "stress box permission warning");

  assert.deepEqual(
    problems,
    [],
    "unresolvable i18n lookups:\n" + problems.join("\n"),
  );
});

/** Expands a literal or `${MODULE_ID}.<static>` template into a full key. */
function resolveKeyLiteral(expr) {
  const m = /^`([^`]*)`$/.exec(expr) || /^"([^"]*)"$/.exec(expr) || /^'([^']*)'$/.exec(expr);
  if (!m) return null;
  const body = m[1];
  if (body.includes("${")) {
    if (!body.startsWith("${MODULE_ID}.")) return null;
    const rest = body.slice("${MODULE_ID}.".length);
    if (rest.includes("${")) return null;
    return `${MODULE_ID}.${rest}`;
  }
  return body;
}
