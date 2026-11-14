/**
 * widgetCanvasPatches — canvas glue for module widget parts (Drawing/Tile
 * documents flagged with `fate-on-the-table.widgetId`).
 *
 * Two entry paths reach the SAME dispatcher (`routeWidgetInteractions` in
 * FatePointManager.js, registered here through `setWidgetInteractionRouter`),
 * whose routing decision is the pure `resolveWidgetRoute`
 * (widgetInteractionRouter.js):
 *
 * 1. PIXI placeable wraps (`initWidgetInteractions`): `Drawing`/`Tile`
 *    `_onClickLeft2`, `_onClickRight`, `_onClickRight2` and the control
 *    permission checks (`can`, `_canControl`, `_canHover`, `_canDrag`,
 *    `_canDragLeftStart`). Foundry's MouseInteractionManager only dispatches
 *    these when the part's OWN layer (DrawingsLayer / TilesLayer) is the active
 *    layer and the placeable is interactive — i.e. mostly for the GM with the
 *    Drawing/Tile tool selected. The permission wraps make widget parts
 *    hoverable/controllable for every user on that layer, while dragging stays
 *    GM-only.
 * 2. DOM fallback (`initCanvasClickFallback`): raw `pointerdown` /
 *    `contextmenu` listeners on `canvas.app.view`. They hit-test widget parts
 *    geometrically and handle the click whenever the part's layer is NOT
 *    active (players without drawing/tile tools, the GM on the token layer,
 *    non-interactive placeables). When the layer IS active they bail out so
 *    the PIXI path owns the event; a rendered token under the pointer always
 *    wins (token clicks/drags/HUD are never stolen).
 *
 * Every wrap goes through `wrapMethod` (patchMethod.js): libWrapper when
 * available, otherwise a direct idempotent prototype patch.
 */

import { PlacementManager } from "./PlacementManager.js";
import { FLAG_SCOPE, CONTEST_OWNER_TYPE } from "./constants.js";
import {
  hitTestConflictPart,
  CONFLICT_OWNER_PRIORITY,
} from "./ConflictInteractions.js";
import { canvasWorldPosition } from "./utils.js";
import { getActiveMenu } from "./menu.js";
import {
  WIDGET_ROUTE,
  WIDGET_EVENT_KINDS,
  resolveWidgetRoute,
} from "./widgetInteractionRouter.js";
import { wrapMethod } from "./patchMethod.js";

/**
 * The Foundry-glue dispatcher executing a resolved widget route. Injected by
 * FatePointManager.js (which owns the fate point / aspect / actor menus) to
 * avoid an import cycle.
 * @type {((input: {doc: object, event?: Event|null, kind: string, source?: string}) => Promise<boolean>)|null}
 */
let widgetRouter = null;

/** Registers the dispatcher used by both the PIXI wraps and the DOM fallback. */
export function setWidgetInteractionRouter(fn) {
  widgetRouter = typeof fn === "function" ? fn : null;
}

function routeWidgetInteractions(input) {
  return widgetRouter ? widgetRouter(input) : Promise.resolve(false);
}

/** Global path of the v14 placeable class prototypes (for libWrapper). */
const PLACEABLES_PATH = "foundry.canvas.placeables";

let interactionsPatched = false;

/**
 * Resolves the Foundry v14 canvas placeable classes from
 * `foundry.canvas.placeables`. Returns `null` under Node (no `foundry`), so
 * callers can bail out and prototype patching is skipped.
 * @returns {{Drawing?: Function, Tile?: Function, Token?: Function}|null}
 */
function resolvePlaceables() {
  if (typeof foundry === "undefined") return null;
  return foundry.canvas?.placeables ?? null;
}

/**
 * Canvas interactions for fate-on-the-table widgets:
 * - double-click on a GM fate point box (or its tokens) opens the Fate Point
 *   Manager; double-click on the situation aspects widget opens its manager;
 *   double-click on an actor widget part opens the actor sheet (when the
 *   clicking user can view the actor);
 * - right-click on an actor widget part opens a small menu with
 *   give/take fate point actions (owner-only).
 * Patching runs at module load (top level), so it survives page reloads.
 */
