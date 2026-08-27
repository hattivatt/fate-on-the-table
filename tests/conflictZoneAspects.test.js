/**
 * Node tests for conflict zone aspects overlay (feature T2).
 * Covers pure `zoneAspectsText`, `buildZoneDescriptors` with aspects part,
 * `buildConflictBoardDocuments` with zone-filtered aspects, and the full
 * `syncConflictBoard` create / delete / no-op / truncation lifecycle.
 *
 * Mocks scene via plain objects (same harness as conflictBoardSync.test.js).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { CONFLICT_BOARD_VERSION } from "../scripts/conflictBoardSchema.js";
import {
  buildZoneDescriptors,
  buildConflictBoardDocuments,
  syncConflictBoard,
  readConflictBoard,
  boardRegistry,
  zoneDocs,
  zoneAspectsText,
  ZONE_ASPECTS_LINE_HEIGHT,
} from "../scripts/ConflictBoardSync.js";
import {
  FLAG_SCOPE,
  CONFLICT_BOARD_FLAG,
  CONFLICT_ZONE_OWNER_TYPE,
  CONFLICT_ZONE_BODY_PART,
  CONFLICT_ZONE_LABEL_PART,
  CONFLICT_ZONE_ASPECTS_PART,
  SITUATION_ASPECTS_SCOPE,
  SITUATION_ASPECTS_KEY,
} from "../scripts/constants.js";
import { CONFLICT_BOARD_WIDGET_FLAG } from "../scripts/ConflictBoardSync.js";
import { getConflictBoardGeometry } from "../scripts/conflictBoardGeometry.js";

// ------------------------------------------------------------------
// Mocks (copied from conflictBoardSync.test.js)
// ------------------------------------------------------------------

function mockDoc(id, documentName, flags, extra = {}) {
  return {
    id,
    documentName,
    x: extra.x ?? 0,
    y: extra.y ?? 0,
    text: extra.text ?? "",
    shape: extra.shape ?? { width: extra.w ?? 0, height: extra.h ?? 0 },
    fontSize: extra.size ?? 14,
    fontFamily: extra.font ?? "Montserrat",
    textColor: extra.color ?? "#000000",
    ...extra,
    getFlag(scope, key) {
      return flags[scope]?.[key];
    },
  };
}

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

function mockScene({ flags = {}, drawings = [], tiles = [], tokens = {} } = {}) {
  const scene = {
    id: "scene1",
    drawings: [...drawings],
    tiles: [...tiles],
    tokens: { get: (id) => tokens[id] ?? null },
    flags,
    updates: [],
    unset: [],
    deleted: { Drawing: [], Tile: [] },
    embeddedUpdates: { Drawing: [], Tile: [] },
    getFlag(scope, key) {
      return this.flags[scope]?.[key];
    },
    async getFlagAsync(scope, key) {
      return this.flags[scope]?.[key];
    },
    async setFlag(scope, key, value) {
      (this.flags[scope] ??= {})[key] = structuredClone(value);
      return this;
    },
    async update(data, options) {
      for (const [k, v] of Object.entries(data)) setPath(this, k, v);
      this.updates.push({ data, options });
      return this;
    },
    async unsetFlag(scope, key) {
      if (this.flags[scope]) delete this.flags[scope][key];
      this.unset.push({ scope, key });
      return this;
    },
    async deleteEmbeddedDocuments(kind, ids) {
      this.deleted[kind].push(...ids);
      const arr = kind === "Drawing" ? this.drawings : this.tiles;
      for (const id of ids ?? []) {
        const i = arr.findIndex((x) => x.id === id);
        assert.ok(i >= 0, `deleteEmbeddedDocuments("${kind}") referenced missing _id "${id}"`);
        arr.splice(i, 1);
      }
      return this;
    },
    async updateEmbeddedDocuments(kind, docs) {
      this.embeddedUpdates[kind].push(...docs);
      const arr = kind === "Drawing" ? this.drawings : this.tiles;
      for (const d of docs ?? []) {
        assert.ok(arr.some((x) => x.id === d._id), `updateEmbeddedDocuments("${kind}") referenced missing _id "${d._id}"`);
        for (const [k, v] of Object.entries(d)) {
          if (k === "_id") continue;
          setPath(arr.find((x) => x.id === d._id), k, v);
        }
      }
      return this;
    },
    async createEmbeddedDocuments(kind, docs) {
      const arr = kind === "Drawing" ? this.drawings : this.tiles;
      for (const d of docs ?? []) {
        arr.push({
          id: d._id ?? `new-${arr.length}-${Math.random().toString(36).slice(2, 6)}`,
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

function validState(overrides = {}) {
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
        name: "Room",
        rect: { x: 10, y: 10, width: 150, height: 120 },
        style: { fill: "#ffffff", alpha: 0.12, stroke: "#000000" },
        sort: 0,
      },
    ],
    cards: {},
    tokenZones: {},
    ...overrides,
  };
}

function registryRecord(overrides = {}) {
  return {
    widgetId: "wBoard",
    zoneWidgetIds: { "zone-1": "wZone1" },
    cardWidgetIds: {},
    ...overrides,
  };
}

function docFlags(flags) {
  return { [FLAG_SCOPE]: flags };
}

function installGlobals() {
  globalThis.CONST = {
    DRAWING_TYPES: { RECTANGLE: "r" },
    DRAWING_FILL_TYPES: { NONE: 0, SOLID: 1, PATTERN: 2 },
  };
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
      hasProperty: (obj, path) => {
        let t = obj;
        for (const k of String(path).split(".")) {
          if (t == null || !(k in t)) return false;
          t = t[k];
        }
        return true;
      },
      randomID: () => `id-${Math.random().toString(36).slice(2, 8)}`,
    },
  };
  globalThis.game = { user: { id: "u1" } };
}
function uninstallGlobals() {
  delete globalThis.CONST;
  delete globalThis.foundry;
  // keep game for other tests? remove if we created
}

// ------------------------------------------------------------------
// zoneAspectsText pure tests
// ------------------------------------------------------------------

test("zoneAspectsText: empty aspects -> empty string", () => {
  const zone = { id: "zone-1", rect: { x: 0, y: 0, width: 150, height: 120 } };
  assert.equal(zoneAspectsText([], zone), "");
  assert.equal(zoneAspectsText([], "zone-1", { rect: zone.rect }), "");
});

test("zoneAspectsText: single aspect -> its name", () => {
  const zone = { id: "zone-1", rect: { x: 0, y: 0, width: 150, height: 120 } };
  const aspects = [{ name: "On Fire", free_invokes: 2, zoneIds: ["zone-1"] }];
  assert.equal(zoneAspectsText(aspects, zone), "On Fire");
});

test("zoneAspectsText: filters by zoneId, preserves order, ignores other zones", () => {
  const zone = { id: "zone-1", rect: { x: 0, y: 0, width: 200, height: 200 } };
  const aspects = [
    { name: "A", zoneIds: ["zone-1"] },
    { name: "B", zoneIds: ["zone-2"] },
    { name: "C", zoneIds: ["zone-1", "zone-2"] },
    { name: "D", zoneIds: [] },
  ];
  assert.equal(zoneAspectsText(aspects, zone), "A\nC");
  assert.equal(zoneAspectsText(aspects, "zone-2", { rect: zone.rect }), "B\nC");
});

test("zoneAspectsText: N aspects without truncation", () => {
  const zone = { id: "zone-1", rect: { x: 0, y: 0, width: 150, height: 120 } };
  // medium rect 150x120 => available 96 => maxLines floor(96/18)=5, so 3 fits
  const aspects = [
    { name: "Smoke", zoneIds: ["zone-1"] },
    { name: "Fire", zoneIds: ["zone-1"] },
    { name: "Rubble", zoneIds: ["zone-1"] },
  ];
  assert.equal(zoneAspectsText(aspects, zone), "Smoke\nFire\nRubble");
});

test("zoneAspectsText: truncation with +N", () => {
  // rect small enough to force truncation: height 60 => available 36 => maxLines 2
  const zone = { id: "zone-1", rect: { x: 0, y: 0, width: 150, height: 60 } };
  const aspects = [
    { name: "A", zoneIds: ["zone-1"] },
    { name: "B", zoneIds: ["zone-1"] },
    { name: "C", zoneIds: ["zone-1"] },
    { name: "D", zoneIds: ["zone-1"] },
  ];
  // maxLines 2 => keep 1 + +3
  assert.equal(zoneAspectsText(aspects, zone), "A\n+3");
  // Another case: height 78 => available 54 => maxLines 3 => keep 2 + +2
  const zone2 = { id: "zone-1", rect: { x: 0, y: 0, width: 150, height: 78 } };
  assert.equal(zoneAspectsText(aspects, zone2), "A\nB\n+2");
});

test("zoneAspectsText: maxLines =1 truncates to +N", () => {
  const zone = { id: "zone-1", rect: { x: 0, y: 0, width: 150, height: 42 } }; // 42-24=18 =>1
  const aspects = [
    { name: "X", zoneIds: ["zone-1"] },
    { name: "Y", zoneIds: ["zone-1"] },
  ];
  assert.equal(zoneAspectsText(aspects, zone), "+2");
  // single aspect fits exactly
  assert.equal(zoneAspectsText([{ name: "Solo", zoneIds: ["zone-1"] }], zone), "Solo");
});

test("zoneAspectsText: small rect height <=24 => +N", () => {
  const zone = { id: "zone-1", rect: { x: 0, y: 0, width: 150, height: 20 } };
  const aspects = [{ name: "A", zoneIds: ["zone-1"] }, { name: "B", zoneIds: ["zone-1"] }];
  assert.equal(zoneAspectsText(aspects, zone), "+2");
  const zone2 = { id: "zone-1", rect: { x: 0, y: 0, width: 150, height: 24 } };
  assert.equal(zoneAspectsText(aspects, zone2), "+2");
});

test("zoneAspectsText: uses only name, not free_invokes, and ignores marker", () => {
  const zone = { id: "zone-1", rect: { x: 0, y: 0, width: 150, height: 120 } };
  const aspects = [{ name: "Burning", free_invokes: 5, zoneIds: ["zone-1"] }];
  assert.equal(zoneAspectsText(aspects, zone), "Burning");
  assert.ok(!zoneAspectsText(aspects, zone).includes("("));
});

test("zoneAspectsText: lineHeight = round(14*1.25)=18", () => {
  assert.equal(ZONE_ASPECTS_LINE_HEIGHT, 18);
  assert.equal(Math.round(14 * 1.25), 18);
});

test("zoneAspectsText: string zoneId via opts.rect", () => {
  const rect = { x: 0, y: 0, width: 150, height: 120 };
  const aspects = [{ name: "Alpha", zoneIds: ["zA"] }, { name: "Beta", zoneIds: ["zA"] }];
  assert.equal(zoneAspectsText(aspects, "zA", { rect }), "Alpha\nBeta");
});

// ------------------------------------------------------------------
// buildZoneDescriptors with aspects
// ------------------------------------------------------------------

test("buildZoneDescriptors: without aspects still 2 parts, no aspects overlay", () => {
  const state = validState();
  const geometry = getConflictBoardGeometry({ sizePreset: "medium" });
  const parts = buildZoneDescriptors(state, geometry, state.zones[0]);
  assert.equal(parts.filter((p) => p.part === CONFLICT_ZONE_BODY_PART).length, 1);
  assert.equal(parts.filter((p) => p.part === CONFLICT_ZONE_LABEL_PART).length, 1);
  assert.equal(parts.filter((p) => p.part === CONFLICT_ZONE_ASPECTS_PART).length, 0);
});

test("buildZoneDescriptors: with one zone-bound aspect creates overlay with correct geometry", () => {
  const state = validState();
  const geometry = getConflictBoardGeometry({ sizePreset: "medium" });
  const zone = state.zones[0]; // 150x120
  const aspects = [{ name: "Fire", zoneIds: ["zone-1"] }];
  const parts = buildZoneDescriptors(state, geometry, zone, aspects);
  assert.equal(parts.length, 3);
  const asp = parts.find((p) => p.part === CONFLICT_ZONE_ASPECTS_PART);
  assert.ok(asp);
  assert.equal(asp.text, "Fire");
  assert.deepEqual({ x: asp.x, y: asp.y, w: asp.w, h: asp.h }, { x: 14, y: 34, w: 142, h: 96 });
  assert.equal(asp.font, "Montserrat");
  assert.equal(asp.size, 14);
  assert.equal(asp.color, "#000000");
  assert.equal(asp.align, "left");
  assert.equal(asp.stroke, 0);
  assert.equal(asp.fillType, 0);
  assert.equal(asp.fillAlpha, 0);
  assert.equal(asp.elevation, -1);
  assert.equal(asp.sort, -40);
});

test("buildZoneDescriptors: with multiple aspects text joins with \\n", () => {
  const state = validState();
  const geometry = getConflictBoardGeometry({ sizePreset: "medium" });
  const zone = state.zones[0];
  const aspects = [
    { name: "Smoke", zoneIds: ["zone-1"] },
    { name: "Fire", zoneIds: ["zone-1"] },
  ];
  const asp = buildZoneDescriptors(state, geometry, zone, aspects).find((p) => p.part === CONFLICT_ZONE_ASPECTS_PART);
  assert.equal(asp.text, "Smoke\nFire");
});

test("buildZoneDescriptors: filters to this zone only", () => {
  const state = validState();
  const geometry = getConflictBoardGeometry({ sizePreset: "medium" });
  const zone = state.zones[0];
  const aspects = [
    { name: "In This Zone", zoneIds: ["zone-1"] },
    { name: "Other Zone", zoneIds: ["zone-99"] },
  ];
  const asp = buildZoneDescriptors(state, geometry, zone, aspects).find((p) => p.part === CONFLICT_ZONE_ASPECTS_PART);
  assert.equal(asp.text, "In This Zone");
});

test("buildZoneDescriptors: empty filtered list -> no overlay", () => {
  const state = validState();
  const geometry = getConflictBoardGeometry({ sizePreset: "medium" });
  const zone = state.zones[0];
  const aspects = [{ name: "Else", zoneIds: ["zone-99"] }];
  const parts = buildZoneDescriptors(state, geometry, zone, aspects);
  assert.equal(parts.filter((p) => p.part === CONFLICT_ZONE_ASPECTS_PART).length, 0);
});

test("buildZoneDescriptors: unnamed zone still gets aspects overlay", () => {
  const state = validState();
  const geometry = getConflictBoardGeometry({ sizePreset: "medium" });
  const zone = { ...state.zones[0], name: "" };
  const aspects = [{ name: "Hidden", zoneIds: ["zone-1"] }];
  const parts = buildZoneDescriptors(state, geometry, zone, aspects);
  // body + aspects (no label)
  assert.equal(parts.filter((p) => p.part === CONFLICT_ZONE_BODY_PART).length, 1);
  assert.equal(parts.filter((p) => p.part === CONFLICT_ZONE_LABEL_PART).length, 0);
  assert.equal(parts.filter((p) => p.part === CONFLICT_ZONE_ASPECTS_PART).length, 1);
});

test("buildZoneDescriptors: truncation carries into overlay text", () => {
  const state = validState();
  const geometry = getConflictBoardGeometry({ sizePreset: "medium" });
  const zone = { id: "zone-1", name: "Tight", rect: { x: 0, y: 0, width: 150, height: 60 }, style: {} };
  const aspects = [
    { name: "A", zoneIds: ["zone-1"] },
    { name: "B", zoneIds: ["zone-1"] },
    { name: "C", zoneIds: ["zone-1"] },
    { name: "D", zoneIds: ["zone-1"] },
  ];
  const asp = buildZoneDescriptors(state, geometry, zone, aspects).find((p) => p.part === CONFLICT_ZONE_ASPECTS_PART);
  assert.equal(asp.text, "A\n+3");
});

test("buildZoneDescriptors: overlay sits above label but below cards (sort ordering)", () => {
  const state = validState();
  const geometry = getConflictBoardGeometry({ sizePreset: "medium" });
  const zone = state.zones[0];
  const parts = buildZoneDescriptors(state, geometry, zone, [{ name: "X", zoneIds: ["zone-1"] }]);
  const body = parts.find((p) => p.part === CONFLICT_ZONE_BODY_PART);
  const label = parts.find((p) => p.part === CONFLICT_ZONE_LABEL_PART);
  const asp = parts.find((p) => p.part === CONFLICT_ZONE_ASPECTS_PART);
  assert.ok(label.sort > body.sort);
  assert.ok(asp.sort > label.sort);
  assert.equal(asp.sort, -40);
  assert.equal(label.sort, -50);
  assert.equal(body.sort, -100);
});

// ------------------------------------------------------------------
// buildConflictBoardDocuments with scene aspects
// ------------------------------------------------------------------

test("buildConflictBoardDocuments injects zone aspects from scene flag", async () => {
  installGlobals();
  try {
    const state = validState({
      zones: [
        { id: "zone-1", name: "Alpha", rect: { x: 0, y: 0, width: 150, height: 120 }, style: {}, sort: 0 },
        { id: "zone-2", name: "Beta", rect: { x: 160, y: 0, width: 150, height: 120 }, style: {}, sort: 1 },
      ],
    });
    const scene = mockScene({
      flags: {
        [FLAG_SCOPE]: { [CONFLICT_BOARD_FLAG]: state },
        [SITUATION_ASPECTS_SCOPE]: {
          [SITUATION_ASPECTS_KEY]: [
            { name: "Fire", free_invokes: 1, zoneIds: ["zone-1"] },
            { name: "Smoke", free_invokes: 0, zoneIds: ["zone-1"] },
            { name: "Flood", free_invokes: 2, zoneIds: ["zone-2"] },
          ],
        },
      },
    });
    const built = await buildConflictBoardDocuments(scene, state, null, {});
    assert.equal(built.zones["zone-1"].find((p) => p.part === CONFLICT_ZONE_ASPECTS_PART).text, "Fire\nSmoke");
    assert.equal(built.zones["zone-2"].find((p) => p.part === CONFLICT_ZONE_ASPECTS_PART).text, "Flood");
  } finally {
    uninstallGlobals();
  }
});

// ------------------------------------------------------------------
// Sync lifecycle: create / delete / no-op / truncation
// ------------------------------------------------------------------

test("sync creates aspect overlay and deletes it when binding removed (byKey deletion)", async () => {
  installGlobals();
  try {
    const state = validState();
    const registry = registryRecord();
    // Board background + area frames/labels already present so manual-deletion guard doesn't fire
    const boardDocs = [
      mockDoc("dBoard", "Drawing", docFlags({ widgetId: "wBoard", ownerType: "conflictBoard", part: "conflictBoardBackground", index: -1 })),
    ];
    const scene = mockScene({
      flags: {
        [FLAG_SCOPE]: {
          [CONFLICT_BOARD_FLAG]: state,
          [CONFLICT_BOARD_WIDGET_FLAG]: registry,
        },
        [SITUATION_ASPECTS_SCOPE]: {
          [SITUATION_ASPECTS_KEY]: [{ name: "Burning", free_invokes: 1, zoneIds: ["zone-1"] }],
        },
      },
      drawings: [...boardDocs],
      tiles: [],
    });
    // Need a zone body doc so upsert finds existing? Actually sync will create if missing.
    // Force projection to bypass manual-deletion guard for the first sync: add at least one zone doc
    scene.drawings.push(mockDoc("dZoneBody", "Drawing", docFlags({ widgetId: "wZone1", ownerType: CONFLICT_ZONE_OWNER_TYPE, part: CONFLICT_ZONE_BODY_PART, index: -1 })));

    const first = await syncConflictBoard(scene, { forceProjection: true });
    assert.equal(first.ok, true);
    let zDocs = zoneDocs(scene, "wZone1");
    let aspDoc = zDocs.find((d) => d.getFlag(FLAG_SCOPE, "part") === CONFLICT_ZONE_ASPECTS_PART);
    assert.ok(aspDoc, "aspect overlay created");
    assert.equal(aspDoc.text, "Burning");

    // Remove binding: aspect without zoneIds
    scene.flags[SITUATION_ASPECTS_SCOPE][SITUATION_ASPECTS_KEY] = [{ name: "Burning", free_invokes: 1 }];
    const second = await syncConflictBoard(scene);
    assert.equal(second.ok, true);
    zDocs = zoneDocs(scene, "wZone1");
    aspDoc = zDocs.find((d) => d.getFlag(FLAG_SCOPE, "part") === CONFLICT_ZONE_ASPECTS_PART);
    assert.equal(aspDoc, undefined, "aspect overlay deleted when no aspect bound");
    // Deleted via upsertParts byKey -> single delete batch
    assert.ok(scene.deleted.Drawing.length >= 1);

    // Re-add with same aspect -> re-create
    scene.flags[SITUATION_ASPECTS_SCOPE][SITUATION_ASPECTS_KEY] = [{ name: "Burning", free_invokes: 1, zoneIds: ["zone-1"] }];
    // reset deleted tracker for clarity
    scene.deleted.Drawing.length = 0;
    const third = await syncConflictBoard(scene);
    zDocs = zoneDocs(scene, "wZone1");
    aspDoc = zDocs.find((d) => d.getFlag(FLAG_SCOPE, "part") === CONFLICT_ZONE_ASPECTS_PART);
    assert.ok(aspDoc);
    assert.equal(aspDoc.text, "Burning");
  } finally {
    uninstallGlobals();
  }
});

test("sync with aspects is no-op when aspect list unchanged", async () => {
  installGlobals();
  try {
    const state = validState();
    const registry = registryRecord();
    const scene = mockScene({
      flags: {
        [FLAG_SCOPE]: {
          [CONFLICT_BOARD_FLAG]: state,
          [CONFLICT_BOARD_WIDGET_FLAG]: registry,
        },
        [SITUATION_ASPECTS_SCOPE]: {
          [SITUATION_ASPECTS_KEY]: [{ name: "A", free_invokes: 0, zoneIds: ["zone-1"] }],
        },
      },
      drawings: [
        mockDoc("dBoard", "Drawing", docFlags({ widgetId: "wBoard", ownerType: "conflictBoard", part: "conflictBoardBackground", index: -1 })),
        mockDoc("dZoneBody", "Drawing", docFlags({ widgetId: "wZone1", ownerType: CONFLICT_ZONE_OWNER_TYPE, part: CONFLICT_ZONE_BODY_PART, index: -1 })),
      ],
    });
    await syncConflictBoard(scene, { forceProjection: true });
    // clear update trackers set by first projection
    scene.embeddedUpdates.Drawing.length = 0;
    scene.deleted.Drawing.length = 0;
    const beforeIds = scene.drawings.map((d) => d.id).sort();
    const res = await syncConflictBoard(scene);
    assert.equal(res.ok, true);
    // No creates/updates/deletes for zone overlay because text unchanged
    assert.equal(res.created, 0);
    assert.equal(res.updated, 0);
    assert.equal(res.deleted, 0);
    const afterIds = scene.drawings.map((d) => d.id).sort();
    assert.deepEqual(afterIds, beforeIds);
  } finally {
    uninstallGlobals();
  }
});

test("sync truncates overlay text with +N when many aspects", async () => {
  installGlobals();
  try {
    const zone = { id: "zone-1", name: "Tight", rect: { x: 0, y: 0, width: 150, height: 60 }, style: {}, sort: 0 };
    const state = validState({ zones: [zone] });
    const registry = registryRecord();
    const scene = mockScene({
      flags: {
        [FLAG_SCOPE]: {
          [CONFLICT_BOARD_FLAG]: state,
          [CONFLICT_BOARD_WIDGET_FLAG]: registry,
        },
        [SITUATION_ASPECTS_SCOPE]: {
          [SITUATION_ASPECTS_KEY]: [
            { name: "A", zoneIds: ["zone-1"] },
            { name: "B", zoneIds: ["zone-1"] },
            { name: "C", zoneIds: ["zone-1"] },
            { name: "D", zoneIds: ["zone-1"] },
          ],
        },
      },
      drawings: [
        mockDoc("dBoard", "Drawing", docFlags({ widgetId: "wBoard", ownerType: "conflictBoard", part: "conflictBoardBackground", index: -1 })),
        mockDoc("dZoneBody", "Drawing", docFlags({ widgetId: "wZone1", ownerType: CONFLICT_ZONE_OWNER_TYPE, part: CONFLICT_ZONE_BODY_PART, index: -1 })),
      ],
    });
    await syncConflictBoard(scene, { forceProjection: true });
    const aspDoc = zoneDocs(scene, "wZone1").find((d) => d.getFlag(FLAG_SCOPE, "part") === CONFLICT_ZONE_ASPECTS_PART);
    assert.ok(aspDoc);
    // height 60 => maxLines 2 => A + +3
    assert.equal(aspDoc.text, "A\n+3");
  } finally {
    uninstallGlobals();
  }
});

test("migration T1: aspect with zoneIds lands in correct zone (no suffix needed)", async () => {
  installGlobals();
  try {
    const state = validState({
      zones: [
        { id: "zone-1", name: "Bridge", rect: { x: 0, y: 0, width: 150, height: 120 }, style: {}, sort: 0 },
        { id: "zone-2", name: "Engine", rect: { x: 160, y: 0, width: 150, height: 120 }, style: {}, sort: 1 },
      ],
    });
    const registry = {
      widgetId: "wBoard",
      zoneWidgetIds: { "zone-1": "wZone1", "zone-2": "wZone2" },
      cardWidgetIds: {},
    };
    const scene = mockScene({
      flags: {
        [FLAG_SCOPE]: {
          [CONFLICT_BOARD_FLAG]: state,
          [CONFLICT_BOARD_WIDGET_FLAG]: registry,
        },
        [SITUATION_ASPECTS_SCOPE]: {
          [SITUATION_ASPECTS_KEY]: [
            { name: "Leak", free_invokes: 1, zoneIds: ["zone-2"] },
          ],
        },
      },
      drawings: [
        mockDoc("dBoard", "Drawing", docFlags({ widgetId: "wBoard", ownerType: "conflictBoard", part: "conflictBoardBackground", index: -1 })),
        mockDoc("dZ1", "Drawing", docFlags({ widgetId: "wZone1", ownerType: CONFLICT_ZONE_OWNER_TYPE, part: CONFLICT_ZONE_BODY_PART, index: -1 })),
        mockDoc("dZ2", "Drawing", docFlags({ widgetId: "wZone2", ownerType: CONFLICT_ZONE_OWNER_TYPE, part: CONFLICT_ZONE_BODY_PART, index: -1 })),
      ],
    });
    await syncConflictBoard(scene, { forceProjection: true });
    const z1Asp = zoneDocs(scene, "wZone1").find((d) => d.getFlag(FLAG_SCOPE, "part") === CONFLICT_ZONE_ASPECTS_PART);
    const z2Asp = zoneDocs(scene, "wZone2").find((d) => d.getFlag(FLAG_SCOPE, "part") === CONFLICT_ZONE_ASPECTS_PART);
    assert.equal(z1Asp, undefined);
    assert.ok(z2Asp);
    assert.equal(z2Asp.text, "Leak");
  } finally {
    uninstallGlobals();
  }
});
