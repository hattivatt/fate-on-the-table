/**
 * Node tests for conflictBoardSchema.js — the pure validator/normalizer,
 * reconcile and initial side assignment of the conflict board state
 * (schema v2). Run with `npm test`; no Foundry dependency.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateConflictBoard,
  normalizeConflictBoard,
  reconcileConflictBoard,
  admitMissingCards,
  applyCombatTurnStateToCards,
  assignInitialCardAreas,
  resolveInitialSide,
  resolveDisposition,
  createConflictBoard,
  migrateConflictBoard,
  CONFLICT_BOARD_VERSION,
  SIZE_PRESETS,
  CARD_SIDES,
  CARD_AREAS,
  TOKEN_DISPOSITION,
  DEFAULT_SIZE_PRESET,
  DEFAULT_BACKGROUND,
  DEFAULT_ZONE_STYLE,
} from "../scripts/conflictBoardSchema.js";

const ZONE_UUID = "Scene.scene1.Token.token1";

/** Minimal valid document for mutation-based broken fixtures. */
function validBoard(overrides = {}) {
  return {
    version: CONFLICT_BOARD_VERSION,
    combatId: "combat-abc",
    sizePreset: "medium",
    board: {
      origin: { x: 1000, y: 800 },
      background: { color: "#ffffff", texture: "", alpha: 1 },
    },
    zones: [
      {
        id: "zone-1",
        name: "Центр комнаты",
        rect: { x: 1200, y: 1000, width: 400, height: 300 },
        style: { fill: "#ffffff", alpha: 0.12, stroke: "#000000" },
        sort: 0,
      },
    ],
    cards: {
      "combatant-1": { side: "friendly", area: "side", order: 0 },
      "combatant-2": { side: "hostile", area: "side", order: 1, acted: true },
    },
    tokenZones: {
      [ZONE_UUID]: "zone-1",
    },
    ...overrides,
  };
}

test("valid fixture normalizes with deterministic defaults", () => {
  const result = normalizeConflictBoard(validBoard());
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.ok(result.normalized);
  const doc = result.normalized;
  assert.equal(doc.version, CONFLICT_BOARD_VERSION);
  assert.equal(doc.combatId, "combat-abc");
  assert.equal(doc.sizePreset, "medium");
  assert.deepEqual(doc.board.origin, { x: 1000, y: 800 });
  assert.deepEqual(doc.board.background, { color: "#ffffff", texture: "", alpha: 1 });
  assert.equal(doc.zones.length, 1);
  assert.equal(doc.zones[0].id, "zone-1");
  assert.deepEqual(doc.cards["combatant-1"], { side: "friendly", area: "side", order: 0 });
  // acted true is preserved, false omitted style
  assert.deepEqual(doc.cards["combatant-2"], { side: "hostile", area: "side", order: 1, acted: true });
  assert.deepEqual(doc.tokenZones, { [ZONE_UUID]: "zone-1" });
  assert.equal(result.errors.length, 0);
});

test("validateConflictBoard mirrors normalizeConflictBoard diagnostics", () => {
  const okResult = validateConflictBoard(validBoard());
  assert.equal(okResult.ok, true);
  const broken = validateConflictBoard(validBoard({ combatId: undefined }));
  assert.equal(broken.ok, false);
  assert.equal(broken.normalized, undefined);
  assert.ok(broken.errors.some((e) => e.path === "$.combatId"));
});

test("diagnostics carry the { path, message, severity } shape", () => {
  const result = normalizeConflictBoard(validBoard({ sizePreset: "huge" }));
  assert.equal(result.ok, false);
  for (const entry of result.errors) {
    assert.equal(typeof entry.path, "string");
    assert.equal(typeof entry.message, "string");
    assert.equal(entry.severity, "error");
  }
});

test("missing/unsupported version, combatId, sizePreset are errors", () => {
  const cases = [
    ["$.version", { version: undefined }],
    ["$.version", { version: 99 }],
    ["$.version", { version: "1" }],
    ["$.combatId", { combatId: "" }],
    ["$.combatId", { combatId: undefined }],
    ["$.sizePreset", { sizePreset: "huge" }],
  ];
  for (const [path, overrides] of cases) {
    const result = normalizeConflictBoard(validBoard(overrides));
    assert.equal(result.ok, false, `"${path}" should fail`);
    assert.ok(
      result.errors.some((e) => e.path === path),
      `expected an error at "${path}", got ${JSON.stringify(result.errors)}`,
    );
  }
});

test("version 1 is migrated to v2 and accepted", () => {
  const v1 = {
    version: 1,
    combatId: "combat-abc",
    sizePreset: "medium",
    board: { origin: { x: 0, y: 0 }, background: { color: "#ffffff", texture: "", alpha: 1 } },
    zones: [{ id: "zone-1", name: "Z", rect: { x: 0, y: 0, width: 10, height: 10 }, sort: 0 }],
    cards: {
      c1: { side: "friendly", area: "acted", order: 0 },
      c2: { side: "hostile", area: "eliminated", order: 1 },
      c3: { side: "friendly", area: "side", order: 2 },
    },
    tokenZones: { "Scene.scene1.Token.t1": "zone-1" },
  };
  const result = normalizeConflictBoard(v1);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.normalized.version, 2);
  assert.deepEqual(result.normalized.cards.c1, { side: "friendly", area: "side", order: 0, acted: true });
  assert.deepEqual(result.normalized.cards.c2, { side: "hostile", area: "side", order: 1, eliminated: true });
  assert.deepEqual(result.normalized.cards.c3, { side: "friendly", area: "side", order: 2 });
  // original not mutated
  assert.equal(v1.version, 1);
  assert.equal(v1.cards.c1.area, "acted");
});