export function initWidgetInteractions() {
  if (interactionsPatched) return;
  interactionsPatched = true;
  // Foundry v14 moved the placeable classes under `foundry.canvas.placeables`;
  // the bare `Drawing`/`Tile` globals are deprecated (removed in v15). Resolve
  // at init time (never at import time) and bail out under Node, where
  // `foundry` is absent. The base classes are wrapped (not a possible
  // `CONFIG.*.objectClass` subclass), exactly as before.
  const { Drawing, Tile } = resolvePlaceables() ?? {};
  if (!Drawing || !Tile) return;
  for (const [name, cls] of [["Drawing", Drawing], ["Tile", Tile]]) {
    const owner = { proto: cls.prototype, cls: name, path: `${PLACEABLES_PATH}.${name}.prototype` };
    patchDoubleClick(owner);
    patchRightClick(owner);
    patchControlPermissions(owner);
  }
  // Menu closing (Escape/outside/scroll/resize) is now delegated to the shared menu.js module.
}

/** Wraps one method of a placeable prototype (see patchMethod.js). */
function wrapPlaceable({ proto, cls, path }, method, wrapper, type) {
  return wrapMethod(proto, { cls, path, method }, wrapper, { type });
}

function patchDoubleClick(owner) {
  // MIXED: a claimed widget double-click never reaches the native handler.
  wrapPlaceable(owner, "_onClickLeft2", async function (wrapped, event, ...rest) {
    const doc = this.document ?? this;
    const widgetId = doc?.getFlag?.(FLAG_SCOPE, "widgetId");
    if (!widgetId) {
      return wrapped(event, ...rest);
    }
    // The shared router decides the exact handler; when it does not claim the
    // event (foreign widget shape) the native flow is untouched.
    const route = resolveWidgetRoute(doc, WIDGET_EVENT_KINDS.DOUBLE_CLICK);
    if (route === WIDGET_ROUTE.NONE) {
      return wrapped(event, ...rest);
    }
    return routeWidgetInteractions({
      doc,
      event,
      kind: WIDGET_EVENT_KINDS.DOUBLE_CLICK,
      source: "pixi",
    });
  }, "MIXED");
}

/**
 * Right-click routing for module widget parts on the ACTIVE layer. Delegates
 * to the same shared router as the DOM fallback:
 * - conflict documents -> owner-aware conflict menu;
 * - situation aspects (GM only) -> per-aspect / widget menu;
 * - actor widget parts -> owner-aware menu (GM give/take/remove, actor owner's
 *   "Roll Skill" submenu, everyone else consumed without a menu).
 * Anything else falls through to the native behaviour.
 */
function patchRightClick(owner) {
  wrapPlaceable(owner, "_onClickRight", function (wrapped, event, ...rest) {
    const doc = this.document ?? this;
    const route = resolveWidgetRoute(doc, WIDGET_EVENT_KINDS.CONTEXT_MENU);
    if (route === WIDGET_ROUTE.NONE) return wrapped(event, ...rest);
    // The situation aspects AND challenge/contest menus stay GM-only; a player
    // keeps the native behaviour (no module menu is offered).
    if (isGmOnlyContextRoute(route) && !isGMUser()) {
      return wrapped(event, ...rest);
    }
    return routeWidgetInteractions({
      doc,
      event,
      kind: WIDGET_EVENT_KINDS.CONTEXT_MENU,
      source: "pixi",
    });
  }, "MIXED");
  wrapPlaceable(owner, "_onClickRight2", function (wrapped, event, ...rest) {
    const doc = this.document ?? this;
    const route = resolveWidgetRoute(doc, WIDGET_EVENT_KINDS.CONTEXT_MENU);
    if (route === WIDGET_ROUTE.NONE) return wrapped(event, ...rest);
    // The second right-click must not fall through to the native config sheet
    // when the first one was answered with a module menu.
    if (isGmOnlyContextRoute(route) && !isGMUser()) {
      return wrapped(event, ...rest);
    }
    consumeEvent(event);
    return true;
  }, "MIXED");
}

/**
 * Canvas control permissions for actor widget parts and the macro-created
 * contest drawing:
 * - everyone can click (hover/control) the widget;
 * - only the GM can drag/move the actor widget / contest block.
 * Both the public `can(user, action)` (used by the mouse interaction
 * manager via CONFIG.Canvas.interactionPermissions) and the protected
 * `_canXxx` helpers are wrapped, so selection works for every user while
 * dragging stays GM-only. GM fate point boxes keep the default permissions.
 * A challenge block is now ONE drawing: move stays fully native, and resize is
 * normalised to independent axes by drawingFreeResize.js.
 * All wraps are MIXED: a module answer short-circuits the original.
 */
