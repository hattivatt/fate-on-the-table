/**
 * ConflictZoneEditor — GM-only canvas/DOM zone editor for the conflict board
 * (feature 5, PLAN.md). Provides:
 *
 *  - enterConflictZoneEditMode() / exitConflictZoneEditMode(): a full editing
 *    mode in which the GM can draw a new zone inside the central field, move
 *    existing zones and resize them with corner handles. The overlay/handles
 *    live ON the canvas (PIXI Graphics added to `canvas.controls`, exactly
 *    like the PlacementManager preview) and the input is DOM on
 *    `canvas.app.view` — no PIXI pointer events are relied on.
 *  - startZoneDraw(scene, point, name): a legacy temporary "draw a zone"
 *    flow, DEPRECATED — the context-menu "Add zone" action now runs a
 *    `PlacementManager` click-placement instead (see
 *    `ConflictInteractions.addZoneAtPoint`); kept only for older callers.
 *  - promptZoneName(): the shared DialogV2 name prompt.
 *  - isConflictEditModeActive(): state used by the routing patches so that
 *    outside edit mode zone drawings never intercept normal token clicks and
 *    players never receive an overlay.
 *  - While the editor is active, a pointer pressed over a rendered token is
 *    handed back to the native token flow (token-under-pointer bailout), so
 *    the GM can still drag tokens between zones inside edit mode.
 *
 * Data contract: only `zones[].rect` (and, for NEW zones, id/name/style/sort)
 * of the normalized `conflictBoard` scene flag are written, through
 * `writeConflictBoard` + `syncConflictBoard`. board.origin, other zones,
 * cards, tokenZones and foreign documents are never touched. New rects are
 * clamped to the central field; the caller decides the final name.
 */

import { MODULE_ID, FLAG_SCOPE } from "./constants.js";
import { DEFAULT_ZONE_STYLE } from "./conflictBoardSchema.js";
import {
  getConflictBoardGeometry,
  pointInRect,
} from "./conflictBoardGeometry.js";
import {
  readConflictBoard,
  writeConflictBoard,
  syncConflictBoard,
} from "./ConflictBoardSync.js";
import { escapeHtml, dialogField, canvasWorldPosition } from "./utils.js";

/** Corners used for zone resize handles. */
const CORNERS = ["nw", "ne", "sw", "se"];
/** Minimum zone size (scene units) enforced on create/move/resize. */
const MIN_ZONE_SIZE = 40;
/** World size of a resize handle square. */
const HANDLE_SIZE = 14;

/** The current editor mode: "edit", "draw" or null (inactive). */
let mode = null;
/** Name of a zone being drawn via startZoneDraw (known before the draw). */
let drawName = null;
/** Resolver of the pending startZoneDraw promise (zone saved/cancelled). */
let drawResolve = null;

/** Scene currently being edited. */
let editorScene = null;
/** PIXI.Graphics overlay (zone outlines, handles, preview) on canvas.controls. */
let graphics = null;
/** DOM message banner (.ctt-conflict-board-overlay + .ctt-conflict-overlay-msg). */
let overlay = null;
let msg = null;
/** The canvas view the DOM input listeners are attached to. */
let view = null;

/** Active pointer operation: { kind, startLocal, origin, corner, zoneId, preview }. */
let op = null;

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

/**
 * True while the zone editor is active (edit or draw mode).
 * @returns {boolean}
 */
export function isConflictEditModeActive() {
  return mode !== null;
}

/**
 * Enters the GM-only zone editing mode (create/move/resize). Idempotent.
 * @returns {boolean}  True when the editor was entered (or already active).
 */
export function enterConflictZoneEditMode() {
  if (mode === "edit") return true;
  if (mode) return false;
  if (!isGm()) {
    if (typeof ui !== "undefined") {
      ui.notifications?.warn?.(game.i18n.localize(`${MODULE_ID}.conflict.permission.gmOnly`));
    }
    return false;
  }
  const scene = currentScene();
  if (!scene) return false;
  const state = readConflictBoard(scene);
  if (!state) {
    if (typeof ui !== "undefined") {
      ui.notifications?.warn?.(game.i18n.localize(`${MODULE_ID}.conflict.noBoard`));
    }
    return false;
  }
  mode = "edit";
  setup(scene);
  return true;
}

