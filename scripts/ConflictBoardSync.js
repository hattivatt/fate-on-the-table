/**
 * ConflictBoardSync — scene-side projection and reconcile for the conflict
 * board scene flag `scene.flags["fate-on-the-table"].conflictBoard`
 * (feature 5, "Розыгрыш конфликта на столе", PLAN.md).
 *
 * This module turns the NORMALIZED conflict board state (schema v1,
 * `conflictBoardSchema.js`) into module-owned Drawing/Tile documents on a
 * scene and keeps them in sync with the board state, the combat it is bound
 * to (`combatId`) and the current turn (`game.combat.turn` +
 * `fate-core-official.hasActed`).
 *
 * ------------------------------------------------------------------
 * API contract for the next agents (ConflictManager C, ConflictInteractions D,
 * ConflictZoneEditor E)
 * ------------------------------------------------------------------
 *
 * All functions take the target scene EXPLICITLY. Combat / combatant / token
 * lookup goes through `options` with a safe runtime fallback to `game`:
 *
 * ```js
 * const opts = {
 *   combat,        // Combat document to project (optional). Used verbatim.
 *   combatants,    // Combatant[] (optional). Overrides combat.combatants.
 *   combatantIds,  // Set<string> (optional) + tokenUuids for a pre-computed
 *   tokenUuids,    //   availability set (skips scene/combat scanning).
 *   cardWidth, cardHeight, minSideWidth, minBottomHeight,  // geometry overrides
 *   fontFamily, textColor, fatePointImage, fatePointTileSize, fatePointStep,
 *   backgroundTexture,  // card build options (optional)
 *   clearState,    // removeConflictBoard/removeConflictBoardProjection: also
 *                  //   unset the state flag
 *   activeCombat,  // buildConflictBoardDocuments: combat driving the turn marker
 * };
 * ```
 *
 * Without options, `game.combat` (when it matches `state.combatId`) and the
 * scene's embedded tokens are used at runtime only; pure Node tests never
 * need `game`.
 *
 * Scene flag layout:
 * - `scene.flags["fate-on-the-table"].conflictBoard` — the board STATE
 *   (schema v1). Single source of geometry: origin, preset, optional frozen
 *   `boardSize`, background, zones, cards, tokenZones.
 * - `scene.flags["fate-on-the-table"].conflictBoardWidget` — the board
 *   REGISTRY `{ widgetId, zoneWidgetIds: {zoneId: widgetId}, cardWidgetIds:
 *   {combatantId: widgetId} }`. Every module-owned document carries
 *   `flags["fate-on-the-table"] = { widgetId, ownerType, part, index, ... }`.
 *
 * Document owner/part flags:
 * - board-level parts (background, area frames, area labels, turn marker):
 *   `{ widgetId, ownerType: "conflictBoard", part, index: -1|areaIndex }`;
 * - zone parts (body + label): per-zone `widgetId`, `ownerType:
 *   "conflictZone"`, `zoneId`, `part: "conflictZoneBody"|"conflictZoneLabel"`,
 *   `index: -1`. A separate widgetId per zone so dragging one zone never
 *   moves the others.
 * - card parts (minimal layout docs): per-card `widgetId`, `ownerType:
 *   "conflictCard"`, `part` = minimal-layout element id, `index` = layout
 *   index, plus `combatId`, `combatantId`, `tokenUuid`, `area`
 *   ("friendly"|"hostile"|"acted"|"eliminated"), the linked `actorUuid` when
 *   the combatant's token has one, and `trackKey` on `stressBoxRows` /
 *   `consequenceCostRows` parts for the click/double-click target mapping.
 *
 * Guarantees:
 * - The flag is normalized/validated through `conflictBoardSchema.js`; an
 *   absent or invalid flag never creates a board and never touches documents
 *   owned by anyone else.
 * - Diff/upsert is idempotent by `widgetId` + `ownerType` + `part#index`
 *   (same pattern as WidgetSync/SituationAspectSync) with batch
 *   create/update/delete on `scene.createEmbeddedDocuments` /
 *   `scene.updateEmbeddedDocuments` / `scene.deleteEmbeddedDocuments`.
 * - Every update initiated by this module passes `{ fateOnTheTableSync: true }`
 *   so widgetDrag/hooks never run a recursive reconcile.
 * - Foreign documents are never located or deleted by coordinates or text.
 * - Manual deletion guard: when the whole board projection is gone while the
 *   registry still exists, the registry is cleared (never auto-recreated).
 *   Individual missing parts are restored by the next explicit sync.
 * - State and registry are persisted only through `scene.update` (nested
 *   flag) / `scene.unsetFlag`.
 *
 * Removal:
 * - `removeConflictBoard(scene, options)` is the serialized removal: it chains
 *   behind every queued `syncConflictBoard` of the same scene, deletes the
 *   projection documents by registry widgetIds, clears the registry and (with
 *   `clearState: true`) the board state. A sync queued after the removal finds
 *   an empty registry/state and never resurrects the board.
 * - `removeConflictBoardProjection(scene, options)` is kept for API
 *   compatibility; it runs the same removal logic directly, outside the queue.
 */

import {
  FLAG_SCOPE,
  GM_FP_SCOPE,
  CONFLICT_BOARD_FLAG,
  CONFLICT_ZONE_OWNER_TYPE,
  CONFLICT_CARD_OWNER_TYPE,
  CONFLICT_BOARD_BACKGROUND_PART,
  CONFLICT_AREA_PART,
  CONFLICT_ZONE_BODY_PART,
  CONFLICT_ZONE_LABEL_PART,
  CONFLICT_ZONE_ASPECTS_PART,
  CONFLICT_TURN_MARKER_PART,
  SITUATION_ASPECTS_SCOPE,
  SITUATION_ASPECTS_KEY,
} from "./constants.js";
import {
  CONFLICT_ROUND_DIVIDER_PART as CONST_ROUND_DIVIDER,
  CONFLICT_ROUND_NUMBER_PART as CONST_ROUND_NUMBER,
} from "./constants.js";
import {
  normalizeConflictBoard,
  reconcileConflictBoard,
  applyCombatTurnStateToCards,
} from "./conflictBoardSchema.js";
import {
  getConflictBoardGeometry,
  layoutConflictCards,
  transformCardRect,
} from "./conflictBoardGeometry.js";
import { build, toDocumentData, stressBoxTarget, consequenceCostTarget } from "./WidgetBuilder.js";
import { getLayout } from "./layoutRegistry.js";
import { aspectsForZone } from "./situationAspectZones.js";
import { normalizeAspects } from "./situationAspectData.js";
import { toArray } from "./utils.js";

/** System flag scope carrying `hasActed` on Combatants. */
const SYSTEM_FLAG_SCOPE = GM_FP_SCOPE;
const HAS_ACTED_KEY = "hasActed";

function situationAspects(scene) {
  const raw = scene?.getFlag?.(SITUATION_ASPECTS_SCOPE, SITUATION_ASPECTS_KEY);
  return normalizeAspects(raw);
}

// ownerType of the board-level projection parts (background/areas/labels).
export const CONFLICT_BOARD_OWNER_TYPE = "conflictBoard";
// Scene registry flag of the board (widget id map, see header comment).
export const CONFLICT_BOARD_WIDGET_FLAG = "conflictBoardWidget";
// Part name of the area name labels (kept out of constants.js: local to the
// sync module, next agents may import it from here).
export const CONFLICT_AREA_LABEL_PART = "conflictAreaLabel";
// Round divider / number parts (canonical in constants.js, re-exported here).
export const CONFLICT_ROUND_DIVIDER_PART = CONST_ROUND_DIVIDER;
export const CONFLICT_ROUND_NUMBER_PART = CONST_ROUND_NUMBER;
// Re-export of the pure turn-state -> cards projection (live hasActed is the
// only source of truth; the board flag only caches the derived area).
export { applyCombatTurnStateToCards } from "./conflictBoardSchema.js";

/** Canonical labels drawn into the side board areas (bottom boxes have no labels). */
const AREA_LABELS = Object.freeze({
  friendly: "Friendly",
  hostile: "Hostile",
});