function patchControlPermissions(owner) {
  const isPlayerWidget = (obj) =>
    !!obj?.document?.getFlag?.(FLAG_SCOPE, "actorUuid") ||
    !!obj?.getFlag?.(FLAG_SCOPE, "actorUuid");
  // A macro-created contest drawing may only be controlled/dragged by the GM
  // (its menu is GM-only). A challenge block is not special-cased here: its
  // single drawing uses the native drawing permissions and interaction.
  const isContestWidget = (obj) =>
    (obj?.document ?? obj)?.getFlag?.(FLAG_SCOPE, "ownerType") ===
    CONTEST_OWNER_TYPE;

  wrapPlaceable(owner, "can", function (wrapped, user, action, ...rest) {
    if (isPlayerWidget(this)) {
      if (action === "hover" || action === "control" || action === "HUD") {
        return true;
      }
      if (action === "drag" || action === "configure") {
        return user?.isGM === true;
      }
    }
    if (isContestWidget(this)) {
      // Hover/view are open to everyone so the menu resolves from any layer;
      // control/drag/configure are GM-only.
      if (action === "hover" || action === "view") return true;
      if (
        action === "control" ||
        action === "drag" ||
        action === "configure" ||
        action === "HUD"
      ) {
        return user?.isGM === true;
      }
    }
    return wrapped(user, action, ...rest);
  }, "MIXED");

  wrapPlaceable(owner, "_canControl", function (wrapped, user, event, ...rest) {
    if (isPlayerWidget(this)) return true;
    return wrapped(user, event, ...rest);
  }, "MIXED");

  wrapPlaceable(owner, "_canHover", function (wrapped, user, event, ...rest) {
    if (isPlayerWidget(this)) return true;
    if (isContestWidget(this)) return true;
    return wrapped(user, event, ...rest);
  }, "MIXED");

  wrapPlaceable(owner, "_canDrag", function (wrapped, user, event, ...rest) {
    if (isPlayerWidget(this)) return user?.isGM === true;
    if (isContestWidget(this)) return user?.isGM === true;
    return wrapped(user, event, ...rest);
  }, "MIXED");

  wrapPlaceable(owner, "_canDragLeftStart", function (wrapped, user, event, ...rest) {
    if (isPlayerWidget(this)) return user?.isGM === true;
    if (isContestWidget(this)) return user?.isGM === true;
    return wrapped(user, event, ...rest);
  }, "MIXED");
}

/* --- Shared interaction router (PIXI patches + DOM fallback) --- */

/** True when the current user is the GM (safe under Node). */
export function isGMUser() {
  return typeof game !== "undefined" && game?.user?.isGM === true;
}

/**
 * True for context-menu routes whose menu is GM-only: the situation aspects
 * widget and the challenge/contest macro drawings. A non-GM user keeps the
 * native Foundry behaviour for these (no module menu, nothing consumed).
 * @param {string} route  A `WIDGET_ROUTE` value.
 */
export function isGmOnlyContextRoute(route) {
  return route === WIDGET_ROUTE.SA || route === WIDGET_ROUTE.CHALLENGE_CONTEST;
}

/** Prevents the native Foundry/browser handling of a consumed event. */
export function consumeEvent(event) {
  event?.preventDefault?.();
  event?.stopPropagation?.();
}

/* ------------------------------------------------------------------ */
/*  Canvas click fallback                                              */
/*                                                                     */
/*  Placeable interaction in Foundry requires the object's LAYER to be */
/*  active. Players without drawing/tile tools cannot activate those   */
/*  layers, so widget parts are unreachable for them through PIXI.     */
/*  This DOM listener on the canvas view handles clicks on widget      */
/*  parts regardless of the active layer. Its routing decision comes   */
/*  from the SAME pure router as the PIXI patches (resolveWidgetRoute  */
/*  in widgetInteractionRouter.js) and it executes the SAME handlers   */
/*  through routeWidgetInteractions, so a widget never behaves         */
/*  differently depending on the active layer. When the part's own     */
/*  layer IS active the PIXI flow owns the event (the layerActive      */
/*  guard only prevents double-handling) — all other layers are fully  */
/*  served here.                                                       */
/* ------------------------------------------------------------------ */

let lastWidgetClick = null;

