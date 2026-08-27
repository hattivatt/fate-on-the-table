/**
 * ConflictInteractions — canvas/DOM interaction router for the conflict board
 * (feature 5, PLAN.md) and the API used by module.js integration hooks.
 *
 * Provides:
 *  - registerConflictInteractions() / unregisterConflictInteractions():
 *    idempotent lifecycle for the module's own canvas context-menu fallback
 *    AND the token-to-zone drag/drop wiring (see below).
 *  - handleConflictDocumentDoubleClick(document, event): opens the character
 *    sheet of the token/actor behind a `conflictCard` projection (linked AND
 *    unlinked tokens); never touches TokenDocument, ignores foreign docs.
 *  - handleConflictContextMenu(document, event): GM-only. A card offers the
 *    "Pass turn" action (only for a target that is not current and has not
 *    acted — executed immediately, WITHOUT a confirmation dialog) and/or the
 *    "Return turn" action (for a target marked `hasActed` that is not
 *    defeated/eliminated — it only clears the `fate-core-official.hasActed`
 *    flag through `ConflictManager.returnTurn`, the FU `unact` analogue, and
 *    never moves the turn marker); a zone offers localized "Rename" / "Remove"
 *    actions (delete asks for confirmation, clears `tokenZones` entries and
 *    re-syncs the projection); the central field offers "Add zone" and "New
 *    round" (with the documented constraints) plus a separated "Remove board"
 *    action, and board-level parts OUTSIDE the field (background, area labels,
 *    turn marker) offer the same "Remove board" action so a right-click on any
 *    board part is never a dead-end. "Remove board" asks for confirmation,
 *    then removes the whole module-owned board (background/areas, zone/card
 *    widgets, registry and state) through the serialized
 *    `ConflictBoardSync.removeConflictBoard` — never touching foreign
 *    Drawing/Tile or actor widgets. Turn actions are delegated to
 *    `ConflictManager.passTurn` / `ConflictManager.returnTurn` /
 *    `ConflictManager.newRound` through lazy import or the injectable
 *    `registerConflictManager` — never a static circular module import.
 *  - handleConflictCanvasContextMenu(point, scene): the same field menu from
 *    a raw canvas point (used by the DOM fallback / future F patches).
 *  - addZoneAtPoint(scene, point): name prompt (DialogV2) then a standard
 *    `PlacementManager.placeGroup` click-placement session with a FIXED zone
 *    rectangle whose size comes from `zonePlacementSize(state.sizePreset,
 *    geometry.field)` (pure geometry — the rect scales with the board preset:
 *    medium 150×120, small smaller, large bigger); the preview follows the
 *    mouse, left-click commits, right-click/Esc cancels. The zone rect is
 *    clamped into the central field and saved via `writeConflictBoard` +
 *    `syncConflictBoard`. The source `point` only validates that the menu was
 *    invoked inside the central field — the placement anchor is the current
 *    mouse position of the placement session. The scene-control zone editor
 *    (`ConflictZoneEditor` edit/draw mode) is never entered and its legacy
 *    `startZoneDraw` is not used.
 *  - handleTokenDropOnConflictZone(tokenDocument, point) and
 *    reconcileTokenZoneMembership(scene, tokenDocument): maintain ONLY the
 *    `tokenZones` membership of the conflict board; a drop additionally sets
 *    the TokenDocument x/y to a snap point inside the zone through the
 *    standard `tokenDocument.update`. Board-unrelated tokens/combatants are
 *    ignored; actor/actor-widget data is never touched.
 *  - Token drag/drop wiring: `registerConflictInteractions` patches
 *    `Token.prototype._onDragLeftDrop` (the stable Foundry v14 completion
 *    point of the native token drag flow) idempotently. While the GM has the
 *    zone editor active, a dragged board token's native destination is routed
 *    to the zone snap point (so the standard debounced TokenDocument.update
 *    lands inside the zone) and the `tokenZones` membership is written through
 *    `writeConflictBoard` + `syncConflictBoard`. Outside edit mode, for
 *    players, or for board-unrelated tokens the patch is a pure passthrough —
 *    normal token drag/vision/ownership/HUD are untouched, and the existing
 *    `updateToken` hook reconciliation remains the fallback.
 *  - hitTestConflictPart(point, scene) / isConflictDocument(doc): helpers for
 *    the routing patches and future F integration.
 *
 * GM rights are always checked explicitly. All paths no-op gracefully when
 * `game`, `canvas`, `ui` or `fromUuid` are absent. Coordinates come from the
 * normalized `conflictBoard` scene flag and the pure geometry engine — never
 * from the text/coordinates of foreign documents.
 */

import {
  MODULE_ID,
  FLAG_SCOPE,
  GM_FP_SCOPE,
  CONFLICT_ZONE_OWNER_TYPE,
  CONFLICT_CARD_OWNER_TYPE,
} from "./constants.js";
import {
  CONFLICT_BOARD_OWNER_TYPE,
  readConflictBoard,
  writeConflictBoard,
  syncConflictBoard,
  removeConflictBoard,
  boardRegistry,
} from "./ConflictBoardSync.js";
import { syncSituationAspects } from "./SituationAspectSync.js";
import {
  getConflictBoardGeometry,
  hitTestConflictZone,
  pointInRect,
  zonePlacementSize,
  zoneRectAtAnchor,
} from "./conflictBoardGeometry.js";
import { DEFAULT_ZONE_STYLE } from "./conflictBoardSchema.js";
import { widgetDocsByOwnerType } from "./widgetDocs.js";
import { PlacementManager } from "./PlacementManager.js";
import {
  isConflictEditModeActive,
  promptZoneName,
} from "./ConflictZoneEditor.js";
import {
  isConsequenceCostPart,
  handleConsequenceCostDoubleClick,
} from "./ConsequenceInteractions.js";

/** System flag scope + key carrying `hasActed` on Combatants. */
const SYSTEM_FLAG_SCOPE = GM_FP_SCOPE;
const HAS_ACTED_KEY = "hasActed";

/** The board-level ownerType of the projection (background/areas/labels). */
const CONFLICT_OWNER_TYPES = [
  CONFLICT_ZONE_OWNER_TYPE,
  CONFLICT_CARD_OWNER_TYPE,
  CONFLICT_BOARD_OWNER_TYPE,
];

/** Hit-test priority: cards > zones > board-level parts. */
const OWNER_PRIORITY = {
  [CONFLICT_CARD_OWNER_TYPE]: 3,
  [CONFLICT_ZONE_OWNER_TYPE]: 2,
  [CONFLICT_BOARD_OWNER_TYPE]: 1,
};
export { OWNER_PRIORITY as CONFLICT_OWNER_PRIORITY };

let registered = false;
let conflictManager = null;
let menuEl = null;

/* ------------------------------------------------------------------ *
 * Lifecycle (idempotent)
 * ------------------------------------------------------------------ */

/**
 * Registers the module's own canvas listeners (DOM right-click fallback for
 * conflict docs / central field). Safe to call multiple times.
 */
export function registerConflictInteractions() {
  if (registered) return;
  registered = true;
  Hooks.on("canvasReady", onCanvasReady);
  attachViewListener();
  patchTokenDragDrop();
}