const DRAWING_FIELDS = [
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

const TILE_FIELDS = [
  "x",
  "y",
  "width",
  "height",
  "texture.src",
  "texture.anchorX",
  "texture.anchorY",
];

/* ------------------------------------------------------------------ *
 * Read / write of the scene flag (state + registry)
 * ------------------------------------------------------------------ */

/**
 * Reads and normalizes the conflict board state of a scene.
 * @param {object} scene
 * @returns {object|null}  Normalized schema-v1 state, or `null` when the
 *   flag is absent or invalid (an invalid flag never produces a board).
 */
export function readConflictBoard(scene) {
  if (!scene) return null;
  const raw = scene.getFlag(FLAG_SCOPE, CONFLICT_BOARD_FLAG);
  if (raw === undefined || raw === null) return null;
  const { ok, normalized } = normalizeConflictBoard(raw);
  return ok ? normalized : null;
}

/**
 * Writes the conflict board state to a scene, normalized through
 * `conflictBoardSchema.js`. Invalid input is rejected without writing.
 * @param {object} scene
 * @param {object} state  Schema-v1 (or raw) conflict board state.
 * @param {object} [options]  { fateOnTheTableSync: boolean (default true) }
 * @returns {Promise<{ok: boolean, errors: Array, scene: object|null,
 *   state?: object}>}
 */
export async function writeConflictBoard(scene, state, options = {}) {
  if (!scene) {
    return {
      ok: false,
      errors: [{ path: "$", message: "No scene.", severity: "error" }],
      scene: null,
    };
  }
  const { ok, errors, normalized } = normalizeConflictBoard(state);
  if (!ok) return { ok: false, errors, scene };
  await scene.update(
    { [`flags.${FLAG_SCOPE}.${CONFLICT_BOARD_FLAG}`]: normalized },
    { fateOnTheTableSync: options.fateOnTheTableSync ?? true },
  );
  return { ok: true, errors: [], scene, state: normalized };
}

/** The board registry record `{ widgetId, zoneWidgetIds, cardWidgetIds }`. */
export function boardRegistry(scene = null) {
  return scene?.getFlag(FLAG_SCOPE, CONFLICT_BOARD_WIDGET_FLAG) ?? null;
}

/**
 * True when the scene hosts a LIVE conflict board: the board state flag is
 * valid (readConflictBoard) AND the projection registry record carries a
 * `widgetId` — i.e. the board is actually placed on this scene. Same guard
 * shape as `hasActiveBoardForCombat` in module.js, without the combat
 * binding.
 * @param {object} scene
 * @returns {boolean}
 */
export function hasConflictBoardOnScene(scene) {
  return !!readConflictBoard(scene) && !!boardRegistry(scene)?.widgetId;
}

async function writeBoardState(scene, state) {
  await scene.update(
    { [`flags.${FLAG_SCOPE}.${CONFLICT_BOARD_FLAG}`]: state },
    { fateOnTheTableSync: true },
  );
  return scene;
}

async function writeBoardRegistry(scene, registry) {
  if (registry) {
    await scene.update(
      { [`flags.${FLAG_SCOPE}.${CONFLICT_BOARD_WIDGET_FLAG}`]: registry },
      { fateOnTheTableSync: true },
    );
  } else {
    await scene.unsetFlag(FLAG_SCOPE, CONFLICT_BOARD_WIDGET_FLAG, {
      fateOnTheTableSync: true,
    });
  }
  return scene;
}

async function clearBoardRegistry(scene) {
  return writeBoardRegistry(scene, null);
}

/* ------------------------------------------------------------------ *
 * Document lookup (module-owned only; never by coordinates/text)
 * ------------------------------------------------------------------ */

/**
 * All drawings/tiles of a widget group on a scene.
 * @param {object} scene
 * @param {string|null} widgetId  Widget id (or a Set of ids).
 * @param {string|null} ownerType  Optional ownerType filter.
 */
function docsOf(scene, widgetId, ownerType, widgetIds) {
  const set = widgetIds ?? (widgetId ? new Set([widgetId]) : null);
  return [...scene.drawings, ...scene.tiles].filter((d) => {
    if (set && !set.has(d.getFlag(FLAG_SCOPE, "widgetId"))) return false;
    if (ownerType && d.getFlag(FLAG_SCOPE, "ownerType") !== ownerType) return false;
    return true;
  });
}

/** Board-level projection docs (background, area frames, labels, marker). */
export function boardLevelDocs(scene, widgetId) {
  return docsOf(scene, widgetId, CONFLICT_BOARD_OWNER_TYPE);
}

/** Zone projection docs of one zone widget. */
export function zoneDocs(scene, widgetId) {
  return docsOf(scene, widgetId, CONFLICT_ZONE_OWNER_TYPE);
}

/** Card projection docs of one participant card widget. */
export function cardDocs(scene, widgetId) {
  return docsOf(scene, widgetId, CONFLICT_CARD_OWNER_TYPE);
}

/** Every module-owned conflict doc referenced by the registry. */
export function allConflictDocs(scene, registry) {
  return docsOf(scene, null, null, collectWidgetIds(registry));
}

function collectWidgetIds(registry) {
  const ids = new Set();
  if (registry?.widgetId) ids.add(registry.widgetId);
  for (const id of Object.values(registry?.zoneWidgetIds ?? {})) ids.add(id);
  for (const id of Object.values(registry?.cardWidgetIds ?? {})) ids.add(id);
  return ids;
}

/* ------------------------------------------------------------------ *
 * Combat / combatant resolution (explicit options win, runtime fallback
 * to `game` only when present)
 * ------------------------------------------------------------------ */

/**
 * Resolves the combat a board is bound to: an explicitly passed `options.combat`
 * first, then `game.combat` when it matches `state.combatId`, then the stored
 * combat in `game.combats`. Returns `null` when the combat is unknown/deleted
 * (in that case assignments are never wiped automatically).
 */
function resolveCombatForState(state, options = {}) {
  const combatId = state?.combatId;
  if (!combatId) return null;
  if (options.combat?.id === combatId) return options.combat;
  if (typeof game === "undefined") return null;
  try {
    if (game.combat?.id === combatId) return game.combat;
    return game.combats?.get(combatId) ?? null;
  } catch (err) {
    return null;
  }
}

/**
 * The combat driving the current-turn marker: only the ACTIVE combat bound to
 * the board, or an explicitly passed `options.combat`. An inactive/archived
 * combat never produces a stale marker.
 */
function resolveActiveCombat(state, options = {}) {
  if (options.combat?.id === state?.combatId) return options.combat;
  if (typeof game === "undefined") return null;
  return game?.combat?.id === state?.combatId ? game.combat : null;
}

function resolveCombatants(combat, options = {}) {
  if (Array.isArray(options.combatants)) return options.combatants;
  return toArray(combat?.combatants);
}

function combatantsOf(combat) {
  return toArray(combat?.combatants);
}

/**
 * The combatants array indexed by `combat.turn` in the SAME order the system
 * uses: `combat.turns` (the turn-order list Fate Utilities and the combat
 * tracker index into — `game.combat.turns.indexOf(combatant)`), with a
 * fallback to `combat.combatants` for plain/mocked combats.
 */
function combatantsInTurnOrder(combat) {
  if (Array.isArray(combat?.turns)) return combat.turns;
  if (Array.isArray(combat?.turns?.contents)) return combat.turns.contents;
  const extra = toArray(combat?.turns);
  if (extra.length && combat?.turns != null) return extra;
  return combatantsOf(combat);
}

/** True when the combatant has an actual TokenDocument on the scene. */
function isCombatantOnScene(combatant, scene) {
  if (!combatant || !scene) return false;
  if (combatant.sceneId && scene.id && combatant.sceneId !== scene.id) return false;
  if (!combatant.tokenId) return false;
  return !!scene.tokens?.get?.(combatant.tokenId);
}

/** Scene token UUID (`Scene.<id>.Token.<id>`) of a combatant, or null. */
function combatantTokenUuid(combatant, scene) {
  if (!combatant) return null;
  if (combatant.tokenId && scene?.tokens?.get) {
    const token = scene.tokens.get(combatant.tokenId);
    if (token?.uuid) return token.uuid;
  }
  return null;
}

/**
 * Availability set used by the pure `reconcileConflictBoard`: combatant ids
 * and token UUIDs of the board's combat that have a token on this scene, plus
 * the plain combatant descriptors (in combat order) needed to admit newcomer
 * cards (only for combatants with an actual token on the scene — combatants
 * without an available token are intentionally excluded, so no card is ever
 * created for them).
 */
function resolveAvailable(scene, combat, options = {}) {
  if (options.combatantIds && options.tokenUuids) {
    return {
      combatantIds: new Set(options.combatantIds),
      tokenUuids: new Set(options.tokenUuids),
      descriptors: Array.isArray(options.descriptors) ? options.descriptors : null,
    };
  }
  const combatantIds = new Set();
  const tokenUuids = new Set();
  const descriptors = [];
  const combatants = resolveCombatants(combat, options);
  const byId = new Map(
    combatantDescriptors(combatants).map((d) => [d.combatantId, d]),
  );
  for (const combatant of combatants) {
    if (!isCombatantOnScene(combatant, scene)) continue;
    combatantIds.add(combatant.id);
    const tokenUuid = combatantTokenUuid(combatant, scene);
    if (tokenUuid) tokenUuids.add(tokenUuid);
    const descriptor = byId.get(combatant.id);
    if (descriptor) descriptors.push(descriptor);
  }
  return { combatantIds, tokenUuids, descriptors };
}

/**
 * Plain `{ [combatantId]: hasActed }` map of a board's combatants, read from
 * the standard `fate-core-official.hasActed` flag. Combatants without an id
 * are skipped; unknown/missing flags count as `false`.
 */
function resolveCombatantTurnStates(combat, options = {}) {
  const states = {};
  for (const combatant of resolveCombatants(combat, options)) {
    if (!combatant?.id) continue;
    states[combatant.id] = !!combatant.getFlag?.(SYSTEM_FLAG_SCOPE, HAS_ACTED_KEY);
  }
  return states;
}

/**
 * Converts Foundry Combatant documents into the plain descriptors expected by
 * `assignInitialCardAreas` (conflictBoardSchema.js) at placement time.
 * @param {object[]} combatants
 * @returns {Array<{combatantId, id, hasPlayerOwner, disposition}>}
 */
export function combatantDescriptors(combatants) {
  const out = [];
  for (const c of combatants ?? []) {
    if (!c?.id) continue;
    out.push({
      combatantId: c.id,
      id: c.id,
      hasPlayerOwner: !!(c.actor?.hasPlayerOwner ?? false),
      disposition: c.token?.disposition,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Pure descriptor builders (board-local coordinates, tests cover these)
 * ------------------------------------------------------------------ */

/**
 * Board-level descriptors: background + area frames + area labels + round
 * divider/number. All coordinates are BOARD-LOCAL; the runtime adds
 * `state.board.origin`.
 * @param {object} state  Normalized conflict board state.
 * @param {object} geometry  Output of `getConflictBoardGeometry`.
 * @param {object|null} [activeCombat]  Combat driving the round number (round>=1).
 * @returns {object[]}
 */
export function buildBoardPartDescriptors(state, geometry, activeCombat = null) {
  // Support legacy call shape buildBoardPartDescriptors(state, geometry, {activeCombat})
  if (activeCombat && typeof activeCombat === "object" && !("round" in activeCombat) && "activeCombat" in activeCombat) {
    activeCombat = activeCombat.activeCombat ?? null;
  }
  const bg = state?.board?.background ?? {};
  const bounds = geometry?.bounds ?? { x: 0, y: 0, width: 0, height: 0 };
  const parts = [];

  parts.push({
    kind: "drawing",
    part: CONFLICT_BOARD_BACKGROUND_PART,
    index: -1,
    x: bounds.x,
    y: bounds.y,
    w: bounds.width,
    h: bounds.height,
    font: "Montserrat",
    size: 8,
    color: bg.color ?? "#ffffff",
    align: "left",
    stroke: 0,
    text: "",
    fillType: bg.texture ? 2 : 1, // PATTERN when textured, else SOLID
    fillColor: bg.color ?? "#ffffff",
    fillAlpha: clampAlpha(bg.alpha, 0.01),
    texture: bg.texture || null,
    elevation: -10,
    sort: -1000,
  });

  const bottomFriendly = geometry?.bottomFriendly ?? geometry?.acted ?? null;
  const bottomHostile = geometry?.bottomHostile ?? geometry?.eliminated ?? null;
  const areas = [
    ["friendly", geometry?.friendly],
    ["hostile", geometry?.hostile],
    ["bottomFriendly", bottomFriendly],
    ["bottomHostile", bottomHostile],
  ];
  const frameIndex = { friendly: 0, hostile: 1, bottomFriendly: 2, bottomHostile: 3, field: 4 };

  for (const [name, rect] of areas) {
    if (!rect) continue;
    parts.push(framePart(CONFLICT_AREA_PART, frameIndex[name], rect, -3, -300, 0.35, 1));
  }
  if (geometry?.field) {
    // stronger contrast border for the central field
    parts.push(framePart(CONFLICT_AREA_PART, frameIndex.field, geometry.field, -3, -300, 1, 2));
  }

  const labelAreas = [
    ["friendly", geometry?.friendly],
    ["hostile", geometry?.hostile],
  ];
  for (const [name, rect] of labelAreas) {
    if (!rect?.content) continue;
    parts.push({
      kind: "drawing",
      part: CONFLICT_AREA_LABEL_PART,
      index: frameIndex[name],
      x: rect.content.x,
      y: rect.y + rect.height - 22,
      w: rect.content.width,
      h: 16,
      font: "Montserrat",
      size: 14,
      color: "#000000",
      align: "center",
      stroke: 0,
      text: AREA_LABELS[name] ?? name,
      fillType: 0,
      fillColor: "#ffffff",
      fillAlpha: 0,
      texture: null,
      elevation: -2,
      sort: -200,
    });
  }

  // vertical divider in the middle of the bottom strip (always)
  if (bottomFriendly && bottomHostile) {
    const bottomY = bottomFriendly.y;
    const bottomH = bottomFriendly.height;
    const centerX = bottomFriendly.width; // totalW/2 since x=0
    // divider as a thin filled rectangle 2px wide centered on the split
    parts.push({
      kind: "drawing",
      part: CONFLICT_ROUND_DIVIDER_PART,
      index: -1,
      x: centerX - 1,
      y: bottomY,
      w: 2,
      h: bottomH,
      font: "Montserrat",
      size: 8,
      color: "#000000",
      align: "left",
      stroke: 0,
      strokeColor: "#000000",
      strokeAlpha: 1,
      fillType: 1,
      fillColor: "#000000",
      fillAlpha: 0.6,
      texture: null,
      elevation: -3,
      sort: -290,
      text: "",
    });

    // large round number centered on the bottom strip, under cards
    const roundNum = Number(activeCombat?.round);
    if (Number.isFinite(roundNum) && Number.isInteger(roundNum) && roundNum >= 1) {
      const preset = geometry?.sizePreset ?? state?.sizePreset ?? "medium";
      const fontSize = preset === "small" ? 48 : preset === "large" ? 64 : 56;
      const boxW = 100;
      const boxH = fontSize;
      const boxX = centerX - boxW / 2;
      const boxY = bottomY + (bottomH - boxH) / 2;
      parts.push({
        kind: "drawing",
        part: CONFLICT_ROUND_NUMBER_PART,
        index: -1,
        x: boxX,
        y: boxY,
        w: boxW,
        h: boxH,
        font: "Montserrat",
        size: fontSize,
        color: "#000000",
        align: "center",
        stroke: 0,
        text: String(roundNum),
        fillType: 0,
        fillColor: "#ffffff",
        fillAlpha: 0,
        texture: null,
        elevation: -2,
        sort: -200,
      });
    }
  }

  return parts;
}

function framePart(part, index, rect, elevation, sort, strokeAlpha, strokeWidth = 1) {
  return {
    kind: "drawing",
    part,
    index,
    x: rect.x,
    y: rect.y,
    w: rect.width,
    h: rect.height,
    font: "Montserrat",
    size: 8,
    color: "#000000",
    align: "left",
    stroke: strokeWidth,
    strokeColor: "#000000",
    strokeAlpha,
    fillType: 0,
    fillColor: "#ffffff",
    fillAlpha: 0,
    texture: null,
    elevation,
    sort,
    text: "",
  };
}

/**
 * Zone projection descriptors for one zone: a fill/stroke body and (when the
 * zone has a name) a label. Coordinates are BOARD-LOCAL.
 *
 * Layer order: the zone sits ABOVE the board-level field frame
 * (`elevation: -3, sort: -300`) and the area labels (`elevation: -2,
 * sort: -200`) — so a click/right-click on the zone never falls through to
 * the field — but BELOW the participant cards (`elevation: 0, sort: 0`) and
 * the turn marker (`elevation: 12, sort: 1200`), so the zone never covers
 * them. Fill/stroke/text stay fully visible at the raised elevation.
 * @param {object} state  Normalized conflict board state.
 * @param {object} geometry  Output of `getConflictBoardGeometry`.
 * @param {object} zone  Zone record `{ id, name, rect, style, sort }`.
 * @returns {object[]}
 */
export const ZONE_ASPECTS_LINE_HEIGHT = Math.round(14 * 1.25);
const ZONE_ASPECTS_TOP_OFFSET = 24;

/**
 * Pure text of the zone-aspects overlay: names of aspects bound to `zone`,
 * truncated to the free vertical space of the zone.
 *
 * @param {object[]} aspects  Full aspect list (or already filtered — filtering
 *   by `zone` is idempotent).
 * @param {object|string|null} zone  Zone record `{id, rect}` or zone id string.
 * @param {object} [opts]  `{ rect?: Rect, lineHeight?: number }` override for tests.
 * @returns {string}  "\n"-joined names, truncated with a final `+N` line when needed.
 */
export function zoneAspectsText(aspects, zone, opts = {}) {
  const lineHeight = Number(opts.lineHeight) > 0 ? Number(opts.lineHeight) : ZONE_ASPECTS_LINE_HEIGHT;
  let zoneId = null;
  let rect = null;
  if (typeof zone === "string") {
    zoneId = zone;
    rect = opts.rect ?? null;
  } else if (zone && typeof zone === "object") {
    zoneId = zone.id ?? opts.zoneId ?? null;
    rect = zone.rect ?? opts.rect ?? null;
  } else {
    rect = opts.rect ?? null;
  }
  // If opts carries an explicit rect but zone also has one, zone.rect wins (see above).
  // Fallback: opts may carry height directly when rect is not available.
  if (!rect && Number.isFinite(opts.height)) {
    rect = { height: Number(opts.height), width: Number(opts.width) || 0, x: 0, y: 0 };
  }
  let filtered = Array.isArray(aspects) ? aspects : [];
  if (zoneId) filtered = aspectsForZone(filtered, zoneId);
  const names = filtered
    .map((a) => String(a?.name ?? "").trim())
    .filter((n) => n.length > 0);
  if (names.length === 0) return "";
  if (!rect || !Number.isFinite(Number(rect.height))) {
    return names.join("\n");
  }
  const h = Number(rect.height);
  const available = h - ZONE_ASPECTS_TOP_OFFSET;
  const maxLines = Math.floor(available / lineHeight);
  if (maxLines <= 0) {
    return `+${names.length}`;
  }
  if (names.length <= maxLines) return names.join("\n");
  const keep = maxLines - 1;
  const remaining = names.length - keep;
  if (keep <= 0) return `+${names.length}`;
  const lines = names.slice(0, keep);
  lines.push(`+${remaining}`);
  return lines.join("\n");
}

/**
 * Zone projection descriptors for one zone: a fill/stroke body and (when the
 * zone has a name) a label, plus an optional aspects overlay.
 * Coordinates are BOARD-LOCAL.
 *
 * Layer order: the zone sits ABOVE the board-level field frame
 * (`elevation: -3, sort: -300`) and the area labels (`elevation: -2,
 * sort: -200`) — so a click/right-click on the zone never falls through to
 * the field — but BELOW the participant cards (`elevation: 0, sort: 0`) and
 * the turn marker (`elevation: 12, sort: 1200`), so the zone never covers
 * them. Fill/stroke/text stay fully visible at the raised elevation.
 * The aspects overlay (when present) renders at elevation -1 / sort -40
 * (above body -100 / label -50, below cards 0).
 * @param {object} state  Normalized conflict board state.
 * @param {object} geometry  Output of `getConflictBoardGeometry`.
 * @param {object} zone  Zone record `{ id, name, rect, style, sort }`.
 * @param {object[]} [zoneAspects]  Aspects bound to this zone (already filtered;
 *   when omitted the aspects part is omitted). Passing the FULL aspect list is
 *   also accepted — it will be filtered by `zone.id` internally.
 * @returns {object[]}
 */
export function buildZoneDescriptors(state, geometry, zone, zoneAspects) {
  const style = zone?.style ?? {};
  const rect = zone?.rect ?? { x: 0, y: 0, width: 0, height: 0 };
  const parts = [
    {
      kind: "drawing",
      part: CONFLICT_ZONE_BODY_PART,
      index: -1,
      x: rect.x,
      y: rect.y,
      w: rect.width,
      h: rect.height,
      font: "Montserrat",
      size: 8,
      color: style.stroke ?? "#000000",
      align: "left",
      stroke: 1,
      strokeColor: style.stroke ?? "#000000",
      strokeAlpha: 1,
      fillType: 1,
      fillColor: style.fill ?? "#ffffff",
      fillAlpha: clampAlpha(style.alpha, 0.01),
      texture: null,
      elevation: -1,
      sort: -100,
      text: "",
    },
  ];
  const name = String(zone?.name ?? "").trim();
  if (name) {
    parts.push({
      kind: "drawing",
      part: CONFLICT_ZONE_LABEL_PART,
      index: -1,
      x: rect.x + 4,
      y: rect.y + 4,
      w: Math.max(rect.width - 8, 0),
      h: 16,
      font: "Montserrat",
      size: 14,
      color: "#000000",
      align: "left",
      stroke: 0,
      text: name,
      fillType: 0,
      fillColor: "#ffffff",
      fillAlpha: 0,
      texture: null,
      elevation: -1,
      sort: -50,
    });
  }
  if (Array.isArray(zoneAspects) && zoneAspects.length > 0) {
    const text = zoneAspectsText(zoneAspects, zone);
    if (text) {
      parts.push({
        kind: "drawing",
        part: CONFLICT_ZONE_ASPECTS_PART,
        index: -1,
        x: rect.x + 4,
        y: rect.y + ZONE_ASPECTS_TOP_OFFSET,
        w: Math.max(rect.width - 8, 0),
        h: Math.max(rect.height - ZONE_ASPECTS_TOP_OFFSET, 0),
        font: "Montserrat",
        size: 14,
        color: "#000000",
        align: "left",
        stroke: 0,
        text,
        fillType: 0,
        fillColor: "#ffffff",
        fillAlpha: 0,
        texture: null,
        elevation: -1,
        sort: -40,
      });
    }
  }
  return parts;
}

/**
 * Id of the current combatant from a combat's `turn` index, or null. Resolves
 * through `combat.turns[turn]` first (the array Fate Utilities indexes with
 * `game.combat.turns.indexOf(combatant)`), falling back to
 * `combat.combatants[turn]`.
 * @param {object} combat
 * @returns {string|null}
 */
export function currentCombatantIdOf(combat) {
  const turn = combat?.turn;
  if (!Number.isInteger(turn) || turn < 0) return null;
  return (
    combatantsInTurnOrder(combat)[turn]?.id ??
    combatantsOf(combat)[turn]?.id ??
    null
  );
}

/** Active marker color: "currently acting", independent of `hasActed`. */
const TURN_MARKER_ACTIVE_COLOR = "#c62828";

/**
 * Current-turn marker descriptor: a frame drawn over the card of the current
 * combatant. `null` when there is no current turn or the combatant has no
 * card on the board. The marker is derived from `combat.turn` (via
 * `combat.turns[combat.turn]`, the Fate Utilities order) and ALWAYS uses the
 * active style — the acting combatant is `hasActed` AND current at the same
 * time (popcorn semantics), so the marker must not fall back to a passive
 * "acted" look. Nothing is written back to the board flag.
 * @param {object} state  Normalized conflict board state.
 * @param {object} geometry  Output of `getConflictBoardGeometry`.
 * @param {object} positions  Output of `layoutConflictCards(...).positions`.
 * @param {object|null} combat  Active combat (or plain `{ turn, turns|combatants }`).
 * @returns {object|null}
 */
export function buildTurnMarkerDescriptor(state, geometry, positions, combat) {
  if (!combat) return null;
  const combatantId = currentCombatantIdOf(combat);
  if (!combatantId) return null;
  const pos = positions?.[combatantId];
  if (!pos) return null;
  const pad = 4;
  return {
    kind: "drawing",
    part: CONFLICT_TURN_MARKER_PART,
    index: -1,
    x: pos.x - pad,
    y: pos.y - pad,
    w: pos.width + pad * 2,
    h: pos.height + pad * 2,
    font: "Montserrat",
    size: 8,
    color: TURN_MARKER_ACTIVE_COLOR,
    align: "left",
    stroke: 3,
    strokeColor: TURN_MARKER_ACTIVE_COLOR,
    strokeAlpha: 1,
    fillType: 0,
    fillColor: "#ffffff",
    fillAlpha: 0,
    texture: null,
    elevation: 12,
    sort: 1200,
    text: "",
  };
}

/* ------------------------------------------------------------------ *
 * Participant card adapter (minimal layout via WidgetBuilder)
 * ------------------------------------------------------------------ */

/**
 * Plain token-actor adapter consumed by the resolver catalog: name and
 * portrait come from the TOKEN (`combatant.token.name` /
 * `TokenDocument.name` and `combatant.token.texture.src`), everything else
 * from `combatant.token.actor`. Works for linked and unlinked tokens and
 * safely skips missing token/actor.
 * @param {object|null} token  TokenDocument (combatant.token).
 * @param {object|null} actor  Token actor (token.actor) or combatant actor.
 * @param {object|null} combatant
 * @returns {{name: string, img: string, system: object, items: object[]}}
 */
export function plainTokenActor(token, actor, combatant) {
  return {
    name: token?.name ?? combatant?.name ?? actor?.name ?? "",
    img: token?.texture?.src ?? actor?.img ?? "",
    system: actor?.system ?? {},
    items: actor?.items ?? [],
  };
}

/** Bounding box of built layout docs (used as the transform source rect). */
export function docsBounds(docs) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const d of docs ?? []) {
    const x = Number(d?.x) || 0;
    const y = Number(d?.y) || 0;
    const w = Number(d?.w) || 0;
    const h = Number(d?.h) || 0;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + w);
    maxY = Math.max(maxY, y + h);
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function cardBuildOptions(options = {}) {
  return {
    scale: 1,
    fontFamily: options.fontFamily ?? "",
    textColor: options.textColor ?? "",
    fatePointImage: options.fatePointImage ?? "",
    fatePointTileSize: options.fatePointTileSize ?? 70,
    fatePointStep: options.fatePointStep ?? 20,
    backgroundTexture: options.backgroundTexture ?? "",
  };
}

/**
 * Scales a card stroke with the fitted-card `t.scale`, keeping a positive
 * original line visible on small conflict cards.
 *
 * The minimal-layout stroke is `style.stroke.width * layoutScale` (for the
 * minimal layout that is a single scene pixel). On a small fitted card (e.g.
 * an acted/eliminated pile) `t.scale` shrinks that stroke to a sub-pixel
 * value that Foundry renders as (nearly) invisible — the empty stress /
 * consequence box borders then vanish entirely. A positive original line is
 * therefore nudged UP to a single visible scene unit when the scaled stroke
 * falls below a sub-pixel threshold, and is never dropped to zero. Zero /
 * absent strokes stay zero (boxes with an explicit 0 border, plain text
 * elements), so ordinary actor widgets and non-stroked parts are unaffected.
 * `strokeAlpha` and `fill` are left untouched.
 */
const MIN_VISIBLE_STROKE = 1;
const SUB_PIXEL_STROKE = 0.5;
function scaleCardStroke(stroke, scale) {
  if (!(stroke > 0)) return 0;
  const scaled = stroke * scale;
  return scaled < SUB_PIXEL_STROKE ? MIN_VISIBLE_STROKE : scaled;
}

/**
 * Builds the minimal-layout card descriptors for one participant, fitted and
 * centered into its board slot via `transformCardRect`. Coordinates are
 * BOARD-LOCAL. Font size scales with the fitted card.
 * @param {object} plainActor  Output of `plainTokenActor`.
 * @param {object} layout  Normalized "minimal" layout.
 * @param {object} position  Card slot from `layoutConflictCards().positions`.
 * @param {object} cardOpts  Card build options.
 * @returns {Promise<object[]>}
 */
export async function buildCardDescriptors(plainActor, layout, position, cardOpts) {
  let built;
  try {
    built = await build(plainActor, layout, cardOpts);
  } catch (err) {
    console.warn("[fate-on-the-table] conflict card build failed:", err);
    return [];
  }
  const docs = built?.docs ?? [];
  if (!docs.length) return [];
  const bounds = docsBounds(docs);
  if (bounds.width <= 0 || bounds.height <= 0) return [];
  const t = transformCardRect(bounds, position);
  return docs.map((d) => ({
    kind: d.kind,
    part: d.part,
    index: d.index ?? -1,
    x: (Number(d.x) || 0) * t.scale + t.dx,
    y: (Number(d.y) || 0) * t.scale + t.dy,
    w: (Number(d.w) || 0) * t.scale,
    h: (Number(d.h) || 0) * t.scale,
    src: d.src,
    textureAnchor: d.textureAnchor,
    font: d.font,
    size: (Number(d.size) || 0) * t.scale,
    color: d.color,
    align: d.align,
    weight: d.weight,
    // The descriptor bypasses layoutGeometry's own scaling for the fitted
    // card. The stroke follows the same t.scale as rect/font, and a positive
    // original line is floored up so small fitted cards keep their box
    // borders visible (see scaleCardStroke).
    stroke: scaleCardStroke(Number(d.stroke) || 0, t.scale),
    strokeColor: d.strokeColor,
    strokeAlpha: d.strokeAlpha,
    fillType: d.fillType,
    fillColor: d.fillColor,
    fillAlpha: d.fillAlpha,
    texture: d.texture,
    text: d.text ?? "",
    elevation: d.elevation ?? 0,
    sort: d.sort ?? 0,
  }));
}

/* ------------------------------------------------------------------ *
 * buildConflictBoardDocuments
 * ------------------------------------------------------------------ */

/**
 * Builds every module-owned descriptor set of the board projection from the
 * NORMALIZED state and the resolved combat. This is the single projection
 * builder: the flag is the only source of geometry (origin, preset, optional
 * frozen `boardSize`, background, zones, cards, tokenZones).
 *
 * @param {object} scene   Target scene.
 * @param {object} state   Normalized conflict board state.
 * @param {object|null} combat  Combat the board is bound to (for card
 *   combatants), already resolved against `state.combatId`.
 * @param {object} [options]  See header. `activeCombat` drives the turn
 *   marker (defaults to `combat`).
 * @returns {Promise<{
 *   geometry: object,
 *   positions: object,
 *   overflow: object[],
 *   board: object[],                     // board-level descriptors
 *   zones: Record<string, object[]>,     // zoneId -> descriptors
 *   cards: Record<string, object[]>      // combatantId -> descriptors (each
 *                                        //   descriptor carries `.flags`:
 *                                        //   combatId/combatantId/tokenUuid/
 *                                        //   area/actorUuid?, trackKey?)
 * }>}
 */
export async function buildConflictBoardDocuments(scene, state, combat, options = {}) {
  const geometry = getConflictBoardGeometry({
    sizePreset: state.sizePreset,
    boardSize: state.board?.boardSize,
    cardWidth: options.cardWidth,
    cardHeight: options.cardHeight,
    minSideWidth: options.minSideWidth,
    minBottomHeight: options.minBottomHeight,
  });
  const { positions, overflow } = layoutConflictCards(geometry, state);

  const activeCombat = options.activeCombat ?? combat;
  const board = buildBoardPartDescriptors(state, geometry, activeCombat);
  const marker = buildTurnMarkerDescriptor(
    state,
    geometry,
    positions,
    activeCombat,
  );
  if (marker) board.push(marker);

  const allZoneAspects = Array.isArray(options.aspects)
    ? options.aspects
    : (scene ? situationAspects(scene) : []);
  const zones = {};
  for (const zone of state.zones ?? []) {
    const filtered = aspectsForZone(allZoneAspects, zone.id);
    zones[zone.id] = buildZoneDescriptors(state, geometry, zone, filtered);
  }

  const cards = {};
  const byId = new Map(resolveCombatants(combat, options).map((c) => [c.id, c]));
  const layout = getLayout("minimal");
  const cardOpts = cardBuildOptions(options);
  for (const [combatantId, record] of Object.entries(state.cards ?? {})) {
    const position = positions[combatantId];
    if (!position) continue;
    const combatant = byId.get(combatantId);
    if (!combatant) continue;
    const tokenUuid = combatantTokenUuid(combatant, scene);
    if (!tokenUuid) continue;
    if (!layout) continue; // minimal layout not registered yet — skip cards
    const token = combatant.token;
    const actor = token?.actor ?? combatant.actor ?? null;
    const actorUuid = actor?.uuid ?? null;
    const descriptors = await buildCardDescriptors(
      plainTokenActor(token, actor, combatant),
      layout,
      position,
      cardOpts,
    );
    if (!descriptors.length) continue;
    // Every card part carries the conflict identity flags so the click /
    // double-click routing can resolve its token/actor. `actorUuid` is the
    // linked actor's document uuid when available (synthetic unlinked token
    // actors have no stable document uuid, so the caller falls back to
    // game.combats/combatant/tokenUuid). `trackKey` pins the exact track of a
    // stress/consequence-cost row so the handlers never re-derive the flat
    // index ordering against a possibly-changed actor config.
    cards[combatantId] = descriptors.map((d) => {
      const flags = {
        combatId: state.combatId,
        combatantId,
        tokenUuid,
        area: position.area,
      };
      if (actorUuid) flags.actorUuid = actorUuid;
      if (d.part === "stressBoxRows") {
        const tgt = stressBoxTarget(actor, Number(d.index ?? -1));
        if (tgt) flags.trackKey = tgt.trackKey;
      } else if (d.part === "consequenceCostRows") {
        const tgt = consequenceCostTarget(actor, Number(d.index ?? -1));
        if (tgt) flags.trackKey = tgt.trackKey;
      }
      return { ...d, flags };
    });
  }

  return { geometry, positions, overflow, board, zones, cards };
}

/* ------------------------------------------------------------------ *
 * Reconcile
 * ------------------------------------------------------------------ */

/**
 * Reconciles the board state and its projection against the live combat:
 *
 * - only combatants of the board's `combatId` with a token available on the
 *   scene are kept in `cards` and `tokenZones` (pure `reconcileConflictBoard`);
 * - orphan card/zone projections (registry widget ids whose zone/card is no
 *   longer in the reconciled state) are deleted — module-owned documents only;
 * - changed state is written back through `scene.update` (nested flag);
 * - the registry is pruned accordingly.
 *
 * When the board's combat cannot be resolved (deleted/unknown) assignments
 * are intentionally left untouched (no automatic cleanup on conflict end).
 * @param {object} scene
 * @param {object} [options]  See header (combat/combatants/availability).
 * @returns {Promise<{changed: boolean, state: object|null,
 *   removedCombatantIds: string[], removedTokenUuids: string[],
 *   removedZoneEntries: Array<{tokenUuid, zoneId}>, removedZoneIds: string[],
 *   admittedCombatantIds: string[]}>}
 */
export async function reconcileConflictBoardProjection(scene, options = {}) {
  if (!scene) {
    return {
      changed: false,
      state: null,
      removedCombatantIds: [],
      removedTokenUuids: [],
      removedZoneEntries: [],
      removedZoneIds: [],
      admittedCombatantIds: [],
    };
  }
  const registry = options.registry ?? boardRegistry(scene);
  const state = options.state ?? readConflictBoard(scene);
  if (!state || !registry?.widgetId) {
    return {
      changed: false,
      state,
      removedCombatantIds: [],
      removedTokenUuids: [],
      removedZoneEntries: [],
      removedZoneIds: [],
      admittedCombatantIds: [],
    };
  }

  const combat = options.combat !== undefined ? options.combat : resolveCombatForState(state, options);
  const explicitCombatants = Array.isArray(options.combatants);
  const hasCombat = !!combat || explicitCombatants;

  let nextState = state;
  let removedCombatantIds = [];
  let removedTokenUuids = [];
  let removedZoneEntries = [];
  let admittedCombatantIds = [];
  if (hasCombat) {
    const pure = reconcileConflictBoard(state, resolveAvailable(scene, combat, options));
    let next = pure.state;
    // Project the LIVE turn state onto `cards[].area` BEFORE the layout runs:
    // `fate-core-official.hasActed` (the only source of truth) decides whether
    // a card sits in its side area or in the acted pile; the current actor
    // (`combat.turn` -> `combat.turns[combat.turn]`, the Fate Utilities order)
    // always stays on its side even when `hasActed` is true (popcorn
    // semantics). The projected state is written back through
    // `writeBoardState` (scene.update + fateOnTheTableSync) — never through a
    // second source of truth.
    const turnStates = resolveCombatantTurnStates(combat, options);
    if (Object.keys(turnStates).length) {
      next = applyCombatTurnStateToCards(next, turnStates, {
        currentCombatantId: currentCombatantIdOf(combat),
      }).state;
    }
    nextState = next;
    removedCombatantIds = pure.removedCombatantIds;
    removedTokenUuids = pure.removedTokenUuids;
    removedZoneEntries = pure.removedZoneEntries;
    admittedCombatantIds = pure.admittedCombatantIds;
  }

  const stateChanged = !deepEqual(nextState, state);
  if (stateChanged) await writeBoardState(scene, nextState);

  // Orphan projection cleanup (module-owned docs only).
  const zoneIds = new Set((nextState.zones ?? []).map((z) => z.id));
  const removedZoneIds = [];
  const orphanZoneWidgetIds = new Set();
  const nextZoneWidgetIds = {};
  for (const [zoneId, widgetId] of Object.entries(registry.zoneWidgetIds ?? {})) {
    if (zoneIds.has(zoneId)) nextZoneWidgetIds[zoneId] = widgetId;
    else {
      removedZoneIds.push(zoneId);
      orphanZoneWidgetIds.add(widgetId);
    }
  }

  const orphanCardWidgetIds = new Set();
  const nextCardWidgetIds = {};
  for (const [combatantId, widgetId] of Object.entries(registry.cardWidgetIds ?? {})) {
    if (nextState.cards[combatantId]) nextCardWidgetIds[combatantId] = widgetId;
    else orphanCardWidgetIds.add(widgetId);
  }

  const removedDocs =
    (await deleteWidgetDocsByIds(scene, orphanZoneWidgetIds, CONFLICT_ZONE_OWNER_TYPE)) +
    (await deleteWidgetDocsByIds(scene, orphanCardWidgetIds, CONFLICT_CARD_OWNER_TYPE));

  let registryChanged = false;
  if (removedZoneIds.length || orphanCardWidgetIds.size) {
    await writeBoardRegistry(scene, {
      ...registry,
      zoneWidgetIds: nextZoneWidgetIds,
      cardWidgetIds: nextCardWidgetIds,
    });
    registryChanged = true;
  }

  return {
    changed: stateChanged || removedDocs > 0 || registryChanged,
    state: nextState,
    removedCombatantIds,
    removedTokenUuids,
    removedZoneEntries,
    removedZoneIds,
    admittedCombatantIds,
  };
}

/* ------------------------------------------------------------------ *
 * Sync (reconcile + project) — serialized per scene
 * ------------------------------------------------------------------ */

/**
 * Per-scene promise tails. `syncConflictBoard` chains every call for a given
 * scene behind the previous one so concurrent hook/manager invocations never
 * interleave their read-modify-write cycles: they cannot create two identical
 * marker Drawings, cannot update a Drawing after another call deleted it, and
 * a rejected call never breaks the chain for the next one. `removeConflictBoard`
 * chains into the SAME queue, so a removal always waits for every pending
 * sync and always runs before any sync queued after it.
 */
const syncQueues = new Map();

/**
 * Serialized entry point of the board sync. Every caller (module.js hooks,
 * ConflictManager.afterChange, placement commit, public API) MUST use this
 * function — never a private variant — so projection syncs for a single scene
 * are always ordered and idempotent.
 *
 * Returns a promise resolving with the same result shape as the underlying
 * sync. The queue keeps a swallowed tail so a rejection of one call does not
 * become an unhandled rejection and does not block the following calls.
 * @param {object} scene
 * @param {object} [options]  See header.
 * @returns {Promise<{ok: boolean, changed: boolean, state: object|null,
 *   registry: object|null, created: number, updated: number, deleted: number,
 *   overflow: object[], hasOverflow: boolean, manuallyDeleted?: boolean,
 *   removedCombatantIds: string[], removedZoneIds: string[]}>}
 */
export function syncConflictBoard(scene, options = {}) {
  if (!scene) {
    return Promise.resolve({ ok: false, changed: false, error: "No scene." });
  }
  const key = scene.id ?? scene.uuid ?? "unknown-scene";
  const previous = syncQueues.get(key) ?? Promise.resolve();
  const result = previous.then(() => syncConflictBoardNow(scene, options));
  // Swallow the chain tail: a failed sync must not unhandled-reject and must
  // not prevent the next queued sync from running.
  syncQueues.set(key, result.catch((err) => console.error("[fate-on-the-table] conflict board sync failed:", err)));
  return result;
}

/**
 * Full scene-side sync of a conflict board: reconciles the state against the
 * live combat, then idempotently upserts the projection documents (board
 * background/areas/labels/marker, per-zone bodies/labels, per-card minimal
 * widgets) in batches by `widgetId + ownerType + part#index`.
 *
 * Guards:
 * - absent/invalid flag: nothing is created, nothing foreign is deleted;
 * - no registry record: projection is never auto-created;
 * - registry exists but the whole projection is gone: treated as a manual
 *   deletion — the registry is cleared and sync returns (never recreated);
 *   the state is kept so an explicit re-place can restore the board;
 * - `options.forceProjection` (set only by the placement commit) skips that
 *   manual-deletion guard so the very first projection can be built;
 * - individual missing parts are restored by this sync.
 *
 * All writes are marked `fateOnTheTableSync: true`.
 * @param {object} scene
 * @param {object} [options]  See header.
 * @returns {Promise<{ok: boolean, changed: boolean, state: object|null,
 *   registry: object|null, created: number, updated: number, deleted: number,
 *   overflow: object[], hasOverflow: boolean, manuallyDeleted?: boolean,
 *   removedCombatantIds: string[], removedZoneIds: string[]}>}
 */
async function syncConflictBoardNow(scene, options = {}) {
  if (!scene) return { ok: false, changed: false, error: "No scene." };
  const registry = boardRegistry(scene);
  const state = readConflictBoard(scene);

  // No board state: nothing to project. A stale registry that also has no
  // projection documents is cleared so it is never auto-recreated.
  if (!state) {
    if (registry?.widgetId) {
      const docs = allConflictDocs(scene, registry);
      if (!docs.length) await clearBoardRegistry(scene);
    }
    return { ok: true, changed: false, state: null, registry: null };
  }

  // State present but no registry: the board was never placed (or its
  // placement was interrupted). Never auto-create a projection without an
  // explicit registry record.
  if (!registry?.widgetId) {
    return { ok: true, changed: false, state, registry: null };
  }

  // Manual whole-board deletion guard. Skipped when `options.forceProjection`
  // is set (the placement commit passes it): at that moment the registry has
  // just been written but no projection documents exist yet, so a premature
  // sync (e.g. from the updateScene hook fired by the registry write) must
  // NOT treat the missing projection as a manual deletion.
  const existingAll = allConflictDocs(scene, registry);
  if (!existingAll.length && !options.forceProjection) {
    await clearBoardRegistry(scene);
    return {
      ok: true,
      changed: false,
      state,
      registry: null,
      manuallyDeleted: true,
    };
  }

  const combat =
    options.combat !== undefined ? options.combat : resolveCombatForState(state, options);

  const rec = await reconcileConflictBoardProjection(scene, {
    ...options,
    state,
    registry,
    combat,
  });

  const nextState = readConflictBoard(scene) ?? state;
  const nextRegistry = boardRegistry(scene) ?? registry;

  // Stable widget ids for new zones/cards.
  const zoneWidgetIds = { ...(nextRegistry.zoneWidgetIds ?? {}) };
  const cardWidgetIds = { ...(nextRegistry.cardWidgetIds ?? {}) };
  let registryChanged = false;
  for (const zone of nextState.zones ?? []) {
    if (!zoneWidgetIds[zone.id]) {
      zoneWidgetIds[zone.id] = randomID();
      registryChanged = true;
    }
  }
  for (const combatantId of Object.keys(nextState.cards ?? {})) {
    if (!cardWidgetIds[combatantId]) {
      cardWidgetIds[combatantId] = randomID();
      registryChanged = true;
    }
  }
  const fullRegistry = { ...nextRegistry, zoneWidgetIds, cardWidgetIds };

  const activeCombat = resolveActiveCombat(nextState, options);
  // Fresh read of situation aspects on every sync — never cached, so a
  // rename / move / resize of a zone immediately refreshes the overlay.
  const zoneAspects = Array.isArray(options.aspects) ? options.aspects : situationAspects(scene);
  const built = await buildConflictBoardDocuments(scene, nextState, combat, {
    ...options,
    activeCombat,
    aspects: zoneAspects,
  });

  const origin = nextState.board?.origin ?? { x: 0, y: 0 };
  const ox = origin.x ?? 0;
  const oy = origin.y ?? 0;
  let created = 0;
  let updated = 0;
  let deleted = 0;

  const boardRes = await upsertParts(
    scene,
    boardLevelDocs(scene, fullRegistry.widgetId),
    built.board,
    fullRegistry.widgetId,
    CONFLICT_BOARD_OWNER_TYPE,
    { ox, oy },
  );
  created += boardRes.created;
  updated += boardRes.updated;
  deleted += boardRes.deleted;

  for (const zone of nextState.zones ?? []) {
    const widgetId = zoneWidgetIds[zone.id];
    if (!widgetId) continue;
    const res = await upsertParts(
      scene,
      zoneDocs(scene, widgetId),
      built.zones[zone.id] ?? [],
      widgetId,
      CONFLICT_ZONE_OWNER_TYPE,
      { ox, oy },
    );
    created += res.created;
    updated += res.updated;
    deleted += res.deleted;
  }

  for (const [combatantId, descriptors] of Object.entries(built.cards)) {
    const widgetId = cardWidgetIds[combatantId];
    if (!widgetId) continue;
    const res = await upsertParts(
      scene,
      cardDocs(scene, widgetId),
      descriptors,
      widgetId,
      CONFLICT_CARD_OWNER_TYPE,
      { ox, oy },
    );
    created += res.created;
    updated += res.updated;
    deleted += res.deleted;
  }

  if (registryChanged) await writeBoardRegistry(scene, fullRegistry);

  return {
    ok: true,
    changed: created > 0 || updated > 0 || deleted > 0 || rec.changed || registryChanged,
    state: nextState,
    registry: fullRegistry,
    created,
    updated,
    deleted,
    overflow: built.overflow,
    hasOverflow: built.overflow.length > 0,
    removedCombatantIds: rec.removedCombatantIds,
    removedZoneIds: rec.removedZoneIds,
    admittedCombatantIds: rec.admittedCombatantIds,
  };
}

/* ------------------------------------------------------------------ *
 * Removal
 * ------------------------------------------------------------------ */

/**
 * Removes the board projection (all board/zone/card documents + the scene
 * registry). By default the board STATE flag is kept so an explicit re-place
 * can restore the board; pass `{ clearState: true }` to also unset it.
 *
 * Kept for API compatibility with callers that deliberately bypass the sync
 * queue (tests / legacy integration). New callers that must be ordered
 * against pending projection syncs should use the serialized
 * `removeConflictBoard` instead — this function runs immediately and is not
 * queued, so a concurrent `syncConflictBoard` could still be mid-write.
 * @param {object} scene
 * @param {object} [options]  { clearState: boolean }
 * @returns {Promise<{removed: number, changed: boolean}>}
 */
export async function removeConflictBoardProjection(scene, options = {}) {
  return removeConflictBoardNow(scene, options);
}

/**
 * Serialized removal of the whole conflict board (projection documents +
 * scene registry and, with `clearState: true`, the board state flag).
 *
 * Runs through the SAME per-scene queue as `syncConflictBoard`: it starts
 * only after every already-queued sync of the scene has settled (so a
 * projection sync is never deleted mid-write) and every sync queued after the
 * removal (e.g. from the updateScene hook fired by our own registry/state
 * unset) finds an empty registry/state and cannot resurrect the board.
 *
 * Deletes ONLY documents whose `widgetId` is referenced by the board registry
 * (board widget, zone widgets, card widgets) — never by coordinates or text,
 * and never foreign Drawing/Tile or actor widgets. All module-owned writes
 * are marked `fateOnTheTableSync` where the API allows it.
 * @param {object} scene
 * @param {object} [options]  { clearState: boolean }
 * @returns {Promise<{removed: number, changed: boolean, error?: string}>}
 */
export function removeConflictBoard(scene, options = {}) {
  if (!scene) {
    return Promise.resolve({ removed: 0, changed: false, error: "No scene." });
  }
  const key = scene.id ?? scene.uuid ?? "unknown-scene";
  const previous = syncQueues.get(key) ?? Promise.resolve();
  const result = previous.then(() => removeConflictBoardNow(scene, options));
  // Same tail discipline as syncConflictBoard: a rejected removal must not
  // unhandled-reject and must not block the next queued operation.
  syncQueues.set(key, result.catch(() => {}));
  return result;
}

async function removeConflictBoardNow(scene, options = {}) {
  if (!scene) return { removed: 0, changed: false };
  const registry = boardRegistry(scene);
  let removed = 0;
  if (registry?.widgetId) {
    removed += await deleteWidgetDocsByIds(
      scene,
      collectWidgetIds(registry),
      null,
      { fateOnTheTableSync: true },
    );
  }
  await clearBoardRegistry(scene);
  if (options.clearState) {
    await scene.unsetFlag(FLAG_SCOPE, CONFLICT_BOARD_FLAG, {
      fateOnTheTableSync: true,
    });
  }
  return { removed, changed: removed > 0 || !!registry };
}

/* ------------------------------------------------------------------ *
 * Batch upsert / delete helpers (runtime)
 * ------------------------------------------------------------------ */

/**
 * Idempotent diff/upsert of one widget group: creates missing parts, updates
 * changed parts and deletes extra parts, each in a single batch per document
 * type. Keyed by `widgetId + ownerType + part#index`; foreign documents are
 * never touched.
 * @param {object} scene
 * @param {object[]} existing  Current module-owned docs of the widget group.
 * @param {object[]} descriptors  Target descriptors (BOARD-LOCAL coords).
 * @param {string} widgetId
 * @param {string} ownerType
 * @param {object} [opts]  { ox, oy } origin offset.
 * @returns {Promise<{created: number, updated: number, deleted: number}>}
 */
async function upsertParts(scene, existing, descriptors, widgetId, ownerType, opts = {}) {
  const ox = opts.ox ?? 0;
  const oy = opts.oy ?? 0;
  const extraFlags = opts.extraFlags ?? {};

  const target = new Map();
  for (const doc of descriptors ?? []) {
    target.set(`${doc.part}#${doc.index ?? -1}`, doc);
  }

  const byKey = new Map();
  for (const doc of existing) {
    const part = doc.getFlag(FLAG_SCOPE, "part");
    const index = doc.getFlag(FLAG_SCOPE, "index") ?? -1;
    byKey.set(`${part}#${index}`, doc);
  }

  const updates = { Drawing: [], Tile: [] };
  const creations = { Drawing: [], Tile: [] };
  const deletions = { Drawing: [], Tile: [] };

  for (const [key, doc] of target) {
    const payload = toDocumentData(
      { ...doc, x: (doc.x ?? 0) + ox, y: (doc.y ?? 0) + oy },
      {
        widgetId,
        part: doc.part,
        index: doc.index ?? -1,
        ownerType,
        ...(doc.flags ?? {}),
        ...extraFlags,
      },
    );
    const existingDoc = byKey.get(key);
    if (existingDoc) {
      const kind = existingDoc.documentName === "Tile" ? "Tile" : "Drawing";
      const fields = kind === "Tile" ? TILE_FIELDS : DRAWING_FIELDS;
      const delta = diff(existingDoc, payload, fields);
      if (Object.keys(delta).length) {
        updates[kind].push({ _id: existingDoc.id, ...delta });
      }
      byKey.delete(key);
    } else {
      creations[doc.kind === "tile" ? "Tile" : "Drawing"].push(payload);
    }
  }

  for (const doc of byKey.values()) {
    deletions[doc.documentName === "Tile" ? "Tile" : "Drawing"].push(doc.id);
  }

  const syncOptions = { fateOnTheTableSync: true };
  if (updates.Drawing.length) {
    await scene.updateEmbeddedDocuments("Drawing", updates.Drawing, syncOptions);
  }
  if (updates.Tile.length) {
    await scene.updateEmbeddedDocuments("Tile", updates.Tile, syncOptions);
  }
  if (deletions.Drawing.length) {
    await scene.deleteEmbeddedDocuments("Drawing", deletions.Drawing, syncOptions);
  }
  if (deletions.Tile.length) {
    await scene.deleteEmbeddedDocuments("Tile", deletions.Tile, syncOptions);
  }
  if (creations.Drawing.length) {
    await scene.createEmbeddedDocuments("Drawing", creations.Drawing);
  }
  if (creations.Tile.length) {
    await scene.createEmbeddedDocuments("Tile", creations.Tile);
  }

  return {
    created: creations.Drawing.length + creations.Tile.length,
    updated: updates.Drawing.length + updates.Tile.length,
    deleted: deletions.Drawing.length + deletions.Tile.length,
  };
}

/**
 * Deletes module-owned docs by widget id (optionally filtered by ownerType).
 * All writes carry `options` (the module marks its own deletes
 * `fateOnTheTableSync: true` so hooks never re-enter the sync).
 */
async function deleteWidgetDocsByIds(scene, widgetIds, ownerType, options = {}) {
  if (!widgetIds?.size) return 0;
  const drawIds = [];
  const tileIds = [];
  for (const doc of scene.drawings) {
    if (
      widgetIds.has(doc.getFlag(FLAG_SCOPE, "widgetId")) &&
      (!ownerType || doc.getFlag(FLAG_SCOPE, "ownerType") === ownerType)
    ) {
      drawIds.push(doc.id);
    }
  }
  for (const doc of scene.tiles) {
    if (
      widgetIds.has(doc.getFlag(FLAG_SCOPE, "widgetId")) &&
      (!ownerType || doc.getFlag(FLAG_SCOPE, "ownerType") === ownerType)
    ) {
      tileIds.push(doc.id);
    }
  }
  if (drawIds.length) await scene.deleteEmbeddedDocuments("Drawing", drawIds, options);
  if (tileIds.length) await scene.deleteEmbeddedDocuments("Tile", tileIds, options);
  return drawIds.length + tileIds.length;
}

function diff(existing, payload, fields) {
  const delta = {};
  for (const field of fields) {
    const cur = foundry.utils.getProperty(existing, field);
    const next = foundry.utils.getProperty(payload, field);
    if (cur !== next && next !== undefined) delta[field] = next;
  }
  return delta;
}

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

function clampAlpha(value, floor = 0.01) {
  const n = Number(value);
  if (!Number.isFinite(n)) return floor;
  return Math.min(1, Math.max(floor, n));
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (a && typeof a === "object") {
    if (!b || typeof b !== "object" || Array.isArray(b)) return false;
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

function randomID() {
  if (typeof foundry !== "undefined" && typeof foundry.utils?.randomID === "function") {
    return foundry.utils.randomID();
  }
  return `cb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
