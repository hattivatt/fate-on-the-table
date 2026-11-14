/**
 * SituationAspectSync — reads the system scene flag
 * `fate-core-official.situation_aspects` and keeps a standalone scene widget
 * (aspect texts + frame + background drawings) in sync:
 *
 * - the widget is identified by the module scene registry
 *   `fate-on-the-table.situationAspectsWidget` ({ widgetId, anchor });
 * - without a registry record nothing is ever auto-created;
 * - frame/background are single Drawing parts; the aspect LIST is projected
 *   as ONE TEXT DRAWING PER ASPECT (part "situationAspectsText",
 *   `index` = aspect position), so every aspect is an independently
 *   clickable/hit-testable part whose list position lives in its flags
 *   (foundation for a future per-aspect context menu);
 * - a fully deleted group clears the registry (never re-created without an
 *   explicit placement);
 * - every sync RECONCILES the text parts against the current aspect list:
 *   any set mismatch (count or rendered lines differ) deletes all stale
 *   text parts and rebuilds them from the list, while an unchanged list is
 *   a guaranteed no-op (no creates, updates or deletes).
 */

import { canRunSync } from "./syncAuthority.js";
import { toDocumentData } from "./WidgetBuilder.js";
import { getSituationAspectOptions } from "./settings.js";
import { normalizeConflictBoard } from "./conflictBoardSchema.js";
import {
  FLAG_SCOPE,
  SITUATION_ASPECTS_SCOPE,
  SITUATION_ASPECTS_KEY,
  SITUATION_ASPECTS_WIDGET_FLAG,
  SA_OWNER_TYPE,
  SA_TEXT_PART,
  SA_FRAME_PART,
  SA_BACKGROUND_PART,
  CONFLICT_BOARD_FLAG,
} from "./constants.js";
import {
  normalizeZoneIds,
  aspectZoneIds,
  migrateZoneSuffixes,
  SA_ZONE_MARKER,
} from "./situationAspectZones.js";
import {
  consequenceMarker,
  reconcileConsequences,
} from "./situationAspectConsequences.js";
import { normalizeAspects as normalizeAspectsData } from "./situationAspectData.js";
import {
  toArray,
  existingDocumentIds,
  safeDeleteEmbeddedDocuments,
  tokenActorName,
} from "./utils.js";

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

