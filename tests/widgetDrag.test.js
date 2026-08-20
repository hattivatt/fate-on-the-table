/**
 * Node tests for widgetDrag.js — the drag-propagation guard that prevents
 * conflict projections from being desynced by free canvas drags.
 *
 * The hook (`preUpdateDrawing`/`preUpdateTile`) is registered through the
 * module's public `initWidgetDrag()`; a minimal `Hooks` stub captures the
 * handler. No Foundry runtime beyond the stub is needed: the guarded branches
 * (`CONFLICT_CARD_OWNER_TYPE`, `CONFLICT_BOARD_OWNER_TYPE`, non-GM
 * `CONFLICT_ZONE_OWNER_TYPE`) never reach the canvas.
 */

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  FLAG_SCOPE,
  CONFLICT_ZONE_OWNER_TYPE,
  CONFLICT_CARD_OWNER_TYPE,
} from "../scripts/constants.js";
import { CONFLICT_BOARD_OWNER_TYPE } from "../scripts/ConflictBoardSync.js";

let handler = null;
globalThis.Hooks = {
  on(name, fn) {
    if (name === "preUpdateDrawing" || name === "preUpdateTile") handler = fn;
  },
};

const { initWidgetDrag } = await import("../scripts/widgetDrag.js");
initWidgetDrag();
assert.ok(handler, "the drag guard must be registered");

afterEach(() => {
  delete globalThis.game;
  delete globalThis.canvas;
});

function doc(ownerType) {
  return {
    id: "d1",
    getFlag(scope, key) {
      if (scope !== FLAG_SCOPE) return undefined;
      return ownerType;
    },
  };
}

test("conflict card moves are rejected outright", () => {
  assert.equal(handler(doc(CONFLICT_CARD_OWNER_TYPE), { x: 10 }, {}, "u"), false);
});

test("board-level part moves are rejected (origin is never moved by a drag)", () => {
  assert.equal(
    handler(doc(CONFLICT_BOARD_OWNER_TYPE), { x: 10, y: 5 }, {}, "u"),
    false,
  );
});

test("non-GM users cannot move conflict zones", () => {
  globalThis.game = { user: { isGM: false } };
  assert.equal(handler(doc(CONFLICT_ZONE_OWNER_TYPE), { x: 10 }, {}, "u"), false);
});

test("GM zone moves pass through to the propagation path", () => {
  globalThis.game = { user: { isGM: true } };
  // `canvas` is absent in Node: propagate() safely no-ops instead of throwing.
  assert.equal(handler(doc(CONFLICT_ZONE_OWNER_TYPE), { x: 10 }, {}, "u"), undefined);
});

test("module-owned sync writes are never rejected", () => {
  assert.equal(
    handler(
      doc(CONFLICT_CARD_OWNER_TYPE),
      { x: 10 },
      { fateOnTheTableSync: true },
      "u",
    ),
    undefined,
  );
});

test("non-position changes do not enter the guard", () => {
  assert.equal(handler(doc(CONFLICT_CARD_OWNER_TYPE), { text: "hi" }, {}, "u"), undefined);
});

test("documents without a widget flag are ignored", () => {
  assert.equal(handler({ getFlag: () => undefined }, { x: 10 }, {}, "u"), undefined);
});
