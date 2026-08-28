/**
 * WidgetBuilder — resolves actor data through the resolver catalog and
 * converts a NORMALIZED layout document (layoutSchema.js / layoutGeometry.js)
 * into the concrete scene document descriptors (drawings + tiles).
 *
 * All returned coordinates are RELATIVE to the widget anchor and already
 * scaled: canvas-local coordinates from the geometry engine get the
 * canvas origin added. The PlacementManager adds the anchor offset when
 * committing.
 *
 * The layout JSON is declarative; this module is the ONLY place where the
 * resolver ids are implemented (the resolver registry). Unknown resolver ids
 * are rejected at validation time (layoutSchema.js).
 */

import { computeLayoutDocs, TEXT_MEASURE_FALLBACK_FACTOR } from "./layoutGeometry.js";
import { MODULE_ID } from "./constants.js";

const warnedFonts = new Set();

/**
 * Resolver catalog. `mode` mirrors the allowed content modes of the JSON
 * format and must stay in sync with `RESOLVER_MODES` in layoutSchema.js.
 */
export const resolverCatalog = {
  "@name": { mode: "value", fn: (actor) => normalizeText(actor.name) },
  "@portrait": { mode: "image", fn: (actor) => actor.img },
  "@empty": { mode: "empty", fn: () => "" },
  "@headerAspects": { mode: "value", fn: () => i18n("fate-on-the-table.header.aspects") },
  "@headerFatePoints": { mode: "value", fn: () => i18n("fate-on-the-table.header.fatePoints") },
  "@headerSkills": { mode: "value", fn: () => i18n("fate-on-the-table.header.skills") },
  "@headerTracks": { mode: "value", fn: () => i18n("fate-on-the-table.header.tracks") },
  "@headerConsequences": { mode: "value", fn: () => i18n("fate-on-the-table.header.consequences") },
  "@consequencesHeader": {
    mode: "value",
    fn: (actor) =>
      consequenceTrackList(actor).length
        ? i18n("fate-on-the-table.header.consequences")
        : "",
  },
  "@consequenceCostRows": {
    mode: "rows",
    fn: (actor) => consequenceCostRows(actor),
  },
  "@headerStunts": { mode: "value", fn: () => i18n("fate-on-the-table.header.stunts") },
  "@headerExtras": { mode: "value", fn: () => i18n("fate-on-the-table.header.extras") },
  "@aspects": { mode: "value", fn: (actor) => aspectsText(actor) },
  "@shortAspects": { mode: "value", fn: (actor) => shortAspectsText(actor) },
  "@skillNames": { mode: "rows", fn: (actor) => skillRows(actor).map((r) => r.names.join(", ")) },
  "@skillValues": { mode: "rows", fn: (actor) => skillRows(actor).map((r) => "+" + r.rank) },
  "@fatePointTokens": {
    mode: "count",
    fn: (actor) => Number(actor.system?.details?.fatePoints?.current) || 0,
  },
  "@fatePointsValue": { mode: "value", fn: (actor) => fatePointsValue(actor) },
  "@stressTrackNames": { mode: "rows", fn: (actor) => stressTrackNames(actor) },
  "@stressTrackBoxes": { mode: "rows", fn: (actor) => stressTrackBoxes(actor) },
  "@stressBoxRows": { mode: "boxRow", fn: (actor) => stressTrackBoxRows(actor) },
  "@stressTracks": { mode: "rows", fn: (actor) => stressTrackRows(actor) },
  "@consequenceNames": { mode: "rows", fn: (actor) => consequenceNames(actor) },
  "@consequences": { mode: "rows", fn: (actor) => consequenceRows(actor) },
  "@stunts": { mode: "rows", fn: (actor) => stuntRows(actor) },
  "@extras": { mode: "rows", fn: (actor) => extraRows(actor) },
  "@description": {
    mode: "value",
    fn: (actor) => richTextToPlain(actor.system?.details?.description?.value),
  },
  "@biography": {
    mode: "value",
    fn: (actor) => richTextToPlain(actor.system?.details?.biography?.value),
  },
  "@notes": {
    mode: "value",
    fn: (actor) => richTextToPlain(actor.system?.details?.notes?.value),
  },
  "@pronouns": {
    mode: "value",
    fn: (actor) => String(actor.system?.details?.pronouns?.value ?? ""),
  },
};

