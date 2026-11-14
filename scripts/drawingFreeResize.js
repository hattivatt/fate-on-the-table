/**
 * drawingFreeResize — thin Foundry glue that gives module-owned challenge /
 * contest drawings an aspect-FREE manual resize (independent width / height).
 *
 * The module's challenge / contest blocks are ONE Drawing each (ownerType
 * `challenge` / `contest`). In Foundry v14 the core `DrawingShapeControls`
 * corner "scale" handle preserves the aspect ratio
 * (`RectangleShapeData.moveControlHandle("scale")`), so dragging any handle
 * changes width and height together. The module wants width and height to
 * change independently, so this wrapper does that ONLY for our drawings.
 *
 * Design:
 *  - wrap `foundry.canvas.placeables.drawings.DrawingShapeControls.prototype`
 *    through `wrapMethod` (patchMethod.js: libWrapper "WRAPPER" when
 *    available, direct patch otherwise; classes resolved lazily, never at
 *    import time):
 *      `_onDragMove`           — recompute the live preview shape freely;
 *      `_prepareDragDropUpdate` — recompute the committed update freely.
 *  - every wrapper calls the original first, then only overrides the shape for
 *    documents whose module `ownerType` is `challenge` / `contest`; a foreign
 *    drawing (or a rotated one) keeps the native flow untouched.
 *  - `freeResizeUpdate` (pure, testable) computes the geometry; fontSize is
 *    NEVER touched (only `x`, `y`, `shape.width`, `shape.height` are written).
 *  - when the core classes / hooks are missing the patch stays inert and warns
 *    once, so unknown Foundry builds simply keep their native behaviour.
 *
 * No top-level `foundry` / `game` / `canvas` access: the module imports cleanly
 * in Node tests.
 */

import {
  FLAG_SCOPE,
  CHALLENGE_OWNER_TYPE,
  CONTEST_OWNER_TYPE,
} from "./constants.js";
import { freeResizeUpdate } from "./drawingResizeMath.js";
import { wrapMethod } from "./patchMethod.js";

/** Global path of the wrapped prototype (libWrapper target prefix). */
const SHAPE_CONTROLS_PATH =
  "foundry.canvas.placeables.drawings.DrawingShapeControls.prototype";

/** Owner types that receive the free resize. */
const FREE_RESIZE_OWNER_TYPES = new Set([
  CHALLENGE_OWNER_TYPE,
  CONTEST_OWNER_TYPE,
]);

/** True once the DrawingShapeControls prototype has been wrapped. */
let patched = false;

/** True once a diagnostic warning was emitted (avoid console spam). */
let warnedOnce = false;

/** Emits a single diagnostic warning. */
function warnOnce(message) {
  if (warnedOnce) return;
  warnedOnce = true;
  console.warn(`[fate-on-the-table] ${message}`);
}

/**
 * True when a Drawing document is a module-owned challenge / contest block that
 * should resize on independent axes. Pure (uses only `doc.getFlag`), so it is
 * safe to unit-test under Node.
 * @param {object} doc  Drawing document (or shape-bearing document).
 * @returns {boolean}
 */
export function isFreeResizeTarget(doc) {
  if (!doc?.getFlag) return false;
  const ownerType = doc.getFlag(FLAG_SCOPE, "ownerType");
  return FREE_RESIZE_OWNER_TYPES.has(ownerType);
}

/**
 * Installs the free-resize wrapper. Idempotent and Foundry-tolerant: it is a
 * no-op when the classes are unavailable and can be called again later (e.g.
 * from the `ready` hook) until the prototype is actually wrapped.
 */
export function initDrawingFreeResize() {
  if (patched) return;
  if (typeof foundry === "undefined") return;
  const ShapeControls =
    foundry.canvas?.placeables?.drawings?.DrawingShapeControls;
  const proto = ShapeControls?.prototype;
  if (
    !proto ||
    typeof proto._onDragMove !== "function" ||
    typeof proto._prepareDragDropUpdate !== "function"
  ) {
    warnOnce(
      "DrawingShapeControls resize hooks unavailable — challenge/contest drawings keep the native resize",
    );
    return;
  }
  wrapShapeControls(proto);
  patched = true;
}

/**
 * Wraps the two DrawingShapeControls resize hooks. Each wrapper calls the
 * original first so native canvas pan / preview bookkeeping is preserved, then
 * (for our drawings only) overwrites the resulting shape with the free math.
 * @param {object} proto  `DrawingShapeControls.prototype`.
 */
