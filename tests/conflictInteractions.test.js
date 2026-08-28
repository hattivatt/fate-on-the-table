/**
 * Node tests for ConflictInteractions.js — the pure routing/guards and the
 * pure zone-CRUD / token-drop state helpers that do not need a Foundry
 * runtime. The module import chain pulls in `settings` -> `LayoutImportExport`
 * which extends `foundry.applications.api.ApplicationV2` at module scope, so a
 * minimal Foundry stub is installed BEFORE the dynamic import.
 */

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  FLAG_SCOPE,
  CONFLICT_BOARD_FLAG,
  CONFLICT_ZONE_OWNER_TYPE,
  CONFLICT_CARD_OWNER_TYPE,
  CONFLICT_ZONE_BODY_PART,
  CONFLICT_ZONE_LABEL_PART,
} from "../scripts/constants.js";
import { createConflictBoard } from "../scripts/conflictBoardSchema.js";

globalThis.foundry = {
  applications: { api: { ApplicationV2: class ApplicationV2 {} } },
  utils: {
    getProperty: (obj, path) => {
      let t = obj;
      for (const key of String(path).split(".")) {
        if (t == null) return undefined;
        t = t[key];
      }
      return t;
    },
    randomID: () => "id",
    htmlToText: (value) => String(value ?? ""),
  },
};

const mod = await import("../scripts/ConflictInteractions.js");
const zoneEditor = await import("../scripts/ConflictZoneEditor.js");
const placement = await import("../scripts/PlacementManager.js");
const sync = await import("../scripts/ConflictBoardSync.js");
const geometry = await import("../scripts/conflictBoardGeometry.js");
const { PlacementManager } = placement;
const originalPlaceGroup = PlacementManager.placeGroup;

/* ------------------------------------------------------------------ *
 * Small mocks (plain objects only)
 * ------------------------------------------------------------------ */

function mockConflictDoc(id, documentName, ownerType, rect, extra = {}) {
  return {
    id,
    documentName,
    x: rect.x,
    y: rect.y,
    elevation: extra.elevation ?? 0,
    sort: extra.sort ?? 0,
    ...(documentName === "Drawing"
      ? { shape: { width: rect.width, height: rect.height } }
      : { width: rect.width, height: rect.height }),
    getFlag(scope, key) {
      if (scope !== FLAG_SCOPE) return undefined;
      if (key === "ownerType") return ownerType;
      if (key === "widgetId") return extra.widgetId ?? "w-unknown";
      return undefined;
    },
  };
}

function mockScene(drawings = [], tiles = []) {
  return { id: "scene1", drawings, tiles };
}

function boardState(overrides = {}) {
  return {
    version: 1,
    combatId: "combat-abc",
    sizePreset: "medium",
    board: { origin: { x: 1000, y: 800 }, background: { color: "#ffffff", texture: "", alpha: 1 } },
    zones: [
      { id: "zone-1", name: "Room", rect: { x: 10, y: 10, width: 100, height: 100 }, style: {}, sort: 0 },
      { id: "zone-2", name: "Corridor", rect: { x: 200, y: 200, width: 80, height: 60 }, style: {}, sort: 1 },
    ],
    cards: { c1: { side: "friendly", area: "side", order: 0 } },
    tokenZones: {
      "Scene.scene1.Token.t1": "zone-1",
      "Scene.scene1.Token.t2": "zone-2",
    },
    ...overrides,
  };
}

/* ------------------------------------------------------------------ *
 * isConflictDocument
 * ------------------------------------------------------------------ */

test("isConflictDocument recognizes only module-owned conflict docs", () => {
  const zone = mockConflictDoc("z1", "Drawing", CONFLICT_ZONE_OWNER_TYPE, { x: 0, y: 0, width: 10, height: 10 });
  const card = mockConflictDoc("c1", "Drawing", CONFLICT_CARD_OWNER_TYPE, { x: 0, y: 0, width: 10, height: 10 });
  assert.equal(mod.isConflictDocument(zone), true);
  assert.equal(mod.isConflictDocument(card), true);
  assert.equal(mod.isConflictDocument({ getFlag: () => "gm" }), false);
  assert.equal(mod.isConflictDocument({ getFlag: () => undefined }), false);
  assert.equal(mod.isConflictDocument(null), false);
  assert.equal(mod.isConflictDocument({}), false);
});

/* ------------------------------------------------------------------ *
 * hitTestConflictPart (priority card > zone > board; ignores foreign)
 * ------------------------------------------------------------------ */

test("hitTestConflictPart ranks cards above zones above board parts", () => {
  const boardDoc = mockConflictDoc("b1", "Drawing", "conflictBoard", { x: 0, y: 0, width: 400, height: 400 });
  const zoneDoc = mockConflictDoc("z1", "Drawing", CONFLICT_ZONE_OWNER_TYPE, { x: 50, y: 50, width: 120, height: 120 });
  const cardDoc = mockConflictDoc("c1", "Drawing", CONFLICT_CARD_OWNER_TYPE, { x: 80, y: 80, width: 60, height: 60 });
  const scene = mockScene([boardDoc, zoneDoc, cardDoc]);

  // Inside the card rect (also inside the zone + board): card wins.
  assert.equal(mod.hitTestConflictPart({ x: 100, y: 100 }, scene).id, "c1");
  // Inside the zone but outside the card: zone wins over board.
  assert.equal(mod.hitTestConflictPart({ x: 60, y: 60 }, scene).id, "z1");
  // Inside the board but outside every zone/card: board part wins.
  assert.equal(mod.hitTestConflictPart({ x: 300, y: 300 }, scene).id, "b1");
  // Outside every conflict doc: null.
  assert.equal(mod.hitTestConflictPart({ x: 600, y: 600 }, scene), null);
});

test("hitTestConflictPart ignores foreign docs and handles tiles", () => {
  const foreign = {
    id: "f1",
    documentName: "Drawing",
    x: 0,
    y: 0,
    shape: { width: 500, height: 500 },
    getFlag: () => undefined,
  };
  const zoneTile = mockConflictDoc("z1", "Tile", CONFLICT_ZONE_OWNER_TYPE, { x: 10, y: 10, width: 100, height: 100 });
  const scene = mockScene([foreign], [zoneTile]);
  assert.equal(mod.hitTestConflictPart({ x: 50, y: 50 }, scene).id, "z1");
  assert.equal(mod.hitTestConflictPart({ x: 250, y: 250 }, scene), null);
  assert.equal(mod.hitTestConflictPart(null, scene), null);
  assert.equal(mod.hitTestConflictPart({ x: 50, y: 50 }, null), null);
});

test("hitTestConflictPart lets a zone win over a field frame with a HIGHER stored z", () => {
  // Regression: the board field frame may be stored with a higher
  // elevation/sort than the zone (imperfect z-order). Owner priority
  // (conflictCard > conflictZone > conflictBoard) is the PRIMARY sort key, so
  // the zone must still win the hit-test.
  const boardDoc = mockConflictDoc(
    "b1",
    "Drawing",
    "conflictBoard",
    { x: 0, y: 0, width: 400, height: 400 },
    { elevation: 5, sort: 100 }, // z = 5100 > zone z = 0
  );
  const zoneDoc = mockConflictDoc(
    "z1",
    "Drawing",
    CONFLICT_ZONE_OWNER_TYPE,
    { x: 50, y: 50, width: 120, height: 120 },
    { elevation: 0, sort: 0 },
  );
  const scene = mockScene([boardDoc, zoneDoc]);
  assert.equal(mod.hitTestConflictPart({ x: 60, y: 60 }, scene).id, "z1");
  // outside the zone but inside the board: the board part still wins
  assert.equal(mod.hitTestConflictPart({ x: 300, y: 300 }, scene).id, "b1");
});

test("hitTestConflictPart lets a card win over a zone with a HIGHER stored z", () => {
  const zoneDoc = mockConflictDoc(
    "z1",
    "Drawing",
    CONFLICT_ZONE_OWNER_TYPE,
    { x: 0, y: 0, width: 300, height: 300 },
    { elevation: 10, sort: 1000 }, // z = 11000 > card z = 0
  );
  const cardDoc = mockConflictDoc(
    "c1",
    "Drawing",
    CONFLICT_CARD_OWNER_TYPE,
    { x: 100, y: 100, width: 60, height: 60 },
    { elevation: 0, sort: 0 },
  );
  const scene = mockScene([zoneDoc, cardDoc]);
  assert.equal(mod.hitTestConflictPart({ x: 120, y: 120 }, scene).id, "c1");
  // inside the zone but outside the card: the zone wins
  assert.equal(mod.hitTestConflictPart({ x: 20, y: 20 }, scene).id, "z1");
});

test("hitTestConflictPart within one ownerType picks the highest z", () => {
  const low = mockConflictDoc(
    "z1",
    "Drawing",
    CONFLICT_ZONE_OWNER_TYPE,
    { x: 0, y: 0, width: 200, height: 200 },
    { elevation: -1, sort: -100 },
  );
  const high = mockConflictDoc(
    "z2",
    "Drawing",
    CONFLICT_ZONE_OWNER_TYPE,
    { x: 0, y: 0, width: 200, height: 200 },
    { elevation: -1, sort: -50 },
  );
  const scene = mockScene([low, high]);
  assert.equal(mod.hitTestConflictPart({ x: 50, y: 50 }, scene).id, "z2");
});

test("hitTestConflictPart picks the consequence cost row over the widgetBounds grab frame at the same point", () => {
  // Regression for the consequence double-click blocker: `consequenceCostRows`
  // in the canonical minimal layout sits on elevation 20 / sort 2000, ABOVE
  // the transparent widgetBounds group (elevation 10 / sort 1000). Both are
  // `conflictCard` parts, so the cost row must win the point hit-test
  // (z = 20*1000+2000 = 22000 > 10*1000+1000 = 11000), routing the
  // double-click to the consequence input instead of the sheet.
  const bounds = mockConflictDoc(
    "wb-card1",
    "Drawing",
    CONFLICT_CARD_OWNER_TYPE,
    { x: 0, y: 0, width: 659, height: 445 },
    { elevation: 10, sort: 1000 },
  );
  const costRow = mockConflictDoc(
    "cc-row0",
    "Drawing",
    CONFLICT_CARD_OWNER_TYPE,
    { x: 440, y: 252, width: 210, height: 20 },
    { elevation: 20, sort: 2000 },
  );
  const scene = mockScene([bounds, costRow]);
  // Inside the cost row (also inside the full-card bounds): the row wins.
  assert.equal(mod.hitTestConflictPart({ x: 500, y: 260 }, scene).id, "cc-row0");
  // On the card but outside the cost row: the bounds frame still wins.
  assert.equal(mod.hitTestConflictPart({ x: 10, y: 10 }, scene).id, "wb-card1");
});

