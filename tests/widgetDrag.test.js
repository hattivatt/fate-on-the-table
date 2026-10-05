/**
 * Node tests for widgetDrag.js — the drag-propagation guard that prevents
 * conflict projections from being desynced by free canvas drags.
 *
 * The hook (`preUpdateDrawing`/`preUpdateTile`) is registered through the
 * module's public `initWidgetDrag()`; a minimal `Hooks` stub captures the
 * handler. No Foundry runtime beyond the stub is needed: the guarded branches
 * (`CONFLICT_CARD_OWNER_TYPE`, `CONFLICT_BOARD_OWNER_TYPE`, non-GM
 * `CONFLICT_ZONE_OWNER_TYPE`, non-GM contest) never reach the canvas.
 *
 * A challenge block is now ONE drawing with native move/resize, so this guard
 * no longer intercepts it; the legacy multi-drawing propagation test stays as
 * a regression guard for the generic `propagate()` path.
 */

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  FLAG_SCOPE,
  CONFLICT_ZONE_OWNER_TYPE,
  CONFLICT_CARD_OWNER_TYPE,
  CHALLENGE_OWNER_TYPE,
  CONTEST_OWNER_TYPE,
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

/* ------------------------------------------------------------------ *
 * Challenge / Contest block drag
 * ------------------------------------------------------------------ */

function challengeRow(id, x, y, ownerType = CHALLENGE_OWNER_TYPE) {
  return {
    id,
    documentName: "Drawing",
    x,
    y,
    getFlag(scope, key) {
      if (scope !== FLAG_SCOPE) return undefined;
      if (key === "widgetId") return "w-ch";
      if (key === "ownerType") return ownerType;
      return undefined;
    },
  };
}

test("a challenge block now moves natively (no interception)", async () => {
  // The challenge block is a single drawing: the guard must not reject it, so
  // Foundry's native move/resize owns the interaction for every user.
  globalThis.game = { user: { isGM: false } };
  globalThis.canvas = {
    scene: { drawings: [], tiles: [], async updateEmbeddedDocuments() {} },
  };
  assert.equal(handler(challengeRow("row-0", 0, 0), { x: 10 }, {}, "u"), undefined);
  await new Promise((resolve) => setTimeout(resolve, 0));
});

test("non-GM users cannot drag a contest block", () => {
  globalThis.game = { user: { isGM: false } };
  assert.equal(
    handler(challengeRow("contest", 0, 0, CONTEST_OWNER_TYPE), { x: 10 }, {}, "u"),
    false,
  );
});

test("moving a legacy challenge drawing propagates the delta to its siblings (marked)", async () => {
  const calls = [];
  const source = challengeRow("row-0", 100, 200);
  const row1 = challengeRow("row-1", 100, 290);
  const strike = challengeRow("strike-0", 104, 219);
  globalThis.game = { user: { isGM: true } };
  globalThis.canvas = {
    scene: {
      drawings: [source, row1, strike],
      tiles: [],
      async updateEmbeddedDocuments(name, updates, options) {
        calls.push({ name, updates, options });
      },
    },
  };

  assert.equal(handler(source, { x: 150, y: 230 }, {}, "u"), undefined);
  // `propagate` is async; let its embedded write settle.
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "Drawing");
  assert.equal(calls[0].options.fateOnTheTableSync, true);
  const updates = [...calls[0].updates].sort((a, b) => a._id.localeCompare(b._id));
  assert.deepEqual(updates, [
    { _id: "row-1", x: 150, y: 320 },
    { _id: "strike-0", x: 154, y: 249 },
  ]);
  // The dragged source itself is moved by Foundry's own (unmarked) update.
  assert.equal(updates.some((u) => u._id === "row-0"), false);
});
