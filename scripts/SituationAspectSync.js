/**
 * SituationAspectSync — reads the system scene flag
 * `fate-core-official.situation_aspects` and keeps a standalone scene widget
 * (text + frame + background drawings) in sync:
 *
 * - the widget is identified by the module scene registry
 *   `chars-to-table.situationAspectsWidget` ({ widgetId, anchor });
 * - without a registry record nothing is ever auto-created;
 * - text/frame/background are separate Drawing parts sharing one widgetId
 *   and ownerType "situationAspects";
 * - a fully deleted group clears the registry (never re-created without an
 *   explicit placement).
 */

import { toDocumentData } from "./WidgetBuilder.js";
import { getSituationAspectOptions } from "./settings.js";
import {
  FLAG_SCOPE,
  SITUATION_ASPECTS_SCOPE,
  SITUATION_ASPECTS_KEY,
  SITUATION_ASPECTS_WIDGET_FLAG,
  SA_OWNER_TYPE,
  SA_TEXT_PART,
  SA_FRAME_PART,
  SA_BACKGROUND_PART,
} from "./constants.js";

const SA_PARTS = [SA_TEXT_PART, SA_FRAME_PART, SA_BACKGROUND_PART];

/**
 * All drawings of the situation aspects widget on a scene (by widgetId and
 * ownerType, so the group is never confused with any other widget).
 */
export function saGroupDocs(scene, widgetId) {
  return scene.drawings.filter(
    (d) =>
      d.getFlag(FLAG_SCOPE, "widgetId") === widgetId &&
      d.getFlag(FLAG_SCOPE, "ownerType") === SA_OWNER_TYPE,
  );
}

/** Scene registry of the situation aspects widget: { widgetId, anchor }. */
export function saRegistry(scene = canvas?.scene) {
  return scene?.getFlag(FLAG_SCOPE, SITUATION_ASPECTS_WIDGET_FLAG) ?? null;
}

/**
 * Deep-clones and normalizes a raw situation aspects list:
 * `free_invokes` becomes a non-negative integer (fixes the old string
 * concatenation bug), names are trimmed, empty names are dropped. Unknown
 * extra fields of the system objects are preserved.
 * @param {*} list
 * @returns {object[]}
 */
export function normalizeAspects(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const raw of list) {
    const name = String(raw?.name ?? "").trim();
    if (!name) continue;
    const invokes = Math.max(0, Math.trunc(Number(raw.free_invokes) || 0));
    out.push({ ...raw, name, free_invokes: invokes });
  }
  return out;
}

/** Normalized situation aspects of a scene (from the system flag). */
export function situationAspects(scene = canvas?.scene) {
  return normalizeAspects(
    scene?.getFlag(SITUATION_ASPECTS_SCOPE, SITUATION_ASPECTS_KEY),
  );
}

/**
 * Plain text of the widget: one `name (free_invokes)` line per aspect,
 * elements separated by an empty line, centered inside the Drawing.
 * @param {object[]} aspects  Normalized aspect objects.
 * @returns {string}
 */
export function aspectsText(aspects) {
  return aspects.map((a) => `${a.name} (${a.free_invokes})`).join("\n\n");
}

/** Text Drawing descriptor of the widget (relative coords). */
export function buildSaTextDoc(aspects, opts = getSituationAspectOptions()) {
  const text = aspectsText(aspects);
  const hasText = text.length > 0;
  return {
    kind: "drawing",
    part: SA_TEXT_PART,
    index: -1,
    x: 0,
    y: 0,
    w: opts.width,
    h: opts.height,
    font: opts.fontFamily,
    size: opts.fontSize,
    color: opts.textColor,
    align: "center",
    stroke: 0,
    text,
    // An empty list still keeps a valid Drawing: with no text Foundry's
    // joint validation requires a visible fill or line, so use a
    // near-invisible solid fill over the background color. The widget stays
    // on the table with an empty text (frame and registry persist too).
    fillType: hasText
      ? CONST.DRAWING_FILL_TYPES.NONE
      : CONST.DRAWING_FILL_TYPES.SOLID,
    fillColor: opts.backgroundColor,
    fillAlpha: hasText ? 0 : 0.01,
  };
}

/** Transparent "grab" frame Drawing descriptor covering the widget bounds. */
export function buildSaFrameDoc(opts = getSituationAspectOptions()) {
  return {
    kind: "drawing",
    part: SA_FRAME_PART,
    index: -1,
    x: 0,
    y: 0,
    w: opts.width,
    h: opts.height,
    font: "Montserrat",
    size: 8,
    color: "#000000",
    align: "left",
    stroke: 1,
    strokeAlpha: 0.2,
    text: "",
    fillType: CONST.DRAWING_FILL_TYPES.NONE,
    fillColor: "#ffffff",
    fillAlpha: 0,
    elevation: 10,
    sort: 1000,
  };
}