/* ------------------------------------------------------------------ *
 * Zone delete (pure next-state helper)
 * ------------------------------------------------------------------ */

test("nextStateWithoutZone removes the zone and its tokenZones entries only", () => {
  const state = boardState();
  const next = mod.nextStateWithoutZone(state, "zone-1");
  assert.deepEqual(next.zones.map((z) => z.id), ["zone-2"]);
  assert.deepEqual(next.tokenZones, { "Scene.scene1.Token.t2": "zone-2" });
  // everything else untouched
  assert.equal(next.combatId, "combat-abc");
  assert.deepEqual(next.cards, state.cards);
  assert.deepEqual(next.board, state.board);
  assert.equal(next.board.origin.x, 1000);
  // input is not mutated
  assert.equal(state.zones.length, 2);
  assert.equal(state.tokenZones["Scene.scene1.Token.t1"], "zone-1");
});

test("nextStateWithoutZone is a no-op for unknown ids and malformed state", () => {
  const state = boardState();
  assert.deepEqual(mod.nextStateWithoutZone(state, "missing"), state);
  assert.deepEqual(mod.nextStateWithoutZone(state, "missing"), { ...state });
  assert.equal(mod.nextStateWithoutZone(null, "zone-1"), null);
  assert.equal(mod.nextStateWithoutZone(state, ""), state);
  const noMemberships = mod.nextStateWithoutZone(
    boardState({ tokenZones: {} }),
    "zone-1",
  );
  assert.deepEqual(noMemberships.tokenZones, {});
});

test("nextStateWithoutZone keeps memberships of the surviving zones", () => {
  const state = boardState({
    tokenZones: {
      "Scene.scene1.Token.t1": "zone-1",
      "Scene.scene1.Token.t2": "zone-2",
      "Scene.scene1.Token.t3": "zone-2",
    },
  });
  const next = mod.nextStateWithoutZone(state, "zone-2");
  assert.deepEqual(next.zones.map((z) => z.id), ["zone-1"]);
  assert.deepEqual(next.tokenZones, { "Scene.scene1.Token.t1": "zone-1" });
});

/* ------------------------------------------------------------------ *
 * Zone rename (pure next-state helper)
 * ------------------------------------------------------------------ */

test("renameZoneInState keeps the stable id and never touches other fields", () => {
  const state = boardState();
  const next = mod.renameZoneInState(state, "zone-1", "Throne Room");
  const renamed = next.zones.find((z) => z.id === "zone-1");
  assert.equal(renamed.id, "zone-1");
  assert.equal(renamed.name, "Throne Room");
  assert.deepEqual(renamed.rect, { x: 10, y: 10, width: 100, height: 100 });
  assert.equal(renamed.sort, 0);
  // other zones + membership preserved
  assert.equal(next.zones.find((z) => z.id === "zone-2").name, "Corridor");
  assert.deepEqual(next.tokenZones, state.tokenZones);
  assert.deepEqual(next.cards, state.cards);
  // input not mutated
  assert.equal(state.zones.find((z) => z.id === "zone-1").name, "Room");
  // unknown id -> structurally unchanged
  assert.deepEqual(mod.renameZoneInState(state, "missing", "X"), state);
});

/* ------------------------------------------------------------------ *
 * Token drop membership (pure)
 * ------------------------------------------------------------------ */

test("applyTokenDropToZones assigns on zone hit and clears outside", () => {
  const state = boardState();
  const hit = { type: "zone", zoneId: "zone-2" };
  const r = mod.applyTokenDropToZones(state, "Scene.scene1.Token.t3", hit);
  assert.equal(r.changed, true);
  assert.equal(r.zoneId, "zone-2");
  assert.equal(r.nextZones["Scene.scene1.Token.t3"], "zone-2");
  // existing memberships untouched
  assert.equal(r.nextZones["Scene.scene1.Token.t1"], "zone-1");

  // dropping the same token into the same zone again is a no-op
  const same = mod.applyTokenDropToZones(
    { ...state, tokenZones: r.nextZones },
    "Scene.scene1.Token.t3",
    hit,
  );
  assert.equal(same.changed, false);

  // dropping outside every zone clears the membership
  const out = mod.applyTokenDropToZones(state, "Scene.scene1.Token.t1", {
    type: null,
    zoneId: null,
  });
  assert.equal(out.changed, true);
  assert.equal(out.zoneId, null);
  assert.equal(out.nextZones["Scene.scene1.Token.t1"], undefined);
  assert.equal(out.nextZones["Scene.scene1.Token.t2"], "zone-2");

  // input is not mutated
  assert.equal(state.tokenZones["Scene.scene1.Token.t1"], "zone-1");
});

test("snapTokenDrop clamps the drop into the zone and maps it to world", () => {
  const state = boardState();
  const zone = state.zones[0]; // rect { x:10, y:10, w:100, h:100 }, origin {1000,800}
  // inside the zone: world = rect + origin
  assert.deepEqual(mod.snapTokenDrop(state, zone, { x: 50, y: 50 }).world, { x: 1050, y: 850 });
  // outside (left/top of the rect): clamped to the rect edge
  const clamped = mod.snapTokenDrop(state, zone, { x: -5, y: -5 });
  assert.deepEqual(clamped.snap, { x: 10, y: 10 });
  assert.deepEqual(clamped.world, { x: 1010, y: 810 });
  // outside (right/bottom): clamped to the far edge
  const clamped2 = mod.snapTokenDrop(state, zone, { x: 999, y: 999 });
  assert.deepEqual(clamped2.snap, { x: 110, y: 110 });
  assert.deepEqual(clamped2.world, { x: 1110, y: 910 });
});

/* ------------------------------------------------------------------ *
 * Lifecycle guard
 * ------------------------------------------------------------------ */

test("conflict zone editor is inactive by default (lifecycle guard)", () => {
  assert.equal(zoneEditor.isConflictEditModeActive(), false);
});

/* ------------------------------------------------------------------ *
 * Add-zone click-placement (PlacementManager flow, not startZoneDraw)
 * ------------------------------------------------------------------ */

function setPath(obj, path, value) {
  const parts = path.split(".");
  let t = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (typeof t[p] !== "object" || t[p] === null) t[p] = {};
    t = t[p];
  }
  t[parts[parts.length - 1]] = value;
}

/** Full document-shaped scene mock supporting writeConflictBoard + sync. */
function fullMockScene({ flags = {}, drawings = [], tiles = [] } = {}) {
  const scene = {
    id: "scene1",
    drawings: [...drawings],
    tiles: [...tiles],
    flags,
    updates: [],
    deleted: { Drawing: [], Tile: [] },
    embeddedUpdates: { Drawing: [], Tile: [] },
    getFlag(scope, key) {
      return this.flags[scope]?.[key];
    },
    async update(data, options) {
      for (const [k, v] of Object.entries(data)) setPath(this, k, v);
      this.updates.push({ data, options });
      return this;
    },
    async unsetFlag(scope, key) {
      if (this.flags[scope]) delete this.flags[scope][key];
      return this;
    },
    async deleteEmbeddedDocuments(kind, ids) {
      this.deleted[kind].push(...ids);
      const arr = kind === "Drawing" ? this.drawings : this.tiles;
      for (const id of ids ?? []) {
        const i = arr.findIndex((x) => x.id === id);
        if (i >= 0) arr.splice(i, 1);
      }
      return this;
    },
    async updateEmbeddedDocuments(kind, docs) {
      this.embeddedUpdates[kind].push(...docs);
      return this;
    },
    async createEmbeddedDocuments(kind, docs) {
      const arr = kind === "Drawing" ? this.drawings : this.tiles;
      for (const d of docs ?? []) {
        arr.push({
          id: d._id ?? `new-${arr.length}`,
          documentName: kind,
          ...d,
          getFlag(scope, key) {
            return d.flags?.[scope]?.[key];
          },
        });
      }
      return this;
    },
  };
  return scene;
}

function boardPartDoc(id, widgetId, part) {
  return {
    id,
    documentName: "Drawing",
    x: 0,
    y: 0,
    shape: { width: 100, height: 100 },
    getFlag(scope, key) {
      if (scope !== FLAG_SCOPE) return undefined;
      if (key === "widgetId") return widgetId;
      if (key === "ownerType") return "conflictBoard";
      if (key === "part") return part;
      return undefined;
    },
  };
}

function addZoneGameStub() {
  return {
    user: { isGM: true, id: "gm1" },
    i18n: { localize: (key) => key, format: (key, data) => key },
    combats: { get: () => null },
  };
}

/** A placed board: state + registry + one board-level projection drawing. */
function placedBoardScene(overrides = {}) {
  const flags = {
    [FLAG_SCOPE]: {
      [CONFLICT_BOARD_FLAG]: boardState(),
      [sync.CONFLICT_BOARD_WIDGET_FLAG]: {
        widgetId: "wBoard",
        zoneWidgetIds: { "zone-1": "wZone1", "zone-2": "wZone2" },
        cardWidgetIds: {},
      },
    },
  };
  const scene = fullMockScene({ flags, ...overrides });
  scene.drawings.push(boardPartDoc("d-bg", "wBoard", "conflictBoardBackground"));
  return scene;
}

test("makeZoneRecord builds a stable zone with the default style and next sort", () => {
  const state = boardState(); // zones: sort 0, sort 1
  const rect = { x: 10, y: 20, width: 120, height: 120 };
  const zone = mod.makeZoneRecord("Throne Room", rect, state, () => "zone-new");
  assert.equal(zone.id, "zone-new");
  assert.equal(zone.name, "Throne Room");
  assert.deepEqual(zone.rect, { x: 10, y: 20, width: 120, height: 120 });
  assert.deepEqual(zone.style, {
    fill: "#ffffff",
    alpha: 0.12,
    stroke: "#000000",
  });
  assert.equal(zone.sort, 2);
  // input state is never mutated
  assert.equal(state.zones.length, 2);
  assert.equal(state.zones[0].sort, 0);
});

test("makeZoneRecord keeps the rect deep-copied and computes sort after the max", () => {
  const rect = { x: 1, y: 2, width: 3, height: 4 };
  const zone = mod.makeZoneRecord("A", rect, { zones: [{ sort: 5 }] }, () => "id-1");
  assert.deepEqual(zone.rect, rect);
  rect.x = 999; // mutating the caller rect must not leak into the record
  assert.equal(zone.rect.x, 1);
  assert.equal(zone.sort, 6);
  assert.equal(zone.id, "id-1");
});

