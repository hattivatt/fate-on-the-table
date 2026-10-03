/**
 * widgetInteractionRouter — pure, Foundry-free routing table for the module's
 * canvas widget interactions.
 *
 * The module has two event paths that MUST behave identically:
 *  - the PIXI placeable patches (`Drawing`/`Tile` `_onClickLeft2` /
 *    `_onClickRight` / `_onClickLeft`), which Foundry only dispatches while the
 *    document's own canvas layer is active;
 *  - the DOM canvas fallback, which receives every pointer event regardless of
 *    the active layer (players usually sit on the token layer and can never
 *    activate the drawing/tile layers).
 *
 * Both paths ask this module which route a widget document takes; the thin
 * Foundry dispatcher (`routeWidgetInteractions` in FatePointManager.js) then
 * calls the one matching handler. Keeping the decision pure and shared
 * prevents the two paths from drifting apart — an actor widget never opens a
 * different menu depending on the active layer.
 *
 * No `foundry` / `game` / `canvas` / `CONST` access at import time. Documents
 * are plain objects exposing `getFlag(scope, key)`, which is also how the Node
 * tests model them.
 *
 * Routing priority mirrors the former PIXI handlers exactly:
 *  - double click: GM row -> situation aspects -> consequence cost row ->
 *    conflict document -> actor widget;
 *  - context menu: conflict document -> situation aspects (GM-gated) ->
 *    actor widget;
 *  - single click: interactive stress box -> widget selection.
 */

import {
  FLAG_SCOPE,
  GM_OWNER_TYPE,
  SA_OWNER_TYPE,
  CONFLICT_ZONE_OWNER_TYPE,
  CONFLICT_CARD_OWNER_TYPE,
  STRESS_BOX_PART,
  CONSEQUENCE_COST_ROWS_PART,
} from "./constants.js";

/**
 * Board-level conflict ownerType. This is part of the persisted schema and is
 * mirrored from ConflictBoardSync.js (which cannot be imported here without
 * pulling Foundry glue); `tests/widgetInteractionRouter.test.js` drift-guards
 * the equality through ConflictInteractions' CONFLICT_OWNER_PRIORITY.
 */
export const CONFLICT_BOARD_OWNER_TYPE = "conflictBoard";

/** All module-owned conflict ownerTypes (zones, cards, board-level parts). */
export const CONFLICT_OWNER_TYPES = [
  CONFLICT_ZONE_OWNER_TYPE,
  CONFLICT_CARD_OWNER_TYPE,
  CONFLICT_BOARD_OWNER_TYPE,
];

/** Event kinds understood by the router. */
export const WIDGET_EVENT_KINDS = Object.freeze({
  SINGLE_CLICK: "singleClick",
  DOUBLE_CLICK: "doubleClick",
  CONTEXT_MENU: "contextMenu",
});

/** Route identifiers returned by `resolveWidgetRoute`. */
export const WIDGET_ROUTE = Object.freeze({
  NONE: "none",
  CONFLICT: "conflict",
  GM_ROW: "gmRow",
  SA: "sa",
  CONSEQUENCE: "consequence",
  ACTOR: "actor",
  STRESS_BOX: "stressBox",
  SELECT: "select",
});

/** Unwraps a placeable (`.document`) into its document, or null. */
function documentOf(doc) {
  const d = doc?.document ?? doc;
  if (!d?.getFlag) return null;
  return d;
}

function flag(d, key) {
  return d.getFlag(FLAG_SCOPE, key);
}

function widgetIdOf(d) {
  return flag(d, "widgetId");
}

function ownerTypeOf(d) {
  return flag(d, "ownerType");
}

function actorUuidOf(d) {
  return flag(d, "actorUuid");
}

function hasValidIndex(d) {
  const index = Number(flag(d, "index"));
  return Number.isInteger(index) && index >= 0;
}

/** True for a GM fate point row projection (ownerType `gm`, no actorUuid). */
export function isGmRowWidget(doc) {
  const d = documentOf(doc);
  return !!d && ownerTypeOf(d) === GM_OWNER_TYPE;
}