test("migrateConflictBoard pure and idempotent", () => {
  const v1 = {
    version: 1,
    combatId: "c",
    board: { origin: { x: 0, y: 0 } },
    zones: [],
    cards: {
      a: { side: "friendly", area: "acted", order: 0 },
      b: { side: "hostile", area: "eliminated", order: 1 },
    },
    tokenZones: {},
    futureField: 42,
  };
  const migrated = migrateConflictBoard(v1);
  assert.equal(migrated.version, 2);
  assert.equal(migrated.futureField, 42);
  assert.deepEqual(migrated.cards.a, { side: "friendly", area: "side", order: 0, acted: true });
  assert.deepEqual(migrated.cards.b, { side: "hostile", area: "side", order: 1, eliminated: true });
  // v1 unchanged
  assert.equal(v1.version, 1);
  // idempotent: migrating v2 returns same reference or equal
  const again = migrateConflictBoard(migrated);
  assert.equal(again.version, 2);
  assert.deepEqual(again, migrated);
  // version 2 as-is
  const v2 = validBoard();
  assert.equal(migrateConflictBoard(v2), v2);
  // other versions unchanged
  const v99 = { version: 99, cards: {} };
  assert.equal(migrateConflictBoard(v99), v99);
});

test("non-object documents are rejected at the root", () => {
  for (const value of [null, [], "x", 42]) {
    const result = normalizeConflictBoard(value);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.path === "$"));
    assert.equal(result.normalized, null);
  }
});

test("board requires an object with a finite origin", () => {
  const cases = [
    ["$.board", { board: undefined }],
    ["$.board.origin", { board: { origin: undefined } }],
    ["$.board.origin.x", { board: { origin: { x: "x", y: 0 } } }],
    ["$.board.origin.y", { board: { origin: { x: 0 } } }],
    ["$.board.boardSize.width", { board: { origin: { x: 0, y: 0 }, boardSize: { width: 0, height: 100 } } }],
    ["$.board.boardSize.height", { board: { origin: { x: 0, y: 0 }, boardSize: { width: 100, height: -5 } } }],
  ];
  for (const [path, overrides] of cases) {
    const result = normalizeConflictBoard(validBoard(overrides));
    assert.equal(result.ok, false, `"${path}" should fail`);
    assert.ok(
      result.errors.some((e) => e.path === path),
      `expected an error at "${path}", got ${JSON.stringify(result.errors)}`,
    );
  }
});

test("board background type errors", () => {
  const cases = [
    ["$.board.background", { board: { origin: { x: 0, y: 0 }, background: 42 } }],
    ["$.board.background.color", { board: { origin: { x: 0, y: 0 }, background: { color: 42 } } }],
    ["$.board.background.texture", { board: { origin: { x: 0, y: 0 }, background: { texture: 5 } } }],
    ["$.board.background.alpha", { board: { origin: { x: 0, y: 0 }, background: { alpha: 2 } } }],
  ];
  for (const [path, overrides] of cases) {
    const result = normalizeConflictBoard(validBoard(overrides));
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.path === path));
  }
});

test("zone validation: id, rect, style, sort, uniqueness", () => {
  const cases = [
    ["$.zones", { zones: "nope" }],
    ["$.zones[0].id", { zones: [{ name: "x", rect: { x: 0, y: 0, width: 10, height: 10 } }] }],
    ["$.zones[0].id", { zones: [{ id: "", rect: { x: 0, y: 0, width: 10, height: 10 } }] }],
    ["$.zones[0].rect", { zones: [{ id: "z1" }] }],
    ["$.zones[0].rect.width", { zones: [{ id: "z1", rect: { x: 0, y: 0, width: -1, height: 10 } }] }],
    ["$.zones[0].style.alpha", { zones: [{ id: "z1", rect: { x: 0, y: 0, width: 10, height: 10 }, style: { alpha: 3 } }] }],
    ["$.zones[0].sort", { zones: [{ id: "z1", rect: { x: 0, y: 0, width: 10, height: 10 }, sort: "a" }] }],
  ];
  for (const [path, overrides] of cases) {
    const result = normalizeConflictBoard(validBoard(overrides));
    assert.equal(result.ok, false, `"${path}" should fail`);
    assert.ok(
      result.errors.some((e) => e.path.startsWith(path)),
      `expected an error at "${path}", got ${JSON.stringify(result.errors)}`,
    );
  }

  const dup = validBoard();
  dup.zones.push({ ...dup.zones[0], id: "zone-1" });
  const dupResult = normalizeConflictBoard(dup);
  assert.equal(dupResult.ok, false);
  assert.ok(dupResult.errors.some((e) => e.message.includes("Duplicate")));
});