test("appendZoneToState appends a zone without mutating the input state", () => {
  const state = boardState();
  const zone = { id: "zone-new", name: "New" };
  const next = mod.appendZoneToState(state, zone);
  assert.equal(next.zones.length, 3);
  assert.equal(next.zones[2], zone);
  assert.equal(state.zones.length, 2);
  assert.equal(next.combatId, state.combatId);
  assert.deepEqual(next.tokenZones, state.tokenZones);
  assert.deepEqual(next.board, state.board);
  assert.equal(mod.appendZoneToState(null, zone), null);
});

test("addZoneAtPoint runs a PlacementManager click-placement (not startZoneDraw) and commits the zone", async () => {
  const scene = placedBoardScene();
  globalThis.CONST = {
    DRAWING_TYPES: { RECTANGLE: "r" },
    DRAWING_FILL_TYPES: { NONE: 0 },
  };
  globalThis.game = addZoneGameStub();
  globalThis.foundry.applications.api.DialogV2 = {
    input: async () => ({ name: "Throne Room" }),
  };

  let placeGroupCalls = 0;
  let capturedCfg = null;
  PlacementManager.placeGroup = async (cfg) => {
    placeGroupCalls++;
    capturedCfg = cfg;
    await cfg.commit({ x: 1600, y: 1300 }, "unused-widget-id");
  };
  try {
    const result = await mod.addZoneAtPoint(scene, { x: 1500, y: 1200 });
    assert.equal(result, true);
    assert.equal(placeGroupCalls, 1);
    // the zone editor draw/drag mode is NEVER entered
    assert.equal(zoneEditor.isConflictEditModeActive(), false);
    // placement session uses the preset-derived rect + the new i18n keys
    assert.equal(capturedCfg.hintKey, "fate-on-the-table.conflict.zone.placeHint");
    assert.equal(capturedCfg.successKey, "fate-on-the-table.conflict.zone.placeSuccess");
    assert.equal(capturedCfg.bounds.width, geometry.ZONE_PLACEMENT_SIZES.medium.width);
    assert.equal(capturedCfg.bounds.height, geometry.ZONE_PLACEMENT_SIZES.medium.height);
    assert.equal(capturedCfg.bounds.x, -geometry.ZONE_PLACEMENT_SIZES.medium.width / 2);
    assert.equal(capturedCfg.bounds.y, -geometry.ZONE_PLACEMENT_SIZES.medium.height / 2);
  } finally {
    PlacementManager.placeGroup = originalPlaceGroup;
    delete globalThis.CONST;
  }

  // the zone was committed through writeConflictBoard + syncConflictBoard
  const nextState = sync.readConflictBoard(scene);
  const zone = nextState.zones.find((z) => z.name === "Throne Room");
  assert.ok(zone, "zone record must be persisted in the board state");
  assert.equal(zone.sort, 2);
  assert.deepEqual(zone.style, {
    fill: "#ffffff",
    alpha: 0.12,
    stroke: "#000000",
  });
  // anchor (1600,1300) -> local (600,500), centered 150x120 rect clamped into
  // the medium-preset field (x:256..1056, y:0..800)
  assert.deepEqual(zone.rect, { x: 525, y: 440, width: 150, height: 120 });
  assert.equal(nextState.zones.length, 3);
  // other zones/cards/tokenZones are untouched
  assert.deepEqual(nextState.tokenZones, boardState().tokenZones);
  assert.equal(nextState.combatId, "combat-abc");
  assert.deepEqual(nextState.board.origin, { x: 1000, y: 800 });

  // projection created the zone body + label through the serialized sync
  const registry = sync.boardRegistry(scene);
  assert.ok(registry, "registry must survive the sync");
  const zoneWidgetId = registry.zoneWidgetIds[zone.id];
  assert.ok(zoneWidgetId);
  const zoneDocs = scene.drawings.filter(
    (d) => d.getFlag(FLAG_SCOPE, "widgetId") === zoneWidgetId,
  );
  assert.equal(zoneDocs.length, 2, "body + label for the new zone");
  assert.ok(
    zoneDocs.some((d) => d.getFlag(FLAG_SCOPE, "part") === CONFLICT_ZONE_BODY_PART),
  );
  assert.ok(
    zoneDocs.some((d) => d.getFlag(FLAG_SCOPE, "part") === CONFLICT_ZONE_LABEL_PART),
  );
});

test("addZoneAtPoint resolves false gracefully when PlacementManager is busy or errors", async () => {
  const scene = placedBoardScene();
  globalThis.game = addZoneGameStub();
  globalThis.foundry.applications.api.DialogV2 = {
    input: async () => ({ name: "Room" }),
  };
  try {
    // error inside the placement session -> graceful false, no rejection
    PlacementManager.placeGroup = async () => {
      throw new Error("boom");
    };
    const errored = await mod.addZoneAtPoint(scene, { x: 1500, y: 1200 });
    assert.equal(errored, false);

    // busy / cancelled (session never commits) -> graceful false
    PlacementManager.placeGroup = async () => {};
    const busy = await mod.addZoneAtPoint(scene, { x: 1500, y: 1200 });
    assert.equal(busy, false);

    // the zone editor is never entered on any path
    assert.equal(zoneEditor.isConflictEditModeActive(), false);
  } finally {
    PlacementManager.placeGroup = originalPlaceGroup;
  }
});

test("addZoneAtPoint rejects a point outside the central field without a placement session", async () => {
  const scene = placedBoardScene();
  globalThis.game = addZoneGameStub();
  let inputCalls = 0;
  globalThis.foundry.applications.api.DialogV2 = {
    input: async () => {
      inputCalls++;
      return { name: "Room" };
    },
  };
  const original = PlacementManager.placeGroup;
  let placeGroupCalls = 0;
  PlacementManager.placeGroup = async () => {
    placeGroupCalls++;
  };
  try {
    // local (1500, 1200) is outside the field (x:256..1056, y:0..800)
    const result = await mod.addZoneAtPoint(scene, { x: 2500, y: 2000 });
    assert.equal(result, false);
    assert.equal(inputCalls, 0, "no name prompt outside the field");
    assert.equal(placeGroupCalls, 0, "no placement session outside the field");
  } finally {
    PlacementManager.placeGroup = original;
  }
});

test("addZoneAtPoint preview bounds match the committed rect for every preset", async () => {
  globalThis.CONST = {
    DRAWING_TYPES: { RECTANGLE: "r" },
    DRAWING_FILL_TYPES: { NONE: 0 },
  };
  try {
    for (const sizePreset of ["small", "medium", "large"]) {
      const zoneName = `Room-${sizePreset}`;
      globalThis.foundry.applications.api.DialogV2 = {
        input: async () => ({ name: zoneName }),
      };
      const flags = {
        [FLAG_SCOPE]: {
          [CONFLICT_BOARD_FLAG]: boardState({ sizePreset }),
          [sync.CONFLICT_BOARD_WIDGET_FLAG]: {
            widgetId: "wBoard",
            zoneWidgetIds: { "zone-1": "wZone1", "zone-2": "wZone2" },
            cardWidgetIds: {},
          },
        },
      };
      const scene = fullMockScene({ flags });
      scene.drawings.push(boardPartDoc("d-bg", "wBoard", "conflictBoardBackground"));
      globalThis.game = addZoneGameStub();
      let captured = null;
      PlacementManager.placeGroup = async (cfg) => {
        captured = cfg;
        // commit at the world center of the field so clamping cannot distort
        const geom = geometry.getConflictBoardGeometry({ sizePreset });
        await cfg.commit(
          { x: 1000 + geom.field.x + geom.field.width / 2, y: 800 + geom.field.y + geom.field.height / 2 },
          "unused",
        );
      };
      const result = await mod.addZoneAtPoint(scene, { x: 1500, y: 1200 });
      assert.equal(result, true, `preset ${sizePreset} must place`);
      const expected = geometry.zonePlacementSize(
        sizePreset,
        geometry.getConflictBoardGeometry({ sizePreset }).field,
      );
      assert.equal(captured.bounds.width, expected.width, `preset ${sizePreset} preview width`);
      assert.equal(captured.bounds.height, expected.height, `preset ${sizePreset} preview height`);
      assert.equal(captured.bounds.x, -expected.width / 2, `preset ${sizePreset} preview x`);
      assert.equal(captured.bounds.y, -expected.height / 2, `preset ${sizePreset} preview y`);
      const zone = sync.readConflictBoard(scene).zones.find((z) => z.name === zoneName);
      assert.ok(zone, `preset ${sizePreset} zone committed`);
      assert.equal(zone.rect.width, expected.width, `preset ${sizePreset} rect width`);
      assert.equal(zone.rect.height, expected.height, `preset ${sizePreset} rect height`);
    }
  } finally {
    PlacementManager.placeGroup = originalPlaceGroup;
    delete globalThis.CONST;
  }
});

/* ------------------------------------------------------------------ *
 * Zone context menu routing (Rename + Remove; GM/player guards)
 * ------------------------------------------------------------------ */

function zoneMenuDoc(widgetId) {
  return {
    id: "zone-doc",
    documentName: "Drawing",
    x: 0,
    y: 0,
    shape: { width: 10, height: 10 },
    getFlag(scope, key) {
      if (scope !== FLAG_SCOPE) return undefined;
      if (key === "ownerType") return CONFLICT_ZONE_OWNER_TYPE;
      if (key === "widgetId") return widgetId;
      return undefined;
    },
  };
}

test("zone context menu routes to Rename + Remove for the GM", async () => {
  const dom = installMenuDomStub();
  const scene = placedBoardScene();
  globalThis.canvas = { scene };
  globalThis.game = {
    user: { isGM: true },
    i18n: { localize: (key) => key },
  };
  try {
    const handled = await mod.handleConflictContextMenu(zoneMenuDoc("wZone1"), fakeMenuEvent());
    assert.equal(handled, true);
    assert.equal(dom.createdButtons.length, 2);
    assert.ok(dom.createdButtons[0].innerHTML.includes("fa-pen"));
    assert.ok(
      dom.createdButtons[0].innerHTML.includes("fate-on-the-table.conflict.zone.rename"),
    );
    assert.ok(dom.createdButtons[1].innerHTML.includes("fa-trash"));
    assert.ok(
      dom.createdButtons[1].innerHTML.includes("fate-on-the-table.conflict.zone.remove"),
    );
    assert.equal(dom.body.children.length, 1); // the menu was rendered
  } finally {
    delete globalThis.canvas;
  }
});