/**
 * Exits the zone editor (edit or draw mode) and cleans up overlay, handles,
 * preview and pointer listeners. Idempotent.
 */
export function exitConflictZoneEditMode() {
  teardown();
  mode = null;
  drawName = null;
}

/**
 * Asks the GM for a zone name (DialogV2.input, the module's standard dialog
 * pattern for text input). In Foundry v14 `DialogV2.prompt()` resolves to the
 * id of the pressed button (`"ok"`), NOT the form fields; `DialogV2.input()`
 * resolves to the submitted form data instead. Resolves with the trimmed name
 * or `null` when cancelled/empty.
 * @returns {Promise<string|null>}
 */
export function promptZoneName() {
  if (
    typeof foundry === "undefined" ||
    !foundry?.applications?.api?.DialogV2?.input
  ) {
    return Promise.resolve(null);
  }
  return foundry.applications.api.DialogV2.input({
    window: {
      title: game.i18n.localize(`${MODULE_ID}.conflict.zone.addTitle`),
    },
    content: `<div class="form-group"><label for="ctt-zone-name">${escapeHtml(
      game.i18n.localize(`${MODULE_ID}.conflict.zone.namePrompt`),
    )}</label><input type="text" id="ctt-zone-name" name="name"></div>`,
    ok: { label: game.i18n.localize(`${MODULE_ID}.conflict.zone.addTitle`) },
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

/**
 * DEPRECATED. Temporary "draw a new zone" flow used by the legacy context-menu
 * "Add zone" action: the name is already known, the user drags a rectangle
 * inside the central field, and the zone is saved on release. Constrained to
 * the field. The context-menu "Add zone" action now uses the standard
 * `PlacementManager.placeGroup` click-placement flow instead
 * (`ConflictInteractions.addZoneAtPoint`); this flow is kept only for older
 * callers and still runs through the same `mode === "draw"` editor session.
 * @param {object} scene  Target scene (canvas scene).
 * @param {{x: number, y: number}} point  World point that started the flow
 *   (must be inside the central field).
 * @param {string} name  Zone name (already validated).
 * @returns {Promise<boolean>}  True when the zone was saved, false on cancel.
 */
export function startZoneDraw(scene, point, name) {
  if (mode) {
    if (typeof ui !== "undefined") {
      ui.notifications?.warn?.(
        game.i18n.localize(`${MODULE_ID}.conflict.placement.busy`),
      );
    }
    return Promise.resolve(false);
  }
  if (!isGm()) return Promise.resolve(false);
  if (!scene || !point) return Promise.resolve(false);
  const state = readConflictBoard(scene);
  if (!state) return Promise.resolve(false);
  const geometry = getBoardGeometry(state);
  const local = worldToBoardPoint(state, point);
  if (!pointInRect(geometry.field, local)) return Promise.resolve(false);
  mode = "draw";
  drawName = name ?? "";
  setup(scene);
  if (typeof ui !== "undefined") {
    ui.notifications?.info?.(
      game.i18n.localize(`${MODULE_ID}.conflict.zone.editorHint`),
    );
  }
  return new Promise((resolve) => {
    drawResolve = resolve;
  });
}

/* ------------------------------------------------------------------ *
 * Setup / teardown
 * ------------------------------------------------------------------ */

function setup(scene) {
  editorScene = scene;
  const g = new PIXI.Graphics();
  g.eventMode = "none";
  canvas.controls.addChild(g);
  graphics = g;

  // DOM message banner. pointer-events stays none (inline) so the banner
  // never blocks the canvas; the interactive overlay is the PIXI graphics.
  overlay = document.createElement("div");
  overlay.className = "ctt-conflict-board-overlay";
  overlay.style.pointerEvents = "none";
  overlay.style.left = "0px";
  overlay.style.top = "0px";
  overlay.style.width = "100vw";
  overlay.style.height = "100vh";
  msg = document.createElement("div");
  msg.className = "ctt-conflict-overlay-msg";
  msg.textContent = game.i18n.localize(
    `${MODULE_ID}.conflict.zone.editorHint`,
  );
  overlay.append(msg);
  document.body.append(overlay);

  view = canvas.app.view;
  view.addEventListener("pointerdown", onPointerDown);
  view.addEventListener("pointermove", onPointerMove);
  view.addEventListener("pointerup", onPointerUp);
  view.addEventListener("pointercancel", onPointerCancel);
  window.addEventListener("keydown", onKeyDown);
  Hooks.on("canvasReady", onCanvasReadyExit);

  render();
}

function teardown() {
  if (view) {
    view.removeEventListener("pointerdown", onPointerDown);
    view.removeEventListener("pointermove", onPointerMove);
    view.removeEventListener("pointerup", onPointerUp);
    view.removeEventListener("pointercancel", onPointerCancel);
  }
  window.removeEventListener("keydown", onKeyDown);
  Hooks.off("canvasReady", onCanvasReadyExit);
  try {
    graphics?.destroy?.({ children: true });
  } catch (err) {
    /* overlay cleanup is best-effort */
  }
  overlay?.remove?.();
  graphics = null;
  overlay = null;
  msg = null;
  view = null;
  editorScene = null;
  op = null;
  if (typeof drawResolve === "function") {
    const resolve = drawResolve;
    drawResolve = null;
    resolve(false);
  }
}

function onCanvasReadyExit() {
  exitConflictZoneEditMode();
}

/* ------------------------------------------------------------------ *
 * Rendering (PIXI graphics on canvas.controls)
 * ------------------------------------------------------------------ */

function render() {
  const g = graphics;
  if (!g) return;
  g.clear();
  const state = editorScene ? readConflictBoard(editorScene) : null;
  if (!state) return;
  const origin = state.board?.origin ?? { x: 0, y: 0 };
  const ox = origin.x ?? 0;
  const oy = origin.y ?? 0;

  for (const zone of state.zones ?? []) {
    const rect = zone?.rect;
    if (!rect) continue;
    const x = ox + rect.x;
    const y = oy + rect.y;
    g.beginFill(0x1e78b4, 0.18);
    g.lineStyle(2, 0x1e78b4, 0.9);
    g.drawRect(x, y, rect.width, rect.height);
    g.endFill();
    for (const corner of CORNERS) {
      const [cx, cy] = cornerPoint(rect, corner, ox, oy);
      g.beginFill(0xffffff, 1);
      g.lineStyle(1, 0x000000, 0.8);
      g.drawRect(cx - HANDLE_SIZE / 2, cy - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE);
      g.endFill();
    }
  }

  if (op?.preview) {
    const r = op.preview;
    g.beginFill(0x22ff22, 0.15);
    g.lineStyle(2, 0x22ff22, 0.9);
    g.drawRect(ox + r.x, oy + r.y, r.width, r.height);
    g.endFill();
  }
}

/* ------------------------------------------------------------------ *
 * DOM input handlers (on canvas.app.view / window)
 * ------------------------------------------------------------------ */

function onPointerDown(event) {
  if (event.button === 2) {
    event.preventDefault();
    event.stopPropagation();
    cancelOp();
    return;
  }
  if (event.button !== 0) return;
  const scene = currentScene();
  if (!scene) return;
  const state = readConflictBoard(scene);
  if (!state) return;
  const local = localPoint(event, state);
  if (!local) return;
  if (op) return;
  // A rendered token must never be hijacked by the zone editor: the token may
  // sit inside a zone, and the GM has to be able to drag it between zones
  // while the editor is on. Hand the pointer over to the native token flow.
  if (tokenUnderPointer(event)) return;
  const geometry = getBoardGeometry(state);

  const handle = hitZoneHandle(state, local);
  if (handle) {
    op = {
      kind: "resize",
      zoneId: handle.zone.id,
      corner: handle.corner,
      origin: { ...handle.zone.rect },
      startLocal: local,
      preview: { ...handle.zone.rect },
    };
  } else {
    const body = hitZoneBody(state, local);
    if (body) {
      op = {
        kind: "move",
        zoneId: body.id,
        origin: { ...body.rect },
        startLocal: local,
        preview: { ...body.rect },
      };
    } else if (pointInRect(geometry.field, local)) {
      op = {
        kind: "create",
        name: mode === "draw" ? drawName : null,
        startLocal: local,
        preview: { x: local.x, y: local.y, width: 0, height: 0 },
      };
    } else {
      return; // outside the board — do nothing
    }
  }
  try {
    view?.setPointerCapture?.(event.pointerId);
  } catch (err) {
    /* pointer capture is best-effort */
  }
  event.preventDefault();
  event.stopPropagation();
}

function onPointerMove(event) {
  if (!op) return;
  const scene = currentScene();
  if (!scene) return;
  const state = readConflictBoard(scene);
  if (!state) return;
  const local = localPoint(event, state);
  if (!local) return;
  const field = getBoardGeometry(state).field;

  if (op.kind === "create") {
    op.preview = clampRectWithin(rectFromPoints(op.startLocal, local), field);
  } else if (op.kind === "move") {
    const dx = local.x - op.startLocal.x;
    const dy = local.y - op.startLocal.y;
    op.preview = clampToField(
      {
        x: op.origin.x + dx,
        y: op.origin.y + dy,
        width: op.origin.width,
        height: op.origin.height,
      },
      field,
    );
  } else if (op.kind === "resize") {
    op.preview = clampToField(resizedRect(op.origin, op.corner, local), field);
  }
  render();
}

async function onPointerUp(event) {
  if (!op) return;
  const finished = op;
  op = null;
  try {
    view?.releasePointerCapture?.(event.pointerId);
  } catch (err) {
    /* best-effort */
  }
  const scene = currentScene();
  if (!scene || !finished.preview) return;
  const state = readConflictBoard(scene);
  if (!state) return;
  const rect = finished.preview;

  if (finished.kind === "create") {
    if (rect.width < MIN_ZONE_SIZE || rect.height < MIN_ZONE_SIZE) {
      finishCreate(false);
      render();
      return;
    }
    let name = finished.name;
    if (mode === "edit" && !name) {
      name = awaitZoneName();
      if (!name) {
        render();
        return;
      }
    }
    if (mode === "draw" && !name) {
      finishCreate(false);
      render();
      return;
    }
    const zone = makeZone(name, rect, state);
    await saveZone(scene, zone);
    if (typeof ui !== "undefined") {
      ui.notifications?.info?.(
        game.i18n.format(`${MODULE_ID}.conflict.zone.added`, { name }),
      );
    }
    finishCreate(true);
  } else {
    const current = readConflictBoard(scene);
    const zone = current?.zones?.find((z) => z?.id === finished.zoneId);
    if (current && zone) {
      await saveZone(scene, { ...zone, rect });
    }
  }
  render();
}

function onPointerCancel(event) {
  if (!op) return;
  op = null;
  render();
}

function onKeyDown(event) {
  if (event.key !== "Escape") return;
  event.preventDefault();
  event.stopPropagation();
  cancelOp();
}

/** Right-click / Escape: cancel the active drag, otherwise exit edit mode. */
function cancelOp() {
  if (op) {
    op = null;
    render();
    return;
  }
  exitConflictZoneEditMode();
}

function finishCreate(result) {
  if (mode === "draw") {
    if (typeof drawResolve === "function") {
      const resolve = drawResolve;
      drawResolve = null;
      resolve(!!result);
    }
    teardown();
    mode = null;
    drawName = null;
  }
}

async function awaitZoneName() {
  return promptZoneName();
}

/* ------------------------------------------------------------------ *
 * Persistence
 * ------------------------------------------------------------------ */

async function saveZone(scene, zone) {
  const state = readConflictBoard(scene);
  if (!state) return;
  const exists = (state.zones ?? []).some((z) => z?.id === zone.id);
  const next = exists
    ? { ...state, zones: state.zones.map((z) => (z?.id === zone.id ? zone : z)) }
    : { ...state, zones: [...(state.zones ?? []), zone] };
  await writeConflictBoard(scene, next);
  await syncConflictBoard(scene);
}

function makeZone(name, rect, state) {
  return {
    id: zoneId(),
    name: name ?? "",
    rect: { ...rect },
    style: { ...DEFAULT_ZONE_STYLE },
    sort: nextZoneSort(state),
  };
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
 * Geometry / hit-test helpers (all board-local; origin applied at render)
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

function localPoint(event, state) {
  const p = canvasWorldPosition(event);
  if (!p) return null;
  return worldToBoardPoint(state, p);
}

/** True when a rendered token sits under the pointer (native drag bailout). */
function tokenUnderPointer(event) {
  try {
    const p = canvasWorldPosition(event);
    if (!p) return false;
    return [...(canvas.tokens?.placeables ?? [])].some((placeable) => {
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

function cornerPoint(rect, corner, ox, oy) {
  const x = rect.x + ox;
  const y = rect.y + oy;
  switch (corner) {
    case "nw":
      return [x, y];
    case "ne":
      return [x + rect.width, y];
    case "sw":
      return [x, y + rect.height];
    default:
      return [x + rect.width, y + rect.height];
  }
}

function hitZoneHandle(state, local) {
  for (const zone of state?.zones ?? []) {
    const rect = zone?.rect;
    if (!rect) continue;
    for (const corner of CORNERS) {
      const [cx, cy] = cornerPoint(rect, corner, 0, 0);
      const hs = HANDLE_SIZE / 2;
      if (
        local.x >= cx - hs &&
        local.x <= cx + hs &&
        local.y >= cy - hs &&
        local.y <= cy + hs
      ) {
        return { zone, corner };
      }
    }
  }
  return null;
}

function hitZoneBody(state, local) {
  for (const zone of state?.zones ?? []) {
    if (zone?.rect && pointInRect(zone.rect, local)) return zone;
  }
  return null;
}

function rectFromPoints(a, b) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  };
}

/** Clamps a rect's position so it stays fully inside the field (no grow). */
function clampRectWithin(rect, field) {
  const width = Math.min(rect.width, field.width);
  const height = Math.min(rect.height, field.height);
  return {
    x: Math.min(Math.max(rect.x, field.x), field.x + field.width - width),
    y: Math.min(Math.max(rect.y, field.y), field.y + field.height - height),
    width,
    height,
  };
}

/** Clamps a rect (min size enforced) fully inside the field. */
function clampToField(rect, field) {
  let width = Math.max(MIN_ZONE_SIZE, rect.width);
  let height = Math.max(MIN_ZONE_SIZE, rect.height);
  width = Math.min(width, field.width);
  height = Math.min(height, field.height);
  const x = Math.min(Math.max(rect.x, field.x), field.x + field.width - width);
  const y = Math.min(Math.max(rect.y, field.y), field.y + field.height - height);
  return { x, y, width, height };
}

function resizedRect(origin, corner, to) {
  let { x, y, width, height } = origin;
  if (corner.indexOf("w") !== -1) {
    const right = x + width;
    x = Math.min(to.x, right - MIN_ZONE_SIZE);
    width = right - x;
  }
  if (corner.indexOf("e") !== -1) {
    width = Math.max(to.x - x, MIN_ZONE_SIZE);
  }
  if (corner.indexOf("n") !== -1) {
    const bottom = y + height;
    y = Math.min(to.y, bottom - MIN_ZONE_SIZE);
    height = bottom - y;
  }
  if (corner.indexOf("s") !== -1) {
    height = Math.max(to.y - y, MIN_ZONE_SIZE);
  }
  return { x, y, width, height };
}

/* ------------------------------------------------------------------ *
 * Runtime helpers
 * ------------------------------------------------------------------ */

function currentScene() {
  if (typeof canvas !== "undefined" && canvas?.scene) return canvas.scene;
  return null;
}

function isGm() {
  if (typeof game === "undefined" || typeof game?.user === "undefined") return true;
  return game.user.isGM === true;
}