test("card validation: side/order enums and area soft normalization", () => {
  const cases = [
    ["$.cards", { cards: "nope" }],
    ["$.cards.x.side", { cards: { x: { side: "enemy", area: "side", order: 0 } } }],
    ["$.cards.x.order", { cards: { x: { side: "friendly", area: "side", order: -1 } } }],
    ["$.cards.x.order", { cards: { x: { side: "friendly", area: "side", order: 1.5 } } }],
  ];
  for (const [path, overrides] of cases) {
    const result = normalizeConflictBoard(validBoard(overrides));
    assert.equal(result.ok, false, `"${path}" should fail`);
    assert.ok(
      result.errors.some((e) => e.path.startsWith(path)),
      `expected an error at "${path}", got ${JSON.stringify(result.errors)}`,
    );
  }
  // area other than "side" is soft warning, normalized to "side", ok true
  const actedArea = normalizeConflictBoard(validBoard({ cards: { x: { side: "friendly", area: "acted", order: 0 } } }));
  assert.equal(actedArea.ok, true);
  assert.ok(actedArea.warnings.some((w) => w.path === "$.cards.x.area"));
  assert.equal(actedArea.normalized.cards.x.area, "side");
  const fieldArea = normalizeConflictBoard(validBoard({ cards: { x: { side: "friendly", area: "field", order: 0 } } }));
  assert.equal(fieldArea.ok, true);
  assert.ok(fieldArea.warnings.some((w) => w.path === "$.cards.x.area"));
  assert.equal(fieldArea.normalized.cards.x.area, "side");
});

test("card validation: acted/eliminated must be boolean or warning + normalization", () => {
  const garbage = validBoard({
    cards: {
      x: { side: "friendly", area: "side", order: 0, acted: "yes", eliminated: 1 },
      y: { side: "hostile", area: "side", order: 1, acted: true, eliminated: true },
    },
  });
  const result = normalizeConflictBoard(garbage);
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some((w) => w.path === "$.cards.x.acted"));
  assert.ok(result.warnings.some((w) => w.path === "$.cards.x.eliminated"));
  // garbage booleans are dropped, true preserved
  assert.equal(result.normalized.cards.x.acted, undefined);
  assert.equal(result.normalized.cards.x.eliminated, undefined);
  assert.equal(result.normalized.cards.y.acted, true);
  assert.equal(result.normalized.cards.y.eliminated, true);
  // false values are omitted
  const withFalse = normalizeConflictBoard(validBoard({ cards: { x: { side: "friendly", area: "side", order: 0, acted: false, eliminated: false } } }));
  assert.equal(withFalse.ok, true);
  assert.equal(withFalse.normalized.cards.x.acted, undefined);
  assert.equal(withFalse.normalized.cards.x.eliminated, undefined);
});

test("tokenZones must be an object mapping uuids to existing zones", () => {
  const cases = [
    ["$.tokenZones", { tokenZones: [] }],
    ["$.tokenZones.x", { tokenZones: { x: "" } }],
    ["$.tokenZones.x", { tokenZones: { x: 42 } }],
    ["$.tokenZones.x", { tokenZones: { x: "zone-404" } }],
  ];
  for (const [path, overrides] of cases) {
    const result = normalizeConflictBoard(validBoard(overrides));
    assert.equal(result.ok, false, `"${path}" should fail`);
    assert.ok(
      result.errors.some((e) => e.path.startsWith(path)),
      `expected an error at "${path}", got ${JSON.stringify(result.errors)}`,
    );
  }
});

test("missing optional fields get safe deterministic defaults", () => {
  const doc = validBoard();
  delete doc.sizePreset;
  delete doc.board.background;
  doc.zones[0] = { id: "zone-1", rect: { x: 0, y: 0, width: 50, height: 50 } };
  doc.cards["combatant-3"] = {};
  delete doc.tokenZones;
  const result = normalizeConflictBoard(doc);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  const normalized = result.normalized;
  assert.equal(normalized.sizePreset, DEFAULT_SIZE_PRESET);
  assert.deepEqual(normalized.board.background, { ...DEFAULT_BACKGROUND });
  const zone = normalized.zones[0];
  assert.equal(zone.name, "");
  assert.deepEqual(zone.style, { ...DEFAULT_ZONE_STYLE });
  assert.equal(zone.sort, 0);
  assert.deepEqual(normalized.cards["combatant-3"], { side: "friendly", area: "side", order: 0 });
  assert.deepEqual(normalized.tokenZones, {});
});

test("unknown compatible fields are warnings and preserved", () => {
  const doc = validBoard();
  doc.futureTopLevel = { ok: 1 };
  doc.board.futureBoard = "keep";
  doc.zones[0].futureZone = true;
  doc.cards["combatant-1"].futureCard = "keep";
  const result = normalizeConflictBoard(doc);
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some((w) => w.path === "$.futureTopLevel"));
  assert.ok(result.warnings.some((w) => w.path === "$.board.futureBoard"));
  assert.ok(result.warnings.some((w) => w.path === "$.zones[0].futureZone"));
  assert.ok(result.warnings.some((w) => w.path === "$.cards.combatant-1.futureCard"));
  assert.equal(result.normalized.futureTopLevel.ok, 1);
  assert.equal(result.normalized.board.futureBoard, "keep");
  assert.equal(result.normalized.zones[0].futureZone, true);
  assert.equal(result.normalized.cards["combatant-1"].futureCard, "keep");
});

test("normalization is idempotent", () => {
  const first = normalizeConflictBoard(validBoard());
  const second = normalizeConflictBoard(first.normalized);
  assert.equal(second.ok, true);
  assert.deepEqual(second.normalized, first.normalized);
  assert.deepEqual(second.errors, first.errors);

  const sparse = validBoard();
  delete sparse.sizePreset;
  delete sparse.board.background;
  sparse.zones[0] = { id: "zone-1", rect: { x: 0, y: 0, width: 50, height: 50 } };
  sparse.cards["combatant-3"] = {};
  const s1 = normalizeConflictBoard(sparse);
  const s2 = normalizeConflictBoard(s1.normalized);
  assert.deepEqual(s2.normalized, s1.normalized);
});