test("zone context menu is consumed without a menu for players", async () => {
  const dom = installMenuDomStub();
  const scene = placedBoardScene();
  globalThis.canvas = { scene };
  globalThis.game = {
    user: { isGM: false },
    i18n: { localize: (key) => key },
  };
  try {
    const handled = await mod.handleConflictContextMenu(zoneMenuDoc("wZone1"), fakeMenuEvent());
    assert.equal(handled, true);
    assert.equal(dom.createdButtons.length, 0);
    assert.equal(dom.body.children.length, 0);
  } finally {
    delete globalThis.canvas;
  }
});

test("zone remove action confirms through DialogV2 and clears the zone + its tokenZones entries", async () => {
  const dom = installMenuDomStub();
  const scene = placedBoardScene();
  globalThis.canvas = { scene };
  globalThis.game = {
    user: { isGM: true, id: "gm1" },
    i18n: { localize: (key) => key, format: (key) => key },
    combats: { get: () => null },
  };
  globalThis.CONST = {
    DRAWING_TYPES: { RECTANGLE: "r" },
    DRAWING_FILL_TYPES: { NONE: 0 },
  };
  const confirmCalls = [];
  globalThis.foundry.applications.api.DialogV2 = {
    confirm: async (opts) => {
      confirmCalls.push(opts);
      return true;
    },
  };
  try {
    const handled = await mod.handleConflictContextMenu(zoneMenuDoc("wZone1"), fakeMenuEvent());
    assert.equal(handled, true);
    assert.equal(dom.createdButtons.length, 2);
    dom.createdButtons[1].click(); // "Remove zone"
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(confirmCalls.length, 1);
    assert.equal(
      confirmCalls[0].window.title,
      "fate-on-the-table.conflict.zone.removeTitle",
    );
    const state = sync.readConflictBoard(scene);
    assert.deepEqual(state.zones.map((z) => z.id), ["zone-2"]);
    assert.deepEqual(state.tokenZones, { "Scene.scene1.Token.t2": "zone-2" });
  } finally {
    PlacementManager.placeGroup = originalPlaceGroup;
    delete globalThis.canvas;
    delete globalThis.CONST;
    delete globalThis.foundry?.applications?.api?.DialogV2;
  }
});

test("zone remove action leaves the state untouched when the confirmation is cancelled", async () => {
  const dom = installMenuDomStub();
  const scene = placedBoardScene();
  globalThis.canvas = { scene };
  globalThis.game = {
    user: { isGM: true, id: "gm1" },
    i18n: { localize: (key) => key, format: (key) => key },
  };
  globalThis.foundry.applications.api.DialogV2 = {
    confirm: async () => false,
  };
  try {
    await mod.handleConflictContextMenu(zoneMenuDoc("wZone1"), fakeMenuEvent());
    dom.createdButtons[1].click();
    await new Promise((r) => setTimeout(r, 0));
    const state = sync.readConflictBoard(scene);
    assert.deepEqual(state.zones.map((z) => z.id), ["zone-1", "zone-2"]);
    assert.equal(state.tokenZones["Scene.scene1.Token.t1"], "zone-1");
  } finally {
    delete globalThis.canvas;
    delete globalThis.foundry?.applications?.api?.DialogV2;
  }
});

/* ------------------------------------------------------------------ *
 * Card context menu (menu DOM stubbed; ConflictManager injected)
 * ------------------------------------------------------------------ */

function installMenuDomStub() {
  const state = { body: null, createdButtons: [], windowListeners: {} };
  function fakeEl(tag) {
    const listeners = {};
    const el = {
      tagName: String(tag).toUpperCase(),
      children: [],
      style: {},
      disabled: false,
      dataset: {},
      className: "",
      classList: {
        add(...names) {
          for (const n of names) el.className += ` ${n}`;
        },
        remove() {},
        toggle() {},
        contains() {
          return false;
        },
      },
      innerHTML: "",
      parentNode: null,
      append(child) {
        this.children.push(child);
        child.parentNode = this;
      },
      remove() {
        if (!this.parentNode) return;
        const i = this.parentNode.children.indexOf(this);
        if (i >= 0) this.parentNode.children.splice(i, 1);
        this.parentNode = null;
      },
      addEventListener(type, fn) {
        listeners[type] = fn;
      },
      removeEventListener(type, fn) {
        if (listeners[type] === fn) delete listeners[type];
      },
      getBoundingClientRect() {
        return { width: 100, height: 24, left: 0, top: 0 };
      },
      click() {
        if (typeof listeners.click === "function") {
          listeners.click({ preventDefault() {}, stopPropagation() {} });
        }
      },
      closest() {
        return null;
      },
      querySelector() {
        return null;
      },
      contains() {
        return false;
      },
      get childElementCount() {
        return this.children.length;
      },
    };
    return el;
  }
  const body = fakeEl("body");
  state.body = body;
  globalThis.document = {
    body,
    createElement: (tag) => {
      const el = fakeEl(tag);
      if (String(tag).toLowerCase() === "button") state.createdButtons.push(el);
      return el;
    },
  };
  globalThis.window = {
    innerWidth: 1024,
    innerHeight: 768,
    addEventListener: (type, fn) => {
      state.windowListeners[type] = fn;
    },
    removeEventListener: (type, fn) => {
      if (state.windowListeners[type] === fn) delete state.windowListeners[type];
    },
  };
  return state;
}

function uninstallMenuDomStub() {
  delete globalThis.document;
  delete globalThis.window;
}

function menuCombatant(id, { hasActed = false, defeated = false } = {}) {
  return {
    id,
    name: id,
    defeated,
    token: { name: id },
    getFlag(scope, key) {
      if (scope === "fate-core-official" && key === "hasActed") return hasActed;
      return undefined;
    },
  };
}

function menuScene(combatId, combatantIds) {
  const state = createConflictBoard({
    combatId,
    sizePreset: "medium",
    origin: { x: 0, y: 0 },
  });
  state.cards = Object.fromEntries(
    combatantIds.map((id, i) => [
      id,
      { side: i % 2 ? "hostile" : "friendly", area: "side", order: i },
    ]),
  );
  return {
    id: "scene1",
    flags: { [FLAG_SCOPE]: { [CONFLICT_BOARD_FLAG]: state } },
    getFlag(scope, key) {
      return this.flags[scope]?.[key];
    },
  };
}

function cardContextDoc(combatantId) {
  return {
    id: `card-${combatantId}`,
    documentName: "Drawing",
    x: 0,
    y: 0,
    shape: { width: 10, height: 10 },
    getFlag(scope, key) {
      if (scope !== FLAG_SCOPE) return undefined;
      if (key === "ownerType") return CONFLICT_CARD_OWNER_TYPE;
      if (key === "combatantId") return combatantId;
      return undefined;
    },
  };
}

function fakeMenuEvent() {
  return {
    clientX: 10,
    clientY: 10,
    preventDefault() {},
    stopPropagation() {},
  };
}

function installMenuCombat(game, combat, scene) {
  globalThis.canvas = { scene };
  globalThis.game = {
    user: { isGM: true },
    i18n: { localize: (key) => key },
    combat,
    combats: { get: () => combat },
    ...game,
  };
}

afterEach(() => {
  delete globalThis.game;
  delete globalThis.canvas;
  uninstallMenuDomStub();
  mod.unregisterConflictManager();
  PlacementManager.placeGroup = originalPlaceGroup;
  delete globalThis.CONST;
  delete globalThis.foundry?.applications?.api?.DialogV2;
});

test("card context menu is never shown to players", async () => {
  const dom = installMenuDomStub();
  const combat = {
    id: "combat-abc",
    turn: 0,
    combatants: [menuCombatant("c1"), menuCombatant("c2")],
  };
  const scene = menuScene("combat-abc", ["c1", "c2"]);
  installMenuCombat({ user: { isGM: false } }, combat, scene);
  const handled = await mod.handleConflictContextMenu(cardContextDoc("c2"), fakeMenuEvent());
  assert.equal(handled, true);
  assert.equal(dom.body.children.length, 0);
  assert.equal(dom.createdButtons.length, 0);
});

test("card context menu pass path calls the manager passTurn directly without DialogV2.confirm", async () => {
  const dom = installMenuDomStub();
  const combat = {
    id: "combat-abc",
    turn: 0,
    combatants: [menuCombatant("c1"), menuCombatant("c2")],
  };
  const scene = menuScene("combat-abc", ["c1", "c2"]);
  installMenuCombat({}, combat, scene);
  const passCalls = [];
  const confirmCalls = [];
  globalThis.foundry.applications.api.DialogV2 = {
    confirm: async (opts) => {
      confirmCalls.push(opts);
      return true;
    },
  };
  mod.registerConflictManager({
    passTurn: async (c, id, opts) => {
      passCalls.push({ c, id, opts });
      return { ok: true, turn: 1 };
    },
    returnTurn: async () => ({ ok: true }),
    newRound: async () => ({ ok: true }),
  });

  const handled = await mod.handleConflictContextMenu(cardContextDoc("c2"), fakeMenuEvent());
  assert.equal(handled, true);
  // Pass turn must be present; Leave combat is also present (new feature) separated by sep
  const passBtn = dom.createdButtons.find((b) => b.innerHTML.includes("fa-forward"));
  assert.ok(passBtn, "Pass turn button must exist");
  assert.ok(dom.createdButtons.some((b) => b.innerHTML.includes("fate-on-the-table.conflict.card.leaveCombat")), "Leave combat should also be present");
  assert.ok(!dom.createdButtons.some((b) => b.innerHTML.includes("fa-undo") && b.innerHTML.includes("fate-on-the-table.conflict.card.returnTurn")));

  passBtn.click();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(confirmCalls.length, 0); // no confirmation dialog on the card path
  assert.equal(passCalls.length, 1);
  assert.equal(passCalls[0].id, "c2");
  assert.equal(passCalls[0].c, combat);
  assert.deepEqual(passCalls[0].opts, { scene });
});