function i18n(key) {
  return game.i18n.localize(key);
}

/**
 * Normalizes a possibly-raw display value into safe Drawing text. Foundry v14
 * treats a Drawing with no visible text/fill/stroke as invalid and rejects the
 * whole creation batch, so whitespace-only actor/track/consequence names must
 * become empty strings — the geometry engine then filters them as invisible
 * clutter. Internal spaces ("Alice Smith") are preserved; only surrounding
 * whitespace is trimmed.
 * @param {unknown} value
 * @returns {string}
 */
function normalizeText(value) {
  return String(value ?? "").trim();
}

/* ------------------------------------------------------------------ *
 * Data normalizers (Fate Core Official data model)
 * ------------------------------------------------------------------ */

function skillRows(actor) {
  const list = Object.values(actor.system?.skills ?? {}).filter(
    (s) => Number(s.rank) > 0,
  );
  const byRank = {};
  for (const s of list) (byRank[s.rank] ??= []).push(s.name);
  return Object.keys(byRank)
    .map(Number)
    .sort((a, b) => b - a)
    .map((rank) => ({ rank, names: byRank[rank] }));
}

function aspectsText(actor) {
  const values = Object.values(actor.system?.aspects ?? {})
    .map((a) => a.value)
    .filter((v) => v && String(v).trim());
  return values.join("\n\n");
}

/**
 * First two NON-EMPTY aspect values of `actor.system.aspects`, in the
 * canonical collection order (the Fate Core sheet order — usually High
 * concept and Trouble), joined with blank lines. Used by the `@shortAspects`
 * resolver for compact aspect blocks.
 *
 * Deliberately no slot-name hardcoding (no "High concept"/"Trouble" lookups
 * in any language) and no sorting: the stored key order is authoritative.
 * A missing/empty actor or aspects object yields an empty string.
 * @param {object} actor
 * @returns {string}
 */
export function shortAspectsText(actor) {
  const values = Object.values(actor?.system?.aspects ?? {})
    .map((a) => a?.value)
    .filter((v) => v && String(v).trim())
    .slice(0, 2);
  return values.join("\n\n");
}

function fatePointsValue(actor) {
  const fp = actor.system?.details?.fatePoints ?? {};
  const current = Number(fp.current) || 0;
  const refresh = Number(fp.refresh);
  if (Number.isFinite(refresh)) return `${current} / ${refresh}`;
  return String(current);
}

/**
 * Enabled tracks with checkboxes (base boxes or skill-granted boxes), i.e.
 * stress tracks without an aspect (consequences/conditions are excluded).
 * @param {object} actor
 * @returns {object[]}  Track objects.
 */
function stressTrackList(actor) {
  return trackList(actor).filter(
    (t) =>
      !isAspectTrack(t) &&
      (Number(t.boxes) > 0 ||
        (Array.isArray(t.box_values) && t.box_values.length > 0)),
  );
}

/**
 * Track names only, one row per track. Used by layouts that render the
 * stress name and the (larger) box markers as separate elements.
 * @param {object} actor
 * @returns {string[]}
 */
export function stressTrackNames(actor) {
  return stressTrackList(actor).map((t) => normalizeText(t.name));
}

/**
 * Box markers only, one row per track. Empty boxes are black squares
 * ("☐"), checked boxes get an X ("☒").
 *
 * The system stores the BASE box count in `boxes`; the actual number of
 * checkboxes (base + boxes granted by linked skill ranks) lives in the
 * `box_values` array (recalculated by `fcoActor.setupTracks`, the sheet
 * renders `box_values`). The widget must therefore count `box_values`,
 * falling back to `boxes` for uninitialized tracks.
 * @param {object} actor
 * @returns {string[]}
 */
