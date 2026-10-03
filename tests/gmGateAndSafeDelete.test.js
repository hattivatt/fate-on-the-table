import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existingDocumentIds, safeDeleteEmbeddedDocuments } from "../scripts/utils.js";

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------
function mockSceneWithMaps({ drawIds = [], tileIds = [] } = {}) {
  const drawMap = new Map(drawIds.map((id) => [id, { id }]));
  const tileMap = new Map(tileIds.map((id) => [id, { id }]));
  return {
    drawings: { get: (id) => drawMap.get(id) ?? null },
    tiles: { get: (id) => tileMap.get(id) ?? null },
  };
}

// ------------------------------------------------------------------
// existingDocumentIds
// ------------------------------------------------------------------
test("existingDocumentIds: filters to still-existing Drawing ids via scene.drawings.get", () => {
  const scene = mockSceneWithMaps({ drawIds: ["a", "c"] });
  assert.deepEqual(existingDocumentIds(scene, "Drawing", ["a", "b", "c", "d"]), ["a", "c"]);
});

test("existingDocumentIds: filters to still-existing Tile ids via scene.tiles.get", () => {
  const scene = mockSceneWithMaps({ tileIds: ["t1", "t2"] });
  assert.deepEqual(existingDocumentIds(scene, "Tile", ["t1", "missing", "t2"]), ["t1", "t2"]);
});

test("existingDocumentIds: passes through when scene has no .get (array-based Node mocks)", () => {
  const scene = { drawings: [], tiles: [] }; // no .get
  assert.deepEqual(existingDocumentIds(scene, "Drawing", ["x", "y"]), ["x", "y"]);
  assert.deepEqual(existingDocumentIds(scene, "Tile", ["x"]), ["x"]);
});

test("existingDocumentIds: empty / non-array returns []", () => {
  const scene = mockSceneWithMaps({ drawIds: ["a"] });
  assert.deepEqual(existingDocumentIds(scene, "Drawing", []), []);
  assert.deepEqual(existingDocumentIds(scene, "Drawing", null), []);
  assert.deepEqual(existingDocumentIds(null, "Drawing", ["a"]), ["a"]); // no coll -> passthrough per impl
});

// ------------------------------------------------------------------
// safeDeleteEmbeddedDocuments — idempotent swallow
// ------------------------------------------------------------------
test("safeDeleteEmbeddedDocuments: swallows 'does not exist' error", async () => {
  const scene = {
    drawings: { get: (id) => ({ id }) },
    tiles: { get: () => null },
    async deleteEmbeddedDocuments(type, ids) {
      throw new Error('Drawing "missing" does not exist!');
    },
  };
  // should not throw
  await safeDeleteEmbeddedDocuments(scene, "Drawing", ["missing"], {});
});

test("safeDeleteEmbeddedDocuments: re-throws non-'does not exist' errors", async () => {
  const scene = {
    drawings: { get: (id) => ({ id }) },
    tiles: { get: () => null },
    async deleteEmbeddedDocuments() {
      throw new Error("permission denied");
    },
  };
  await assert.rejects(() => safeDeleteEmbeddedDocuments(scene, "Drawing", ["a"], {}), /permission denied/);
});

test("safeDeleteEmbeddedDocuments: no-op when filtered list empty", async () => {
  let called = false;
  const scene = {
    drawings: { get: () => null }, // nothing exists
    tiles: { get: () => null },
    async deleteEmbeddedDocuments() {
      called = true;
    },
  };
  await safeDeleteEmbeddedDocuments(scene, "Drawing", ["ghost"], {});
  assert.equal(called, false);
});

test("safeDeleteEmbeddedDocuments: deletes only still-existing ids (filters before call)", async () => {
  let passedIds = null;
  const scene = {
    drawings: {
      get: (id) => (id === "keep" ? { id } : null),
    },
    tiles: { get: () => null },
    async deleteEmbeddedDocuments(type, ids) {
      passedIds = ids;
    },
  };
  await safeDeleteEmbeddedDocuments(scene, "Drawing", ["keep", "gone"], {});
  assert.deepEqual(passedIds, ["keep"]);
});

// ------------------------------------------------------------------
// GM gate — sync entry points must be test-friendly (no crash when game absent)
// and must no-op for non-GM.
// ------------------------------------------------------------------
afterEach(() => {
  // clean global game pollution between GM tests
  delete globalThis.game;
  delete globalThis.canvas;
  delete globalThis.foundry;
  delete globalThis.CONST;
});

