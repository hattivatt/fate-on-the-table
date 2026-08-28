import { test } from "node:test";
import assert from "node:assert/strict";
import { turnMarkerPatchFor, collectTurnMarkerPatches, TURN_MARKER_SETTING } from "../scripts/turnMarkerQol.js";
import { TURN_MARKER_SETTING as CONST_SETTING } from "../scripts/constants.js";

test("TURN_MARKER_SETTING constant is autoTurnMarker", () => {
  assert.equal(TURN_MARKER_SETTING, "autoTurnMarker");
  assert.equal(CONST_SETTING, "autoTurnMarker");
});

test("turnMarkerPatchFor: mode 0 -> patch with mode 1 preserves fields", () => {
  const tm = { mode: 0, animation: "spin", src: "icons/marker.svg", disposition: 1 };
  const patch = turnMarkerPatchFor(tm);
  assert.deepEqual(patch, { mode: 1, animation: "spin", src: "icons/marker.svg", disposition: 1 });
  // original not mutated? shallow copy retains
  assert.equal(tm.mode, 0);
  // minimal object mode 0 string?
  const patchStr = turnMarkerPatchFor({ mode: "0" });
  assert.equal(patchStr.mode, 1);
});

test("turnMarkerPatchFor: mode 1/2 -> null", () => {
  assert.equal(turnMarkerPatchFor({ mode: 1, animation: "a" }), null);
  assert.equal(turnMarkerPatchFor({ mode: 2 }), null);
  assert.equal(turnMarkerPatchFor({ mode: "1" }), null);
  assert.equal(turnMarkerPatchFor({ mode: "2" }), null);
});

test("turnMarkerPatchFor: undefined/null/garbage -> null", () => {
  assert.equal(turnMarkerPatchFor(undefined), null);
  assert.equal(turnMarkerPatchFor(null), null);
  assert.equal(turnMarkerPatchFor(42), null);
  assert.equal(turnMarkerPatchFor("0"), null);
  assert.equal(turnMarkerPatchFor([]), null);
  assert.equal(turnMarkerPatchFor({}), null); // missing mode -> Number(undefined)=NaN => not 0 => null
});

test("turnMarkerPatchFor: does not invent structure for missing field", () => {
  // undefined input should be no-op
  assert.equal(turnMarkerPatchFor(undefined), null);
  // null -> no-op
  assert.equal(turnMarkerPatchFor(null), null);
});

test("collectTurnMarkerPatches: collects only mode 0 tokens", () => {
  const tokens = [
    { id: "t1", turnMarker: { mode: 0, src: "a" } },
    { id: "t2", turnMarker: { mode: 1 } },
    { id: "t3", turnMarker: { mode: 0, animation: "x" } },
    { id: "t4" }, // missing turnMarker -> null patch -> skipped
    null,
    { id: "t5", turnMarker: null },
  ];
  const patches = collectTurnMarkerPatches(tokens);
  assert.equal(patches.length, 2);
  const ids = patches.map((p) => p.id ?? p._id).sort();
  assert.deepEqual(ids, ["t1", "t3"]);
  const p1 = patches.find((p) => (p.id ?? p._id) === "t1");
  assert.equal(p1.patch.mode, 1);
  assert.equal(p1.turnMarker.mode, 1);
  assert.equal(p1.patch.src, "a");
  const p3 = patches.find((p) => (p.id ?? p._id) === "t3");
  assert.equal(p3.patch.animation, "x");
});

test("collectTurnMarkerPatches: handles _id and document wrapper", () => {
  const tokens = [
    { _id: "tokA", document: { turnMarker: { mode: 0 } } },
    { id: "tokB", document: { turnMarker: { mode: 0, disposition: 2 } } },
  ];
  const patches = collectTurnMarkerPatches(tokens);
  assert.equal(patches.length, 2);
});
