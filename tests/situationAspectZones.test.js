/**
 * Node tests for the situation-aspect <-> conflict-board ZONE binding:
 *
 * - `hasConflictBoardOnScene` (ConflictBoardSync.js): the
 *   "board is actually placed" guard;
 * - `buildBoundName` / `parseBinding` (situationAspectNames.js): the pure
 *   textual `${base} (${choice})` suffix format used by both inline forms of
 *   the SituationAspectManager.
 *
 * No Foundry runtime is stubbed — only plain mock objects, mirroring
 * conflictBoardSync.test.js.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  readConflictBoard,
  hasConflictBoardOnScene,
} from "../scripts/ConflictBoardSync.js";
import {
  buildBoundName,
  parseBinding,
} from "../scripts/situationAspectNames.js";
import { FLAG_SCOPE } from "../scripts/constants.js";
import { CONFLICT_BOARD_VERSION } from "../scripts/conflictBoardSchema.js";

/* ------------------------------------------------------------------ *
 * Mocks (plain objects, no globals)
 * ------------------------------------------------------------------ */

function mockScene(flags = {}) {
  return {
    id: "scene1",
    flags,
    getFlag(scope, key) {
      return this.flags[scope]?.[key];
    },
  };
}

/** Minimal schema-v1 state that passes normalizeConflictBoard. */
function validState(overrides = {}) {
  return {
    version: CONFLICT_BOARD_VERSION,
    combatId: "combat-abc",
    sizePreset: "medium",
    board: { origin: { x: 1000, y: 800 } },
    zones: [],
    cards: {},
    ...overrides,
  };
}

function sceneWithZones(zones, { withRegistry = true } = {}) {
  const raw = validState({ zones });
  return mockScene({
    [FLAG_SCOPE]: {
      conflictBoard: raw,
      ...(withRegistry ? { conflictBoardWidget: { widgetId: "wBoard" } } : {}),
    },
  });
}

function zone(id, name) {
  return {
    id,
    name,
    rect: { x: 10, y: 10, width: 100, height: 100 },
  };
}

/* ------------------------------------------------------------------ *
 * hasConflictBoardOnScene
 * ------------------------------------------------------------------ */

test("hasConflictBoardOnScene: false without a scene or a board flag", () => {
  assert.equal(hasConflictBoardOnScene(null), false);
  assert.equal(hasConflictBoardOnScene(undefined), false);
  assert.equal(hasConflictBoardOnScene(mockScene()), false);
});

test("hasConflictBoardOnScene: false for an INVALID board state", () => {
  // A broken flag never produces a board even when a stale registry exists.
  const scene = mockScene({
    [FLAG_SCOPE]: {
      conflictBoard: { version: 999, combatId: "c" },
      conflictBoardWidget: { widgetId: "wBoard" },
    },
  });
  assert.equal(readConflictBoard(scene), null);
  assert.equal(hasConflictBoardOnScene(scene), false);
});

test("hasConflictBoardOnScene: false for state without a registry record", () => {
  // The board was never placed (or its projection was removed).
  const scene = sceneWithZones([zone("z1", "Room")], { withRegistry: false });
  assert.ok(readConflictBoard(scene));
  assert.equal(hasConflictBoardOnScene(scene), false);
});

test("hasConflictBoardOnScene: false when the registry lacks a widgetId", () => {
  const scene = sceneWithZones([]);
  scene.flags[FLAG_SCOPE].conflictBoardWidget = {};
  assert.equal(hasConflictBoardOnScene(scene), false);
});

test("hasConflictBoardOnScene: true only for a live board (state + widgetId)", () => {
  const scene = sceneWithZones([zone("z1", "Room")]);
  assert.equal(hasConflictBoardOnScene(scene), true);
});

/* ------------------------------------------------------------------ *
 * buildBoundName
 * ------------------------------------------------------------------ */

test("buildBoundName: no binding returns the trimmed base", () => {
  assert.equal(buildBoundName("Hot fire", {}), "Hot fire");
  assert.equal(buildBoundName("Hot fire"), "Hot fire");
  assert.equal(buildBoundName("  Hot fire  ", { character: "", zone: "" }), "Hot fire");
});

test("buildBoundName: character binding appends exactly one suffix", () => {
  assert.equal(buildBoundName("Hot fire", { character: "Goblin" }), "Hot fire (Goblin)");
});

test("buildBoundName: zone binding uses the same parenthetical format", () => {
  assert.equal(buildBoundName("Hot fire", { zone: "Rooftop" }), "Hot fire (Rooftop)");
});

test("buildBoundName: character wins when both choices are non-empty", () => {
  const name = buildBoundName("Hot fire", { character: "Goblin", zone: "Rooftop" });
  assert.equal(name, "Hot fire (Goblin)");
  // Exactly one suffix — parseBinding must see a clean single group.
  assert.deepEqual(parseBinding(name), { base: "Hot fire", suffix: "Goblin" });
});

test("buildBoundName: empty base yields an empty name", () => {
  assert.equal(buildBoundName("", { character: "Goblin" }), "");
  assert.equal(buildBoundName(null, { zone: "Room" }), "");
});

/* ------------------------------------------------------------------ *
 * parseBinding
 * ------------------------------------------------------------------ */

test("parseBinding: name without a suffix splits to base + empty suffix", () => {
  assert.deepEqual(parseBinding("Dark corridor"), { base: "Dark corridor", suffix: "" });
  assert.deepEqual(parseBinding(""), { base: "", suffix: "" });
  assert.deepEqual(parseBinding(null), { base: "", suffix: "" });
});

test("parseBinding: extracts the trailing parenthetical group", () => {
  assert.deepEqual(parseBinding("Hot fire (Goblin)"), { base: "Hot fire", suffix: "Goblin" });
  assert.deepEqual(parseBinding("Hot fire (Rooftop)"), { base: "Hot fire", suffix: "Rooftop" });
});

test("parseBinding: takes the LAST bracketed group at the end only", () => {
  // Nested-paren tails are NOT a simple binding: no suffix is parsed, so
  // such names survive saving untouched (unknown-suffix path).
  assert.deepEqual(parseBinding("Fire (hot (very))"), {
    base: "Fire (hot (very))",
    suffix: "",
  });
  assert.deepEqual(parseBinding("Fire (very)"), { base: "Fire", suffix: "very" });
  // A mid-string group is NOT a suffix.
  assert.deepEqual(parseBinding("Trap (old) door"), { base: "Trap (old) door", suffix: "" });
});

test("parseBinding: tolerates whitespace and empty groups", () => {
  assert.deepEqual(parseBinding("Hot fire   (Goblin) "), { base: "Hot fire", suffix: "Goblin" });
  assert.deepEqual(parseBinding("Hot ()"), { base: "Hot", suffix: "" });
});

test("parseBinding: a name that is only a suffix has an empty base", () => {
  assert.deepEqual(parseBinding("(Goblin)"), { base: "", suffix: "Goblin" });
});