/** Removes the listeners registered by `registerConflictInteractions`. */
export function unregisterConflictInteractions() {
  if (!registered) return;
  registered = false;
  Hooks.off("canvasReady", onCanvasReady);
  detachViewListener();
  closeMenu();
}

function onCanvasReady() {
  attachViewListener();
}

function attachViewListener() {
  const view = canvas?.app?.view;
  if (!view || view.dataset.cttConflictInteractions) return;
  view.dataset.cttConflictInteractions = "1";
  view.addEventListener("pointerdown", onConflictCanvasPointerDown);
  view.addEventListener("contextmenu", onConflictCanvasContextMenu);
}

function detachViewListener() {
  const view = canvas?.app?.view;
  if (!view || !view.dataset.cttConflictInteractions) return;
  delete view.dataset.cttConflictInteractions;
  view.removeEventListener("pointerdown", onConflictCanvasPointerDown);
  view.removeEventListener("contextmenu", onConflictCanvasContextMenu);
}

/* ------------------------------------------------------------------ *
 * Canvas DOM fallback for the context menus (right-click)
 * ------------------------------------------------------------------ */

function onConflictCanvasPointerDown(event) {
  if (event.button !== 2) return;
  if (isConflictEditModeActive()) return;
  if (PlacementManager.active) return;
  const scene = canvas?.scene;
  if (!scene) return;
  const point = canvasWorldPosition(event);
  if (!point) return;
  const doc = hitTestConflictPart(point, scene);
  if (doc) {
    // When the doc's own layer is active the PIXI patch path routes it
    // already — do not double-handle.
    const layerActive =
      doc.documentName === "Drawing"
        ? canvas.drawings?.active
        : canvas.tiles?.active;
    if (layerActive) return;
    event.preventDefault();
    event.stopPropagation();
    handleConflictContextMenu(doc, event);
    return;
  }
  const state = readConflictBoard(scene);
  if (!state) return;
  const local = worldToBoardPoint(state, point);
  const geometry = getBoardGeometry(state);
  if (!pointInRect(geometry.field, local)) return;
  if (tokenAtPoint(scene, point)) return;
  event.preventDefault();
  event.stopPropagation();
  handleConflictCanvasContextMenu(point, scene);
}

/** Prevents the native browser menu over handled conflict areas. */
function onConflictCanvasContextMenu(event) {
  if (menuEl) {
    event.preventDefault();
    return;
  }
  if (isConflictEditModeActive()) return;
  const scene = canvas?.scene;
  if (!scene) return;
  const point = canvasWorldPosition(event);
  if (!point) return;
  if (hitTestConflictPart(point, scene)) {
    event.preventDefault();
    return;
  }
  const state = readConflictBoard(scene);
  if (!state) return;
  const local = worldToBoardPoint(state, point);
  const geometry = getBoardGeometry(state);
  if (pointInRect(geometry.field, local)) event.preventDefault();
}

/* ------------------------------------------------------------------ *
 * Token <-> zone drag/drop wiring (Foundry v14 native drag completion)
 * ------------------------------------------------------------------ */

/**
 * Idempotently wraps `Token.prototype._onDragLeftDrop` — the stable point in
 * Foundry v13/v14 where a native token drag flow completes. The wrapper:
 *
 * 1. resolves the drop BEFORE the native handler so the native destination
 *    (and its standard debounced `TokenDocument.update`) is routed to the
 *    zone snap point;
 * 2. lets the native handler run untouched (token control/HUD/vision and the
 *    standard position update all keep working);
 * 3. afterwards updates ONLY the `tokenZones` membership through
 *    `handleTokenDropOnConflictZone`.
 *
 * The wrapper only acts while the module lifecycle is active, the user is the
 * GM and the zone editor is on; every other drag is a pure passthrough, so
 * ordinary token drag/vision/ownership/HUD are never affected. When this
 * completion point is unavailable (older/patched builds), the existing
 * `updateToken` hook reconciliation stays the fallback.
 */
function patchTokenDragDrop() {
  if (typeof Token === "undefined") return;
  const proto = Token.prototype;
  if (proto.__fateOnTheTableTokenDrag) return;
  proto.__fateOnTheTableTokenDrag = true;
  const original = proto._onDragLeftDrop;
  proto._onDragLeftDrop = function (event) {
    const drop = prepareConflictTokenDrop(this);
    if (drop) {
      try {
        if (this._dragData) {
          this._dragData.destination = {
            ...(this._dragData.destination ?? {}),
            x: drop.world.x,
            y: drop.world.y,
          };
        }
      } catch (err) {
        /* destination override is best-effort */
      }
    }
    const result = original ? original.call(this, event) : undefined;
    if (drop) {
      handleTokenDropOnConflictZone(this, drop.world).catch((err) =>
        console.error("[fate-on-the-table] conflict token drop failed:", err),
      );
    }
    return result;
  };
}

/**
 * Resolves the drop of a dragged board token for the patched
 * `Token._onDragLeftDrop` completion point. Returns `null` (pure passthrough)
 * unless the module lifecycle is active, the user is the GM, the zone editor
 * is on, the dragged object is a board token and a drag destination exists.
 * The returned `world` point is snapped into the zone when the drop lands in
 * one (board-local rect clamp mapped back through `board.origin`).
 * @param {object} token  Token placeable (with `_dragData`).
 * @returns {{world: {x: number, y: number}}|null}
 */
function prepareConflictTokenDrop(token) {
  if (!registered) return null;
  if (!game?.user?.isGM) return null;
  if (!isConflictEditModeActive()) return null;
  const scene = canvas?.scene;
  if (!scene) return null;
  const state = readConflictBoard(scene);
  if (!state) return null;
  if (!tokenBelongsToBoard(state, scene, token)) return null;
  const dest = token._dragData?.destination;
  if (!dest) return null;
  const geometry = getBoardGeometry(state);
  const local = worldToBoardPoint(state, dest);
  const hit = hitTestConflictZone(geometry, state.zones ?? [], local);
  let world = dest;
  if (hit?.type === "zone") {
    world = snapTokenDrop(state, hit.zone, local).world;
  }
  return { world };
}

/* ------------------------------------------------------------------ *
 * Helpers for the routing patches / future F integration
 * ------------------------------------------------------------------ */

/**
 * True for any module-owned conflict document (zone, card or board part).
 * @param {object} doc  Drawing/Tile document (or a placeable with `.document`).
 * @returns {boolean}
 */
export function isConflictDocument(doc) {
  const d = doc?.document ?? doc;
  if (!d?.getFlag) return false;
  const ownerType = d.getFlag(FLAG_SCOPE, "ownerType");
  return CONFLICT_OWNER_TYPES.includes(ownerType);
}

/**
 * The topmost module-owned conflict document under a world point, or null.
 * Cards rank above zones, zones above board-level parts; within one ownerType
 * the highest z wins. Never uses foreign document text/coordinates.
 * @param {{x: number, y: number}} point  World coordinates.
 * @param {object} scene  Scene document.
 * @returns {object|null}
 */
