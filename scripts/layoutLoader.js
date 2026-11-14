/**
 * layoutLoader — loads the built-in JSON layouts from the module assets and
 * manages the custom layouts stored in the world setting `customLayouts`.
 *
 * The JSON files are loaded with a plain `fetch` during the (async) init
 * hook, BEFORE the settings are registered, so the settings choices already
 * list the loaded layouts. A fetch failure or an invalid built-in document
 * means the install is broken (the shipped `layouts/*.json` files are part of
 * the module package): the error is logged, the user is notified, and the
 * layouts that could be loaded (possibly none) are registered as-is.
 *
 * Import/export of custom layouts:
 *   - importLayoutText(): parse + validate (never writes anything);
 *   - saveCustomLayout(): validate, resolve id conflicts, write the setting;
 *   - deleteCustomLayout(): remove a custom layout;
 *   - getCustomLayouts(): current custom layout documents.
 */

import { analyzeLayout } from "./layoutSchema.js";
import {
  registerBuiltins,
  setCustomLayouts,
  unregisterCustomLayout,
  getLayoutRecord,
} from "./layoutRegistry.js";
import { MODULE_ID } from "./constants.js";

/** World setting key holding the custom layout documents. */
export const CUSTOM_LAYOUTS_SETTING = "customLayouts";

const BUILTIN_IDS = ["default", "minimal", "full"];

/**
 * Loads the built-in layouts and the custom layouts from the world setting.
 * Called once during the init hook before registerSettings().
 */
export async function initialize() {
  game.settings.register(MODULE_ID, CUSTOM_LAYOUTS_SETTING, {
    scope: "world",
    config: false,
    type: Array,
    default: [],
  });

  const builtins = await loadBuiltinLayouts();
  if (builtins.length) {
    registerBuiltins(builtins);
  } else {
    console.error(
      "[fate-on-the-table] no built-in layout could be loaded from the shipped layouts/*.json files; the module install looks broken (missing or invalid layout assets).",
    );
    ui.notifications?.error(game.i18n.localize(`${MODULE_ID}.layouts.builtinLoadFailed`));
  }
  setCustomLayouts(readCustomLayouts());
}

/** @returns {string}  Base path of the module assets. */
function moduleBasePath() {
  return game.modules.get(MODULE_ID)?.path ?? `modules/${MODULE_ID}/`;
}

async function loadBuiltinLayouts() {
  const base = moduleBasePath();
  const docs = [];
  for (const id of BUILTIN_IDS) {
    try {
      const response = await fetch(`${base}layouts/${id}.json`);
      if (!response.ok) {
        console.error(
          `[fate-on-the-table] failed to fetch layout "${id}" (${response.status}); the module install is incomplete.`,
        );
        continue;
      }
      const text = await response.text();
      const parsed = JSON.parse(text);
      const { ok, errors, normalized } = analyzeLayout(parsed);
      if (!ok) {
        console.error(
          `[fate-on-the-table] built-in layout "${id}" is invalid and was skipped:`,
          errors,
        );
        continue;
      }
      docs.push(normalized);
    } catch (err) {
      console.error(`[fate-on-the-table] failed to load layout "${id}":`, err);
    }
  }
  return docs;
}

function readCustomLayouts() {
  const list = game.settings.get(MODULE_ID, CUSTOM_LAYOUTS_SETTING) ?? [];
  if (!Array.isArray(list)) return [];
  const valid = [];
  for (const raw of list) {
    const { ok, errors, normalized } = analyzeLayout(raw);
    if (ok) {
      valid.push(normalized);
    } else {
      console.warn("[fate-on-the-table] an invalid custom layout was skipped:", errors);
    }
  }
  return valid;
}

/** @returns {object[]}  Current custom layout documents. */
export function getCustomLayouts() {
  return readCustomLayouts();
}

/**
 * Parses and validates a JSON string (file content or pasted text).
 * @param {string} text
 * @returns {{ok: boolean, errors: Array, warnings: Array, normalized: object|null, parseError?: string}}
 */
export function importLayoutText(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      ok: false,
      errors: [{ path: "", message: `Invalid JSON: ${err.message}` }],
      warnings: [],
      normalized: null,
    };
  }
  return analyzeLayout(parsed);
}

/**
 * Validates and persists a custom layout into the world setting.
 * @param {object} document  Parsed JSON document.
 * @returns {Promise<{ok: boolean, id?: string, errors?: Array, error?: string}>}
 */
export async function saveCustomLayout(document) {
  const { ok, errors, normalized } = analyzeLayout(document);
  if (!ok) return { ok: false, errors };
  const id = normalized.id;
  const existing = getLayoutRecord(id);
  if (existing && existing.source !== "custom") {
    return {
      ok: false,
      error: `A layout with id "${id}" is already registered (${existing.source}) and cannot be replaced.`,
    };
  }
  const list = readCustomLayouts().filter((l) => l.id !== id);
  list.push(normalized);
  await game.settings.set(MODULE_ID, CUSTOM_LAYOUTS_SETTING, list);
  setCustomLayouts(list);
  return { ok: true, id };
}

/** Removes a custom layout from the world setting. */
export async function deleteCustomLayout(id) {
  const list = readCustomLayouts().filter((l) => l.id !== id);
  await game.settings.set(MODULE_ID, CUSTOM_LAYOUTS_SETTING, list);
  unregisterCustomLayout(id);
}