test("card context menu shows Return turn for an acted card and calls the manager returnTurn", async () => {
  const dom = installMenuDomStub();
  const combat = {
    id: "combat-abc",
    turn: 0,
    combatants: [menuCombatant("c1"), menuCombatant("c2", { hasActed: true })],
  };
  const scene = menuScene("combat-abc", ["c1", "c2"]);
  installMenuCombat({}, combat, scene);
  const returnCalls = [];
  mod.registerConflictManager({
    passTurn: async () => ({ ok: true }),
    returnTurn: async (c, id, opts) => {
      returnCalls.push({ c, id, opts });
      return { ok: true };
    },
    newRound: async () => ({ ok: true }),
  });

  const handled = await mod.handleConflictContextMenu(cardContextDoc("c2"), fakeMenuEvent());
  assert.equal(handled, true);
  const returnBtn = dom.createdButtons.find((b) => b.innerHTML.includes("fa-undo"));
  assert.ok(returnBtn, "Return turn button must exist");
  assert.ok(dom.createdButtons.some((b) => b.innerHTML.includes("fate-on-the-table.conflict.card.leaveCombat")), "Leave combat should also be present");
  assert.ok(!dom.createdButtons.some((b) => b.innerHTML.includes("fa-forward") && b.innerHTML.includes("fate-on-the-table.conflict.card.passTurn")));

  returnBtn.click();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(returnCalls.length, 1);
  assert.equal(returnCalls[0].id, "c2");
  assert.deepEqual(returnCalls[0].opts, { scene });
});

test("card context menu allows Return turn for a current acted card (flag only, marker untouched)", async () => {
  const dom = installMenuDomStub();
  const combat = {
    id: "combat-abc",
    turn: 0,
    combatants: [menuCombatant("c1", { hasActed: true }), menuCombatant("c2")],
  };
  const scene = menuScene("combat-abc", ["c1", "c2"]);
  installMenuCombat({}, combat, scene);
  const returnCalls = [];
  mod.registerConflictManager({
    passTurn: async () => ({ ok: true }),
    returnTurn: async (c, id, opts) => {
      returnCalls.push({ c, id, opts });
      return { ok: true };
    },
    newRound: async () => ({ ok: true }),
  });

  const handled = await mod.handleConflictContextMenu(cardContextDoc("c1"), fakeMenuEvent());
  assert.equal(handled, true);
  const returnBtn2 = dom.createdButtons.find((b) => b.innerHTML.includes("fa-undo"));
  assert.ok(returnBtn2, "Return turn for current acted must exist");
  // leave also present
  assert.ok(dom.createdButtons.some((b) => b.innerHTML.includes("fate-on-the-table.conflict.card.leaveCombat")));

  returnBtn2.click();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(returnCalls.length, 1);
  assert.equal(returnCalls[0].id, "c1");
});

test("card context menu shows no actions for a defeated acted card", async () => {
  const dom = installMenuDomStub();
  const combat = {
    id: "combat-abc",
    turn: 0,
    combatants: [
      menuCombatant("c1"),
      menuCombatant("c2", { hasActed: true, defeated: true }),
    ],
  };
  const scene = menuScene("combat-abc", ["c1", "c2"]);
  installMenuCombat({}, combat, scene);
  const handled = await mod.handleConflictContextMenu(cardContextDoc("c2"), fakeMenuEvent());
  assert.equal(handled, true);
  assert.equal(dom.body.children.length, 0); // no empty menu
  assert.equal(dom.createdButtons.length, 0);
});

test("card context menu shows no actions for a defeated unacted card (no Pass turn either)", async () => {
  const dom = installMenuDomStub();
  const combat = {
    id: "combat-abc",
    turn: 0,
    combatants: [
      menuCombatant("c1"),
      menuCombatant("c2", { defeated: true }), // defeated, never acted
    ],
  };
  const scene = menuScene("combat-abc", ["c1", "c2"]);
  installMenuCombat({}, combat, scene);
  const handled = await mod.handleConflictContextMenu(cardContextDoc("c2"), fakeMenuEvent());
  assert.equal(handled, true);
  assert.equal(dom.body.children.length, 0); // defeated cards get no menu at all
  assert.equal(dom.createdButtons.length, 0);
});

test("card context menu never offers Pass turn for a card in the eliminated pile", async () => {
  const dom = installMenuDomStub();
  const combat = {
    id: "combat-abc",
    turn: 0,
    combatants: [
      menuCombatant("c1"),
      menuCombatant("c2"), // not defeated but its card sits in the pile
    ],
  };
  const scene = menuScene("combat-abc", ["c1", "c2"]);
  scene.flags[FLAG_SCOPE][CONFLICT_BOARD_FLAG].cards.c2.eliminated = true;
  installMenuCombat({}, combat, scene);
  const handled = await mod.handleConflictContextMenu(cardContextDoc("c2"), fakeMenuEvent());
  assert.equal(handled, true);
  assert.equal(dom.body.children.length, 0);
  assert.equal(dom.createdButtons.length, 0);
});

test("card context menu consumes the event without a menu for a current unacted card", async () => {
  const dom = installMenuDomStub();
  const combat = {
    id: "combat-abc",
    turn: 0,
    combatants: [menuCombatant("c1")],
  };
  const scene = menuScene("combat-abc", ["c1"]);
  installMenuCombat({}, combat, scene);
  const handled = await mod.handleConflictContextMenu(cardContextDoc("c1"), fakeMenuEvent());
  assert.equal(handled, true);
  // Now Leave combat is the only action for a current unacted card (no Pass/Return/Roll)
  assert.equal(dom.createdButtons.length, 1);
  assert.ok(dom.createdButtons[0].innerHTML.includes("fate-on-the-table.conflict.card.leaveCombat"));
  assert.ok(dom.createdButtons[0].innerHTML.includes("fa-skull"));
});

test("card context menu consumes the event without a menu for an orphan card", async () => {
  const dom = installMenuDomStub();
  const combat = {
    id: "combat-abc",
    turn: 0,
    combatants: [menuCombatant("c1")],
  };
  const scene = menuScene("combat-abc", ["c1"]);
  installMenuCombat({}, combat, scene);
  const handled = await mod.handleConflictContextMenu(cardContextDoc("missing"), fakeMenuEvent());
  assert.equal(handled, true);
  assert.equal(dom.createdButtons.length, 0);
});

/* ------------------------------------------------------------------ *
 * Card double-click: sheet opens for a card actor (regression)
 * ------------------------------------------------------------------ */

/** A full conflict-card document with all identity flags. */
function fullCardDoc(combatantId, overrides = {}) {
  return {
    id: `card-${combatantId}`,
    documentName: "Drawing",
    x: 0,
    y: 0,
    shape: { width: 10, height: 10 },
    getFlag(scope, key) {
      if (scope !== FLAG_SCOPE) return undefined;
      return {
        ownerType: CONFLICT_CARD_OWNER_TYPE,
        combatantId,
        tokenUuid: `Scene.scene1.Token.t-${combatantId}`,
        ...overrides,
      }[key];
    },
  };
}

test("conflict card double-click (non-cost part) still opens the character sheet", async () => {
  let rendered = 0;
  const actor = {
    name: "Grom",
    testUserPermission: (user, level) => true,
    sheet: { render: () => { rendered += 1; } },
  };
  globalThis.CONST = {
    DOCUMENT_OWNERSHIP_LEVELS: { LIMITED: 1, OWNER: 2 },
    DRAWING_TYPES: { RECTANGLE: "r" },
  };
  const combat = {
    id: "combat-abc",
    combatants: [{ id: "c1", token: { actor }, actor }],
  };
  const scene = menuScene("combat-abc", ["c1"]);
  scene.flags[FLAG_SCOPE][sync.CONFLICT_BOARD_WIDGET_FLAG] = {
    widgetId: "wBoard",
    zoneWidgetIds: {},
    cardWidgetIds: { c1: "wCard1" },
  };
  installMenuCombat({}, combat, scene);
  const handled = await mod.handleConflictDocumentDoubleClick(
    fullCardDoc("c1"),
    fakeMenuEvent(),
  );
  assert.equal(handled, true);
  assert.equal(rendered, 1, "the ordinary card must open its character sheet");
});

test("conflict card double-click on a consequence cost row is consumed without opening the sheet", async () => {
  // Regression for the topmost-cost-row fix: the consequence cost row (on the
  // card) must route to the consequence input handler as the topmost part — it
  // consumes the double-click and never opens the character sheet, unlike any
  // other card part (covered by the test above).
  let rendered = 0;
  let actorUpdated = false;
  const actor = {
    name: "Grom",
    testUserPermission: (user, level) => true,
    sheet: { render: () => { rendered += 1; } },
    system: {
      tracks: {
        mild: {
          name: "Mild Consequence",
          enabled: true,
          boxes: 0,
          box_values: [false],
          aspect: { when_marked: true, name: "" },
        },
      },
    },
    update: () => {
      actorUpdated = true;
      return Promise.resolve(actor);
    },
  };
  globalThis.CONST = {
    DOCUMENT_OWNERSHIP_LEVELS: { LIMITED: 1, OWNER: 2 },
    DRAWING_TYPES: { RECTANGLE: "r" },
  };
  const combat = {
    id: "combat-abc",
    combatants: [{ id: "c1", token: { actor }, actor }],
  };
  const scene = menuScene("combat-abc", ["c1"]);
  globalThis.canvas = { scene };
  scene.flags[FLAG_SCOPE][sync.CONFLICT_BOARD_WIDGET_FLAG] = {
    widgetId: "wBoard",
    zoneWidgetIds: {},
    cardWidgetIds: { c1: "wCard1" },
  };
  installMenuCombat({}, combat, scene);
  const handled = await mod.handleConflictDocumentDoubleClick(
    fullCardDoc("c1", { part: "consequenceCostRows", index: 0 }),
    fakeMenuEvent(),
  );
  assert.equal(handled, true);
  assert.equal(rendered, 0, "the consequence cost row must NOT open the sheet");
  assert.equal(actorUpdated, false, "a cancelled prompt must not write the actor");
});

test("conflict card double-click opens sheet for an UNLINKED synthetic token actor (via combatant.token.actor)", async () => {
  let rendered = 0;
  const syntheticActor = {
    name: "Grom (unlinked)",
    isToken: true,
    testUserPermission: (user, level) => true,
    sheet: { render: (force) => { rendered += 1; assert.equal(force, true); } },
  };
  const token = { id: "t-c1", actor: syntheticActor, name: "Grom Token" };
  globalThis.CONST = {
    DOCUMENT_OWNERSHIP_LEVELS: { LIMITED: 1, OWNER: 2 },
    DRAWING_TYPES: { RECTANGLE: "r" },
  };
  // combatant with synthetic token actor, no linked actor
  const combat = {
    id: "combat-abc",
    combatants: [{ id: "c1", token, actor: null }],
  };
  const scene = menuScene("combat-abc", ["c1"]);
  scene.flags[FLAG_SCOPE][sync.CONFLICT_BOARD_WIDGET_FLAG] = {
    widgetId: "wBoard",
    zoneWidgetIds: {},
    cardWidgetIds: { c1: "wCard1" },
  };
  installMenuCombat({}, combat, scene);
  const handled = await mod.handleConflictDocumentDoubleClick(
    fullCardDoc("c1", { part: "name", index: 0 }),
    fakeMenuEvent(),
  );
  assert.equal(handled, true);
  assert.equal(rendered, 1, "unlinked synthetic token actor must open its sheet");
});