function wrapShapeControls(proto) {
  const spec = (method) => ({
    cls: "DrawingShapeControls",
    path: SHAPE_CONTROLS_PATH,
    method,
  });
  wrapMethod(
    proto,
    spec("_onDragMove"),
    function (wrapped, event, ...rest) {
      const result = wrapped(event, ...rest);
      try {
        if (isFreeResizeTarget(this.document)) applyFreeResizeToPreview(this, event);
      } catch (err) {
        warnOnce(`free resize preview failed: ${err?.message ?? err}`);
      }
      return result;
    },
    { type: "WRAPPER" },
  );

  wrapMethod(
    proto,
    spec("_prepareDragDropUpdate"),
    function (wrapped, event, ...rest) {
      const base = wrapped(event, ...rest);
      if (!isFreeResizeTarget(this.document)) return base;
      const free = computeFreeResize(this, event);
      if (!free) return base;
      return {
        ...base,
        x: free.x,
        y: free.y,
        shape: { ...(base?.shape ?? {}), width: free.width, height: free.height },
      };
    },
    { type: "WRAPPER" },
  );
}

/**
 * Recomputes the LIVE preview shape freely. `DrawingShapeControls` keeps the
 * rectangle as a CENTER-based shape (`anchorX/anchorY` default 0.5) and the
 * layer preview derives the committed top-left from `shape.x - width/2`, so the
 * center is moved to keep the pinned (top-left) corner stationary.
 * @param {object} controls  DrawingShapeControls instance.
 * @param {object} event     Drag event.
 * @returns {boolean}  True when the preview was overwritten.
 */
function applyFreeResizeToPreview(controls, event) {
  const it = event?.interactionData;
  if (!it || it.handle?.name !== "scale" || !it.shape?.updateSource) return false;
  const free = computeFreeResize(controls, event);
  if (!free) return false;
  it.shape.updateSource({
    x: free.x + free.width / 2,
    y: free.y + free.height / 2,
    width: free.width,
    height: free.height,
  });
  controls._updateDragPreview(event);
  return true;
}

/**
 * Computes the free rectangle geometry for a corner "scale" drag, or `null`
 * when this drag is not a module-owned, axis-aligned corner resize (so the
 * caller leaves the native result untouched).
 * @param {object} controls  DrawingShapeControls instance.
 * @param {object} event     Drag event.
 * @returns {{x: number, y: number, width: number, height: number}|null}
 */
function computeFreeResize(controls, event) {
  const it = event?.interactionData;
  const doc = controls?.document;
  const source = doc?._source;
  if (!it || it.handle?.name !== "scale" || !source) return null;
  // Rotated blocks are left to the native flow: their pinned corner is not the
  // axis-aligned top-left this math assumes (rotation itself is never touched).
  const rotation = Number(source.rotation) || 0;
  if (Math.abs(rotation) > 1e-6) return null;
  const origin = it.origin;
  const destination = it.destination;
  if (!origin || !destination) return null;

  const shape = source.shape ?? {};
  const width = Number(shape.width);
  const height = Number(shape.height);
  if (!(width > 0) || !(height > 0)) return null;

  const { anchorX, anchorY } = scaleAnchor(controls);
  const result = freeResizeUpdate({
    current: {
      x: Number(source.x) || 0,
      y: Number(source.y) || 0,
      width,
      height,
    },
    origin: {
      x: Number(origin.x),
      y: Number(origin.y),
      width,
      height,
      anchorX,
      anchorY,
    },
    destination: { x: Number(destination.x), y: Number(destination.y) },
    locked: doc?.locked === true,
  });
  if (!result) return null;
  return {
    x: Math.round(result.x),
    y: Math.round(result.y),
    width: Math.round(result.width),
    height: Math.round(result.height),
  };
}

/**
 * Resolves which edges are pinned for the active "scale" corner: `0` = the
 * left/top edge is stationary, `1` = the right/bottom edge. Derived from the
 * corner handle's position relative to the shape center; falls back to the
 * native bottom-right handle convention (top-left pinned) when unavailable.
 * @param {object} controls  DrawingShapeControls instance.
 * @returns {{anchorX: 0|1, anchorY: 0|1}}
 */
function scaleAnchor(controls) {
  const shape = controls?.shape;
  const position = shape?.controlHandles?.scale?.position;
  const centerX = Number(shape?.x);
  const centerY = Number(shape?.y);
  if (
    !position ||
    !Number.isFinite(centerX) ||
    !Number.isFinite(centerY)
  ) {
    return { anchorX: 0, anchorY: 0 };
  }
  return {
    anchorX: Number(position.x) < centerX ? 1 : 0,
    anchorY: Number(position.y) < centerY ? 1 : 0,
  };
}