test("reconcile removes orphaned combatant cards and keeps present ones", () => {
  const state = normalizeConflictBoard(validBoard()).normalized;
  const result = reconcileConflictBoard(state, {
    combatantIds: ["combatant-1"],
    tokenUuids: [ZONE_UUID],
  });
  assert.deepEqual(result.removedCombatantIds, ["combatant-2"]);
  assert.deepEqual(Object.keys(result.state.cards), ["combatant-1"]);
  assert.deepEqual(result.state.cards["combatant-1"], state.cards["combatant-1"]);
  // other data untouched (not owned by cards/tokenZones)
  assert.deepEqual(result.state.zones, state.zones);
  assert.deepEqual(result.state.board, state.board);
  assert.equal(result.state.version, state.version);
});

test("reconcile removes orphaned token uuids without touching present ones", () => {
  const state = normalizeConflictBoard(validBoard()).normalized;
  const result = reconcileConflictBoard(state, {
    combatantIds: ["combatant-1", "combatant-2"],
    tokenUuids: [],
  });
  assert.deepEqual(result.removedTokenUuids, [ZONE_UUID]);
  assert.deepEqual(result.state.tokenZones, {});
});

test("reconcile drops tokenZones entries pointing to deleted zones", () => {
  const state = normalizeConflictBoard(validBoard()).normalized;
  const withDeletedZone = {
    ...state,
    zones: [],
    tokenZones: { ...state.tokenZones },
  };
  const result = reconcileConflictBoard(withDeletedZone, {
    combatantIds: ["combatant-1", "combatant-2"],
    tokenUuids: [ZONE_UUID],
  });
  assert.deepEqual(result.removedZoneEntries, [{ tokenUuid: ZONE_UUID, zoneId: "zone-1" }]);
  assert.deepEqual(result.state.tokenZones, {});
  assert.deepEqual(result.state.cards, state.cards);
});

test("reconcile is idempotent and accepts Sets", () => {
  const state = normalizeConflictBoard(validBoard()).normalized;
  const available = {
    combatantIds: new Set(["combatant-1"]),
    tokenUuids: new Set([ZONE_UUID]),
  };
  const once = reconcileConflictBoard(state, available);
  const twice = reconcileConflictBoard(once.state, available);
  assert.deepEqual(twice.state, once.state);
  assert.deepEqual(twice.removedCombatantIds, []);
  assert.deepEqual(twice.removedTokenUuids, []);
});

test("reconcile admits a newly available combatant card without touching existing ones", () => {
  const state = normalizeConflictBoard(
    validBoard({
      cards: {
        "combatant-1": { side: "friendly", area: "side", order: 0, acted: true },
        "combatant-2": { side: "hostile", area: "side", order: 1 },
      },
    }),
  ).normalized;
  const result = reconcileConflictBoard(
    state,
    {
      combatantIds: ["combatant-1", "combatant-2", "combatant-3"],
      tokenUuids: [ZONE_UUID, "Scene.scene1.Token.token3"],
      descriptors: [
        { combatantId: "combatant-1", hasPlayerOwner: true, disposition: -1 },
        { combatantId: "combatant-2", hasPlayerOwner: false, disposition: -1 },
        { combatantId: "combatant-3", hasPlayerOwner: false, disposition: TOKEN_DISPOSITION.HOSTILE },
      ],
    },
  );
  // newcomer admitted with primary-placement side/area and a conflict-free order
  assert.deepEqual(result.admittedCombatantIds, ["combatant-3"]);
  assert.deepEqual(result.state.cards["combatant-3"], {
    side: "hostile",
    area: "side",
    order: 2,
  });
  // existing cards keep side/area/order/acted exactly
  assert.deepEqual(result.state.cards["combatant-1"], {
    side: "friendly",
    area: "side",
    order: 0,
    acted: true,
  });
  assert.deepEqual(result.state.cards["combatant-2"], {
    side: "hostile",
    area: "side",
    order: 1,
  });
  // nothing else was removed or changed
  assert.deepEqual(result.removedCombatantIds, []);
  assert.deepEqual(result.state.zones, state.zones);
  assert.deepEqual(result.state.board, state.board);
});

test("reconcile keeps an existing order free of conflicts when admitting multiple newcomers", () => {
  // existing cards already use orders 0 and 2 (a gap at 1)
  const state = normalizeConflictBoard(
    validBoard({
      cards: {
        "combatant-1": { side: "friendly", area: "side", order: 0 },
        "combatant-2": { side: "hostile", area: "side", order: 2 },
      },
    }),
  ).normalized;
  const result = reconcileConflictBoard(state, {
    combatantIds: ["combatant-1", "combatant-2", "combatant-3", "combatant-4"],
    tokenUuids: ["Scene.scene1.Token.a", "Scene.scene1.Token.b"],
    descriptors: [
      { combatantId: "combatant-3", disposition: TOKEN_DISPOSITION.HOSTILE },
      { combatantId: "combatant-4", disposition: TOKEN_DISPOSITION.NEUTRAL },
    ],
  });
  // newcomer order fills the smallest free values, never colliding
  assert.deepEqual(result.state.cards["combatant-3"].order, 1);
  assert.deepEqual(result.state.cards["combatant-4"].order, 3);
  assert.deepEqual(result.state.cards["combatant-1"].order, 0);
  assert.deepEqual(result.state.cards["combatant-2"].order, 2);
  // side follows primary-placement rules
  assert.equal(result.state.cards["combatant-3"].side, "hostile");
  assert.equal(result.state.cards["combatant-4"].side, "friendly"); // NEUTRAL -> friendly
});