export function hitTestConflictPart(point, scene) {
  if (!point || !scene) return null;
  const candidates = [];
  for (const doc of widgetDocsByOwnerType(scene, CONFLICT_OWNER_TYPES)) {
    const isDrawing = doc.documentName === "Drawing";
    const w = isDrawing ? (doc.shape?.width ?? 0) : (doc.width ?? 0);
    const h = isDrawing ? (doc.shape?.height ?? 0) : (doc.height ?? 0);
    if (
      point.x >= doc.x &&
      point.x <= doc.x + w &&
      point.y >= doc.y &&
      point.y <= doc.y + h
    ) {
      const ownerType = doc.getFlag(FLAG_SCOPE, "ownerType");
      candidates.push({
        doc,
        priority: OWNER_PRIORITY[ownerType] ?? 0,
        z: (doc.elevation ?? 0) * 1000 + (doc.sort ?? 0),
        isDrawing,
      });
    }
  }
  if (!candidates.length) return null;
  // Owner priority is the PRIMARY key (conflictCard > conflictZone >
  // conflictBoard), so a zone always wins over the board field frame even if
  // the stored elevation/sort z-order were imperfect; within one ownerType
  // the highest z wins, drawings last.
  candidates.sort(
    (a, b) =>
      b.priority - a.priority ||
      b.z - a.z ||
      (b.isDrawing ? 1 : 0) - (a.isDrawing ? 1 : 0),
  );
  return candidates[0].doc;
}

/* ------------------------------------------------------------------ *
 * Document interactions
 * ------------------------------------------------------------------ */

/**
 * Double-click on a conflict document: opens the character sheet of the
 * token/actor behind a `conflictCard` projection (linked and unlinked tokens
 * resolved from the combatant token or the stored `tokenUuid`). Zones and
 * board-level parts are consumed without any action. Foreign docs return
 * false. Never changes the TokenDocument.
 * @param {object} document  Drawing/Tile document.
 * @param {Event|null} event  DOM/MIM event (optional).
 * @returns {Promise<boolean>}  True when the event was consumed.
 */
export async function handleConflictDocumentDoubleClick(document, event) {
  const doc = document?.document ?? document;
  if (!isConflictDocument(doc)) return false;
  event?.preventDefault?.();
  event?.stopPropagation?.();
  // Consequence cost rows are edited by double-click (consequence input),
  // never by opening the character sheet. This MUST run before the general
  // card double-click opens the sheet.
  if (isConsequenceCostPart(doc)) {
    await handleConsequenceCostDoubleClick(doc, event);
    return true;
  }
  if (doc.getFlag(FLAG_SCOPE, "ownerType") !== CONFLICT_CARD_OWNER_TYPE) {
    return true;
  }
  const scene = canvas?.scene;
  const state = scene ? readConflictBoard(scene) : null;
  if (!state) return true;
  const combatantId = doc.getFlag(FLAG_SCOPE, "combatantId");
  const tokenUuid = doc.getFlag(FLAG_SCOPE, "tokenUuid");
  const actor = await resolveCardActor(state, scene, combatantId, tokenUuid);
  const limited = limitedLevel();
  if (actor && game?.user && limited && actor.testUserPermission?.(game.user, limited)) {
    actor.sheet?.render?.(true);
  }
  return true;
}

/**
 * Context menu on a conflict document (GM-only). A card offers "Pass turn"
 * (only when the target is not current and has not acted — executed
 * immediately without confirmation) and/or "Return turn" (only for a target
 * marked `hasActed` that is not defeated/eliminated — it clears just the
 * `fate-core-official.hasActed` flag and never moves the turn marker); a zone
 * offers the localized "Rename" / "Remove" actions; the central field
 * (detected through the pure geometry, not foreign doc coordinates) offers
 * "Add zone" and "New round" with their constraints. Players always get the
 * event consumed without any menu.
 * @param {object} document  Drawing/Tile document.
 * @param {Event|null} event  DOM/MIM event (optional).
 * @returns {boolean}  True when the event was consumed.
 */
export function handleConflictContextMenu(document, event) {
  const doc = document?.document ?? document;
  if (!isConflictDocument(doc)) return false;
  event?.preventDefault?.();
  event?.stopPropagation?.();
  const scene = canvas?.scene;
  const state = scene ? readConflictBoard(scene) : null;
  const ownerType = doc.getFlag(FLAG_SCOPE, "ownerType");

  if (ownerType === CONFLICT_CARD_OWNER_TYPE) {
    return showCardContextMenu(doc, state, event);
  }
  if (ownerType === CONFLICT_ZONE_OWNER_TYPE) {
    return showZoneContextMenu(doc, state, event);
  }
  if (ownerType === CONFLICT_BOARD_OWNER_TYPE && state) {
    const point = worldPointFromEvent(event);
    const local = point ? worldToBoardPoint(state, point) : null;
    const geometry = getBoardGeometry(state);
    if (local && pointInRect(geometry.field, local)) {
      return showFieldContextMenu(state, geometry, event, point);
    }
    // Board-level parts outside the central field (background, area frames/
    // labels, turn marker): a dedicated "Remove board" menu so a right-click
    // on any board part is never a dead-end.
    return showBoardContextMenu(event);
  }
  return true;
}

/**
 * Context menu for the central field from a raw canvas point.
 * @param {{x: number, y: number}} point  World point (inside the field).
 * @param {object} scene  Scene document.
 * @returns {boolean}  True when the menu was shown.
 */
export function handleConflictCanvasContextMenu(point, scene) {
  if (!game?.user?.isGM) return false;
  if (!point || !scene) return false;
  const state = readConflictBoard(scene);
  if (!state) return false;
  const geometry = getBoardGeometry(state);
  const local = worldToBoardPoint(state, point);
  if (!pointInRect(geometry.field, local)) return false;
  return showFieldContextMenu(state, geometry, null, point);
}

/**
 * "Add zone" flow: asks for a name (DialogV2.input via the shared
 * `promptZoneName`), then runs a standard `PlacementManager.placeGroup`
 * click-placement session with a FIXED zone rectangle whose `{width, height}`
 * comes from `zonePlacementSize(state.sizePreset, geometry.field)` (see
 * conflictBoardGeometry.js — the rect scales with the board preset: medium
 * 150×120, small smaller, large bigger): the preview follows the mouse, a
 * left click commits, right-click/Esc cancel. The given `point` is used ONLY
 * to verify the menu was invoked inside the central field — the placement
 * anchor is the current mouse position of the placement session (never the
 * menu point). On commit the zone is saved with a stable random
 * id/name/default style/sort through `writeConflictBoard` +
 * `syncConflictBoard`; the rect is clamped into the central `geometry.field`.
 * `ConflictZoneEditor` edit/draw mode is never entered and its legacy
 * `startZoneDraw` is not used. Busy/cancel/error all resolve gracefully to
 * `false` without an unhandled rejection.
 * @param {object} scene  Scene document.
 * @param {{x: number, y: number}} point  World point inside the central field.
 * @returns {Promise<boolean>}  True when the zone was saved.
 */