test("conflict card double-click falls back to tokenUuid via fromUuid when combat is unavailable (unlinked-aware)", async () => {
  let rendered = 0;
  const syntheticActor = {
    name: "Grom (orphan)",
    isToken: true,
    testUserPermission: (user, level) => true,
    sheet: { render: () => { rendered += 1; } },
  };
  const tokenDoc = { id: "t-c1", uuid: "Scene.scene1.Token.t-c1", actor: syntheticActor };
  globalThis.CONST = {
    DOCUMENT_OWNERSHIP_LEVELS: { LIMITED: 1, OWNER: 2 },
    DRAWING_TYPES: { RECTANGLE: "r" },
  };
  globalThis.fromUuid = async (uuid) => {
    assert.equal(uuid, "Scene.scene1.Token.t-c1");
    return tokenDoc;
  };
  // No combat available — state has combatId but game.combats returns null
  const scene = menuScene("combat-abc", ["c1"]);
  scene.flags[FLAG_SCOPE][sync.CONFLICT_BOARD_WIDGET_FLAG] = {
    widgetId: "wBoard",
    zoneWidgetIds: {},
    cardWidgetIds: { c1: "wCard1" },
  };
  globalThis.canvas = { scene };
  globalThis.game = {
    user: { isGM: true },
    i18n: { localize: (key) => key },
    combat: null,
    combats: { get: () => null },
  };
  globalThis.CONST.DOCUMENT_OWNERSHIP_LEVELS.LIMITED = 1;
  // Need a board state so readConflictBoard returns state; menuScene already has it.
  // Provide a minimal canvas.scene for resolveCardActor fallback.
  const handled = await mod.handleConflictDocumentDoubleClick(
    fullCardDoc("c1"),
    fakeMenuEvent(),
  );
  assert.equal(handled, true);
  assert.equal(rendered, 1, "fallback via tokenUuid must open synthetic actor sheet");
  delete globalThis.fromUuid;
});

test("conflict card double-click respects LIMITED permission (no render for unauthorized user)", async () => {
  let rendered = 0;
  const actor = {
    name: "Grom",
    testUserPermission: (user, level) => false,
    sheet: { render: () => { rendered += 1; } },
  };
  globalThis.CONST = {
    DOCUMENT_OWNERSHIP_LEVELS: { LIMITED: 1, OWNER: 2 },
    DRAWING_TYPES: { RECTANGLE: "r" },
  };
  const combat = {
    id: "combat-abc",
    combatants: [{ id: "c1", token: { actor }, actor }],
  };
  const scene = menuScene("combat-abc", ["c1"]);
  scene.flags[FLAG_SCOPE][sync.CONFLICT_BOARD_WIDGET_FLAG] = {
    widgetId: "wBoard",
    zoneWidgetIds: {},
    cardWidgetIds: { c1: "wCard1" },
  };
  installMenuCombat({}, combat, scene);
  const handled = await mod.handleConflictDocumentDoubleClick(
    fullCardDoc("c1"),
    fakeMenuEvent(),
  );
  assert.equal(handled, true);
  assert.equal(rendered, 0, "unauthorized user must not open the sheet (permission gate)");
});

test("zone and board double-clicks are consumed without opening any sheet", async () => {
  let rendered = 0;
  const actor = {
    name: "Grom",
    testUserPermission: () => true,
    sheet: { render: () => { rendered += 1; } },
  };
  globalThis.CONST = {
    DOCUMENT_OWNERSHIP_LEVELS: { LIMITED: 1, OWNER: 2 },
    DRAWING_TYPES: { RECTANGLE: "r" },
  };
  const combat = {
    id: "combat-abc",
    combatants: [{ id: "c1", token: { actor }, actor }],
  };
  const scene = menuScene("combat-abc", ["c1"]);
  scene.flags[FLAG_SCOPE][sync.CONFLICT_BOARD_WIDGET_FLAG] = {
    widgetId: "wBoard",
    zoneWidgetIds: { "zone-1": "wZone1" },
    cardWidgetIds: { c1: "wCard1" },
  };
  installMenuCombat({}, combat, scene);
  function zoneDoc() {
    return {
      id: "zone-doc",
      documentName: "Drawing",
      x: 0, y: 0, shape: { width: 10, height: 10 },
      getFlag(scope, key) {
        if (scope !== FLAG_SCOPE) return undefined;
        if (key === "ownerType") return "conflictZone";
        if (key === "widgetId") return "wZone1";
        return undefined;
      },
    };
  }
  function boardDoc() {
    return {
      id: "board-doc",
      documentName: "Drawing",
      x: 0, y: 0, shape: { width: 10, height: 10 },
      getFlag(scope, key) {
        if (scope !== FLAG_SCOPE) return undefined;
        if (key === "ownerType") return "conflictBoard";
        if (key === "widgetId") return "wBoard";
        return undefined;
      },
    };
  }
  assert.equal(await mod.handleConflictDocumentDoubleClick(zoneDoc(), fakeMenuEvent()), true);
  assert.equal(await mod.handleConflictDocumentDoubleClick(boardDoc(), fakeMenuEvent()), true);
  assert.equal(rendered, 0, "zone/board double-clicks must not open the sheet");
});

/* ------------------------------------------------------------------ *
 * Turn marker double-click transparency (marker should open underlying card)
 * ------------------------------------------------------------------ */

test("findConflictCardAtPoint pure helper picks highest z and handles nulls", () => {
  const rects = [
    { x: 0, y: 0, width: 100, height: 100, z: 0, combatantId: "c1" },
    { x: 0, y: 0, width: 100, height: 100, z: 10, combatantId: "c2" },
    { x: 200, y: 200, width: 50, height: 50, z: 5, combatantId: "c3" },
  ];
  assert.equal(mod.findConflictCardAtPoint(rects, { x: 10, y: 10 }).combatantId, "c2");
  assert.equal(mod.findConflictCardAtPoint(rects, { x: 210, y: 210 }).combatantId, "c3");
  assert.equal(mod.findConflictCardAtPoint(rects, { x: 500, y: 500 }), null);
  assert.equal(mod.findConflictCardAtPoint([], { x: 10, y: 10 }), null);
  assert.equal(mod.findConflictCardAtPoint(rects, null), null);
  assert.equal(mod.findConflictCardAtPoint(null, { x: 10, y: 10 }), null);
});

test("findConflictCardAtPoint respects exact bounds inclusive", () => {
  const rects = [{ x: 10, y: 10, width: 20, height: 20, z: 0, combatantId: "c1" }];
  assert.equal(mod.findConflictCardAtPoint(rects, { x: 10, y: 10 }).combatantId, "c1");
  assert.equal(mod.findConflictCardAtPoint(rects, { x: 30, y: 30 }).combatantId, "c1");
  assert.equal(mod.findConflictCardAtPoint(rects, { x: 30.1, y: 30 }), null);
});

test("isTurnMarkerDocument recognizes only the turn marker overlay", () => {
  const marker = {
    getFlag: (scope, key) => {
      if (scope !== FLAG_SCOPE) return undefined;
      if (key === "ownerType") return "conflictBoard";
      if (key === "part") return "conflictTurnMarker";
      return undefined;
    },
  };
  const board = {
    getFlag: (scope, key) => {
      if (scope !== FLAG_SCOPE) return undefined;
      if (key === "ownerType") return "conflictBoard";
      if (key === "part") return "conflictBoardBackground";
      return undefined;
    },
  };
  const card = {
    getFlag: (scope, key) => {
      if (scope !== FLAG_SCOPE) return undefined;
      if (key === "ownerType") return CONFLICT_CARD_OWNER_TYPE;
      return undefined;
    },
  };
  assert.equal(mod.isTurnMarkerDocument(marker), true);
  assert.equal(mod.isTurnMarkerDocument(board), false);
  assert.equal(mod.isTurnMarkerDocument(card), false);
  assert.equal(mod.isTurnMarkerDocument(null), false);
});

test("findTopConflictCardDocAtPoint picks the topmost card doc at a world point", () => {
  const card1 = mockConflictDoc("c1", "Drawing", CONFLICT_CARD_OWNER_TYPE, { x: 0, y: 0, width: 100, height: 100 }, { elevation: 0, sort: 0 });
  card1.getFlag = (scope, key) => {
    if (scope !== FLAG_SCOPE) return undefined;
    if (key === "ownerType") return CONFLICT_CARD_OWNER_TYPE;
    if (key === "widgetId") return "w1";
    if (key === "combatantId") return "c1";
    return undefined;
  };
  const card2 = mockConflictDoc("c2", "Drawing", CONFLICT_CARD_OWNER_TYPE, { x: 0, y: 0, width: 100, height: 100 }, { elevation: 10, sort: 0 });
  card2.getFlag = (scope, key) => {
    if (scope !== FLAG_SCOPE) return undefined;
    if (key === "ownerType") return CONFLICT_CARD_OWNER_TYPE;
    if (key === "widgetId") return "w2";
    if (key === "combatantId") return "c2";
    return undefined;
  };
  const scene = mockScene([card1, card2]);
  const hit = mod.findTopConflictCardDocAtPoint(scene, { x: 10, y: 10 });
  assert.equal(hit.id, "c2");
  assert.equal(mod.findTopConflictCardDocAtPoint(scene, { x: 200, y: 200 }), null);
  assert.equal(mod.findTopConflictCardDocAtPoint(null, { x: 10, y: 10 }), null);
});