test("reconcile admission is idempotent: a second pass adds no duplicate cards", () => {
  const state = normalizeConflictBoard(validBoard()).normalized;
  const available = {
    combatantIds: ["combatant-1", "combatant-2", "combatant-3"],
    tokenUuids: [ZONE_UUID, "Scene.scene1.Token.a", "Scene.scene1.Token.b"],
    descriptors: [
      { combatantId: "combatant-1", disposition: TOKEN_DISPOSITION.FRIENDLY },
      { combatantId: "combatant-2", disposition: TOKEN_DISPOSITION.HOSTILE },
      { combatantId: "combatant-3", disposition: TOKEN_DISPOSITION.HOSTILE },
    ],
  };
  const once = reconcileConflictBoard(state, available);
  assert.deepEqual(once.admittedCombatantIds, ["combatant-3"]);
  assert.deepEqual(Object.keys(once.state.cards).sort(), [
    "combatant-1",
    "combatant-2",
    "combatant-3",
  ]);
  // second pass: nothing else admitted, no duplicates, cards identical
  const twice = reconcileConflictBoard(once.state, available);
  assert.deepEqual(twice.admittedCombatantIds, []);
  assert.deepEqual(twice.state.cards, once.state.cards);
  assert.ok(!twice.state.cards["combatant-3"].sideChanged);
});

test("reconcile admission never creates cards for combatants without a descriptor/token", () => {
  const state = normalizeConflictBoard(validBoard()).normalized;
  // "ghost" is available by id but has NO descriptor -> must NOT be admitted
  const result = reconcileConflictBoard(state, {
    combatantIds: ["combatant-1", "combatant-2", "ghost"],
    tokenUuids: [ZONE_UUID],
    descriptors: [
      { combatantId: "combatant-1", disposition: TOKEN_DISPOSITION.FRIENDLY },
      { combatantId: "combatant-2", disposition: TOKEN_DISPOSITION.HOSTILE },
    ],
  });
  assert.deepEqual(result.admittedCombatantIds, []);
  assert.deepEqual(Object.keys(result.state.cards).sort(), ["combatant-1", "combatant-2"]);
});

test("admitMissingCards is pure and reusable as a standalone helper", () => {
  const state = {
    ...normalizeConflictBoard(validBoard()).normalized,
    cards: {},
  };
  const snapshot = structuredClone(state);
  const { state: next, admittedCombatantIds } = admitMissingCards(state, {
    descriptors: [
      { combatantId: "pc", hasPlayerOwner: true, disposition: TOKEN_DISPOSITION.HOSTILE },
      { combatantId: "npc", disposition: TOKEN_DISPOSITION.HOSTILE },
      { combatantId: "npc2", disposition: undefined },
    ],
  });
  // input never mutated
  assert.deepEqual(state, snapshot);
  assert.deepEqual(admittedCombatantIds, ["pc", "npc", "npc2"]);
  assert.deepEqual(next.cards.pc, { side: "friendly", area: "side", order: 0 });
  assert.deepEqual(next.cards.npc, { side: "hostile", area: "side", order: 1 });
  assert.deepEqual(next.cards.npc2, { side: "friendly", area: "side", order: 2 });
});

test("resolveDisposition maps numbers and names", () => {
  assert.equal(resolveDisposition(TOKEN_DISPOSITION.HOSTILE), "hostile");
  assert.equal(resolveDisposition(TOKEN_DISPOSITION.NEUTRAL), "neutral");
  assert.equal(resolveDisposition(TOKEN_DISPOSITION.FRIENDLY), "friendly");
  assert.equal(resolveDisposition(TOKEN_DISPOSITION.SECRET), "secret");
  assert.equal(resolveDisposition("hostile"), "hostile");
  assert.equal(resolveDisposition("friendly"), "friendly");
  assert.equal(resolveDisposition(undefined), "unknown");
  assert.equal(resolveDisposition(99), "unknown");
  assert.equal(resolveDisposition("bogus"), "unknown");
});

test("resolveInitialSide follows the PLAN priority", () => {
  assert.equal(resolveInitialSide({ hasPlayerOwner: true, disposition: -1 }), "friendly");
  assert.equal(resolveInitialSide({ hasPlayerOwner: true }), "friendly");
  assert.equal(resolveInitialSide({ disposition: TOKEN_DISPOSITION.FRIENDLY }), "friendly");
  assert.equal(resolveInitialSide({ disposition: TOKEN_DISPOSITION.HOSTILE }), "hostile");
  assert.equal(resolveInitialSide({ disposition: TOKEN_DISPOSITION.NEUTRAL }), "friendly");
  assert.equal(resolveInitialSide({ disposition: TOKEN_DISPOSITION.SECRET }), "friendly");
  assert.equal(resolveInitialSide({}), "friendly");
  assert.equal(resolveInitialSide(undefined), "friendly");
});