export function normalizeAspects(list) {
  return normalizeAspectsData(list);
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
function aspectsText(aspects) {
  return aspects.map((a) => `${a.name} (${a.free_invokes})`).join("\n\n");
}

/**
 * LEGACY single-part text descriptor: the whole list rendered as one
 * full-height Drawing (`index: -1`), lines joined by an empty line.
 * Historically the initial placement trio was built from it; placeWidget now
 * projects `buildSaTextDocs()` directly, so new widgets are per-aspect from
 * the start. The export stays for compatibility with external macros/tests,
 * and `syncSituationAspects` still migrates a legacy part on its next run.
 * @param {object[]} aspects  Normalized aspect objects.
 * @returns {object}
 */
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

/** PIXI.TextStyle default line height: fontSize * 1.25. */
const SA_LINE_HEIGHT_FACTOR = 1.25;

/** Rendered line of one aspect — same format as one `aspectsText()` row. */
export function saAspectLine(aspect) {
  const line = `${aspect.name} (${aspect.free_invokes})`;
  const prefixes = [];
  const ids = aspectZoneIds(aspect);
  if (ids.length) prefixes.push(SA_ZONE_MARKER);
  if (aspect?.consequence) prefixes.push(consequenceMarker(aspect.consequence.cost));
  return prefixes.length ? `${prefixes.join(" ")} ${line}` : line;
}

/** Pixel line height of one widget text row for the given font size. */
export function saLineHeight(fontSize) {
  return (
    Math.round(Math.max(8, Number(fontSize) || 32) * SA_LINE_HEIGHT_FACTOR)
  );
}

/**
 * Text Drawing descriptors of the widget — ONE PER ASPECT (relative coords).
 *
 * Aspect i becomes its own clickable part (`index = i`) holding exactly the
 * legacy line `name (free_invokes)` with the same font/color/centered
 * alignment and the full widget width. The vertical geometry mirrors the old
 * combined text block: rows are separated by one blank line (the legacy
 * "\n\n" join), so every slot is two line heights tall and the block keeps
 * the legacy vertical centering inside `opts.height`.
 *
 * An EMPTY list still yields exactly ONE part (index 0): a near-invisible
 * placeholder covering the whole widget — same visual as the legacy single
 * text Drawing for an empty list (Foundry rejects Drawings without any
 * visible text/fill/line). Index 0 lets the placeholder be updated in place
 * when the first aspect appears.
 * @param {object[]} aspects  Normalized aspect objects.
 * @returns {object[]}
 */
export function buildSaTextDocs(aspects, opts = getSituationAspectOptions()) {
  if (!Array.isArray(aspects) || aspects.length === 0) {
    return [
      {
        kind: "drawing",
        part: SA_TEXT_PART,
        index: 0,
        x: 0,
        y: 0,
        w: opts.width,
        h: opts.height,
        font: opts.fontFamily,
        size: opts.fontSize,
        color: opts.textColor,
        align: "center",
        stroke: 0,
        text: "",
        fillType: CONST.DRAWING_FILL_TYPES.SOLID,
        fillColor: opts.backgroundColor,
        fillAlpha: 0.01,
      },
    ];
  }
  const lineHeight = saLineHeight(opts.fontSize);
  // Legacy layout: one row + one empty separator line ("\n\n" join).
  const slotHeight = lineHeight * 2;
  const blockHeight = aspects.length * slotHeight - lineHeight;
  const top = Math.max(0, Math.round((opts.height - blockHeight) / 2));
  return aspects.map((aspect, i) => ({
    kind: "drawing",
    part: SA_TEXT_PART,
    index: i,
    x: 0,
    y: top + i * slotHeight,
    w: opts.width,
    h: slotHeight,
    font: opts.fontFamily,
    size: opts.fontSize,
    color: opts.textColor,
    align: "center",
    stroke: 0,
    text: saAspectLine(aspect),
    fillType: CONST.DRAWING_FILL_TYPES.NONE,
    fillColor: opts.backgroundColor,
    fillAlpha: 0,
  }));
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
    elevation: 0,
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
 * 4. registry — update frame and background; RECONCILE the text parts
 *    against the aspect list by part#index: a part that moved or was renamed
 *    is delta-updated in place, only part#index slots that no longer exist
 *    (a removed aspect, the legacy combined text drawing, unknown parts) are
 *    deleted. All deltas and creations of one sync are flushed in a single
 *    `updateEmbeddedDocuments` / `createEmbeddedDocuments` call each, so a
 *    rename never churns the whole text block;
 * 5. background is synced separately (fill/texture, size, elevation, sort)
 *    without touching the anchor;
 * 6. a repeated sync writes nothing — it is a strict no-op;
 * 7. when the whole group was deleted manually, the registry is cleared.
 *
 * @param {object} [scene]
 * @returns {Promise<boolean>}  True when the scene has a live widget.
 */
export async function syncSituationAspects(scene = canvas?.scene, options = {}) {
  if (!canRunSync(options)) return false;
  if (!scene) return false;

  // Coalesced structural passes: zone migration/cleanup + consequence
  // reconciliation share ONE working list and produce at most ONE flag write.
  // Each pass is isolated (a failure in one does not drop the other) and the
  // combined change is persisted once. Must run before drawing so the widget
  // reflects the final list, and must NOT import ConflictBoardSync (cycle).
  const rawFlag = scene?.getFlag?.(SITUATION_ASPECTS_SCOPE, SITUATION_ASPECTS_KEY);
  if (Array.isArray(rawFlag)) {
    let workingList = rawFlag;
    let structuralChanged = false;
    try {
      const res = migrateAndCleanSituationAspects(workingList, scene);
      if (res.changed) {
        workingList = res.list;
        structuralChanged = true;
      }
    } catch (err) {
      console.warn("[fate-on-the-table] situation aspect zone migration failed:", err);
    }
    try {
      const actors = collectSceneActors(scene);
      const { list, changed } = reconcileConsequences(workingList, actors);
      if (changed) {
        workingList = list;
        structuralChanged = true;
      }
    } catch (err) {
      console.warn("[fate-on-the-table] situation aspect consequence reconciliation failed:", err);
    }
    if (structuralChanged) {
      await scene.setFlag(SITUATION_ASPECTS_SCOPE, SITUATION_ASPECTS_KEY, workingList);
    }
  }

  const registry = saRegistry(scene);
  if (!registry?.widgetId) return false;

  const existing = saGroupDocs(scene, registry.widgetId);
  if (!existing.length) {
    await scene.unsetFlag(FLAG_SCOPE, SITUATION_ASPECTS_WIDGET_FLAG);
    return false;
  }

  const anchor = registry.anchor ?? { x: 0, y: 0 };
  const opts = getSituationAspectOptions();
  const desired = [
    buildSaFrameDoc(opts),
    buildSaBackgroundDoc(opts),
    ...buildSaTextDocs(situationAspects(scene), opts),
  ];

  const updates = [];
  const creations = [];
  const matched = new Set();
  for (const doc of desired) {
    const payload = toDocumentData(
      { ...doc, x: doc.x + anchor.x, y: doc.y + anchor.y },
      {
        widgetId: registry.widgetId,
        part: doc.part,
        index: doc.index,
        ownerType: SA_OWNER_TYPE,
      },
    );
    const current = existing.find(
      (d) => !matched.has(d.id) && partMatches(d, doc.part, doc.index),
    );
    if (!current) {
      creations.push(payload);
      continue;
    }
    matched.add(current.id);
    const delta = {};
    for (const field of SYNC_FIELDS) {
      const cur = foundry.utils.getProperty(current, field);
      const next = foundry.utils.getProperty(payload, field);
      if (cur !== next && next !== undefined) delta[field] = next;
    }
    if (Object.keys(delta).length) updates.push({ _id: current.id, ...delta });
  }

  // Every stored part that no desired part claimed is stale: surplus aspect
  // rows, the legacy combined-text drawing (index -1) and unknown parts.
  const staleIds = existing.filter((d) => !matched.has(d.id)).map((d) => d.id);

  const syncOptions = { fateOnTheTableSync: true };
  if (staleIds.length) {
    await safeDeleteEmbeddedDocuments(
      scene,
      "Drawing",
      existingDocumentIds(scene, "Drawing", staleIds),
      syncOptions,
    );
  }
  if (updates.length) {
    await scene.updateEmbeddedDocuments("Drawing", updates, syncOptions);
  }
  if (creations.length) {
    await scene.createEmbeddedDocuments("Drawing", creations);
  }
  return true;
}

/**
 * True when a stored document is the projection of one desired widget part.
 * Single parts (frame/background, `index` -1) match by part name; repeated
 * parts (one text drawing per aspect) must also match the `index` flag so
 * every aspect owns exactly its own document. A missing `index` flag counts
 * as -1 so an old single part is updated in place instead of recreated.
 * @param {object} doc  Stored Drawing document.
 * @param {string} part  Desired part name.
 * @param {number} index  Desired part index.
 * @returns {boolean}
 */
function partMatches(doc, part, index) {
  if (doc.getFlag(FLAG_SCOPE, "part") !== part) return false;
  const stored = Number(doc.getFlag(FLAG_SCOPE, "index"));
  return (Number.isFinite(stored) ? stored : -1) === Number(index ?? -1);
}

/**
 * Reads the board's live zone ids and name->id map via the pure schema.
 * No import of ConflictBoardSync (cycle-free).
 * @param {object} scene
 * @returns {{validIds: Set<string>, zoneNameToId: Record<string,string>}}
 */
function readBoardZoneInfo(scene) {
  const rawBoard = scene?.getFlag?.(FLAG_SCOPE, CONFLICT_BOARD_FLAG);
  if (rawBoard == null) return { validIds: new Set(), zoneNameToId: {} };
  let normalized = null;
  try {
    const res = normalizeConflictBoard(rawBoard);
    if (!res?.ok || !res?.normalized) return { validIds: new Set(), zoneNameToId: {} };
    normalized = res.normalized;
  } catch {
    return { validIds: new Set(), zoneNameToId: {} };
  }
  const zones = Array.isArray(normalized.zones) ? normalized.zones : [];
  const validIds = new Set(zones.map((z) => z?.id).filter((id) => typeof id === "string" && id));
  const zoneNameToId = {};
  for (const z of zones) {
    const n = String(z?.name ?? "").trim();
    if (!n) continue;
    if (zoneNameToId[n] === undefined) zoneNameToId[n] = z.id;
  }
  return { validIds, zoneNameToId };
}

function sceneCharacterNames(scene) {
  try {
    const tokens = scene?.tokens;
    if (!tokens) return new Set();
    const arr = toArray(tokens);
    const names = arr.map((t) => String(t?.name ?? "").trim()).filter((n) => n.length > 0);
    return new Set(names);
  } catch {
    return new Set();
  }
}

function collectSceneActors(scene) {
  try {
    const tokens = scene?.tokens;
    if (!tokens) return [];
    const arr = toArray(tokens);
    const seen = new Set();
    const out = [];
    for (const token of arr) {
      const actor = token?.actor;
      if (!actor) continue;
      const name = tokenActorName(token, actor);
      if (!name) continue;
      if (seen.has(name)) continue;
      seen.add(name);
      out.push({ name, tracks: actor.system?.tracks ?? {} });
    }
    return out;
  } catch {
    return [];
  }
}

function migrateAndCleanSituationAspects(inputList, scene) {
  if (!Array.isArray(inputList)) return { list: [], changed: false };
  const { validIds, zoneNameToId } = readBoardZoneInfo(scene);
  const characterNames = sceneCharacterNames(scene);

  let list = inputList;
  let changed = false;

  // 1) migrate textual zone suffixes -> structural zoneIds
  const mig = migrateZoneSuffixes(list, zoneNameToId, characterNames);
  if (mig.changed) {
    list = mig.list;
    changed = true;
  }

  // 2) clean dangling / duplicate / garbage zoneIds
  let cleanedList = [];
  let dangling = false;
  for (const aspect of list) {
    if (!aspect || typeof aspect !== "object") {
      cleanedList.push(aspect);
      continue;
    }
    const desired = normalizeZoneIds(aspect.zoneIds, validIds);
    const hasField = Object.prototype.hasOwnProperty.call(aspect, "zoneIds");
    const original = aspect.zoneIds;
    let needsUpdate = false;
    if (!hasField) {
      needsUpdate = desired.length > 0;
    } else if (!Array.isArray(original)) {
      needsUpdate = true;
    } else if (original.length !== desired.length) {
      needsUpdate = true;
    } else {
      for (let i = 0; i < original.length; i++) {
        if (original[i] !== desired[i]) {
          needsUpdate = true;
          break;
        }
      }
      // Also catch non-string entries that were filtered: if original contains non-string,
      // desired will have fewer entries, already caught by length check.
      // For original with same length but different ids (dangling removed and replaced? actually filtered)
      // the length check already covers invalid removal.
    }
    // Additional check: if hasField but original contains non-string values, the length check
    // would be same but desired filtered them, so lengths differ? Example [123,"z1"] length 2 vs desired ["z1"] length 1 => differ, so needsUpdate true.
    if (!needsUpdate) {
      cleanedList.push(aspect);
      continue;
    }
    dangling = true;
    if (desired.length === 0) {
      const copy = { ...aspect };
      delete copy.zoneIds;
      cleanedList.push(copy);
    } else {
      cleanedList.push({ ...aspect, zoneIds: desired });
    }
  }
  if (dangling) {
    list = cleanedList;
    changed = true;
  }

  return { list, changed };
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
      // Marked like every module-owned delete (see deleteWidgetDocsByIds in
      // ConflictBoardSync.js) so hooks never re-enter the sync.
      await safeDeleteEmbeddedDocuments(scene, "Drawing", existingDocumentIds(scene, "Drawing", docs.map((d) => d.id)), { fateOnTheTableSync: true });
      removed += docs.length;
    }
    await scene.unsetFlag(FLAG_SCOPE, SITUATION_ASPECTS_WIDGET_FLAG);
  }
  return removed > 0;
}