/** Attach the fallback listeners to the current canvas view (idempotent). */
export function initCanvasClickFallback() {
  const view = canvas?.app?.view;
  if (!view || view.dataset.cttClickFallback) return;
  view.dataset.cttClickFallback = "true";
  view.addEventListener("pointerdown", onCanvasPointerDown);
  view.addEventListener("contextmenu", onCanvasContextMenu);
}

function onCanvasPointerDown(event) {
  if (PlacementManager.active) return;
  // Right-clicks on situation aspects (GM) and actor (owner-aware) widget
  // parts work through the same DOM fallback (players / inactive layers never
  // reach the PIXI patch).
  if (event.button === 2) {
    onCanvasRightPointerDown(event);
    return;
  }
  if (event.button !== 0) return;
  // Widget parts (actor widgets, conflict zones/cards, ...) must never block
  // the standard token interactions: when a rendered token sits under the
  // pointer the PIXI/token flow takes over.
  if (tokenUnderPointer(event)) return;
  const part = hitTestWidgetPart(event);
  if (!part) return;
  // When the part's own layer is active the standard PIXI/MIM flow (plus
  // the permission patches) already handles it — do not double-handle.
  const layerActive =
    part.documentName === "Drawing"
      ? canvas.drawings?.active
      : canvas.tiles?.active;
  if (layerActive) return;
  event.preventDefault();
  event.stopPropagation();
  const now = Date.now();
  const isDouble =
    lastWidgetClick?.id === part.id && now - lastWidgetClick.time <= 300;
  lastWidgetClick = { id: part.id, time: now };
  // Double click first, then single click: the SAME shared router as the PIXI
  // path decides between manager/sheet opening, stress-box toggling and
  // selection, so both paths can never diverge.
  routeWidgetInteractions({
    doc: part,
    event,
    kind: isDouble
      ? WIDGET_EVENT_KINDS.DOUBLE_CLICK
      : WIDGET_EVENT_KINDS.SINGLE_CLICK,
    source: "dom",
  });
}

/**
 * DOM fallback for RIGHT-clicks on module widget parts where the PIXI
 * `_onClickRight` patch never fires (inactive layers, layers players cannot
 * activate): the raw view event routes here — the mirror of the conflict
 * fallback (`onConflictCanvasPointerDown` in ConflictInteractions.js).
 *
 * - Actor widget parts go through the SAME owner-aware router as the PIXI
 *   path (`handleActorWidgetContextMenu`): GM give/take/remove menu, an
 *   actor owner's "Roll Skill" submenu, or consumed-without-menu.
 * - Situation aspects widget parts keep their GM-only menu (same
 *   aspect / empty-place split as the PIXI path).
 * - Every other part (conflict docs, GM row, foreign widgets) keeps its own
 *   routing; conflict documents are handled by `onConflictCanvasPointerDown`.
 * Double clicks are untouched.
 */
function onCanvasRightPointerDown(event) {
  // Never steal right-clicks that carry normal token interactions (HUD).
  if (tokenUnderPointer(event)) return;
  const part = hitTestWidgetPart(event);
  if (!part) return;
  const route = resolveWidgetRoute(part, WIDGET_EVENT_KINDS.CONTEXT_MENU);
  // Conflict documents are handled by the conflict fallback listener
  // (`onConflictCanvasPointerDown`) so they are never double-handled here; the
  // GM row keeps the native context menu.
  if (
    route !== WIDGET_ROUTE.ACTOR &&
    route !== WIDGET_ROUTE.SA &&
    route !== WIDGET_ROUTE.CHALLENGE_CONTEST
  ) {
    return;
  }
  // Situation aspects AND challenge/contest menus stay GM-only; actor widgets
  // are owner-aware.
  if (isGmOnlyContextRoute(route) && !isGMUser()) return;
  // When the part's own layer is active the PIXI patch path handles it —
  // do not double-handle.
  const layerActive =
    part.documentName === "Drawing"
      ? canvas.drawings?.active
      : canvas.tiles?.active;
  if (layerActive) return;
  // Conflict parts outrank SA/actor parts in hitTestWidgetPart already; skip
  // when a conflict document would answer this click itself.
  const point = canvasWorldPosition(event);
  if (point && hitTestConflictPart(point, canvas.scene)) return;
  // The shared router consumes the event and calls the exact same handler as
  // the PIXI path.
  routeWidgetInteractions({
    doc: part,
    event,
    kind: WIDGET_EVENT_KINDS.CONTEXT_MENU,
    source: "dom",
  });
}