export async function addZoneAtPoint(scene, point) {
  if (!game?.user?.isGM) return false;
  if (!scene || !point) return false;
  const state = readConflictBoard(scene);
  if (!state) return false;
  const geometry = getBoardGeometry(state);
  const local = worldToBoardPoint(state, point);
  if (!pointInRect(geometry.field, local)) {
    notifyError();
    return false;
  }
  // The SAME preset+field-derived {width, height} drives the preview bounds
  // and the committed rect, so what the GM sees is exactly what is saved.
  const placement = zonePlacementSize(state.sizePreset, geometry.field);
  const name = await promptZoneName();
  if (!name) return false;
  let committed = false;
  try {
    await PlacementManager.placeGroup({
      docs: [],
      bounds: {
        x: -placement.width / 2,
        y: -placement.height / 2,
        width: placement.width,
        height: placement.height,
      },
      label: name,
      options: {},
      hintKey: `${MODULE_ID}.conflict.zone.placeHint`,
      successKey: `${MODULE_ID}.conflict.zone.placeSuccess`,
      commit: async (anchor) => {
        committed = await commitZonePlacement(scene, name, anchor);
      },
    });
  } catch (err) {
    console.error("[fate-on-the-table] add zone placement failed:", err);
    notifyError();
    return false;
  }
  return committed;
}

/**
 * Placement commit for "Add zone": converts the world anchor to board-local
 * coordinates, clamps the preset-derived zone rect (from
 * `zonePlacementSize(state.sizePreset, geometry.field)` — the same
 * `{width, height}` as the placement preview) into the central
 * `geometry.field` and writes the new zone record through
 * `writeConflictBoard` + `syncConflictBoard` (the single serialized
 * projection API). Other zones, cards, tokenZones and the board itself are
 * never touched.
 * @param {object} scene  Target scene.
 * @param {string} name  Zone name (already validated).
 * @param {{x: number, y: number}} anchor  World placement anchor (rounded).
 * @returns {Promise<boolean>}  True when the zone was saved.
 */
export async function commitZonePlacement(scene, name, anchor) {
  if (!scene || !anchor) return false;
  const state = readConflictBoard(scene);
  if (!state) return false;
  const geometry = getBoardGeometry(state);
  const field = geometry.field;
  const origin = state.board?.origin ?? { x: 0, y: 0 };
  const local = {
    x: anchor.x - (origin.x ?? 0),
    y: anchor.y - (origin.y ?? 0),
  };
  const rect = zoneRectAtAnchor(field, local, zonePlacementSize(state.sizePreset, field));
  const zone = makeZoneRecord(name, rect, state);
  const written = await writeConflictBoard(
    scene,
    appendZoneToState(state, zone),
  );
  if (!written.ok) return false;
  await syncConflictBoard(scene);
  return true;
}

/**
 * Pure: a new zone record with a stable random id, the given name, the
 * default zone style and the next `sort` index (max existing sort + 1).
 * Never mutates the input state.
 * @param {string} name  Zone name.
 * @param {Rect} rect  Board-local zone rect (already clamped to the field).
 * @param {object} state  Conflict board state (`state.zones`).
 * @param {Function} [idGen]  Injectable id generator (tests).
 * @returns {{id: string, name: string, rect: Rect, style: object, sort: number}}
 */
export function makeZoneRecord(name, rect, state, idGen) {
  return {
    id: typeof idGen === "function" ? idGen() : zoneId(),
    name: name ?? "",
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    style: { ...DEFAULT_ZONE_STYLE },
    sort: nextZoneSort(state),
  };
}

/**
 * Pure: the next board state after appending a zone. Every other field
 * (board, cards, tokenZones, other zones) is untouched; the input is never
 * mutated.
 * @param {object} state  Conflict board state.
 * @param {object} zone  Zone record to append.
 * @returns {object}
 */
export function appendZoneToState(state, zone) {
  if (!state) return state;
  return { ...state, zones: [...(state.zones ?? []), zone] };
}

function nextZoneSort(state) {
  let max = -1;
  for (const zone of state?.zones ?? []) {
    if (typeof zone?.sort === "number" && zone.sort > max) max = zone.sort;
  }
  return max + 1;
}