export function stressTrackBoxes(actor) {
  return stressTrackList(actor).map((t) => {
    const values = Array.isArray(t.box_values) ? t.box_values : [];
    const boxCount = Math.max(Number(t.boxes) || 0, values.length);
    const boxes = [];
    for (let i = 0; i < boxCount; i++) {
      boxes.push(values[i] ? "\u2612" : "\u2610");
    }
    return boxes.join(" ");
  });
}

/**
 * Per-track box marker texts as rows of arrays ("X" for a checked box, ""
 * for an empty one). Used by "boxRow" layout elements where every checkbox
 * is its own framed Drawing (like the legacy macro stress boxes).
 * @param {object} actor
 * @returns {string[][]}
 */
export function stressTrackBoxRows(actor) {
  return stressTrackList(actor).map((t) => {
    const values = Array.isArray(t.box_values) ? t.box_values : [];
    const boxCount = Math.max(Number(t.boxes) || 0, values.length);
    const boxes = [];
    for (let i = 0; i < boxCount; i++) {
      boxes.push(values[i] ? "X" : "");
    }
    return boxes;
  });
}

/**
 * Maps a flat stress box index (the `index` flag of a boxRow drawing) back
 * to its track key and within-track box index, using the same ordering as
 * `stressTrackBoxRows`: enabled tracks with checkboxes, aspect tracks
 * (consequences/conditions) excluded.
 * @param {object} actor
 * @param {number} flatIndex  Flat box index (0-based across all tracks).
 * @returns {{trackKey: string, boxIndex: number}|null}
 */
export function stressBoxTarget(actor, flatIndex) {
  const index = Number(flatIndex);
  if (!Number.isInteger(index) || index < 0) return null;
  let remaining = index;
  for (const [key, track] of Object.entries(actor.system?.tracks ?? {})) {
    if (!track?.enabled || isAspectTrack(track)) continue;
    const count = Math.max(
      Number(track.boxes) || 0,
      Array.isArray(track.box_values) ? track.box_values.length : 0,
    );
    if (count <= 0) continue;
    if (remaining < count) return { trackKey: key, boxIndex: remaining };
    remaining -= count;
  }
  return null;
}

/**
 * Combined rows ("Name: ☐ ☐ ☐") for layouts with a single stress element.
 * @param {object} actor
 * @returns {string[]}
 */
export function stressTrackRows(actor) {
  const names = stressTrackNames(actor);
  const boxes = stressTrackBoxes(actor);
  return names.map((name, i) => {
    const suffix = boxes[i] ? " " + boxes[i] : "";
    return `${name}:${suffix}`;
  });
}

/**
 * Enabled aspect tracks (consequences/conditions) in sheet order — occupied
 * AND free. Like stress tracks, every enabled aspect track gets its own
 * checkbox cell (empty or marked), so free consequence slots never disappear
 * from the widget and never shift the flat indices of later tracks. Keeps
 * the `actor.system.tracks` insertion (sheet) order — no slot-name or
 * severity hardcoding. An actor without aspect tracks returns [] and creates
 * no box Drawing at all.
 * @param {object} actor
 * @returns {object[]}  Track objects.
 */
function consequenceTrackList(actor) {
  return trackList(actor).filter((t) => isAspectTrack(t));
}

/**
 * A consequence slot is occupied when the sheet has an aspect name and/or a
 * checked `box_values[0]`. The two signals use the same priority in every
 * consumer (legacy `@consequences` rows, the consequence cost rows and the
 * docs). Note that `consequenceNames` and `consequenceCostRows` operate on
 * EVERY enabled aspect track (free ones included), so occupancy only decides
 * the row text, never whether the row exists.
 * @param {object} track
 * @returns {boolean}
 */