/**
 * Keeps the native browser context menu off the module's right-click targets
 * in the fallback: while one of the module menus is open, over situation
 * aspects widget parts answered by the GM fallback, and over actor widget parts
 * answered by the owner-aware fallback for EVERY user (the PIXI patch path
 * prevents default on its own).
 */
function onCanvasContextMenu(event) {
  if (getActiveMenu()) {
    event.preventDefault();
    return;
  }
  if (PlacementManager.active) return;
  const part = hitTestWidgetPart(event);
  if (!part) return;
  const route = resolveWidgetRoute(part, WIDGET_EVENT_KINDS.CONTEXT_MENU);
  if (
    route !== WIDGET_ROUTE.ACTOR &&
    route !== WIDGET_ROUTE.SA &&
    route !== WIDGET_ROUTE.CHALLENGE_CONTEST
  ) {
    return;
  }
  if (isGmOnlyContextRoute(route) && !isGMUser()) return;
  const layerActive =
    part.documentName === "Drawing"
      ? canvas.drawings?.active
      : canvas.tiles?.active;
  if (layerActive) return;
  event.preventDefault();
}

/**
 * True when a rendered token sits under the pointer. Used so the DOM canvas
 * fallback never intercepts normal token clicks/drags over widget parts.
 */
function tokenUnderPointer(event) {
  try {
    const p = canvasWorldPosition(event);
    if (!p) return false;
    return [...canvas.tokens.placeables].some((placeable) => {
      if (typeof placeable.containsPoint === "function") {
        try {
          return placeable.containsPoint(p.x, p.y);
        } catch (err) {
          return false;
        }
      }
      const bounds = placeable.getBounds?.();
      if (bounds) {
        return (
          p.x >= bounds.x &&
          p.x <= bounds.x + bounds.width &&
          p.y >= bounds.y &&
          p.y <= bounds.y + bounds.height
        );
      }
      return false;
    });
  } catch (err) {
    return false;
  }
}

/** The topmost widget part (drawing/tile) under the cursor, or null. */
function hitTestWidgetPart(event) {
  if (!canvas?.scene) return null;
  const p = canvasWorldPosition(event);
  if (!p) return null;
  const candidates = [];
  for (const doc of canvas.scene.drawings) {
    if (!doc.getFlag?.(FLAG_SCOPE, "widgetId")) continue;
    const w = doc.shape?.width ?? 0;
    const h = doc.shape?.height ?? 0;
    if (p.x >= doc.x && p.x <= doc.x + w && p.y >= doc.y && p.y <= doc.y + h) {
      const ownerType = doc.getFlag?.(FLAG_SCOPE, "ownerType");
      candidates.push({
        doc,
        isDrawing: true,
        priority: CONFLICT_OWNER_PRIORITY[ownerType] ?? 0,
        z: (doc.elevation ?? 0) * 1000 + (doc.sort ?? 0),
      });
    }
  }
  for (const doc of canvas.scene.tiles) {
    if (!doc.getFlag?.(FLAG_SCOPE, "widgetId")) continue;
    if (
      p.x >= doc.x &&
      p.x <= doc.x + doc.width &&
      p.y >= doc.y &&
      p.y <= doc.y + doc.height
    ) {
      const ownerType = doc.getFlag?.(FLAG_SCOPE, "ownerType");
      candidates.push({
        doc,
        isDrawing: false,
        priority: CONFLICT_OWNER_PRIORITY[ownerType] ?? 0,
        z: doc.sort ?? 0,
      });
    }
  }
  if (!candidates.length) return null;
  // Conflict-document owner priority is the PRIMARY key (conflictCard >
  // conflictZone > conflictBoard), so a zone is never shadowed by the board
  // field frame even when the stored z-order is imperfect. Non-conflict
  // widgets keep the legacy order (drawings above tiles, then z).
  candidates.sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority;
    if (a.isDrawing !== b.isDrawing) return (b.isDrawing ? 1 : 0) - (a.isDrawing ? 1 : 0);
    return b.z - a.z;
  });
  return candidates[0].doc;
}

/** Selects a widget part so the click gives visible feedback. */
export function selectWidgetPart(part) {
  try {
    const placeable =
      part.documentName === "Drawing"
        ? canvas.drawings?.get(part.id)
        : canvas.tiles?.get(part.id);
    placeable?.control({ releaseOthers: false });
  } catch (err) {
    console.warn("[fate-on-the-table] widget select failed:", err);
  }
}
