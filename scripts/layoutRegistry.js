/**
 * layoutRegistry — the single layout registry of the module.
 *
 * Holds normalized layout documents (see layoutSchema.js) from three
 * sources:
 *   - "builtin":   shipped JSON layouts (read-only, cannot be replaced);
 *   - "custom":    layouts saved into the world setting by the module UI;
 *   - "registered": layouts added in memory by other modules.
 *
 * Lookup is by id; the public API (registerLayout, getLayout, getLayoutIds,
 * validateLayout, getLayoutJson) is the contract other modules may rely on.
 * This module must stay free of any Foundry runtime dependency.
 */

import { analyzeLayout } from "./layoutSchema.js";

const records = new Map();

/**
 * Registers a layout document.
 * @param {object} document  Normalized layout document.
 * @param {object} [opts]    { source: "builtin"|"custom"|"registered", override }
 * @returns {{ok: boolean, error?: string, id?: string}}
 */
export function registerLayout(document, { source = "registered", override = false } = {}) {
  if (!document || typeof document !== "object") {
    return { ok: false, error: "Layout document must be an object." };
  }
  const id = document.id;
  if (!id) return { ok: false, error: "Layout document has no id." };
  const existing = records.get(id);
  if (existing && !override) {
    if (existing.source === "builtin" && source !== "builtin") {
      return {
        ok: false,
        error: `Layout id "${id}" is a built-in layout and cannot be replaced.`,
      };
    }
    if (existing.source === "registered" && source === "builtin") {
      return {
        ok: false,
        error: `Layout id "${id}" is already registered by another module.`,
      };
    }
  }
  const record = {
    id,
    name: typeof document.name === "string" ? document.name : id,
    source,
    version: document.version,
    document,
  };
  records.set(id, record);
  return { ok: true, id };
}

/** Registers a list of built-in layout documents. */
export function registerBuiltins(documents) {
  for (const doc of documents) registerLayout(doc, { source: "builtin" });
}

/** Replaces all custom layouts with the given documents. */
export function setCustomLayouts(documents) {
  for (const [id, record] of records) {
    if (record.source === "custom") records.delete(id);
  }
  for (const doc of documents) registerLayout(doc, { source: "custom" });
}

/** Removes a single custom layout (used when the world setting changes). */
export function unregisterCustomLayout(id) {
  const record = records.get(id);
  if (record?.source === "custom") records.delete(id);
}

/**
 * Returns the normalized layout document by id, or undefined.
 * @param {string} id
 */
export function getLayout(id) {
  return records.get(id)?.document;
}

/** @returns {string[]}  All registered layout ids. */
export function getLayoutIds() {
  return [...records.keys()];
}

/**
 * @returns {Array<{id: string, name: string, source: string, version: number}>}
 */
export function getLayoutRecords() {
  return [...records.values()].map(({ id, name, source, version }) => ({
    id,
    name,
    source,
    version,
  }));
}

/** @param {string} id  @returns {object|null}  The registry record. */
export function getLayoutRecord(id) {
  return records.get(id) ?? null;
}

/**
 * Validates a layout document without registering it.
 * @param {*} input  Parsed JSON.
 * @returns {object}  analyzeLayout() result.
 */
export function validateLayout(input) {
  return analyzeLayout(input);
}

/**
 * Returns a deep copy of the normalized layout document for export.
 * @param {string} id
 * @returns {object}
 * @throws  When the id is not registered.
 */
export function getLayoutJson(id) {
  const record = records.get(id);
  if (!record) throw new Error(`Unknown layout id "${id}".`);
  return JSON.parse(JSON.stringify(record.document));
}

/**
 * Normalizes and registers a layout document from an external module.
 * Shortcut for `registerLayout(validateLayout(input).normalized)`.
 * @param {*} input  Parsed JSON document.
 * @returns {{ok: boolean, error?: string, id?: string, errors?: Array}}
 */
export function addLayout(input) {
  const { ok, errors, normalized } = analyzeLayout(input);
  if (!ok) return { ok: false, errors };
  return registerLayout(normalized, { source: "registered" });
}