/** True for a situation aspects widget part (ownerType `situationAspects`). */
export function isSaWidget(doc) {
  const d = documentOf(doc);
  return !!d && ownerTypeOf(d) === SA_OWNER_TYPE;
}

/** True for an actor widget part (carries an `actorUuid`). */
export function isActorWidget(doc) {
  const d = documentOf(doc);
  return !!d && !!actorUuidOf(d);
}

/** True for any module-owned conflict document (zone, card or board part). */
export function isConflictWidget(doc) {
  const d = documentOf(doc);
  return !!d && CONFLICT_OWNER_TYPES.includes(ownerTypeOf(d));
}

/**
 * True when the document is an interactive STRESS box that toggles on a single
 * click (same identity as `StressBoxes.isBoxDrawing`): the `stressBoxRows`
 * part with a flat index >= 0 on a conflict card or on an actor widget.
 */
export function isStressBoxWidget(doc) {
  const d = documentOf(doc);
  if (!d) return false;
  if (flag(d, "part") !== STRESS_BOX_PART) return false;
  if (!hasValidIndex(d)) return false;
  return ownerTypeOf(d) === CONFLICT_CARD_OWNER_TYPE || !!actorUuidOf(d);
}

/**
 * True when the document is an editable consequence COST row (same identity as
 * `ConsequenceInteractions.isConsequenceCostPart`): the `consequenceCostRows`
 * part with a flat index >= 0 on a conflict card or on an actor widget.
 */
export function isConsequenceCostWidget(doc) {
  const d = documentOf(doc);
  if (!d) return false;
  if (flag(d, "part") !== CONSEQUENCE_COST_ROWS_PART) return false;
  if (!hasValidIndex(d)) return false;
  return ownerTypeOf(d) === CONFLICT_CARD_OWNER_TYPE || !!actorUuidOf(d);
}

/**
 * Pure routing decision for a widget document and an event kind.
 *
 * Returns a `WIDGET_ROUTE` value; `NONE` means the event is not a module
 * interaction and the caller must leave it to Foundry's native flow.
 *
 * @param {object|null} doc  Drawing/Tile document or placeable.
 * @param {string} kind  One of `WIDGET_EVENT_KINDS`.
 * @returns {string}  A `WIDGET_ROUTE` value.
 */
export function resolveWidgetRoute(doc, kind) {
  const d = documentOf(doc);
  if (!d) return WIDGET_ROUTE.NONE;
  const ownerType = ownerTypeOf(d);

  if (kind === WIDGET_EVENT_KINDS.SINGLE_CLICK) {
    // A stress box toggles on the first click; every other module part is
    // merely selected (or, for the GM row / foreign docs, left to Foundry).
    if (isStressBoxWidget(d)) return WIDGET_ROUTE.STRESS_BOX;
    if (widgetIdOf(d)) return WIDGET_ROUTE.SELECT;
    return WIDGET_ROUTE.NONE;
  }

  if (kind === WIDGET_EVENT_KINDS.DOUBLE_CLICK) {
    if (ownerType === GM_OWNER_TYPE) return WIDGET_ROUTE.GM_ROW;
    if (ownerType === SA_OWNER_TYPE) return WIDGET_ROUTE.SA;
    if (isConsequenceCostWidget(d)) return WIDGET_ROUTE.CONSEQUENCE;
    if (CONFLICT_OWNER_TYPES.includes(ownerType)) return WIDGET_ROUTE.CONFLICT;
    if (actorUuidOf(d)) return WIDGET_ROUTE.ACTOR;
    return WIDGET_ROUTE.NONE;
  }

  if (kind === WIDGET_EVENT_KINDS.CONTEXT_MENU) {
    // Conflict documents outrank every other module widget (the conflict
    // fallback is the reference behaviour and works from any layer).
    if (CONFLICT_OWNER_TYPES.includes(ownerType)) return WIDGET_ROUTE.CONFLICT;
    if (ownerType === SA_OWNER_TYPE) return WIDGET_ROUTE.SA;
    if (actorUuidOf(d)) return WIDGET_ROUTE.ACTOR;
    return WIDGET_ROUTE.NONE;
  }

  return WIDGET_ROUTE.NONE;
}
