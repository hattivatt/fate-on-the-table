/**
 * layoutLoader — loads the built-in JSON layouts from the module assets,
 * keeps the legacy `layouts.js` object as a fallback, and manages the custom
 * layouts stored in the world setting `customLayouts`.
 *
 * The JSON files are loaded with a plain `fetch` during the (async) init
 * hook, BEFORE the settings are registered, so the settings choices already
 * list the loaded layouts. When a fetch fails (or a built-in document is
 * invalid), the legacy JS template is converted to the JSON model and used as
 * a fallback so the module keeps working without the JSON assets.
 *
 * Import/export of custom layouts:
 *   - importLayoutText(): parse + validate (never writes anything);
 *   - saveCustomLayout(): validate, resolve id conflicts, write the setting;
 *   - deleteCustomLayout(): remove a custom layout;
 *   - getCustomLayouts(): current custom layout documents.
 */

import { analyzeLayout, FORMAT, VERSION } from "./layoutSchema.js";
import {
  registerBuiltins,
  setCustomLayouts,
  unregisterCustomLayout,
  getLayoutRecord,
} from "./layoutRegistry.js";
import { layouts as legacyLayouts } from "./layouts.js";
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
    // Fallback: the legacy JS template keeps the widget working without the
    // JSON assets (e.g. a broken module install).
    console.warn(
      "[chars-to-table] built-in layout JSON could not be loaded; using the legacy JS layout as a fallback.",
    );
    registerBuiltins([legacyToJson(legacyLayouts.default)]);
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
        console.warn(
          `[chars-to-table] failed to fetch layout "${id}" (${response.status}); falling back to the legacy JS layout.`,
        );
        continue;
      }
      const text = await response.text();
      const parsed = JSON.parse(text);
      const { ok, errors, normalized } = analyzeLayout(parsed);
      if (!ok) {
        console.warn(
          `[chars-to-table] built-in layout "${id}" is invalid and was skipped:`,
          errors,
        );
        continue;
      }
      docs.push(normalized);
    } catch (err) {
      console.warn(`[chars-to-table] failed to load layout "${id}":`, err);
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
      console.warn("[chars-to-table] an invalid custom layout was skipped:", errors);
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

/**
 * Converts a legacy `layouts.js` template object into the JSON model
 * (LAYOUT-FORMAT.md). Only the current single legacy layout ("default")
 * exists, so the conversion targets its documented canonical geometry
 * (canvas minimum 659x568, reference size 659x849).
 *
 * The legacy `drawingOffset` is folded into `canvas.origin`: every element is
 * re-expressed relative to the canvas top-left, i.e. minus the effective
 * origin (the top-left of the union of the legacy anchor-relative rects).
 * @param {object} legacy
 * @returns {object}  Normalized JSON layout document.
 */
export function legacyToJson(legacy) {
  const dx = legacy.drawingOffset?.x ?? 0;
  const dy = legacy.drawingOffset?.y ?? 0;
  const legacyRect = (el) => ({
    x: el.id === "portrait" ? 0 : dx + (el.x ?? 0),
    y: el.id === "portrait" ? 0 : dy + (el.y ?? 0),
    w: el.w ?? 0,
    h: el.h ?? 0,
  });

  let minX = Infinity;
  let minY = Infinity;
  for (const el of legacy.elements ?? []) {
    const r = legacyRect(el);
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
  }
  if (!Number.isFinite(minX)) {
    minX = 0;
    minY = 0;
  }

  const elements = (legacy.elements ?? []).map((el) => {
    const r = legacyRect(el);
    const base = {
      id: el.id,
      type: el.type,
      rect: {
        x: r.x - minX,
        y: r.y - minY,
        width: r.w,
        height: r.h,
      },
    };

    if (el.type === "tile") {
      base.content = { resolver: el.content, mode: "image" };
      return base;
    }

    if (el.type === "tileRow") {
      base.content = { resolver: el.content, mode: "count" };
      base.repeat = {
        axis: "x",
        direction: "forward",
        pitch: el.step ?? el.w + 20,
      };
      if (el.frameAnchor) {
        base.position = {
          anchorTo: el.frameAnchor.frame,
          anchorPoint: "leftCenter",
          selfPoint: "leftCenter",
          offset: { x: el.frameAnchor.padX ?? 2, y: 0 },
        };
      }
      return base;
    }

    const mode = el.rows ? "rows" : el.content === "@empty" ? "empty" : "value";
    base.content = { resolver: el.rows ?? el.content, mode };
    const style = {
      fontFamily: el.font || "Montserrat",
      fontSize: el.size ?? 20,
      fontWeight: el.weight ?? 400,
      textColor: el.color || "#000000",
      textAlign: el.align || "left",
    };
    if (el.stroke) {
      style.stroke = {
        width: el.stroke,
        color: el.color || "#000000",
        alpha: 1,
      };
    }
    base.style = style;
    if (el.rows) {
      const lineHeight = el.lineHeight ?? Math.round((el.size ?? 20) * 1.2);
      base.repeat = {
        axis: "y",
        pitch: lineHeight,
        itemHeight: lineHeight,
      };
    }
    const sizing = {};
    if (el.frameFor) {
      sizing.growTo = el.frameFor;
      sizing.padding = el.pad ?? 7;
      sizing.minimum = true;
    }
    if (el.matchBoundsWidth) sizing.width = "canvas";
    if (Object.keys(sizing).length) base.sizing = sizing;
    return base;
  });

  const background = legacy.background
    ? {
        enabled: true,
        fill: {
          color: legacy.background.fillColor ?? "#ffffff",
          alpha: legacy.background.alpha ?? 1,
        },
        texture: { source: "@setting.backgroundTexture", whenEmpty: "fill" },
        layer: {
          elevation: legacy.background.elevation ?? -10,
          sort: legacy.background.sort ?? -1000,
        },
      }
    : undefined;
  const bounds = legacy.bounds
    ? {
        enabled: true,
        rect: "canvas",
        stroke: {
          width: legacy.bounds.stroke ?? 1,
          color: legacy.bounds.color ?? "#000000",
          alpha: legacy.bounds.alpha ?? 0.2,
        },
        layer: {
          elevation: legacy.bounds.elevation ?? 10,
          sort: legacy.bounds.sort ?? 1000,
        },
      }
    : undefined;

  const document = {
    format: FORMAT,
    version: VERSION,
    id: legacy.id,
    name: legacy.name,
    description: "Legacy layout converted from the built-in JS template.",
    anchor: { element: "portrait", point: "topLeft" },
    scale: legacy.scale ?? 1,
    canvas: {
      origin: { x: minX, y: minY },
      size: { width: 659, height: 849 },
      sizePolicy: {
        mode: "content",
        minimum: { width: 659, height: 568 },
        overflow: "expand",
      },
    },
    elements,
  };
  if (background) document.background = background;
  if (bounds) document.bounds = bounds;

  const result = analyzeLayout(document);
  return result.normalized ?? document;
}
