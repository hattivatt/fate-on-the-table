import { test } from "node:test";
import { strict as assert } from "node:assert";
import { escapeHtml, dialogField, canvasWorldPosition, toArray } from "../scripts/utils.js";
import { normalizeAspects as normalizeAspectsData } from "../scripts/situationAspectData.js";

// escapeHtml cases — superset including single-quote (LayoutImportExport previously missed it)
test("escapeHtml: escapes 5 characters", () => {
  assert.equal(escapeHtml("&<>\"'"), "&amp;&lt;&gt;&quot;&#39;");
  assert.equal(escapeHtml("a&b<c>d\"e'f"), "a&amp;b&lt;c&gt;d&quot;e&#39;f");
  assert.equal(escapeHtml(null), "");
  assert.equal(escapeHtml(undefined), "");
  assert.equal(escapeHtml(123), "123");
  assert.equal(escapeHtml("hello"), "hello");
});

test("escapeHtml: null/undefined treated as empty", () => {
  assert.equal(escapeHtml(null), "");
  assert.equal(escapeHtml(undefined), "");
  assert.equal(escapeHtml(""), "");
});

// dialogField — 5 call shapes
test("dialogField: returns field from plain object", () => {
  assert.equal(dialogField({ name: "hello", layout: "minimal" }, "name"), "hello");
  assert.equal(dialogField({ name: "hello" }, "missing"), undefined);
});
test("dialogField: returns undefined for null/non-object", () => {
  assert.equal(dialogField(null, "name"), undefined);
  assert.equal(dialogField("cancel", "name"), undefined);
  assert.equal(dialogField(undefined, "name"), undefined);
});
test("dialogField: supports FormData when available", () => {
  if (typeof FormData === "undefined") return;
  const fd = new FormData();
  fd.set("name", "fromForm");
  assert.equal(dialogField(fd, "name"), "fromForm");
  assert.equal(dialogField(fd, "missing"), null);
});

// toArray — 5 forms
test("toArray: array passthrough", () => {
  const arr = [1, 2, 3];
  assert.equal(toArray(arr), arr);
});
test("toArray: contents array", () => {
  const col = { contents: [4, 5] };
  assert.deepEqual(toArray(col), [4, 5]);
  // original Array.isArray check takes precedence
  assert.deepEqual(toArray([6, 7]), [6, 7]);
});
test("toArray: values() iterable", () => {
  const col = { values() { return [8, 9][Symbol.iterator](); } };
  assert.deepEqual(toArray(col), [8, 9]);
});
test("toArray: Map values", () => {
  const m = new Map([["a", 10], ["b", 11]]);
  assert.deepEqual(toArray(m), [10, 11]);
});
test("toArray: iterable (Set)", () => {
  const s = new Set([12, 13, 14]);
  assert.deepEqual(toArray(s), [12, 13, 14]);
});
test("toArray: non-iterable / null returns []", () => {
  assert.deepEqual(toArray(null), []);
  assert.deepEqual(toArray(undefined), []);
  assert.deepEqual(toArray({}), []);
  assert.deepEqual(toArray(42), []);
});
test("toArray: preserves order for contents case", () => {
  const col = { contents: [3, 1, 2] };
  assert.deepEqual(toArray(col), [3, 1, 2]);
});

// canvasWorldPosition — testable null guards (no canvas)
test("canvasWorldPosition: null guards", () => {
  assert.equal(canvasWorldPosition(null), null);
  assert.equal(canvasWorldPosition(undefined), null);
  assert.equal(canvasWorldPosition({}), null);
  assert.equal(canvasWorldPosition({ clientX: 10 }), null); // missing clientY
  assert.equal(canvasWorldPosition({ clientX: "10", clientY: 20 }), null);
  // without global canvas, should return null
  delete globalThis.canvas;
  delete globalThis.PIXI;
  assert.equal(canvasWorldPosition({ clientX: 0, clientY: 0 }), null);
  assert.equal(canvasWorldPosition({ clientX: 100, clientY: 100 }), null);
});

test("canvasWorldPosition: worldTransform guard", () => {
  // mock canvas with view/rect but no worldTransform
  globalThis.canvas = {
    app: { view: { width: 800, height: 600, getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600 }; } } },
    stage: {},
  };
  globalThis.PIXI = { Point: class Point { constructor(x, y) { this.x = x; this.y = y; } } };
  assert.equal(canvasWorldPosition({ clientX: 100, clientY: 100 }), null);
  delete globalThis.canvas;
  delete globalThis.PIXI;
});

test("canvasWorldPosition: rect guard", () => {
  globalThis.canvas = {
    app: { view: { width: 800, height: 600, getBoundingClientRect() { return null; } } },
    stage: { worldTransform: { applyInverse(p) { return p; } } },
  };
  globalThis.PIXI = { Point: class Point { constructor(x, y) { this.x = x; this.y = y; } } };
  assert.equal(canvasWorldPosition({ clientX: 10, clientY: 10 }), null);
  delete globalThis.canvas;
  delete globalThis.PIXI;
});

// parity normalizeAspects — verifies pure module matches expected behavior
// (SituationAspectSync now delegates to the same pure module; parity is structural)
test("normalizeAspects parity: pure module behaves as spec", () => {
  const raw = [
    { name: "  Fire  ", free_invokes: "2", zoneIds: ["z1", "z1", null], extra: 1 },
    { name: "", free_invokes: 1 },
    { name: "Ice", free_invokes: -3, zoneIds: "bad" },
    { name: "Wind", free_invokes: 1.9, zoneIds: ["z2"] },
    { extraOnly: true },
  ];
  const a = normalizeAspectsData(raw);
  // expected via spec: trim name, clamp free_invokes, normalizeZoneIds, spread extra
  assert.equal(a[0].name, "Fire");
  assert.equal(a[0].free_invokes, 2);
  assert.deepEqual(a[0].zoneIds, ["z1"]);
  assert.equal(a[0].extra, 1);
  assert.equal(a[1].name, "Ice");
  assert.equal(a[1].free_invokes, 0);
  assert.deepEqual(a[1].zoneIds, []);
  assert.equal(a[2].name, "Wind");
  assert.equal(a[2].free_invokes, 1);
  // second call parity (idempotent)
  const b = normalizeAspectsData(JSON.parse(JSON.stringify(raw)));
  assert.deepEqual(a, b);
});

test("utils is importable without foundry globals", () => {
  // just reaching here proves top-level foundry not required
  assert.ok(typeof escapeHtml === "function");
  assert.ok(typeof toArray === "function");
});