function isConsequenceOccupied(track) {
  const name = track?.aspect?.name ? String(track.aspect.name).trim() : "";
  if (name) return true;
  return Array.isArray(track?.box_values) && Boolean(track.box_values[0]);
}

/**
 * Plain consequence NAMES, one row per enabled aspect track, in sheet order.
 * An occupied slot shows its `aspect.name`; a free (or marked-but-unnamed)
 * slot shows the track's slot name ("Mild Consequence", ...) so the empty
 * slot has a label and the row list stays stable. This resolver is the text
 * companion of the consequence COST rows used on the conflict card (there
 * are no interactive consequence checkboxes). No "[ ]"/"[X]" markers.
 * @param {object} actor
 * @returns {string[]}
 */
export function consequenceNames(actor) {
  return consequenceTrackList(actor).map((t) => {
    const name = normalizeText(t?.aspect?.name);
    return name || normalizeText(t?.name);
  });
}

/**
 * Fixed width that every FREE consequence cost row pads to with underscores.
 * The underscore-run visually signals a writable slot and must reach the end
 * of the layout text column. A constant (not a per-slot calcuation) keeps the
 * pure resolver deterministic and editor-preview compatible. Occupied slots
 * do NOT pad: they show the actual consequence name.
 */
export const CONSEQUENCE_COST_ROW_WIDTH = 12;

/**
 * Cost rows for the conflict-card consequence section, one row per enabled
 * aspect track in stable sheet order. This REPLACES the plain consequence
 * name rows on the conflict card:
 *   - an occupied slot WITH a cost (`harm_can_absorb`) shows BOTH, so the
 *     price stays visible next to the entered consequence text, e.g.
 *     "2 Broken leg";
 *   - an occupied slot WITHOUT a cost shows the actual `aspect.name` only;
 *   - a slot that is occupied by a checked box but has no name shows just its
 *     cost (e.g. "2");
 *   - a free slot shows its cost (`harm_can_absorb`) padded with underscores
 *     to `CONSEQUENCE_COST_ROW_WIDTH`, e.g. "2__________".
 *
 * The cost is read from `track.harm_can_absorb` (Fate Core Official), never
 * hardcoded (no 2/4/6 defaults). If the cost field is missing the free slot
 * still shows the empty cost + underscore line, so the layout row keeps its
 * shape without inventing a price. Stress tracks and disabled tracks are
 * excluded. An actor without aspect tracks returns [].
 * @param {object} actor
 * @returns {string[]}
 */
export function consequenceCostRows(actor) {
  return consequenceTrackList(actor).map((track) => {
    const name = normalizeText(track?.aspect?.name);
    const occupied = isConsequenceOccupied(track);
    const cost = track?.harm_can_absorb;
    const costText = cost == null || cost === "" ? "" : String(cost);
    if (!occupied) {
      const underscores = "_".repeat(
        Math.max(0, CONSEQUENCE_COST_ROW_WIDTH - costText.length),
      );
      return costText + underscores;
    }
    // Occupied slot: the cost must never disappear once the slot is filled.
    if (costText) return name ? `${costText} ${name}` : costText;
    return name;
  });
}

/**
 * Per-row descriptor metadata for `consequenceCostRows` in the SAME stable
 * order (one entry per enabled aspect track). Gives the future double-click
 * handler the exact track it must write the entered consequence into, without
 * re-deriving the ordering:
 *   { trackKey, cost, occupied }
 *   - `trackKey`  : the `actor.system.tracks` key to update;
 *   - `cost`      : the raw `harm_can_absorb` value (may be null/undefined);
 *   - `occupied`  : whether the slot already has a consequence.
 * @param {object} actor
 * @returns {Array<{trackKey: string, cost: (number|string|null|undefined), occupied: boolean}>}
 */
export function consequenceCostDescriptors(actor) {
  const out = [];
  for (const [key, track] of Object.entries(actor?.system?.tracks ?? {})) {
    if (!track?.enabled || !isAspectTrack(track)) continue;
    out.push({
      trackKey: key,
      cost: track?.harm_can_absorb,
      occupied: isConsequenceOccupied(track),
    });
  }
  return out;
}

