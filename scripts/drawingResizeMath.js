/**
 * drawingResizeMath — pure, Foundry-free resize math for module-owned
 * challenge / contest drawings.
 *
 * WHY THIS EXISTS
 * Foundry v14 replaced the legacy `Drawing` resize handlers with
 * `DrawingShapeControls` + `RectangleShapeData.moveControlHandle("scale")`.
 * Its default (non-`unlinked`) "scale" (corner) branch CONSTRAINS the aspect
 * ratio: the shorter axis is recomputed from the longer one, so a challenge /
 * contest block can never change width and height independently. The module
 * wants width and height to change independently.
 *
 * The thin glue in `drawingFreeResize.js` wraps `DrawingShapeControls` ONLY for
 * documents flagged with the module's challenge / contest `ownerType` and
 * recomputes the committed geometry through `freeResizeUpdate` below. Foreign
 * drawings keep the native aspect-preserving behaviour.
 *
 * This module never touches top-level `foundry` / `game` / `canvas` / `CONST`,
 * so it imports cleanly in Node tests.
 */

/** Smallest width/height the free resize may produce (document units). */
export const MIN_FREE_RESIZE = 10;

/**
 * Coerces a value to a finite number, else `fallback`.
 * @param {*} value
 * @param {number} fallback
 * @returns {number}
 */
function finiteOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Sanitizes a geometry object into `{x, y, width, height}` with finite values.
 * A missing/invalid `current` degrades to the zero geometry, which callers can
 * return as a safe identity.
 * @param {*} geometry
 * @returns {{x: number, y: number, width: number, height: number}}
 */
function sanitizeGeometry(geometry) {
  const source = geometry && typeof geometry === "object" ? geometry : {};
  return {
    x: finiteOr(source.x, 0),
    y: finiteOr(source.y, 0),
    width: finiteOr(source.width, 0),
    height: finiteOr(source.height, 0),
  };
}

/**
 * Computes an aspect-FREE rectangle resize from the drag geometry.
 *
 * Semantics (top-left `{x, y}`, document units):
 *   - `current`  — the shape geometry at drag start (top-left corner). Used as
 *     the base for `x`/`y` and as the identity fallback.
 *   - `origin`   — the drag state at pointer-down:
 *       `x`, `y`               pointer position at drag start;
 *       `width`, `height`      shape size at drag start;
 *       `anchorX`, `anchorY`   optional 0|1 fixed edge (0 = left/top edge is
 *                              pinned, 1 = right/bottom edge is pinned);
 *                              defaults to `0` (top-left pinned, the native
 *                              bottom-right corner handle).
 *       `axes`                 optional `{x, y}` of booleans selecting which
 *                              axes may change; defaults to both. An edge
 *                              handle passes only one active axis.
 *   - `destination` — pointer position while dragging.
 *   - `locked`   — when truthy the resize is refused and `current` is returned.
 *
 * Returns a NEW `{x, y, width, height}` object. `x`/`y` are the top-left corner
 * of the resized rectangle; width/height are clamped to `MIN_FREE_RESIZE`.
 * Rotation is intentionally NOT part of this math (callers skip rotated docs).
 *
 * @param {{
 *   current?: {x?: number, y?: number, width?: number, height?: number},
 *   origin?: {x?: number, y?: number, width?: number, height?: number,
 *     anchorX?: number, anchorY?: number, axes?: {x?: boolean, y?: boolean}},
 *   destination?: {x?: number, y?: number},
 *   locked?: boolean,
 * }} [input]
 * @returns {{x: number, y: number, width: number, height: number}}
 */
export function freeResizeUpdate({ current, origin, destination, locked } = {}) {
  const base = sanitizeGeometry(current);
  // Locked drawings never resize; an invalid pointer capture is a safe no-op.
  if (locked) return { ...base };
  if (!origin || typeof origin !== "object") return { ...base };
  if (!destination || typeof destination !== "object") return { ...base };

  const originWidth = Number(origin.width);
  const originHeight = Number(origin.height);
  const originX = Number(origin.x);
  const originY = Number(origin.y);
  const destinationX = Number(destination.x);
  const destinationY = Number(destination.y);
  // A degenerate origin (zero/unknown size or pointer) must not produce NaN /
  // negative geometries — leave the shape exactly as it is.
  if (
    !Number.isFinite(originWidth) ||
    !Number.isFinite(originHeight) ||
    !Number.isFinite(originX) ||
    !Number.isFinite(originY) ||
    !Number.isFinite(destinationX) ||
    !Number.isFinite(destinationY) ||
    originWidth <= 0 ||
    originHeight <= 0
  ) {
    return { ...base };
  }

  const axes = {
    x: origin.axes?.x !== false,
    y: origin.axes?.y !== false,
  };
  const anchorX = origin.anchorX === 1 ? 1 : 0;
  const anchorY = origin.anchorY === 1 ? 1 : 0;

  // Independent per-axis deltas: the corner handle moves both axes, an edge
  // handle moves only its own (the other axis keeps its delta at zero).
  const dx = axes.x ? destinationX - originX : 0;
  const dy = axes.y ? destinationY - originY : 0;

  const width = Math.max(
    MIN_FREE_RESIZE,
    anchorX === 0 ? originWidth + dx : originWidth - dx,
  );
  const height = Math.max(
    MIN_FREE_RESIZE,
    anchorY === 0 ? originHeight + dy : originHeight - dy,
  );

  // Keep the pinned edge stationary.
  const x = anchorX === 0 ? base.x : base.x + base.width - width;
  const y = anchorY === 0 ? base.y : base.y + base.height - height;

  return { x, y, width, height };
}