test("assignInitialCardAreas distributes by owner/disposition with stable order", () => {
  const combatants = [
    { combatantId: "pc1", hasPlayerOwner: true, disposition: TOKEN_DISPOSITION.HOSTILE },
    { combatantId: "friendly1", disposition: TOKEN_DISPOSITION.FRIENDLY },
    { combatantId: "hostile1", disposition: TOKEN_DISPOSITION.HOSTILE },
    { combatantId: "neutral1", disposition: TOKEN_DISPOSITION.NEUTRAL },
    { combatantId: "unknown1", disposition: undefined },
    { combatantId: "secret1", disposition: TOKEN_DISPOSITION.SECRET },
  ];
  const { cards, order } = assignInitialCardAreas(combatants);
  assert.equal(cards.pc1.side, "friendly");
  assert.equal(cards.friendly1.side, "friendly");
  assert.equal(cards.hostile1.side, "hostile");
  assert.equal(cards.neutral1.side, "friendly");
  assert.equal(cards.unknown1.side, "friendly");
  assert.equal(cards.secret1.side, "friendly");
  for (const record of Object.values(cards)) {
    assert.equal(record.area, "side");
  }
  assert.deepEqual(order, ["pc1", "friendly1", "hostile1", "neutral1", "unknown1", "secret1"]);
  assert.equal(cards.friendly1.order, 1);
  assert.equal(cards.hostile1.order, 2);
});

test("assignInitialCardAreas accepts plain descriptors, id alias and dedupe", () => {
  const { cards, order } = assignInitialCardAreas([
    { id: "via-id", disposition: -1 },
    { id: "via-id", disposition: 1 }, // duplicate id is skipped
    "not-an-object",
    null,
    { combatantId: "", disposition: 1 },
  ]);
  assert.deepEqual(Object.keys(cards), ["via-id"]);
  assert.equal(cards["via-id"].side, "hostile");
  assert.deepEqual(order, ["via-id"]);
  assert.deepEqual(assignInitialCardAreas(), { cards: {}, order: [] });
});

/* ---- v2: applyCombatTurnStateToCards uses acted/eliminated flags, eliminated mirrors defeated ---- */

test("applyCombatTurnStateToCards projects hasActed onto the cards' acted flag (defeated false)", () => {
  const state = normalizeConflictBoard(validBoard()).normalized;
  state.cards["combatant-2"] = { side: "hostile", area: "side", order: 1 };
  const res = applyCombatTurnStateToCards(state, {
    "combatant-1": { hasActed: true, defeated: false },
    "combatant-2": { hasActed: true, defeated: false },
  });
  assert.equal(res.state.cards["combatant-1"].acted, true);
  assert.equal(res.state.cards["combatant-1"].eliminated, undefined);
  assert.equal(res.state.cards["combatant-1"].area, "side");
  assert.equal(res.state.cards["combatant-1"].side, "friendly");
  assert.equal(res.state.cards["combatant-1"].order, 0);
  assert.equal(res.state.cards["combatant-2"].acted, true);
  assert.equal(res.state.cards["combatant-2"].area, "side");
  assert.deepEqual(res.changed.sort(), ["combatant-1", "combatant-2"]);

  const back = applyCombatTurnStateToCards(res.state, {
    "combatant-1": { hasActed: false, defeated: false },
    "combatant-2": { hasActed: false, defeated: false },
  });
  assert.equal(back.state.cards["combatant-1"].acted, undefined);
  assert.equal(back.state.cards["combatant-1"].area, "side");
  assert.equal(back.state.cards["combatant-2"].acted, undefined);
  assert.equal(back.state.cards["combatant-2"].area, "side");
  assert.deepEqual(back.changed.sort(), ["combatant-1", "combatant-2"]);
});

test("applyCombatTurnStateToCards mirrors defeated to eliminated: true sets, false clears (incl. manual flag)", () => {
  const state = normalizeConflictBoard(
    validBoard({
      cards: {
        "combatant-1": { side: "friendly", area: "side", order: 0, eliminated: true },
        "combatant-2": { side: "hostile", area: "side", order: 1 },
        "combatant-3": { side: "friendly", area: "side", order: 2, acted: true },
      },
    }),
  ).normalized;
  // defeated:true -> eliminated:true even if was false; defeated also forces acted:false
  const set = applyCombatTurnStateToCards(state, {
    "combatant-2": { hasActed: false, defeated: true },
    "combatant-3": { hasActed: true, defeated: true },
  });
  assert.equal(set.state.cards["combatant-2"].eliminated, true);
  assert.equal(set.state.cards["combatant-2"].acted, undefined, "defeated forces acted false");
  assert.equal(set.state.cards["combatant-3"].eliminated, true);
  assert.equal(set.state.cards["combatant-3"].acted, undefined, "defeated clears acted");
  assert.ok(set.changed.includes("combatant-2"));
  assert.ok(set.changed.includes("combatant-3"));

  // defeated:false -> eliminated cleared, even if previously eliminated true (manual/migrated flag)
  const clear = applyCombatTurnStateToCards(state, {
    "combatant-1": { hasActed: false, defeated: false },
  });
  assert.equal(clear.state.cards["combatant-1"].eliminated, undefined, "defeated false clears manual eliminated");
  assert.deepEqual(clear.changed, ["combatant-1"]);

  // migrated v1 board: v1 area eliminated -> v2 eliminated:true, first sync with defeated:false clears it
  const migrated = normalizeConflictBoard({
    version: 1,
    combatId: "combat-abc",
    sizePreset: "medium",
    board: { origin: { x: 0, y: 0 }, background: { color: "#ffffff", texture: "", alpha: 1 } },
    zones: [],
    cards: { m: { side: "friendly", area: "eliminated", order: 0 } },
    tokenZones: {},
  }).normalized;
  assert.equal(migrated.cards.m.eliminated, true);
  const afterSync = applyCombatTurnStateToCards(migrated, { m: { hasActed: false, defeated: false } });
  assert.equal(afterSync.state.cards.m.eliminated, undefined, "migrated eliminated cleared when defeated false");
});