function zoneId() {
  if (
    typeof foundry !== "undefined" &&
    typeof foundry?.utils?.randomID === "function"
  ) {
    return foundry.utils.randomID();
  }
  return `zone-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/* ------------------------------------------------------------------ *
 * Token <-> zone membership
 * ------------------------------------------------------------------ */

/**
 * Drop of a board token onto the conflict board: updates ONLY the
 * `tokenZones` membership and, when the drop lands in a zone, sets the
 * TokenDocument x/y to a snap point inside the zone through the standard
 * `tokenDocument.update`. Board-unrelated tokens are ignored; actor and
 * actor-widget data are never touched.
 * @param {object} tokenDocument  TokenDocument (or placeable with `.document`).
 * @param {{x: number, y: number}} point  World drop point.
 * @returns {Promise<{changed: boolean, moved: boolean, zoneId: string|null}>}
 */
export async function handleTokenDropOnConflictZone(tokenDocument, point) {
  const token = tokenDocument?.document ?? tokenDocument;
  if (!token || !point) return { changed: false, moved: false, zoneId: null };
  const scene = canvas?.scene;
  if (!scene) return { changed: false, moved: false, zoneId: null };
  const state = readConflictBoard(scene);
  if (!state) return { changed: false, moved: false, zoneId: null };
  if (!tokenBelongsToBoard(state, scene, token)) {
    return { changed: false, moved: false, zoneId: null };
  }
  const geometry = getBoardGeometry(state);
  const local = worldToBoardPoint(state, point);
  const hit = hitTestConflictZone(geometry, state.zones ?? [], local);
  const tokenUuid = token.uuid;
  const { nextZones, zoneId, changed } = applyTokenDropToZones(
    state,
    tokenUuid,
    hit,
  );
  let moved = false;

  if (hit?.type === "zone") {
    const { world } = snapTokenDrop(state, hit.zone, local);
    if (
      typeof token.update === "function" &&
      (world.x !== token.x || world.y !== token.y)
    ) {
      await token.update({ x: world.x, y: world.y });
      moved = true;
    }
  }

  if (changed) {
    await writeConflictBoard(scene, { ...state, tokenZones: nextZones });
    await syncConflictBoard(scene);
  }
  return { changed, moved, zoneId };
}

/**
 * Pure: the next `tokenZones` membership after a drop hit. On a zone hit the
 * token is assigned to the zone; on any other drop the entry is cleared.
 * Returns the changed map plus whether the membership actually changed and
 * the assigned zone id. Never mutates the input.
 * @param {object} state  Conflict board state.
 * @param {string} tokenUuid  Token UUID (`token.uuid`).
 * @param {{type: string, zoneId: string|null}} hit  `hitTestConflictZone` hit.
 * @returns {{nextZones: object, zoneId: string|null, changed: boolean}}
 */
export function applyTokenDropToZones(state, tokenUuid, hit) {
  const nextZones = { ...(state?.tokenZones ?? {}) };
  let zoneId = null;
  if (hit?.type === "zone") {
    zoneId = hit.zoneId;
    nextZones[tokenUuid] = zoneId;
  } else {
    delete nextZones[tokenUuid];
  }
  const changed = nextZones[tokenUuid] !== (state?.tokenZones ?? {})[tokenUuid];
  return { nextZones, zoneId, changed };
}

/**
 * Pure: the snap point of a zone drop. The board-local drop point is clamped
 * into the zone rect and mapped back through `board.origin` to a rounded world
 * point (the standard `TokenDocument.update` destination).
 * @param {object} state  Conflict board state (uses `state.board.origin`).
 * @param {object} zone  Zone record with `rect`.
 * @param {{x: number, y: number}} local  Board-local drop point.
 * @returns {{snap: {x, y}, world: {x: number, y: number}}}
 */
export function snapTokenDrop(state, zone, local) {
  const snap = snapPointInZone(zone?.rect, local);
  const world = boardToWorldPoint(state, snap);
  return { snap, world: { x: Math.round(world.x), y: Math.round(world.y) } };
}

/**
 * Reconciles the `tokenZones` membership of a board token after it moved
 * manually (wire to the `updateToken` hook of the integration module): the
 * token's center is hit-tested against the zones; when it left every zone the
 * assignment is removed. Only the board state flag is written — actor and
 * actor-widget are never touched.
 * @param {object} scene  Scene document.
 * @param {object} tokenDocument  TokenDocument (or placeable with `.document`).
 * @returns {Promise<{changed: boolean, zoneId: string|null}>}
 */
export async function reconcileTokenZoneMembership(scene, tokenDocument) {
  const token = tokenDocument?.document ?? tokenDocument;
  if (!scene || !token) return { changed: false, zoneId: null };
  const state = readConflictBoard(scene);
  if (!state) return { changed: false, zoneId: null };
  if (!tokenBelongsToBoard(state, scene, token)) {
    return { changed: false, zoneId: null };
  }
  const geometry = getBoardGeometry(state);
  const center = { x: token.x, y: token.y };
  const local = worldToBoardPoint(state, center);
  const hit = hitTestConflictZone(geometry, state.zones ?? [], local);
  const tokenUuid = token.uuid;
  const current = (state.tokenZones ?? {})[tokenUuid];

  if (hit?.type === "zone") {
    if (current === hit.zoneId) return { changed: false, zoneId: hit.zoneId };
    await writeConflictBoard(scene, {
      ...state,
      tokenZones: { ...(state.tokenZones ?? {}), [tokenUuid]: hit.zoneId },
    });
    await syncConflictBoard(scene);
    return { changed: true, zoneId: hit.zoneId };
  }
  if (current !== undefined) {
    const tokenZones = { ...(state.tokenZones ?? {}) };
    delete tokenZones[tokenUuid];
    await writeConflictBoard(scene, { ...state, tokenZones });
    await syncConflictBoard(scene);
    return { changed: true, zoneId: null };
  }
  return { changed: false, zoneId: null };
}

/**
 * True when the token belongs to the board's conflict: it maps to a combatant
 * of `state.combatId` that has a card on the board and a matching token id on
 * this scene. Everything else is ignored by the drop/reconcile paths.
 */
function tokenBelongsToBoard(state, scene, token) {
  if (!token || !state?.combatId || !scene) return false;
  const combat = resolveCombat(state, scene);
  if (!combat) return false;
  const cardIds = new Set(Object.keys(state.cards ?? {}));
  return combatantsOf(combat).some(
    (c) =>
      c?.id &&
      cardIds.has(c.id) &&
      c.tokenId === token.id &&
      (!c.sceneId || !scene.id || c.sceneId === scene.id),
  );
}

/* ------------------------------------------------------------------ *
 * Card sheet resolution
 * ------------------------------------------------------------------ */

async function resolveCardActor(state, scene, combatantId, tokenUuid) {
  const combat = resolveCombat(state, scene);
  if (combat) {
    const combatant = combatantOf(combat, combatantId);
    if (combatant) {
      const token = combatant.token;
      if (token?.actor) return token.actor;
      if (combatant.actor) return combatant.actor;
    }
  }
  if (typeof fromUuid === "function" && tokenUuid) {
    try {
      const token = await fromUuid(tokenUuid);
      return token?.actor ?? null;
    } catch (err) {
      return null;
    }
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Context menus
 * ------------------------------------------------------------------ */

function showCardContextMenu(doc, state, event) {
  if (!game?.user?.isGM) return true; // players never receive the menu
  if (!state) return true;
  const scene = canvas?.scene;
  const combat = resolveCombat(state, scene);
  if (!combat) return true;
  const targetCombatantId = doc.getFlag(FLAG_SCOPE, "combatantId");
  if (!targetCombatantId) return true;
  const combatant = combatantOf(combat, targetCombatantId);
  if (!combatant) return true; // orphan card — no actions
  const items = [];
  // "Pass turn": available target (not current, has not acted, not defeated).
  // Executed immediately — no DialogV2 confirmation on the card path.
  if (canPassTurnTo(targetCombatantId, combat, state)) {
    items.push({
      icon: "fa-forward",
      label: game.i18n.localize(`${MODULE_ID}.conflict.card.passTurn`),
      onClick: () => runCardTurnAction("passTurn", targetCombatantId),
    });
  }
  // "Return turn": acted target that is not defeated/eliminated — the FU
  // `unact` analogue. Clears only the hasActed flag; combat.turn/marker never
  // move (a current combatant with hasActed that sits on the side area is
  // still allowed — returning just clears the flag).
  if (hasActed(combatant) && !isCardDisqualified(state, combatant)) {
    items.push({
      icon: "fa-undo",
      label: game.i18n.localize(`${MODULE_ID}.conflict.card.returnTurn`),
      onClick: () => runCardTurnAction("returnTurn", targetCombatantId),
    });
  }
  if (!items.length) return true; // no valid actions — consume without a menu
  showMenu(items, event);
  return true;
}

function showFieldContextMenu(state, geometry, event, point) {
  if (!game?.user?.isGM) return false;
  const combat = resolveCombat(state, canvas?.scene);
  const canNewRound = canStartNewRound(combat);
  showMenu(
    [
      {
        icon: "fa-plus",
        label: game.i18n.localize(`${MODULE_ID}.conflict.zone.add`),
        onClick: () => addZoneAtPoint(canvas?.scene, point),
      },
      {
        icon: "fa-rotate-right",
        label: game.i18n.localize(`${MODULE_ID}.conflict.turn.newRound`),
        disabled: !canNewRound,
        onClick: () => runNewRound(),
      },
      {
        icon: "fa-trash",
        label: game.i18n.localize(`${MODULE_ID}.conflict.board.remove`),
        sep: true,
        onClick: () => removeBoardFromScene(canvas?.scene),
      },
    ],
    event,
    point,
  );
  return true;
}

/**
 * GM-only context menu for board-level parts OUTSIDE the central field
 * (background, area frames/labels, turn marker): a single localized "Remove
 * board" action with confirmation. Players get the event consumed with no
 * menu, so a right-click on any board part is never a dead-end.
 * @param {Event|null} event  DOM/MIM event (optional).
 * @returns {boolean}  True when the event was consumed.
 */
function showBoardContextMenu(event) {
  if (!game?.user?.isGM) return true; // players never receive the menu
  showMenu(
    [
      {
        icon: "fa-trash",
        label: game.i18n.localize(`${MODULE_ID}.conflict.board.remove`),
        onClick: () => removeBoardFromScene(canvas?.scene),
      },
    ],
    event,
  );
  return true;
}

/**
 * GM-only "Remove board" flow (wired from the central-field menu and from
 * every board-level part menu): asks for confirmation through
 * `foundry.applications.api.DialogV2.confirm`, then removes the WHOLE
 * module-owned conflict board of the scene — background/areas, zone/card
 * widgets, registry and state — through the serialized
 * `ConflictBoardSync.removeConflictBoard` (which waits for pending projection
 * syncs and deletes only registry-referenced widget ids, never by
 * coordinates/text and never foreign Drawing/Tile or actor widgets).
 * Cancelling the dialog changes nothing. Players can never reach this path.
 */
async function removeBoardFromScene(scene) {
  if (!game?.user?.isGM) return;
  if (!scene) return;
  if (
    typeof foundry === "undefined" ||
    !foundry?.applications?.api?.DialogV2?.confirm
  ) {
    return;
  }
  const confirmed = await foundry.applications.api.DialogV2.confirm({
    window: {
      title: game.i18n.localize(`${MODULE_ID}.conflict.board.removeTitle`),
    },
    content: game.i18n.localize(`${MODULE_ID}.conflict.board.removeConfirm`),
    rejectClose: false,
  });
  if (!confirmed) return;
  await removeConflictBoard(scene, { clearState: true });
  try {
    await syncSituationAspects(scene);
  } catch (err) {
    console.warn("[fate-on-the-table] situation aspects zone cleanup failed:", err);
  }
  if (typeof ui !== "undefined") {
    ui.notifications?.info?.(
      game.i18n.localize(`${MODULE_ID}.conflict.board.removed`),
    );
  }
}

/**
 * GM-only context menu for a zone projection: localized "Rename" (keeps the
 * stable id, prompts through DialogV2 with the current name pre-filled) and
 * "Remove" (asks for confirmation, then removes the zone from `conflictBoard`
 * state, clears its `tokenZones` entries and re-syncs — the projection docs
 * of the zone are deleted by the module's own reconcile, foreign
 * Drawing/Tile are never touched). Players get the event consumed with no
 * menu.
 * @param {object} doc  Zone Drawing/Tile document.
 * @param {object|null} state  Conflict board state.
 * @param {Event|null} event  DOM/MIM event (optional).
 * @returns {boolean}  True when the event was consumed.
 */
function showZoneContextMenu(doc, state, event) {
  if (!game?.user?.isGM) return true; // players never receive the menu
  if (!state) return true;
  const scene = canvas?.scene;
  if (!scene) return true;
  const zoneId = zoneIdForWidget(scene, doc.getFlag(FLAG_SCOPE, "widgetId"));
  const zone = zoneId
    ? (state.zones ?? []).find((z) => z?.id === zoneId)
    : null;
  if (!zone) return true;
  const name = String(zone.name ?? "");
  showMenu(
    [
      {
        icon: "fa-pen",
        label: game.i18n.localize(`${MODULE_ID}.conflict.zone.rename`),
        onClick: () => renameZone(scene, zoneId, name),
      },
      {
        icon: "fa-trash",
        label: game.i18n.localize(`${MODULE_ID}.conflict.zone.remove`),
        sep: true,
        onClick: () => removeZone(scene, zoneId, name),
      },
    ],
    event,
  );
  return true;
}

/** Resolves the stable zone id for a zone projection `widgetId`, or null. */
function zoneIdForWidget(scene, widgetId) {
  if (!scene || !widgetId) return null;
  const registry = boardRegistry(scene);
  const entry = Object.entries(registry?.zoneWidgetIds ?? {}).find(
    ([, widget]) => widget === widgetId,
  );
  return entry?.[0] ?? null;
}

/**
 * Renames a zone: only `zones[].name` of the `conflictBoard` state flag is
 * written (the stable id, rect, style, sort and every other field are kept)
 * and the projection is re-synced. GM-only; no-op when the zone is gone.
 */
async function renameZone(scene, zoneId, currentName) {
  const name = await promptZoneRename(currentName);
  if (!name) return;
  const state = readConflictBoard(scene);
  if (!state || !(state.zones ?? []).some((z) => z?.id === zoneId)) return;
  await writeConflictBoard(scene, renameZoneInState(state, zoneId, name));
  await syncConflictBoard(scene);
  if (typeof ui !== "undefined") {
    ui.notifications?.info?.(
      game.i18n.format(`${MODULE_ID}.conflict.zone.renamed`, { name }),
    );
  }
}

/**
 * Removes a zone after confirmation: writes ONLY `conflictBoard.zones`
 * (without the zone) and `conflictBoard.tokenZones` (entries pointing to the
 * zone removed), then re-syncs. The zone's own projection docs are deleted by
 * the module reconcile (`syncConflictBoard` → `reconcileConflictBoardProjection`),
 * never by coordinates/text, and foreign Drawing/Tile are untouched.
 */
async function removeZone(scene, zoneId, name) {
  if (
    typeof foundry === "undefined" ||
    !foundry?.applications?.api?.DialogV2?.confirm
  ) {
    return;
  }
  const state = readConflictBoard(scene);
  const zone = state?.zones?.find((z) => z?.id === zoneId);
  if (!state || !zone) return;
  const confirmed = await foundry.applications.api.DialogV2.confirm({
    window: {
      title: game.i18n.localize(`${MODULE_ID}.conflict.zone.removeTitle`),
    },
    content: game.i18n.format(`${MODULE_ID}.conflict.zone.removeConfirm`, {
      name: String(zone.name ?? "").trim() || String(name ?? "").trim(),
    }),
    rejectClose: false,
  });
  if (!confirmed) return;
  // Re-read the state so a change during the confirmation dialog is not lost.
  const current = readConflictBoard(scene);
  if (!current) return;
  await writeConflictBoard(scene, nextStateWithoutZone(current, zoneId));
  await syncConflictBoard(scene);
  try {
    await syncSituationAspects(scene);
  } catch (err) {
    console.warn("[fate-on-the-table] situation aspects zone cleanup failed:", err);
  }
  if (typeof ui !== "undefined") {
    ui.notifications?.info?.(
      game.i18n.localize(`${MODULE_ID}.conflict.zone.removed`),
    );
  }
}

/**
 * Pure: the next board state after deleting `zoneId` — the zone is removed
 * from `zones` and every `tokenZones` entry pointing at it is dropped. Every
 * other field (board, cards, other zones/zones' memberships, combatId) is
 * untouched. Never mutates the input.
 * @param {object} state  Conflict board state.
 * @param {string} zoneId  Stable zone id.
 * @returns {object}
 */
export function nextStateWithoutZone(state, zoneId) {
  if (!state || !zoneId) return state;
  const tokenZones = {};
  for (const [tokenUuid, currentZoneId] of Object.entries(
    state.tokenZones ?? {},
  )) {
    if (currentZoneId !== zoneId) tokenZones[tokenUuid] = currentZoneId;
  }
  return {
    ...state,
    zones: (state.zones ?? []).filter((z) => z?.id !== zoneId),
    tokenZones,
  };
}

/**
 * Pure: the next board state after renaming `zoneId` to `name`. Only the
 * zone's `name` changes — the stable id, rect, style, sort and every other
 * field, plus all other state, are kept. Never mutates the input.
 * @param {object} state  Conflict board state.
 * @param {string} zoneId  Stable zone id.
 * @param {string} name  New zone name.
 * @returns {object}
 */
export function renameZoneInState(state, zoneId, name) {
  if (!state || !zoneId) return state;
  return {
    ...state,
    zones: (state.zones ?? []).map((z) =>
      z?.id === zoneId ? { ...z, name } : z,
    ),
  };
}

/**
 * DialogV2 rename prompt reusing the existing `conflict.zone.*` i18n keys
 * (rename = title, namePrompt = label, nameEmpty = empty guard). The current
 * name is pre-filled. Uses `DialogV2.input` (in Foundry v14 `prompt()` returns
 * the pressed button id, not the form fields) and resolves with the trimmed
 * name or `null` on cancel/empty.
 * @param {string} currentName  Current zone name.
 * @returns {Promise<string|null>}
 */
export function promptZoneRename(currentName) {
  if (
    typeof foundry === "undefined" ||
    !foundry?.applications?.api?.DialogV2?.input
  ) {
    return Promise.resolve(null);
  }
  const current = escapeHtml(String(currentName ?? ""));
  return foundry.applications.api.DialogV2.input({
    window: {
      title: game.i18n.localize(`${MODULE_ID}.conflict.zone.rename`),
    },
    content: `<div class="form-group"><label for="ctt-zone-name">${escapeHtml(
      game.i18n.localize(`${MODULE_ID}.conflict.zone.namePrompt`),
    )}</label><input type="text" id="ctt-zone-name" name="name" value="${current}"></div>`,
    ok: { label: game.i18n.localize(`${MODULE_ID}.conflict.zone.rename`) },
    rejectClose: false,
  }).then((result) => {
    const name = String(dialogField(result, "name") ?? "").trim();
    if (!name) {
      if (typeof ui !== "undefined") {
        ui.notifications?.warn?.(
          game.i18n.localize(`${MODULE_ID}.conflict.zone.nameEmpty`),
        );
      }
      return null;
    }
    return name;
  });
}

async function runCardTurnAction(action, targetCombatantId) {
  const scene = canvas?.scene;
  const state = scene ? readConflictBoard(scene) : null;
  const combat = state ? resolveCombat(state, scene) : null;
  if (!combat) {
    notifyReason("noCombat");
    return;
  }
  const fn = await resolveTurnAction(action);
  if (!fn) {
    notifyReason("noCombat");
    return;
  }
  const result = await fn(combat, targetCombatantId, { scene });
  if (result?.ok === false) notifyReason(result.reason);
}

async function runNewRound() {
  const scene = canvas?.scene;
  const state = scene ? readConflictBoard(scene) : null;
  const combat = state ? resolveCombat(state, scene) : null;
  if (!combat) {
    notifyReason("noCombat");
    return;
  }
  const fn = await resolveTurnAction("newRound");
  if (!fn) {
    notifyReason("noCombat");
    return;
  }
  const result = await fn(combat, { scene });
  if (result?.ok === false) notifyReason(result.reason);
}

/**
 * Injects the ConflictManager facade (or an object with
 * `passTurn`/`returnTurn`/`newRound`) so turn actions never depend on a
 * static module import (no circular import).
 * @param {object|null} manager  e.g. `{ passTurn, returnTurn, newRound }` or
 *   the imported ConflictManager module namespace.
 */
export function registerConflictManager(manager) {
  conflictManager = manager ?? null;
}

/** Clears the injected ConflictManager reference. */
export function unregisterConflictManager() {
  conflictManager = null;
}

/**
 * Resolves `passTurn`/`returnTurn`/`newRound`: injected first, lazy import as
 * fallback.
 */
async function resolveTurnAction(action) {
  if (conflictManager && typeof conflictManager[action] === "function") {
    return conflictManager[action];
  }
  try {
    const mod = await import("./ConflictManager.js");
    if (typeof mod?.[action] === "function") return mod[action];
  } catch (err) {
    /* ConflictManager is not present yet — the caller must inject it. */
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Pure-ish combat state helpers (mirror ConflictManager's rules)
 * ------------------------------------------------------------------ */

function combatantsOf(combat) {
  if (Array.isArray(combat?.combatants)) return combat.combatants;
  if (Array.isArray(combat?.combatants?.contents)) return combat.combatants.contents;
  return [];
}

function combatantOf(combat, id) {
  return combatantsOf(combat).find((c) => c?.id === id) ?? null;
}

/**
 * The combatants in the SAME order the system indexes with
 * `game.combat.turns.indexOf(combatant)` (Fate Utilities) and the board
 * projection reads via `currentCombatantIdOf`: `combat.turns` first, with a
 * `combat.combatants` fallback. `combat.turn` is an index into this order.
 */
function combatantsInTurnOrder(combat) {
  if (Array.isArray(combat?.turns)) return combat.turns;
  if (Array.isArray(combat?.turns?.contents)) return combat.turns.contents;
  return combatantsOf(combat);
}

function currentCombatantId(combat) {
  const turn = combat?.turn;
  if (!Number.isInteger(turn) || turn < 0) return null;
  return combatantsInTurnOrder(combat)[turn]?.id ?? null;
}

function hasActed(combatant) {
  return !!combatant?.getFlag?.(SYSTEM_FLAG_SCOPE, HAS_ACTED_KEY);
}

function isAvailable(combatant) {
  return !!combatant && !combatant.defeated && !hasActed(combatant);
}

/**
 * Pass turn is offered only for a non-current target without `hasActed` that
 * is not disqualified (defeated, or a card sitting in the eliminated pile) —
 * the same guard as the "Return turn" action.
 */
function canPassTurnTo(targetCombatantId, combat, state) {
  if (!targetCombatantId || !combat) return false;
  if (targetCombatantId === currentCombatantId(combat)) return false;
  const combatant = combatantOf(combat, targetCombatantId);
  if (!combatant) return false;
  if (isCardDisqualified(state, combatant)) return false;
  return !hasActed(combatant);
}

/**
 * True when a card/combatant is disqualified from the "Return turn" action:
 * the combatant is defeated or the card sits in the eliminated pile. Return
 * turn is the FU `unact` analogue and is never offered for eliminated cards.
 */
function isCardDisqualified(state, combatant) {
  if (combatant?.defeated) return true;
  return state?.cards?.[combatant?.id]?.area === "eliminated";
}

/**
 * "New round" is enabled only when no combatant of the combat can still take
 * a turn (the current participant included) — same rule as
 * `ConflictManager.startNextRound` (`pendingTurns`).
 */
function canStartNewRound(combat) {
  if (!combat) return false;
  const combatants = combatantsOf(combat);
  if (!combatants.length) return false;
  return !combatants.some(isAvailable);
}

function resolveCombat(state, scene) {
  const combatId = state?.combatId;
  if (!combatId) return null;
  if (typeof game === "undefined" || !game?.combats?.get) return null;
  try {
    if (game.combat?.id === combatId) return game.combat;
    return game.combats.get(combatId) ?? null;
  } catch (err) {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

function getBoardGeometry(state) {
  return getConflictBoardGeometry({
    sizePreset: state?.sizePreset,
    boardSize: state?.board?.boardSize,
  });
}

function worldToBoardPoint(state, point) {
  const origin = state?.board?.origin ?? { x: 0, y: 0 };
  return { x: point.x - (origin.x ?? 0), y: point.y - (origin.y ?? 0) };
}

function boardToWorldPoint(state, point) {
  const origin = state?.board?.origin ?? { x: 0, y: 0 };
  return { x: point.x + (origin.x ?? 0), y: point.y + (origin.y ?? 0) };
}

function snapPointInZone(rect, point) {
  return {
    x: clamp(point.x, rect.x, rect.x + rect.width),
    y: clamp(point.y, rect.y, rect.y + rect.height),
  };
}

function clamp(value, lo, hi) {
  return Math.min(Math.max(value, lo), hi);
}

function limitedLevel() {
  if (typeof CONST === "undefined") return null;
  return CONST?.DOCUMENT_OWNERSHIP_LEVELS?.LIMITED ?? null;
}

function canvasWorldPosition(event) {
  if (!event?.clientX || !canvas?.app?.view) return null;
  try {
    const view = canvas.app.view;
    const rect = view.getBoundingClientRect();
    const x = (event.clientX - rect.left) * (view.width / rect.width);
    const y = (event.clientY - rect.top) * (view.height / rect.height);
    const world = canvas.stage.worldTransform.applyInverse(
      new PIXI.Point(x, y),
    );
    return { x: world.x, y: world.y };
  } catch (err) {
    return null;
  }
}

function worldPointFromEvent(event) {
  if (!event?.clientX) return null;
  return canvasWorldPosition(event);
}

function tokenAtPoint(scene, point) {
  try {
    const placeables = canvas?.tokens?.placeables ?? [];
    return [...placeables].some((placeable) => {
      if (typeof placeable.containsPoint === "function") {
        try {
          return placeable.containsPoint(point.x, point.y);
        } catch (err) {
          return false;
        }
      }
      const bounds = placeable.getBounds?.();
      if (bounds) {
        return (
          point.x >= bounds.x &&
          point.x <= bounds.x + bounds.width &&
          point.y >= bounds.y &&
          point.y <= bounds.y + bounds.height
        );
      }
      return false;
    });
  } catch (err) {
    return false;
  }
}

function menuPosition(event, point) {
  if (Number.isFinite(event?.clientX) && Number.isFinite(event?.clientY)) {
    return { clientX: event.clientX, clientY: event.clientY };
  }
  if (point && canvas?.app?.view) {
    try {
      const p = canvas.stage.worldTransform.apply(new PIXI.Point(point.x, point.y));
      const rect = canvas.app.view.getBoundingClientRect();
      return { clientX: rect.left + p.x, clientY: rect.top + p.y };
    } catch (err) {
      /* fall through */
    }
  }
  return { clientX: 0, clientY: 0 };
}

function showMenu(items, event, point) {
  closeMenu();
  const menu = document.createElement("div");
  menu.className = "ctt-conflict-menu";
  for (const item of items) {
    const btn = document.createElement("button");
    btn.type = "button";
    if (item.sep) btn.classList.add("ctt-conflict-menu-sep");
    if (item.disabled) btn.disabled = true;
    btn.innerHTML = `<i class="fas ${escapeHtml(item.icon)}"></i> ${escapeHtml(item.label)}`;
    btn.addEventListener("click", () => {
      closeMenu();
      if (!item.disabled && typeof item.onClick === "function") {
        Promise.resolve(item.onClick()).catch((err) =>
          console.error("[fate-on-the-table] conflict menu action failed:", err),
        );
      }
    });
    menu.append(btn);
  }
  if (!menu.childElementCount) return;
  document.body.append(menu);
  const rect = menu.getBoundingClientRect();
  const pos = menuPosition(event, point);
  menu.style.left = `${Math.min(pos.clientX, window.innerWidth - rect.width - 8)}px`;
  menu.style.top = `${Math.min(pos.clientY, window.innerHeight - rect.height - 8)}px`;
  menuEl = menu;
  window.addEventListener("pointerdown", onMenuPointerDown, true);
  window.addEventListener("keydown", onMenuKeyDown);
}

function closeMenu() {
  if (!menuEl) return;
  menuEl.remove();
  menuEl = null;
  window.removeEventListener("pointerdown", onMenuPointerDown, true);
  window.removeEventListener("keydown", onMenuKeyDown);
}

function onMenuPointerDown(event) {
  if (!menuEl) return;
  if (menuEl.contains(event.target)) return;
  closeMenu();
}

function onMenuKeyDown(event) {
  if (event.key === "Escape") closeMenu();
}

function notifyReason(reason) {
  if (typeof game === "undefined" || typeof ui === "undefined") return;
  ui.notifications?.warn?.(game.i18n.localize(reasonMessageKey(reason)));
}

function notifyError() {
  if (typeof game === "undefined" || typeof ui === "undefined") return;
  ui.notifications?.warn?.(
    game.i18n.localize(`${MODULE_ID}.conflict.error.generic`),
  );
}

function reasonMessageKey(reason) {
  switch (reason) {
    case "permission":
      return `${MODULE_ID}.conflict.permission.gmOnly`;
    case "noScene":
      return `${MODULE_ID}.conflict.error.noScene`;
    case "noCombat":
      return `${MODULE_ID}.conflict.error.noCombat`;
    case "notOnScene":
      return `${MODULE_ID}.conflict.error.notOnScene`;
    case "noTokens":
      return `${MODULE_ID}.conflict.error.noTokens`;
    case "noCurrentTurn":
    case "pendingTurns":
      return `${MODULE_ID}.conflict.turnState.notStarted`;
    case "noNextTurn":
    case "alreadyActed":
      return `${MODULE_ID}.conflict.turnState.complete`;
    case "notActed":
      return `${MODULE_ID}.conflict.turnState.notActed`;
    case "defeated":
      return `${MODULE_ID}.conflict.card.eliminated`;
    default:
      return `${MODULE_ID}.conflict.error.generic`;
  }
}

function escapeHtml(text) {
  return String(text ?? "").replace(/[&<>"']/g, (c) => {
    const map = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return map[c];
  });
}

/**
 * Reads a named field from a DialogV2.input() result. In Foundry v14 the
 * result is the submitted form data (a plain object keyed by the field `name`
 * attributes, or a FormData instance in some builds), the id of a non-ok
 * button (e.g. `"cancel"`), or `null` when the dialog was dismissed. Returns
 * the raw field value, or `undefined` when absent/cancelled.
 * @param {unknown} result  The DialogV2.input() resolution.
 * @param {string} name  The field `name` attribute to read.
 * @returns {string|number|File|null|undefined}
 */
function dialogField(result, name) {
  if (!result || typeof result !== "object") return undefined;
  if (typeof FormData !== "undefined" && result instanceof FormData) {
    return result.get(name);
  }
  return result[name];
}