/**
 * Maps a flat row index (the `index` flag of the `consequenceCostRows` rows
 * element) back to its track key using the SAME ordering as
 * `consequenceCostRows` / `consequenceCostDescriptors`: every enabled aspect
 * track occupies exactly one sequential cell. This mirrors the stable
 * ordering so a double-click handler can locate the track to persist a newly
 * entered consequence name.
 * @param {object} actor
 * @param {number} flatIndex  Flat row index (0-based across all tracks).
 * @returns {{trackKey: string, boxIndex: number}|null}
 */
export function consequenceCostTarget(actor, flatIndex) {
  const index = Number(flatIndex);
  if (!Number.isInteger(index) || index < 0) return null;
  let remaining = index;
  for (const [key, track] of Object.entries(actor?.system?.tracks ?? {})) {
    if (!track?.enabled || !isAspectTrack(track)) continue;
    if (remaining === 0) return { trackKey: key, boxIndex: 0 };
    remaining -= 1;
  }
  return null;
}

/** Tracks that become an aspect when marked (consequences, conditions). */
function consequenceRows(actor) {
  return trackList(actor)
    .filter((t) => isAspectTrack(t))
    .map((t) => {
      const name = t.aspect?.name ? String(t.aspect.name).trim() : "";
      if (name) return `[X] ${name}`;
      return `[ ] ${t.name}`;
    });
}

function trackList(actor) {
  return Object.values(actor.system?.tracks ?? {}).filter((t) => t?.enabled);
}

function isAspectTrack(track) {
  const aspect = track?.aspect;
  return (
    !!aspect &&
    typeof aspect === "object" &&
    !Array.isArray(aspect) &&
    !!(aspect.when_marked || aspect.as_name)
  );
}

function stuntRows(actor) {
  return Object.values(actor.system?.stunts ?? {})
    .filter((s) => s?.name)
    .map((s) => {
      const bonus = Number(s.bonus) || 0;
      const skill =
        s.linked_skill && s.linked_skill !== "None" ? s.linked_skill : null;
      const parts = [s.name];
      if (bonus) parts.push(`+${bonus}`);
      if (skill) parts.push(`(${skill})`);
      return parts.join(" ");
    });
}

function extraRows(actor) {
  const extras = (actor.items ?? []).filter(
    (item) => item.type === "Extra" && item.system?.active !== false,
  );
  return extras.map((item) => {
    const refresh = Number(item.system?.refresh);
    if (Number.isFinite(refresh) && refresh > 0) {
      return `${item.name} (${refresh})`;
    }
    return item.name;
  });
}

/** Converts a rich-text HTML field to plain text for a Drawing. */
function richTextToPlain(value) {
  if (!value) return "";
  try {
    if (typeof foundry?.utils?.htmlToText === "function") {
      return foundry.utils.htmlToText(value);
    }
  } catch (err) {
    /* fall through to the regex-based strip */
  }
  return String(value)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .trim();
}

/* ------------------------------------------------------------------ *
 * Content resolution
 * ------------------------------------------------------------------ */

function resolveValue(key, actor) {
  if (typeof key === "string" && key.startsWith("@setting.")) {
    return game.settings.get(MODULE_ID, key.slice("@setting.".length));
  }
  if (typeof key === "string" && key.startsWith("@")) {
    const entry = resolverCatalog[key];
    return entry ? entry.fn(actor) : key;
  }
  return key;
}

/**
 * Resolves the runtime value of an element's content for an actor.
 * Exported for tests: the returned value must keep its shape (rows -> array
 * of strings, boxRow -> array of arrays, count -> number, ...).
 * @param {object} el  Layout element (normalized).
 * @param {object} actor
 */