/**
 * Background Drawing descriptor of the widget: texture pattern when
 * configured, plain fill otherwise. Rendered below the text (low
 * elevation/sort) and never grabs the double-click from text or frame.
 */
export function buildSaBackgroundDoc(opts = getSituationAspectOptions()) {
  return {
    kind: "drawing",
    part: SA_BACKGROUND_PART,
    index: -1,
    x: 0,
    y: 0,
    w: opts.width,
    h: opts.height,
    font: "Montserrat",
    size: 8,
    color: opts.backgroundColor,
    align: "left",
    stroke: 0,
    text: "",
    fillType: opts.backgroundTexture
      ? CONST.DRAWING_FILL_TYPES.PATTERN
      : CONST.DRAWING_FILL_TYPES.SOLID,
    fillColor: opts.backgroundColor,
    fillAlpha: opts.backgroundAlpha,
    texture: opts.backgroundTexture || null,
    elevation: -10,
    sort: -1000,
  };
}

const SYNC_FIELDS = [
  "x",
  "y",
  "text",
  "fontSize",
  "fontFamily",
  "textColor",
  "textAlign",
  "fillType",
  "fillColor",
  "fillAlpha",
  "texture",
  "strokeWidth",
  "strokeColor",
  "strokeAlpha",
  "elevation",
  "sort",
  "shape.width",
  "shape.height",
  "flags.advanced-drawing-tools.textStyle.align",
  "flags.advanced-drawing-tools.textStyle.fontWeight",
];

/**
 * Re-syncs the situation aspects widget of a scene against the system flag
 * and the module settings:
 *
 * 1. read + normalize the system flag;
 * 2. find the registry and the group documents by widgetId;
 * 3. no registry — nothing is created (never auto-create);
 * 4. registry — update text (text, geometry, font, color, ADT flags), frame
 *    and background; create missing parts / delete extras by their flags;
 * 5. background is synced separately (fill/texture, size, elevation, sort)
 *    without touching the anchor;
 * 6. when the whole group was deleted manually, the registry is cleared.
 *
 * @param {object} [scene]
 * @returns {Promise<boolean>}  True when the scene has a live widget.
 */
export async function syncSituationAspects(scene = canvas?.scene) {
  if (!scene) return false;
  const registry = saRegistry(scene);
  if (!registry?.widgetId) return false;

  const existing = saGroupDocs(scene, registry.widgetId);
  if (!existing.length) {
    await scene.unsetFlag(FLAG_SCOPE, SITUATION_ASPECTS_WIDGET_FLAG);
    return false;
  }

  const anchor = registry.anchor ?? { x: 0, y: 0 };
  const opts = getSituationAspectOptions();
  const descriptors = [
    buildSaTextDoc(situationAspects(scene), opts),
    buildSaFrameDoc(opts),
    buildSaBackgroundDoc(opts),
  ];

  for (const doc of descriptors) {
    const payload = toDocumentData(
      { ...doc, x: doc.x + anchor.x, y: doc.y + anchor.y },
      {
        widgetId: registry.widgetId,
        part: doc.part,
        index: doc.index,
        ownerType: SA_OWNER_TYPE,
      },
    );
    await upsertPart(scene, existing, doc.part, payload);
  }

  const extras = existing.filter(
    (d) => !SA_PARTS.includes(d.getFlag(FLAG_SCOPE, "part")),
  );
  if (extras.length) {
    await scene.deleteEmbeddedDocuments("Drawing", extras.map((d) => d.id));
  }
  return true;
}

/** Updates one widget part in place or creates it when missing. */
async function upsertPart(scene, existing, part, payload) {
  const current = existing.find(
    (d) => d.getFlag(FLAG_SCOPE, "part") === part,
  );
  if (current) {
    const delta = {};
    for (const field of SYNC_FIELDS) {
      const cur = foundry.utils.getProperty(current, field);
      const next = foundry.utils.getProperty(payload, field);
      if (cur !== next && next !== undefined) delta[field] = next;
    }
    if (Object.keys(delta).length) {
      await scene.updateEmbeddedDocuments(
        "Drawing",
        [{ _id: current.id, ...delta }],
        { charsToTableSync: true },
      );
    }
  } else {
    await scene.createEmbeddedDocuments("Drawing", [payload]);
  }
}

/**
 * Removes the situation aspects widget (text + frame + background + scene
 * registry). The system aspects array is NOT touched.
 * @param {object} [scene]
 * @returns {Promise<boolean>}  True when something was removed.
 */
export async function removeSituationAspectWidget(scene = canvas?.scene) {
  if (!scene) return false;
  const registry = saRegistry(scene);
  let removed = 0;
  if (registry?.widgetId) {
    const docs = saGroupDocs(scene, registry.widgetId);
    if (docs.length) {
      await scene.deleteEmbeddedDocuments("Drawing", docs.map((d) => d.id));
      removed += docs.length;
    }
    await scene.unsetFlag(FLAG_SCOPE, SITUATION_ASPECTS_WIDGET_FLAG);
  }
  return removed > 0;
}