// Minimal foundry stub required for SituationAspectSync / FatePointSync imports
function installFoundryStub() {
  globalThis.foundry = {
    applications: { api: { ApplicationV2: class {} } },
    utils: {
      duplicate: (v) => structuredClone(v),
      getProperty: (obj, path) => {
        let t = obj;
        for (const k of String(path).split(".")) {
          if (t == null) return undefined;
          t = t[k];
        }
        return t;
      },
      hasProperty: (obj, path) => {
        let t = obj;
        for (const k of String(path).split(".")) {
          if (t == null) return false;
          t = t[k];
        }
        return t !== undefined;
      },
    },
  };
  globalThis.CONST = {
    DRAWING_TYPES: { RECTANGLE: "r" },
    DRAWING_FILL_TYPES: { NONE: 0, SOLID: 1, PATTERN: 2 },
    DOCUMENT_OWNERSHIP_LEVELS: { OWNER: 2 },
  };
  globalThis.CONFIG = { fontDefinitions: {}, tileMappings: {} };
}

test("GM gate: syncSituationAspects returns false for non-GM and does not touch scene", async () => {
  installFoundryStub();
  const { syncSituationAspects } = await import("../scripts/SituationAspectSync.js");
  globalThis.game = {
    user: { isGM: false, id: "player1" },
    i18n: { localize: (k) => k },
    settings: { get: () => undefined },
  };
  const scene = {
    id: "scene1",
    flags: {},
    drawings: [],
    tiles: [],
    getFlag: () => null,
    setFlag: async () => assert.fail("should not write"),
  };
  const res = await syncSituationAspects(scene);
  assert.equal(res, false);
});

test("GM gate: syncSituationAspects allows GM (or absent game) to proceed — no crash when game undefined behaves like allowed", async () => {
  installFoundryStub();
  const { syncSituationAspects } = await import("../scripts/SituationAspectSync.js");
  // absent game -> allowed, but returns false because no registry
  delete globalThis.game;
  const scene = {
    id: "scene1",
    flags: {},
    drawings: [],
    tiles: [],
    getFlag: () => null,
  };
  const res = await syncSituationAspects(scene);
  assert.equal(res, false);
});

test("GM gate: syncGmFatePointRow returns false for non-GM", async () => {
  installFoundryStub();
  globalThis.game = {
    user: { isGM: false, id: "player1" },
    users: { find: () => ({ isGM: true, active: true, getFlag: () => 3 }) },
    i18n: { localize: (k) => k },
  };
  const { syncGmFatePointRow } = await import("../scripts/FatePointSync.js");
  const scene = {
    id: "scene1",
    flags: {},
    tiles: [],
    drawings: [],
    getFlag: () => null,
  };
  const res = await syncGmFatePointRow(scene);
  assert.equal(res, false);
});

test("GM gate: syncConflictBoard enqueued call resolves with notGm for non-GM", async () => {
  // ConflictBoardSync has its own GM gate BEFORE enqueuing; test that path directly
  globalThis.foundry = {
    utils: {
      getProperty: (obj, path) => {
        let t = obj;
        for (const k of String(path).split(".")) {
          if (t == null) return undefined;
          t = t[k];
        }
        return t;
      },
      randomID: () => "rand",
    },
  };
  globalThis.CONST = {
    DRAWING_TYPES: { RECTANGLE: "r" },
    DRAWING_FILL_TYPES: { NONE: 0, SOLID: 1, PATTERN: 2 },
  };
  globalThis.game = { user: { isGM: false, id: "player1" } };
  const { syncConflictBoard } = await import("../scripts/ConflictBoardSync.js");
  const scene = { id: "scene-gm-test", flags: {}, drawings: [], tiles: [], tokens: { get: () => null }, getFlag: () => null };
  const res = await syncConflictBoard(scene, {});
  assert.equal(res.reason, "notGm");
  assert.equal(res.changed, false);
});

test("GM gate: removeConflictBoard returns notGm for non-GM", async () => {
  globalThis.foundry = {
    utils: {
      getProperty: () => undefined,
      randomID: () => "rand",
    },
  };
  globalThis.CONST = {
    DRAWING_TYPES: { RECTANGLE: "r" },
    DRAWING_FILL_TYPES: { NONE: 0, SOLID: 1, PATTERN: 2 },
  };
  globalThis.game = { user: { isGM: false, id: "player1" } };
  const { removeConflictBoard } = await import("../scripts/ConflictBoardSync.js");
  const scene = { id: "scene-rm-test", flags: {}, drawings: [], tiles: [], getFlag: () => null, unsetFlag: async () => {} };
  const res = await removeConflictBoard(scene, {});
  assert.equal(res.reason, "notGm");
  assert.equal(res.changed, false);
});

test("canEditActor: Node tests without game are treated as allowed (no crash)", async () => {
  delete globalThis.game;
  globalThis.foundry = { utils: { duplicate: (v) => structuredClone(v) } };
  const { toggleStressBox } = await import("../scripts/StressBoxes.js");
  // toggleStressBox with a mock actor — game absent should be allowed
  const actor = {
    testUserPermission: () => false,
    isOwner: false,
    system: { tracks: { phys: { enabled: true, boxes: 1, box_values: [false] } } },
    async update(data) {
      assert.ok(data["system.tracks"]);
    },
  };
  // Need stressBoxTarget mapping: single track phys maps index 0
  const ok = await toggleStressBox(actor, 0);
  assert.equal(ok, true);
});