test("applyCombatTurnStateToCards eliminated+hasActed combos, changed includes both flags", () => {
  const state = normalizeConflictBoard(
    validBoard({
      cards: {
        a: { side: "friendly", area: "side", order: 0 },
        b: { side: "friendly", area: "side", order: 1, acted: true },
        c: { side: "friendly", area: "side", order: 2, eliminated: true },
      },
    }),
  ).normalized;
  const res = applyCombatTurnStateToCards(state, {
    a: { hasActed: true, defeated: true }, // -> eliminated true, acted false (defeated overrides)
    b: { hasActed: false, defeated: false }, // -> acted cleared
    c: { hasActed: true, defeated: false }, // -> eliminated cleared, acted true
  });
  assert.equal(res.state.cards.a.eliminated, true);
  assert.equal(res.state.cards.a.acted, undefined);
  assert.equal(res.state.cards.b.acted, undefined);
  assert.equal(res.state.cards.b.eliminated, undefined);
  assert.equal(res.state.cards.c.eliminated, undefined);
  assert.equal(res.state.cards.c.acted, true);
  assert.deepEqual(res.changed.sort(), ["a", "b", "c"]);
  // both flags changing counts as one entry per id
  const both = applyCombatTurnStateToCards(
    normalizeConflictBoard(validBoard({ cards: { x: { side: "friendly", area: "side", order: 0 } } })).normalized,
    { x: { hasActed: true, defeated: true } },
  );
  assert.equal(both.state.cards.x.eliminated, true);
  assert.equal(both.state.cards.x.acted, undefined);
  assert.deepEqual(both.changed, ["x"]);
});

test("applyCombatTurnStateToCards is pure and leaves unknown combatants alone (area still normalized)", () => {
  const state = normalizeConflictBoard(validBoard()).normalized;
  // inject an area that needs normalization to verify unknown id still normalizes it
  state.cards["combatant-1"].area = "acted";
  const snapshot = structuredClone(state);
  const res = applyCombatTurnStateToCards(state, { ghost: { hasActed: true, defeated: false } });
  assert.deepEqual(state, snapshot);
  assert.equal(res.state.cards["combatant-1"].area, "side", "unknown id still normalizes area");
  assert.deepEqual(res.changed, [], "area normalization alone does not count as changed");
  assert.equal(res.state.cards["combatant-2"].acted, true);
  assert.deepEqual(res.state.zones, state.zones);
  assert.deepEqual(res.state.board, state.board);
  assert.deepEqual(res.state.tokenZones, state.tokenZones);
  assert.deepEqual(applyCombatTurnStateToCards(null, {}).state.cards, {});
  // unknown id with eliminated flag: eliminated is NOT mirrored (no entry)
  const withElim = normalizeConflictBoard(validBoard({ cards: { u: { side: "friendly", area: "side", order: 0, eliminated: true } } })).normalized;
  const keep = applyCombatTurnStateToCards(withElim, {});
  assert.equal(keep.state.cards.u.eliminated, true);
});

test("applyCombatTurnStateToCards keeps the current combatant un-acted even when hasActed (defeated false)", () => {
  const state = normalizeConflictBoard(validBoard()).normalized;
  state.cards["combatant-2"] = { side: "hostile", area: "side", order: 1 };
  const res = applyCombatTurnStateToCards(
    state,
    { "combatant-1": { hasActed: true, defeated: false }, "combatant-2": { hasActed: true, defeated: false } },
    { currentCombatantId: "combatant-1" },
  );
  assert.equal(res.state.cards["combatant-1"].acted, undefined);
  assert.equal(res.state.cards["combatant-1"].eliminated, undefined);
  assert.equal(res.state.cards["combatant-1"].area, "side");
  assert.equal(res.state.cards["combatant-2"].acted, true);
  assert.deepEqual(res.changed, ["combatant-2"]);
});

test("applyCombatTurnStateToCards treats a current combatant with hasActed false as not acted", () => {
  const state = normalizeConflictBoard(validBoard()).normalized;
  state.cards["combatant-2"] = { side: "hostile", area: "side", order: 1 };
  const res = applyCombatTurnStateToCards(
    state,
    { "combatant-1": { hasActed: false, defeated: false }, "combatant-2": { hasActed: true, defeated: false } },
    { currentCombatantId: "combatant-1" },
  );
  assert.equal(res.state.cards["combatant-1"].acted, undefined);
  assert.equal(res.state.cards["combatant-2"].acted, true);
  assert.deepEqual(res.changed, ["combatant-2"]);
});