test("turn marker double-click opens the underlying card sheet (PIXI path)", async () => {
  let rendered = 0;
  const actor = {
    name: "Grom",
    testUserPermission: () => true,
    sheet: { render: () => { rendered += 1; } },
  };
  globalThis.CONST = { DOCUMENT_OWNERSHIP_LEVELS: { LIMITED: 1 }, DRAWING_TYPES: { RECTANGLE: "r" } };
  globalThis.PIXI = { Point: class { constructor(x, y) { this.x = x; this.y = y; } } };
  const combat = { id: "combat-abc", combatants: [{ id: "c1", token: { actor }, actor }] };
  const scene = menuScene("combat-abc", ["c1"]);
  // card doc at world (100,100) size 100x100
  const cardDoc = {
    id: "card-c1",
    documentName: "Drawing",
    x: 100, y: 100, elevation: 0, sort: 0, shape: { width: 100, height: 100 },
    getFlag(scope, key) {
      if (scope !== FLAG_SCOPE) return undefined;
      if (key === "ownerType") return CONFLICT_CARD_OWNER_TYPE;
      if (key === "combatantId") return "c1";
      if (key === "tokenUuid") return "Scene.scene1.Token.t-c1";
      if (key === "widgetId") return "wCard1";
      return undefined;
    },
  };
  const markerDoc = {
    id: "marker",
    documentName: "Drawing",
    x: 96, y: 96, elevation: 12, sort: 1200, shape: { width: 108, height: 108 },
    getFlag(scope, key) {
      if (scope !== FLAG_SCOPE) return undefined;
      if (key === "ownerType") return "conflictBoard";
      if (key === "part") return "conflictTurnMarker";
      if (key === "widgetId") return "wBoard";
      return undefined;
    },
  };
  // Provide both docs on scene so findTop can locate the card.
  scene.drawings = [cardDoc, markerDoc];
  scene.tiles = [];
  installMenuCombat({}, combat, scene);
  // Preserve the canvas app/stage needed for world point resolution (installMenuCombat overwrites canvas)
  globalThis.canvas.app = { view: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 1000 }), width: 1000, height: 1000 } };
  globalThis.canvas.stage = { worldTransform: { applyInverse: (pt) => ({ x: pt.x, y: pt.y }) } };
  // Event at world point inside both marker and card
  const evt = { clientX: 150, clientY: 150, preventDefault() {}, stopPropagation() {} };
  const handled = await mod.handleConflictDocumentDoubleClick(markerDoc, evt);
  assert.equal(handled, true);
  assert.equal(rendered, 1, "marker double-click must open underlying card sheet");
  delete globalThis.PIXI;
});

test("turn marker double-click with no card underneath is consumed without sheet", async () => {
  let rendered = 0;
  const actor = { name: "Grom", testUserPermission: () => true, sheet: { render: () => { rendered += 1; } } };
  globalThis.CONST = { DOCUMENT_OWNERSHIP_LEVELS: { LIMITED: 1 }, DRAWING_TYPES: { RECTANGLE: "r" } };
  globalThis.PIXI = { Point: class { constructor(x, y) { this.x = x; this.y = y; } } };
  const combat = { id: "combat-abc", combatants: [{ id: "c1", token: { actor }, actor }] };
  const scene = menuScene("combat-abc", ["c1"]);
  const markerDoc = {
    id: "marker",
    documentName: "Drawing",
    x: 500, y: 500, elevation: 12, sort: 1200, shape: { width: 108, height: 108 },
    getFlag(scope, key) {
      if (scope !== FLAG_SCOPE) return undefined;
      if (key === "ownerType") return "conflictBoard";
      if (key === "part") return "conflictTurnMarker";
      if (key === "widgetId") return "wBoard";
      return undefined;
    },
  };
  scene.drawings = [markerDoc];
  scene.tiles = [];
  installMenuCombat({}, combat, scene);
  globalThis.canvas.app = { view: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 1000 }), width: 1000, height: 1000 } };
  globalThis.canvas.stage = { worldTransform: { applyInverse: (pt) => ({ x: pt.x, y: pt.y }) } };
  const evt = { clientX: 550, clientY: 550, preventDefault() {}, stopPropagation() {} };
  // No card doc at that point, so no sheet
  const handled = await mod.handleConflictDocumentDoubleClick(markerDoc, evt);
  assert.equal(handled, true);
  assert.equal(rendered, 0);
  delete globalThis.PIXI;
});

/* ------------------------------------------------------------------ *
 * Pure helpers: buildSkillMenuItems & markEliminatedInState
 * ------------------------------------------------------------------ */

test("buildSkillMenuItems shows all skills with name, positives first then zero/negatives", () => {
  const actor = {
    system: {
      skills: {
        a: { name: "Stealth", rank: 2 },
        b: { name: "Athletics", rank: 4 },
        c: { name: "Burglary", rank: 0 },
        d: { name: "Fight", rank: 1 },
        e: { name: "Shoot", rank: 3 },
        f: { name: "", rank: 5 },
        g: { name: "Notice", rank: "2" },
        h: { name: "Lore", rank: -1 },
        i: { name: "Crafts", rank: 0 },
        j: { name: "Will", rank: -2 },
      },
    },
    rollSkill: async () => {},
  };
  const items = mod.buildSkillMenuItems(actor);
  // positives descending: 4,3,2,2,1 then zero/negatives descending: 0,0,-1,-2; ties alphabetically
  assert.deepEqual(items.map((it) => it.label), [
    "Athletics (+4)",
    "Shoot (+3)",
    "Notice (+2)",
    "Stealth (+2)",
    "Fight (+1)",
    "Burglary (+0)",
    "Crafts (+0)",
    "Lore (+-1)",
    "Will (+-2)",
  ]);
  assert.ok(items.every((it) => it.icon === "fa-dice-d20"));
  assert.ok(items.every((it) => typeof it.onClick === "function"));
  // empty name filtered
  assert.equal(items.some((it) => it.label.includes("(+5)")), false);
  // original actor not mutated
  assert.equal(Object.keys(actor.system.skills).length, 10);
});

test("buildSkillMenuItems returns [] for missing/empty skills", () => {
  assert.deepEqual(mod.buildSkillMenuItems(null), []);
  assert.deepEqual(mod.buildSkillMenuItems({}), []);
  assert.deepEqual(mod.buildSkillMenuItems({ system: {} }), []);
  assert.deepEqual(mod.buildSkillMenuItems({ system: { skills: {} } }), []);
  // only empty names -> []
  const actorEmpty = { system: { skills: { a: { name: "", rank: 0 }, b: { name: "  ", rank: 2 } } }, rollSkill: async () => {} };
  assert.deepEqual(mod.buildSkillMenuItems(actorEmpty), []);
  // sanity: rank 0 and negative are NOT filtered when name present
  const actorWithZero = { system: { skills: { a: { name: "Foo", rank: 0 }, b: { name: "Bar", rank: -1 } } }, rollSkill: async () => {} };
  assert.deepEqual(mod.buildSkillMenuItems(actorWithZero).map((it) => it.label), ["Foo (+0)", "Bar (+-1)"]);
});

test("buildSkillMenuItems onClick calls actor.rollSkill and warns on throw", async () => {
  let called = null;
  const actor = {
    system: { skills: { a: { name: "Athletics", rank: 2 } } },
    rollSkill: async (name) => { called = name; if(name==="Athletics") throw new Error("boom"); },
  };
  const items = mod.buildSkillMenuItems(actor);
  assert.equal(items.length, 1);
  // should not throw, should warn
  let warned = null;
  const origWarn = console.warn;
  console.warn = (...args) => { warned = args.join(" "); };
  try {
    await items[0].onClick();
    assert.equal(called, "Athletics");
    assert.ok(warned && warned.includes("skill roll failed"));
  } finally {
    console.warn = origWarn;
  }
  // success path
  called = null;
  const actor2 = { system: { skills: { a: { name: "Stealth", rank: 1 } } }, rollSkill: async (name) => { called = name; } };
  const items2 = mod.buildSkillMenuItems(actor2);
  await items2[0].onClick();
  assert.equal(called, "Stealth");
});

test("buildSkillMenuItems onClick for zero-rank skill calls rollSkill with its name", async () => {
  let called = null;
  const actor = {
    system: { skills: { a: { name: "Burglary", rank: 0 }, b: { name: "Lore", rank: -1 } } },
    rollSkill: async (name) => { called = name; },
  };
  const items = mod.buildSkillMenuItems(actor);
  assert.deepEqual(items.map((it) => it.label), ["Burglary (+0)", "Lore (+-1)"]);
  await items[0].onClick();
  assert.equal(called, "Burglary");
  await items[1].onClick();
  assert.equal(called, "Lore");
});

test("markEliminatedInState clones correctly and is pure", () => {
  const state = boardState({ cards: { c1: { side: "friendly", area: "side", order: 0 }, c2: { side: "hostile", area: "side", order: 1 } } });
  const next = mod.markEliminatedInState(state, "c1");
  assert.equal(next !== state, true);
  assert.equal(next.cards.c1.eliminated, true);
  assert.equal(next.cards.c1.side, "friendly");
  assert.equal(next.cards.c2, state.cards.c2); // untouched ref not required but value equal
  // original not mutated
  assert.equal(state.cards.c1.eliminated, undefined);
  // already eliminated -> same ref
  const next2 = mod.markEliminatedInState(next, "c1");
  assert.equal(next2, next);
  // missing id -> same ref
  assert.equal(mod.markEliminatedInState(state, "missing"), state);
  assert.equal(mod.markEliminatedInState(null, "c1"), null);
  assert.equal(mod.markEliminatedInState(state, ""), state);
});