export function resolveElement(el, actor) {
  const { resolver, mode } = el.content ?? {};
  const value = resolveValue(resolver, actor);
  switch (mode) {
    case "rows":
      return Array.isArray(value) ? value : [String(value ?? "")];
    case "boxRow":
      return Array.isArray(value) ? value : [];
    case "count":
      return Math.max(0, Number(value) || 0);
    case "image":
      return String(value ?? "");
    case "empty":
      return "";
    default:
      return String(value ?? "");
  }
}

export function resolveFont(family) {
  if (CONFIG.fontDefinitions?.[family]) return family;
  if (family && family !== "Montserrat" && !warnedFonts.has(family)) {
    warnedFonts.add(family);
    console.warn(
      `[fate-on-the-table] font "${family}" is not registered; using Montserrat`,
    );
  }
  return "Montserrat";
}

let textMeasureContext = null;

/** Measures layout text with the same browser font fallback as Drawing text. */
function measureTextWidth(text, style) {
  try {
    if (typeof document !== "undefined") {
      textMeasureContext ??= document.createElement("canvas").getContext("2d");
      if (textMeasureContext) {
        const family = String(style?.font ?? "Montserrat").replaceAll('"', "");
        const weight = style?.weight ?? 400;
        textMeasureContext.font = `${weight} ${Number(style?.size) || 20}px "${family}"`;
        return textMeasureContext.measureText(String(text ?? "")).width;
      }
    }
  } catch (err) {
    // Fall back to a deterministic approximation outside a browser canvas.
  }
  return String(text ?? "").length * (Number(style?.size) || 20) * TEXT_MEASURE_FALLBACK_FACTOR;
}

/**
 * Builds a horizontal row of tile descriptors (fate point tokens).
 * Shared by the GM fate point row (which is not layout-driven) and the
 * layout tileRow elements (the layout engine builds those).
 * @param {object} opts  { part, count, src, x, y, w, h, step, ox, oy, scale,
 *   direction }
 * @returns {object[]}  Tile descriptors (kind: "tile", index per tile).
 */
export function buildTileRow({
  part,
  count,
  src,
  x,
  y,
  w,
  h,
  step,
  ox = 0,
  oy = 0,
  scale = 1,
  direction = "ltr",
}) {
  const docs = [];
  const n = Math.max(0, Number(count) || 0);
  if (!src || n === 0) return docs;
  const pitch = (step ?? w + 20) * scale;
  const oxScaled = (x + ox) * scale;
  const oyScaled = (y + oy) * scale;
  const wScaled = w * scale;
  const hScaled = h * scale;
  const dirX = direction === "rtl" ? -1 : direction === "ltr" ? 1 : 0;
  const dirY = direction === "ttb" ? 1 : direction === "btt" ? -1 : 0;
  for (let i = 0; i < n; i++) {
    docs.push({
      kind: "tile",
      part,
      index: i,
      x: oxScaled + dirX * i * pitch,
      y: oyScaled + dirY * i * pitch,
      w: wScaled,
      h: hScaled,
      src,
      // Row coordinates are visible top-left coordinates. Keep the texture
      // anchor at the top-left as well; Foundry otherwise centers the image.
      textureAnchor: { x: 0, y: 0 },
    });
  }
  return docs;
}

/**
 * Builds the widget layout for an actor.
 * @param {object} actor
 * @param {object} layout  Normalized layout document.
 * @param {object} [options]  Overrides: { scale, fontFamily, textColor,
 *   fatePointImage, fatePointTileSize, fatePointStep,
 *   backgroundTexture }.
 * @returns {Promise<{docs: object[], bounds: {x, y, width, height}}>}
 */