test("applyCombatTurnStateToCards defeated current combatant is eliminated and not acted", () => {
  const state = normalizeConflictBoard(
    validBoard({
      cards: {
        "combatant-1": { side: "friendly", area: "side", order: 0, eliminated: true },
        "combatant-2": { side: "hostile", area: "side", order: 1, acted: true },
      },
    }),
  ).normalized;
  const res = applyCombatTurnStateToCards(
    state,
    { "combatant-1": { hasActed: true, defeated: true }, "combatant-2": { hasActed: true, defeated: false } },
    { currentCombatantId: "combatant-1" },
  );
  assert.equal(res.state.cards["combatant-1"].eliminated, true);
  assert.equal(res.state.cards["combatant-1"].acted, undefined, "defeated forces acted false even when current");
  assert.equal(res.state.cards["combatant-2"].acted, true);
  // c1 already eliminated:true -> no eliminated change; c2 not defeated so remains acted true (already) -> no change, but c1's acted was already undefined so also no change
  assert.deepEqual(res.changed, []);
  // clearing defeated on the same current combatant removes eliminated and respects current
  const cleared = applyCombatTurnStateToCards(
    state,
    { "combatant-1": { hasActed: true, defeated: false }, "combatant-2": { hasActed: true, defeated: false } },
    { currentCombatantId: "combatant-1" },
  );
  assert.equal(cleared.state.cards["combatant-1"].eliminated, undefined);
  assert.equal(cleared.state.cards["combatant-1"].acted, undefined, "current still not acted even after clearing defeated");
  assert.deepEqual(cleared.changed, ["combatant-1"]);
});

test("applyCombatTurnStateToCards without a current keeps the legacy true->acted mapping (defeated false)", () => {
  const state = normalizeConflictBoard(validBoard()).normalized;
  state.cards["combatant-1"] = { side: "friendly", area: "side", order: 0 };
  state.cards["combatant-2"] = { side: "hostile", area: "side", order: 1 };
  const snapshot = structuredClone(state);
  const legacy = applyCombatTurnStateToCards(
    state,
    { "combatant-1": { hasActed: true, defeated: false }, "combatant-2": { hasActed: true, defeated: false } },
    {},
  );
  assert.equal(legacy.state.cards["combatant-1"].acted, true);
  assert.equal(legacy.state.cards["combatant-2"].acted, true);
  assert.deepEqual(legacy.changed.sort(), ["combatant-1", "combatant-2"]);
  const nullCurrent = applyCombatTurnStateToCards(
    state,
    { "combatant-1": { hasActed: true, defeated: false }, "combatant-2": { hasActed: true, defeated: false } },
    { currentCombatantId: null },
  );
  assert.equal(nullCurrent.state.cards["combatant-1"].acted, true);
  assert.equal(nullCurrent.state.cards["combatant-2"].acted, true);
  assert.deepEqual(state, snapshot);
  const unknown = applyCombatTurnStateToCards(
    state,
    { ghost: { hasActed: true, defeated: false } },
    { currentCombatantId: "ghost" },
  );
  assert.deepEqual(unknown.state.cards, state.cards);
  assert.deepEqual(unknown.changed, []);
});

test("applyCombatTurnStateToCards priority: unknown -> eliminated:=defeated -> current/defeated -> hasActed", () => {
  const state = normalizeConflictBoard(
    validBoard({
      cards: {
        a: { side: "friendly", area: "side", order: 0 },
        b: { side: "friendly", area: "side", order: 1, eliminated: true },
        c: { side: "friendly", area: "side", order: 2 },
        d: { side: "friendly", area: "side", order: 3 },
        e: { side: "friendly", area: "side", order: 4, acted: true },
      },
    }),
  ).normalized;
  // a unknown -> no-op; b defeated:false -> eliminated cleared even though was true; c current with hasActed true -> not acted; d hasActed true -> acted; e defeated:true -> eliminated true and acted false
  const res = applyCombatTurnStateToCards(
    state,
    {
      b: { hasActed: true, defeated: false },
      c: { hasActed: true, defeated: false },
      d: { hasActed: true, defeated: false },
      e: { hasActed: true, defeated: true },
    },
    { currentCombatantId: "c" },
  );
  assert.equal(res.state.cards.a.acted, undefined);
  assert.equal(res.state.cards.a.eliminated, undefined);
  assert.equal(res.state.cards.b.eliminated, undefined, "defeated false clears eliminated");
  assert.equal(res.state.cards.b.acted, true, "b now acted (was eliminated, now cleared and hasActed true)");
  assert.equal(res.state.cards.c.acted, undefined, "current wins");
  assert.equal(res.state.cards.d.acted, true);
  assert.equal(res.state.cards.e.eliminated, true);
  assert.equal(res.state.cards.e.acted, undefined, "defeated forces not acted");
  assert.deepEqual(res.changed.sort(), ["b", "d", "e"]);
  assert.ok(res.changed.includes("b") && res.changed.includes("d") && res.changed.includes("e"));
});

test("createConflictBoard produces a normalized empty board v2", () => {
  const board = createConflictBoard({ combatId: "combat-x", sizePreset: "large", origin: { x: 5, y: 6 } });
  const result = normalizeConflictBoard(board);
  assert.equal(result.ok, true);
  assert.equal(result.normalized.version, CONFLICT_BOARD_VERSION);
  assert.equal(result.normalized.version, 2);
  assert.equal(result.normalized.combatId, "combat-x");
  assert.equal(result.normalized.sizePreset, "large");
  assert.deepEqual(result.normalized.board.origin, { x: 5, y: 6 });
  assert.deepEqual(result.normalized.zones, []);
  assert.deepEqual(result.normalized.cards, {});
  assert.deepEqual(result.normalized.tokenZones, {});

  const defaultBoard = createConflictBoard();
  assert.equal(defaultBoard.sizePreset, DEFAULT_SIZE_PRESET);
  assert.deepEqual(defaultBoard.board.origin, { x: 0, y: 0 });
  assert.equal(defaultBoard.version, 2);
});
