/**
 * Node tests for `drawingResizeMath.freeResizeUpdate` — the aspect-free resize
 * math behind the challenge / contest free-resize patch.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  MIN_FREE_RESIZE,
  freeResizeUpdate,
} from "../scripts/drawingResizeMath.js";

const CURRENT = { x: 100, y: 50, width: 200, height: 100 };

test("corner drag changes width and height independently (no aspect lock)", () => {
  const result = freeResizeUpdate({
    current: CURRENT,
    origin: { x: 0, y: 0, width: 200, height: 100 },
    destination: { x: -50, y: 30 },
  });
  assert.deepEqual(result, { x: 100, y: 50, width: 150, height: 130 });
  // Both axes moved by their OWN delta (a locked resize would have kept the
  // 2:1 ratio, e.g. width 150 -> height 75).
  assert.equal(result.width, CURRENT.width - 50);
  assert.equal(result.height, CURRENT.height + 30);
});

test("a pure horizontal drag leaves height untouched", () => {
  const result = freeResizeUpdate({
    current: CURRENT,
    origin: { x: 0, y: 0, width: 200, height: 100 },
    destination: { x: 40, y: 0 },
  });
  assert.equal(result.width, 240);
  assert.equal(result.height, 100);
  assert.deepEqual(result, { x: 100, y: 50, width: 240, height: 100 });
});

test("a pure vertical drag leaves width untouched", () => {
  const result = freeResizeUpdate({
    current: CURRENT,
    origin: { x: 0, y: 0, width: 200, height: 100 },
    destination: { x: 0, y: -25 },
  });
  assert.equal(result.width, 200);
  assert.equal(result.height, 75);
});

test("edge handle (axes) only changes its own axis", () => {
  const result = freeResizeUpdate({
    current: CURRENT,
    origin: {
      x: 0,
      y: 0,
      width: 200,
      height: 100,
      axes: { x: false, y: true },
    },
    destination: { x: 999, y: 25 },
  });
  assert.equal(result.width, 200);
  assert.equal(result.height, 125);
});

test("width and height clamp to MIN_FREE_RESIZE", () => {
  assert.equal(MIN_FREE_RESIZE, 10);
  const result = freeResizeUpdate({
    current: CURRENT,
    origin: { x: 0, y: 0, width: 200, height: 100 },
    destination: { x: -5000, y: -5000 },
  });
  assert.equal(result.width, MIN_FREE_RESIZE);
  assert.equal(result.height, MIN_FREE_RESIZE);
});

test("locked refuses the resize and returns the current geometry", () => {
  const result = freeResizeUpdate({
    current: CURRENT,
    origin: { x: 0, y: 0, width: 200, height: 100 },
    destination: { x: 999, y: 999 },
    locked: true,
  });
  assert.deepEqual(result, CURRENT);
});

test("right/bottom anchored growth keeps the pinned edge stationary", () => {
  const result = freeResizeUpdate({
    current: { x: 100, y: 50, width: 200, height: 100 },
    origin: {
      x: 0,
      y: 0,
      width: 200,
      height: 100,
      anchorX: 1,
      anchorY: 1,
    },
    destination: { x: -50, y: -20 },
  });
  assert.equal(result.width, 250);
  assert.equal(result.height, 120);
  // Right edge of the current rect (100 + 200 = 300) stays fixed.
  assert.equal(result.x + result.width, 300);
  // Bottom edge (50 + 100 = 150) stays fixed.
  assert.equal(result.y + result.height, 150);
});

test("a zero / missing origin is a safe identity (no NaN geometry)", () => {
  const zero = freeResizeUpdate({
    current: CURRENT,
    origin: { x: 0, y: 0, width: 0, height: 0 },
    destination: { x: 10, y: 10 },
  });
  assert.deepEqual(zero, CURRENT);

  assert.deepEqual(
    freeResizeUpdate({ current: CURRENT, destination: { x: 1, y: 2 } }),
    CURRENT,
  );
  assert.deepEqual(freeResizeUpdate({ current: CURRENT }), CURRENT);
  assert.deepEqual(freeResizeUpdate({}), { x: 0, y: 0, width: 0, height: 0 });
});

test("non-finite pointer input degrades to the current geometry", () => {
  const result = freeResizeUpdate({
    current: CURRENT,
    origin: { x: 0, y: 0, width: 200, height: 100 },
    destination: { x: NaN, y: 10 },
  });
  assert.deepEqual(result, CURRENT);
});

test("uses a fresh object and never mutates the inputs", () => {
  const current = { ...CURRENT };
  const origin = { x: 0, y: 0, width: 200, height: 100 };
  const destination = { x: -50, y: 30 };
  const result = freeResizeUpdate({ current, origin, destination });
  assert.notEqual(result, current);
  assert.deepEqual(current, CURRENT);
  assert.deepEqual(origin, { x: 0, y: 0, width: 200, height: 100 });
  assert.deepEqual(destination, { x: -50, y: 30 });
});