export async function build(actor, layout, options = {}) {
  const resolved = {};
  for (const el of layout.elements ?? []) {
    resolved[el.id] = resolveElement(el, actor);
  }

  let backgroundTexture = "";
  const textureSource = layout.background?.texture?.source;
  if (textureSource) {
    backgroundTexture = textureSource.startsWith("@setting.")
      ? game.settings.get(MODULE_ID, textureSource.slice("@setting.".length)) ?? ""
      : String(textureSource);
  }

  const { docs, canvas } = computeLayoutDocs(layout, resolved, {
    scale: options.scale ?? 1,
    fontFamily: options.fontFamily,
    textColor: options.textColor,
    fatePointImage: options.fatePointImage ?? "",
    fatePointTileSize: options.fatePointTileSize,
    fatePointStep: options.fatePointStep,
    backgroundTexture,
    resolveFont,
    measureText: measureTextWidth,
  });

  const scale = (layout.scale ?? 1) * (options.scale ?? 1);
  const ox = (layout.canvas?.origin?.x ?? 0) * scale;
  const oy = (layout.canvas?.origin?.y ?? 0) * scale;
  for (const doc of docs) {
    doc.x += ox;
    doc.y += oy;
  }

  if (!docs.length) {
    return { docs, bounds: { x: 0, y: 0, width: 0, height: 0 } };
  }
  return {
    docs,
    bounds: {
      x: canvas.x + ox,
      y: canvas.y + oy,
      width: canvas.width,
      height: canvas.height,
    },
  };
}

/* ------------------------------------------------------------------ *
 * Document payloads
 * ------------------------------------------------------------------ */

/**
 * Converts a built document descriptor into a Drawing/Tile create payload
 * with the widget identity flags.
 * @param {object} doc
 * @param {object} flags  { widgetId, part, index, actorUuid? | ownerType? }
 * @returns {object}
 */
function getRectangleType() {
  return (
    CONST.DRAWING_TYPES?.RECTANGLE ?? foundry.data.ShapeData.TYPES.RECTANGLE
  );
}

export function toDocumentData(doc, flags) {
  if (doc.kind === "tile") {
    const texture = { src: doc.src };
    if (doc.textureAnchor) {
      texture.anchorX = doc.textureAnchor.x;
      texture.anchorY = doc.textureAnchor.y;
    }
    return {
      texture,
      x: Math.round(doc.x),
      y: Math.round(doc.y),
      width: Math.round(doc.w),
      height: Math.round(doc.h),
      flags: { "fate-on-the-table": flags },
    };
  }
  const strokeWidth = doc.stroke ?? 0;
  const widgetFlags = { "fate-on-the-table": flags };
  // Advanced Drawing Tools: without these flags ADT overrides the core text
  // styling (in particular alignment) with its own defaults.
  const textStyle = {
    dropShadow: false,
    strokeThickness: 0,
    align: doc.align || "left",
  };
  if (doc.weight) textStyle.fontWeight = doc.weight;
  widgetFlags["advanced-drawing-tools"] = { textStyle };
  widgetFlags.adt = { dropShadow: false };
  if (doc.weight) widgetFlags.adt.fontWeight = doc.weight;
  const payload = {
    type: getRectangleType(),
    author: game.user.id,
    x: Math.round(doc.x),
    y: Math.round(doc.y),
    shape: { width: Math.round(doc.w), height: Math.round(doc.h) },
    fillType: doc.fillType ?? CONST.DRAWING_FILL_TYPES.NONE,
    fillColor: doc.fillColor ?? "#ffffff",
    fillAlpha: doc.fillAlpha ?? 0,
    texture: doc.texture ?? null,
    strokeWidth,
    strokeColor: strokeWidth ? doc.strokeColor ?? doc.color : "#000000",
    strokeAlpha: doc.strokeAlpha ?? (strokeWidth ? 1 : 0),
    text: doc.text ?? "",
    fontFamily: doc.font,
    fontSize: Math.max(8, doc.size),
    textColor: doc.color,
    textAlign: doc.align,
    elevation: doc.elevation ?? 0,
    sort: doc.sort ?? 0,
    points: [],
    flags: widgetFlags,
  };
  if (Number.isFinite(doc.rotation)) payload.rotation = Number(doc.rotation);
  return payload;
}