test("card context menu shows Roll submenu when actor has skills (sorted, with icons)", async () => {
  const dom = installMenuDomStub();
  const actor = {
    system: { skills: { a: { name: "Stealth", rank: 2 }, b: { name: "Athletics", rank: 4 }, c: { name: "Fight", rank: 0 } } },
    rollSkill: async () => {},
  };
  const combat = {
    id: "combat-abc",
    turn: 0,
    combatants: [
      menuCombatant("c1"),
      { id: "c2", name: "c2", defeated: false, token: { actor }, actor, getFlag: (scope,key) => { if(scope==="fate-core-official" && key==="hasActed") return false; return undefined; } },
    ],
  };
  const scene = menuScene("combat-abc", ["c1", "c2"]);
  // give combatant c2 a card with tokenUuid
  installMenuCombat({}, combat, scene);
  // card doc for c2 with tokenUuid that would resolve via sync path (combatant.token.actor)
  const doc = {
    id: "card-c2",
    documentName: "Drawing",
    x: 0, y: 0, shape: { width: 10, height: 10 },
    getFlag(scope,key){
      if(scope!==FLAG_SCOPE) return undefined;
      if(key==="ownerType") return CONFLICT_CARD_OWNER_TYPE;
      if(key==="combatantId") return "c2";
      if(key==="tokenUuid") return "Scene.scene1.Token.t-c2";
      return undefined;
    },
  };
  const handled = await mod.handleConflictContextMenu(doc, fakeMenuEvent());
  assert.equal(handled, true);
  // should have at least pass turn + roll + leave combat (since not defeated, not eliminated)
  // Order: Pass, sep, Roll, sep, Leave combat. Pass is available (c2 not current, not acted)
  // Check roll button exists
  const labels = dom.createdButtons.map((b) => b.innerHTML);
  const hasRoll = labels.some((html) => html.includes("fate-on-the-table.conflict.card.roll"));
  assert.equal(hasRoll, true, "Roll item must be present when actor has skills");
  // verify roll is not shown as disabled sep etc - it should have chevron for submenu
  const rollBtn = dom.createdButtons.find((b) => b.innerHTML.includes("fate-on-the-table.conflict.card.roll"));
  assert.ok(rollBtn.innerHTML.includes("fa-chevron-right"), "Roll with children should show chevron");
  // Check Leave combat present at bottom
  const hasLeave = labels.some((html) => html.includes("fate-on-the-table.conflict.card.leaveCombat"));
  assert.equal(hasLeave, true);
  // Check ordering: Pass before Roll before Leave
  const idxPass = labels.findIndex((h) => h.includes("fate-on-the-table.conflict.card.passTurn"));
  const idxRoll = labels.findIndex((h) => h.includes("fate-on-the-table.conflict.card.roll"));
  const idxLeave = labels.findIndex((h) => h.includes("fate-on-the-table.conflict.card.leaveCombat"));
  assert.ok(idxPass >= 0 && idxRoll >= 0 && idxLeave >= 0);
  assert.ok(idxPass < idxRoll && idxRoll < idxLeave, "Order must be Pass -> Roll -> Leave");
});

test("card context menu hides Roll when actor has no skills or no actor", async () => {
  const dom = installMenuDomStub();
  const combat = {
    id: "combat-abc",
    turn: 0,
    combatants: [
      menuCombatant("c1"),
      menuCombatant("c2"),
    ],
  };
  const scene = menuScene("combat-abc", ["c1", "c2"]);
  installMenuCombat({}, combat, scene);
  const doc = cardContextDoc("c2");
  // ensure actor cannot be resolved (menuCombatant has no actor)
  const handled = await mod.handleConflictContextMenu(doc, fakeMenuEvent());
  assert.equal(handled, true);
  const labels = dom.createdButtons.map((b) => b.innerHTML);
  const hasRoll = labels.some((html) => html.includes("fate-on-the-table.conflict.card.roll"));
  assert.equal(hasRoll, false, "Roll must be hidden when no actor/skills");
});

test("card context menu Roll hidden when fromUuid returns actor without skills (fallback path)", async () => {
  const dom = installMenuDomStub();
  const combat = {
    id: "combat-abc",
    turn: 0,
    combatants: [
      menuCombatant("c1"),
      { id: "c2", name: "c2", defeated: false, token: null, actor: null, getFlag: () => false },
    ],
  };
  const actorNoSkills = { system: { skills: { a: { name: "", rank: 0 } } }, rollSkill: async () => {} };
  globalThis.fromUuid = async () => ({ actor: actorNoSkills });
  const scene = menuScene("combat-abc", ["c1", "c2"]);
  installMenuCombat({}, combat, scene);
  const doc = {
    id: "card-c2",
    documentName: "Drawing",
    x: 0, y: 0, shape: { width: 10, height: 10 },
    getFlag(scope,key){
      if(scope!==FLAG_SCOPE) return undefined;
      if(key==="ownerType") return CONFLICT_CARD_OWNER_TYPE;
      if(key==="combatantId") return "c2";
      if(key==="tokenUuid") return "Scene.scene1.Token.t-c2";
      return undefined;
    },
  };
  try {
    const handled = await mod.handleConflictContextMenu(doc, fakeMenuEvent());
    assert.equal(handled, true);
    const labels = dom.createdButtons.map((b) => b.innerHTML);
    assert.equal(labels.some((h) => h.includes("fate-on-the-table.conflict.card.roll")), false);
  } finally {
    delete globalThis.fromUuid;
  }
});

test("card context menu Leave combat is hidden when defeated or already eliminated", async () => {
  const dom1 = installMenuDomStub();
  const combat = {
    id: "combat-abc",
    turn: 0,
    combatants: [menuCombatant("c1"), menuCombatant("c2", { defeated: true })],
  };
  const scene = menuScene("combat-abc", ["c1", "c2"]);
  installMenuCombat({}, combat, scene);
  let handled = await mod.handleConflictContextMenu(cardContextDoc("c2"), fakeMenuEvent());
  assert.equal(handled, true);
  let labels = dom1.createdButtons.map((b) => b.innerHTML);
  assert.equal(labels.some((h) => h.includes("fate-on-the-table.conflict.card.leaveCombat")), false, "defeated should hide Leave");

  // eliminated via state
  uninstallMenuDomStub();
  const dom2 = installMenuDomStub();
  const combat2 = { id: "combat-abc", turn: 0, combatants: [menuCombatant("c1"), menuCombatant("c2")] };
  const scene2 = menuScene("combat-abc", ["c1", "c2"]);
  scene2.flags[FLAG_SCOPE][CONFLICT_BOARD_FLAG].cards.c2.eliminated = true;
  installMenuCombat({}, combat2, scene2);
  handled = await mod.handleConflictContextMenu(cardContextDoc("c2"), fakeMenuEvent());
  assert.equal(handled, true);
  labels = dom2.createdButtons.map((b) => b.innerHTML);
  assert.equal(labels.some((h) => h.includes("fate-on-the-table.conflict.card.leaveCombat")), false, "eliminated should hide Leave");
});

test("card context menu Leave combat action marks defeated and eliminated", async () => {
  const dom = installMenuDomStub();
  let defeatedUpdate = null;
  const combatant = {
    id: "c2",
    name: "c2",
    defeated: false,
    token: { actor: null },
    actor: null,
    getFlag: () => false,
    update: async (data) => { defeatedUpdate = data; combatant.defeated = !!data.defeated; return combatant; },
  };
  const combat = { id: "combat-abc", turn: 0, combatants: [menuCombatant("c1"), combatant] };
  // Build a full scene with update support via fullMockScene helper (reuse placedBoardScene style)
  const baseState = createConflictBoard({ combatId: "combat-abc", sizePreset: "medium", origin: { x: 0, y: 0 } });
  baseState.cards = { c1: { side: "friendly", area: "side", order: 0 }, c2: { side: "friendly", area: "side", order: 1 } };
  const scene = {
    id: "scene1",
    flags: { [FLAG_SCOPE]: { [CONFLICT_BOARD_FLAG]: baseState, [sync.CONFLICT_BOARD_WIDGET_FLAG]: { widgetId: "wBoard", zoneWidgetIds: {}, cardWidgetIds: {} } } },
    drawings: [],
    tiles: [],
    getFlag(scope,key){ return this.flags[scope]?.[key]; },
    async update(data,options){
      for(const [k,v] of Object.entries(data)){
        const parts = k.split(".");
        let t=this;
        for(let i=0;i<parts.length-1;i++){ if(typeof t[parts[i]]!=="object"||t[parts[i]]===null) t[parts[i]]={}; t=t[parts[i]]; }
        t[parts[parts.length-1]]=v;
      }
      return this;
    },
    async unsetFlag(scope,key){ if(this.flags[scope]) delete this.flags[scope][key]; return this; },
    async deleteEmbeddedDocuments(){return [];},
    async updateEmbeddedDocuments(){return [];},
    async createEmbeddedDocuments(){return [];},
  };
  globalThis.canvas = { scene };
  globalThis.game = { user: { isGM: true }, i18n: { localize: (k) => k }, combat, combats: { get: () => combat } };
  globalThis.CONST = { DRAWING_TYPES: { RECTANGLE: "r" }, DRAWING_FILL_TYPES: { NONE: 0 } };
  globalThis.foundry.applications.api.DialogV2 = { confirm: async () => true, input: async () => null };
  const doc = {
    id: "card-c2",
    documentName: "Drawing",
    x: 0, y: 0, shape: { width: 10, height: 10 },
    getFlag(scope,key){
      if(scope!==FLAG_SCOPE) return undefined;
      if(key==="ownerType") return CONFLICT_CARD_OWNER_TYPE;
      if(key==="combatantId") return "c2";
      if(key==="tokenUuid") return "Scene.scene1.Token.t-c2";
      return undefined;
    },
  };
  const handled = await mod.handleConflictContextMenu(doc, fakeMenuEvent());
  assert.equal(handled, true);
  const leaveBtn = dom.createdButtons.find((b) => b.innerHTML.includes("fate-on-the-table.conflict.card.leaveCombat"));
  assert.ok(leaveBtn, "Leave combat button must exist");
  leaveBtn.click();
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(defeatedUpdate, { defeated: true });
  const after = sync.readConflictBoard(scene);
  assert.equal(after.cards.c2.eliminated, true);
});

test("card context menu with only Leave combat (no Pass/Return, no Roll) still shows menu", async () => {
  const dom = installMenuDomStub();
  const combat = {
    id: "combat-abc",
    turn: 0,
    combatants: [menuCombatant("c1", { hasActed: true }), menuCombatant("c2")], // c2? actually we test c1 current acted: no pass, but return available -> would be return. Let's make solitary card that is current so no pass/return
  };
  // single combatant current => no pass, no return if not acted, but leave should still show
  const singleCombat = { id: "combat-abc", turn: 0, combatants: [menuCombatant("c1")] };
  const scene = menuScene("combat-abc", ["c1"]);
  installMenuCombat({}, singleCombat, scene);
  const doc = cardContextDoc("c1");
  const handled = await mod.handleConflictContextMenu(doc, fakeMenuEvent());
  assert.equal(handled, true);
  const labels = dom.createdButtons.map((b) => b.innerHTML);
  // No pass/return for current unacted, but leave should be there, and roll hidden (no actor)
  assert.equal(labels.some((h) => h.includes("fate-on-the-table.conflict.card.passTurn")), false);
  assert.equal(labels.some((h) => h.includes("fate-on-the-table.conflict.card.returnTurn")), false);
  assert.equal(labels.some((h) => h.includes("fate-on-the-table.conflict.card.roll")), false);
  assert.equal(labels.some((h) => h.includes("fate-on-the-table.conflict.card.leaveCombat")), true);
  assert.equal(dom.body.children.length, 1);
});
