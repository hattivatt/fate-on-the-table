/**
 * Node tests for ConflictBoardSync.js — the scene-side projection/reconcile
 * of the conflict board. Covers the pure descriptor builders, the flag
 * read/write helpers, the guard branches of `syncConflictBoard` and a
 * reconcile against a mocked scene. Foundry `game`/`canvas` are NOT stubbed;
 * only plain objects are used.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CONFLICT_BOARD_VERSION } from "../scripts/conflictBoardSchema.js";
import { analyzeLayout } from "../scripts/layoutSchema.js";
import { addLayout } from "../scripts/layoutRegistry.js";
import { getConflictBoardGeometry, layoutConflictCards } from "../scripts/conflictBoardGeometry.js";
import {
  readConflictBoard,
  writeConflictBoard,
  syncConflictBoard,
  reconcileConflictBoardProjection,
  buildConflictBoardDocuments,
  removeConflictBoardProjection,
  removeConflictBoard,
  boardRegistry,
  boardLevelDocs,
  zoneDocs,
  cardDocs,
  allConflictDocs,
  combatantDescriptors,
  buildBoardPartDescriptors,
  buildZoneDescriptors,
  buildTurnMarkerDescriptor,
  buildCardActedOverlayDescriptor,
  buildCardEliminatedStrikeDescriptors,
  plainTokenActor,
  docsBounds,
  currentCombatantIdOf,
  buildCardDescriptors,
  CONFLICT_BOARD_OWNER_TYPE,
  CONFLICT_BOARD_WIDGET_FLAG,
  CONFLICT_AREA_LABEL_PART,
} from "../scripts/ConflictBoardSync.js";
import {
  FLAG_SCOPE,
  CONFLICT_BOARD_FLAG,
  CONFLICT_ZONE_OWNER_TYPE,
  CONFLICT_CARD_OWNER_TYPE,
  CONFLICT_BOARD_BACKGROUND_PART,
  CONFLICT_AREA_PART,
  CONFLICT_ZONE_BODY_PART,
  CONFLICT_ZONE_LABEL_PART,
  CONFLICT_TURN_MARKER_PART,
  CONFLICT_CARD_ACTED_OVERLAY_PART,
  CONFLICT_CARD_ELIMINATED_STRIKE_PART,
} from "../scripts/constants.js";

/* ------------------------------------------------------------------ *
 * Mocks (plain objects, no globals)
 * ------------------------------------------------------------------ */

function mockDoc(id, documentName, flags) {
  return {
    id,
    documentName,
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
    async update(data, options) {
      // Update data uses document-root paths like `flags.<scope>.<key>`.
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
        // A projection sync must never delete a document that is no longer
        // present (regression guard for concurrent syncs).
        assert.ok(
          i >= 0,
          `deleteEmbeddedDocuments("${kind}") referenced missing _id "${id}"`,
        );
        arr.splice(i, 1);
      }
      return this;
    },
    async updateEmbeddedDocuments(kind, docs) {
      this.embeddedUpdates[kind].push(...docs);
      const arr = kind === "Drawing" ? this.drawings : this.tiles;
      for (const d of docs ?? []) {
        // A projection sync must never update a document that is no longer
        // present (regression guard for concurrent syncs).
        assert.ok(
          arr.some((x) => x.id === d._id),
          `updateEmbeddedDocuments("${kind}") referenced missing _id "${d._id}"`,
        );
        // Apply the patch to the stored doc (mirrors Foundry). Flat keys and
        // dotted paths (e.g. `shape.width`, `flags.advanced-drawing-tools.*`)
        // are resolved so a later sync's diff sees the up-to-date value.
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
        rect: { x: 10, y: 10, width: 100, height: 100 },
        style: { fill: "#ffffff", alpha: 0.12, stroke: "#000000" },
        sort: 0,
      },
    ],
    cards: {
      c1: { side: "friendly", area: "side", order: 0 },
      c2: { side: "hostile", area: "side", order: 1 },
    },
    tokenZones: {
      "Scene.scene1.Token.t1": "zone-1",
      "Scene.scene1.Token.t2": "zone-1",
    },
    ...overrides,
  };
}

function registryRecord(overrides = {}) {
  return {
    widgetId: "wBoard",
    zoneWidgetIds: { "zone-1": "wZone1" },
    cardWidgetIds: { c1: "wCard1", c2: "wCard2" },
    ...overrides,
  };
}

function docFlags(flags) {
  return { [FLAG_SCOPE]: flags };
}

/* ------------------------------------------------------------------ *
 * read / write of the scene flag
 * ------------------------------------------------------------------ */

test("readConflictBoard returns normalized state for a valid flag", () => {
  const scene = mockScene({
    flags: { [FLAG_SCOPE]: { [CONFLICT_BOARD_FLAG]: validState() } },
  });
  const state = readConflictBoard(scene);
  assert.ok(state);
  assert.equal(state.combatId, "combat-abc");
  assert.deepEqual(state.board.origin, { x: 1000, y: 800 });
});

test("readConflictBoard returns null for absent or invalid flags", () => {
  assert.equal(readConflictBoard(mockScene()), null);
  const invalid = mockScene({
    flags: { [FLAG_SCOPE]: { [CONFLICT_BOARD_FLAG]: { version: 99, board: {} } } },
  });
  assert.equal(readConflictBoard(invalid), null);
});

test("writeConflictBoard normalizes valid input and rejects invalid input", async () => {
  const scene = mockScene();
  const ok = await writeConflictBoard(scene, validState({ sizePreset: "large" }));
  assert.equal(ok.ok, true);
  const stored = readConflictBoard(scene);
  assert.equal(stored.sizePreset, "large");

  const bad = await writeConflictBoard(scene, { version: 1, board: { origin: { x: 0, y: 0 } } });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.length > 0);
  // invalid input must not overwrite the existing flag
  assert.equal(readConflictBoard(scene).combatId, "combat-abc");
});

/* ------------------------------------------------------------------ *
 * pure descriptor builders
 * ------------------------------------------------------------------ */

test("buildBoardPartDescriptors emits background + 5 frames + 2 labels + divider (field border stronger)", () => {
  const state = validState();
  const geometry = getConflictBoardGeometry({ sizePreset: "medium" });
  const parts = buildBoardPartDescriptors(state, geometry);
  // background 1 + frames 5 (friendly, hostile, bottomFriendly, bottomHostile, field) + labels 2 + divider 1 = 9 without round number
  assert.equal(parts.length, 9);
  assert.equal(parts.filter((p) => p.part === CONFLICT_BOARD_BACKGROUND_PART).length, 1);
  assert.equal(parts.filter((p) => p.part === CONFLICT_AREA_PART).length, 5);
  assert.equal(parts.filter((p) => p.part === CONFLICT_AREA_LABEL_PART).length, 2);
  assert.equal(parts.filter((p) => p.part === "conflictRoundDivider").length, 1);
  assert.equal(parts.filter((p) => p.part === "conflictRoundNumber").length, 0);

  const bg = parts.find((p) => p.part === CONFLICT_BOARD_BACKGROUND_PART);
  assert.equal(bg.fillType, 1);
  assert.equal(bg.fillColor, "#ffffff");
  assert.equal(bg.fillAlpha, 1);
  assert.deepEqual(
    { x: bg.x, y: bg.y, w: bg.w, h: bg.h },
    { x: geometry.bounds.x, y: geometry.bounds.y, w: geometry.bounds.width, h: geometry.bounds.height },
  );

  const field = parts.find((p) => p.part === CONFLICT_AREA_PART && p.index === 4);
  assert.deepEqual(
    { x: field.x, y: field.y, w: field.w, h: field.h },
    { x: geometry.field.x, y: geometry.field.y, w: geometry.field.width, h: geometry.field.height },
  );
  // field frame stronger: stroke 2, alpha 1
  assert.equal(field.stroke, 2);
  assert.equal(field.strokeAlpha, 1);
  // side/bottom frames keep thin stroke
  const friendly = parts.find((p) => p.part === CONFLICT_AREA_PART && p.index === 0);
  assert.equal(friendly.stroke, 1);
  assert.equal(friendly.strokeAlpha, 0.35);

  // divider spans bottom strip vertically at center
  const divider = parts.find((p) => p.part === "conflictRoundDivider");
  assert.equal(divider.y, geometry.bottomFriendly.y);
  assert.equal(divider.h, geometry.bottomFriendly.height);
  assert.equal(divider.x + divider.w / 2, geometry.bottomFriendly.width);
  assert.equal(divider.elevation, -3);
});

test("buildBoardPartDescriptors round number appears only with activeCombat round>=1 and scales with preset", () => {
  const state = validState();
  const geomMedium = getConflictBoardGeometry({ sizePreset: "medium" });
  const geomSmall = getConflictBoardGeometry({ sizePreset: "small" });
  const geomLarge = getConflictBoardGeometry({ sizePreset: "large" });
  // no combat -> no number
  assert.equal(buildBoardPartDescriptors(state, geomMedium).filter((p) => p.part === "conflictRoundNumber").length, 0);
  assert.equal(buildBoardPartDescriptors(state, geomMedium, { round: 0 }).filter((p) => p.part === "conflictRoundNumber").length, 0);
  assert.equal(buildBoardPartDescriptors(state, geomMedium, null).filter((p) => p.part === "conflictRoundNumber").length, 0);
  // round 1 -> number present
  const withRound = buildBoardPartDescriptors(state, geomMedium, { round: 3 });
  const num = withRound.find((p) => p.part === "conflictRoundNumber");
  assert.ok(num);
  assert.equal(num.text, "3");
  assert.equal(num.elevation, -2);
  assert.equal(num.sort, -200);
  // size scales with preset
  const smallNum = buildBoardPartDescriptors(state, geomSmall, { round: 1 }).find((p) => p.part === "conflictRoundNumber");
  const largeNum = buildBoardPartDescriptors(state, geomLarge, { round: 1 }).find((p) => p.part === "conflictRoundNumber");
  assert.ok(smallNum.size < num.size);
  assert.ok(largeNum.size > num.size);
  assert.equal(smallNum.size, 48);
  assert.equal(num.size, 56);
  assert.equal(largeNum.size, 64);
});

test("board background uses texture/color/alpha from the state (never shifts origin)", () => {
  const state = validState();
  state.board.background = { color: "#ff0000", texture: "img/wood.jpg", alpha: 0.5 };
  const geometry = getConflictBoardGeometry({ sizePreset: "medium" });
  const bg = buildBoardPartDescriptors(state, geometry).find(
    (p) => p.part === CONFLICT_BOARD_BACKGROUND_PART,
  );
  assert.equal(bg.fillType, 2);
  assert.equal(bg.fillColor, "#ff0000");
  assert.equal(bg.texture, "img/wood.jpg");
  assert.equal(bg.fillAlpha, 0.5);
  assert.equal(bg.x, geometry.bounds.x);
  assert.equal(bg.y, geometry.bounds.y);
});

test("buildZoneDescriptors emits a body + a named label", () => {
  const state = validState();
  const geometry = getConflictBoardGeometry({ sizePreset: "medium" });
  const named = buildZoneDescriptors(state, geometry, state.zones[0]);
  assert.equal(named.length, 2);
  assert.equal(named[0].part, CONFLICT_ZONE_BODY_PART);
  assert.equal(named[1].part, CONFLICT_ZONE_LABEL_PART);
  assert.equal(named[1].text, "Room");
  assert.deepEqual(
    { x: named[0].x, y: named[0].y, w: named[0].w, h: named[0].h },
    { x: 10, y: 10, w: 100, h: 100 },
  );

  const unnamed = buildZoneDescriptors(state, geometry, { ...state.zones[0], name: "" });
  assert.equal(unnamed.length, 1);
  assert.equal(unnamed[0].part, CONFLICT_ZONE_BODY_PART);
});

test("zone projection sits above the field frame but below cards and the turn marker", () => {
  const state = validState();
  const geometry = getConflictBoardGeometry({ sizePreset: "medium" });
  const [body, label] = buildZoneDescriptors(state, geometry, state.zones[0]);

  // zone body + label are raised above the board-level field parts
  assert.equal(body.elevation, -1);
  assert.equal(body.sort, -100);
  assert.equal(label.elevation, -1);
  assert.equal(label.sort, -50);
  assert.ok(label.sort > body.sort, "label renders above the zone body");

  // the board field frame (elevation -3 / sort -300) and the area labels
  // (elevation -2 / sort -200) stay BELOW the zone
  const boardParts = buildBoardPartDescriptors(state, geometry);
  const fieldFrame = boardParts.find(
    (p) => p.part === CONFLICT_AREA_PART && p.index === 4,
  );
  assert.ok(fieldFrame, "field frame descriptor present");
  assert.equal(fieldFrame.elevation, -3);
  assert.equal(fieldFrame.sort, -300);
  const areaLabel = boardParts.find((p) => p.part === CONFLICT_AREA_LABEL_PART);
  assert.equal(areaLabel.elevation, -2);
  assert.equal(areaLabel.sort, -200);
  assert.ok(body.elevation > fieldFrame.elevation, "zone body above field frame");
  assert.ok(body.sort > fieldFrame.sort, "zone body sort above field frame");
  assert.ok(body.elevation > areaLabel.elevation, "zone body above area labels");
  assert.ok(body.sort > areaLabel.sort, "zone body sort above area labels");

  // participant cards (elevation 0) and the turn marker (elevation 12)
  // stay ABOVE the zone: the zone must never cover them
  assert.ok(body.elevation < 0, "zone body below participant cards");
  assert.ok(label.elevation < 0, "zone label below participant cards");
  const marker = buildTurnMarkerDescriptor(
    state,
    geometry,
    layoutConflictCards(geometry, state).positions,
    { turn: 0, combatants: [{ id: "c1" }, { id: "c2" }] },
  );
  assert.ok(marker, "turn marker descriptor present for the current combatant");
  assert.equal(marker.elevation, 12);
  assert.ok(body.elevation < marker.elevation, "zone body below the turn marker");
  assert.ok(body.sort < marker.sort, "zone body sort below the turn marker");
});

test("buildTurnMarkerDescriptor follows combat.turn over the current card", () => {
  const state = validState();
  const geometry = getConflictBoardGeometry({ sizePreset: "medium" });
  const { positions } = layoutConflictCards(geometry, state);
  const combat = { turn: 0, combatants: [{ id: "c1" }, { id: "c2" }] };
  const marker = buildTurnMarkerDescriptor(state, geometry, positions, combat);
  assert.ok(marker);
  assert.equal(marker.part, CONFLICT_TURN_MARKER_PART);
  assert.deepEqual(
    { x: marker.x, y: marker.y },
    { x: positions.c1.x - 4, y: positions.c1.y - 4 },
  );

  assert.equal(buildTurnMarkerDescriptor(state, geometry, positions, { turn: null, combatants: [] }), null);
  assert.equal(buildTurnMarkerDescriptor(state, geometry, positions, { turn: 0, combatants: [{ id: "missing" }] }), null);
  assert.equal(buildTurnMarkerDescriptor(state, geometry, positions, null), null);
});

test("turn marker always uses the active style, even for a current combatant with hasActed", () => {
  const state = validState();
  const geometry = getConflictBoardGeometry({ sizePreset: "medium" });
  const { positions } = layoutConflictCards(geometry, state);
  const flagCombatant = (id, hasActed) => ({
    id,
    getFlag(scope, key) {
      return scope === "fate-core-official" && key === "hasActed" ? hasActed : undefined;
    },
  });
  // current combatant already hasActed (popcorn state): still "now acting"
  const acted = buildTurnMarkerDescriptor(state, geometry, positions, {
    turn: 0,
    combatants: [flagCombatant("c1", true), flagCombatant("c2", false)],
  });
  assert.equal(acted.part, CONFLICT_TURN_MARKER_PART);
  assert.equal(acted.index, -1);
  assert.equal(acted.color, "#c62828");
  assert.equal(acted.strokeColor, "#c62828");
  // a fresh current combatant (hasActed false) keeps the exact same style
  const fresh = buildTurnMarkerDescriptor(state, geometry, positions, {
    turn: 0,
    combatants: [flagCombatant("c1", false), flagCombatant("c2", false)],
  });
  assert.equal(fresh.color, "#c62828");
  assert.equal(fresh.strokeColor, "#c62828");
  assert.deepEqual(
    { x: fresh.x, y: fresh.y },
    { x: positions.c1.x - 4, y: positions.c1.y - 4 },
  );
});

test("currentCombatantIdOf maps turn index to combatant id", () => {
  assert.equal(currentCombatantIdOf({ turn: 1, combatants: [{ id: "a" }, { id: "b" }] }), "b");
  assert.equal(currentCombatantIdOf({ turn: 0, combatants: [{ id: "a" }] }), "a");
  assert.equal(currentCombatantIdOf({ turn: null, combatants: [] }), null);
  assert.equal(currentCombatantIdOf({ turn: 0, combatants: [] }), null);
  assert.equal(currentCombatantIdOf({ turn: 0, combatants: [{ id: "a", hasActed: true }] }), "a");
});

test("currentCombatantIdOf resolves through combat.turns (Fate Utilities order) with combatants fallback", () => {
  const combatants = [{ id: "a" }, { id: "b" }, { id: "c" }];
  // Fate Utilities uses game.combat.turns.indexOf(combatant) — turns order wins
  assert.equal(
    currentCombatantIdOf({ turn: 1, turns: [{ id: "c" }, { id: "a" }], combatants }),
    "a",
  );
  assert.equal(currentCombatantIdOf({ turn: 2, turns: combatants, combatants }), "c");
  // fallback to combat.combatants[turn] when turns is absent (plain/mocked combats)
  assert.equal(currentCombatantIdOf({ turn: 1, combatants }), "b");
  // out-of-range / null still resolve to null
  assert.equal(currentCombatantIdOf({ turn: 5, turns: combatants, combatants }), null);
  assert.equal(currentCombatantIdOf({ turn: null, turns: combatants, combatants }), null);
});

test("plainTokenActor prefers token name/texture, falls back to actor/combatant", () => {
  const token = { name: "Token Name", texture: { src: "token.png" } };
  const actor = { name: "Actor Name", img: "actor.png", system: { foo: 1 }, items: [] };
  const plain = plainTokenActor(token, actor, { name: "Combatant" });
  assert.equal(plain.name, "Token Name");
  assert.equal(plain.img, "token.png");
  assert.deepEqual(plain.system, { foo: 1 });

  const linked = plainTokenActor(null, actor, null);
  assert.equal(linked.name, "Actor Name");
  assert.equal(linked.img, "actor.png");

  const bare = plainTokenActor(null, null, { name: "Fallback" });
  assert.equal(bare.name, "Fallback");
  assert.equal(bare.img, "");
  assert.deepEqual(bare.items, []);
});

test("docsBounds wraps the layout documents", () => {
  const bounds = docsBounds([
    { x: -150, y: -200, w: 659, h: 28 },
    { x: 0, y: 0, w: 270, h: 270 },
  ]);
  assert.deepEqual(bounds, { x: -150, y: -200, width: 659, height: 470 });
  assert.deepEqual(docsBounds([]), { x: 0, y: 0, width: 0, height: 0 });
});

test("combatantDescriptors converts Combatant-like docs to plain descriptors", () => {
  const out = combatantDescriptors([
    { id: "a", actor: { hasPlayerOwner: true }, token: { disposition: -1 } },
    { id: "b", token: { disposition: 1 } },
    null,
    { token: { disposition: 0 } },
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], {
    combatantId: "a",
    id: "a",
    hasPlayerOwner: true,
    disposition: -1,
  });
  assert.equal(out[1].hasPlayerOwner, false);
});

/* ------------------------------------------------------------------ *
 * buildConflictBoardDocuments (no cards -> fully pure)
 * ------------------------------------------------------------------ */

test("buildConflictBoardDocuments projects board + zones deterministically", async () => {
  const state = validState({ cards: {}, tokenZones: {} });
  const scene = mockScene();
  const combat = null;
  const built = await buildConflictBoardDocuments(scene, state, combat, {});
  // v2 board: background + 4 area frames + field frame + 2 labels + divider = 9
  assert.equal(built.board.length, 9);
  assert.deepEqual(Object.keys(built.zones), ["zone-1"]);
  assert.equal(built.zones["zone-1"].length, 2);
  assert.deepEqual(built.cards, {});
});

test("buildConflictBoardDocuments builds card descriptors with identity flags", async () => {
  const state = validState();
  const scene = mockScene({
    tokens: {
      t1: { uuid: "Scene.scene1.Token.t1" },
      t2: { uuid: "Scene.scene1.Token.t2" },
    },
  });
  const combat = {
    id: "combat-abc",
    combatants: [
      {
        id: "c1",
        tokenId: "t1",
        sceneId: "scene1",
        token: { name: "A", texture: { src: "a.png" }, disposition: 1 },
      },
      {
        id: "c2",
        tokenId: "t2",
        sceneId: "scene1",
        token: { name: "B", texture: { src: "b.png" }, disposition: -1 },
      },
    ],
  };
  const built = await buildConflictBoardDocuments(scene, state, combat, {});
  // minimal layout is not registered under Node -> cards are skipped safely
  assert.deepEqual(built.cards, {});
});

test("conflict card descriptors scale the stroke with the fitted card", async () => {
  installProjectionGlobals();
  try {
    const raw = JSON.parse(
      readFileSync(new URL("../layouts/minimal.json", import.meta.url), "utf8"),
    );
    const layout = analyzeLayout(raw).normalized;
    const plainActor = {
      name: "Card",
      img: "card.png",
      system: {
        aspects: {},
        details: { fatePoints: { current: 0 } },
        tracks: {
          phys: {
            name: "Physical Stress",
            enabled: true,
            boxes: 2,
            box_values: [false, true, false, false],
            aspect: "No",
          },
          mild: {
            name: "Mild Consequence",
            enabled: true,
            boxes: 0,
            box_values: [true],
            aspect: { when_marked: true, name: "Broken leg" },
          },
        },
      },
    };
    const position = { x: 0, y: 0, width: 500, height: 350, area: "side" };
    const descriptors = await buildCardDescriptors(
      plainActor,
      layout,
      position,
      {
        fontFamily: "",
        textColor: "",
        fatePointImage: "",
        fatePointTileSize: 70,
        fatePointStep: 20,
        backgroundTexture: "",
      },
    );
    const boxes = descriptors.filter(
      (d) => d.part === "stressBoxRows",
    );
    assert.ok(boxes.length >= 3, "card descriptors must include stress box drawings");
    assert.ok(
      boxes.every((d) => d.w !== 16),
      "the fitted card must scale the stress box drawings",
    );
    boxes.forEach((d) => {
      // Layout stroke 1 scales with the same t as the 16px stress box:
      // stroke = w/16.
      assert.ok(
        Math.abs(d.stroke - d.w / 16) < 1e-9,
        `${d.part} stroke must follow the same t.scale as the box width`,
      );
      assert.ok(Math.abs(d.h / d.w - 1) < 1e-9, `${d.part} box stays square`);
    });
    // No consequence checkbox parts are projected anymore.
    assert.equal(
      descriptors.some((d) => d.part === "consequenceBoxRows"),
      false,
      "consequence checkbox parts must not be projected",
    );
    // A zero-width layout stroke stays zero on the fitted card.
    const name = descriptors.find((d) => d.part === "name");
    assert.equal(name.stroke, 0);
  } finally {
    uninstallProjectionGlobals();
  }
});

test("conflict card projection includes the full minimal layout, service widgetBackground AND the top widgetBounds group", async () => {
  installProjectionGlobals();
  // Register the minimal layout so the projection actually produces cards.
  const raw = JSON.parse(
    readFileSync(new URL("../layouts/minimal.json", import.meta.url), "utf8"),
  );
  addLayout(analyzeLayout(raw).normalized);
  try {
    const state = validState({ cards: { c1: { side: "friendly", area: "side", order: 0 } }, tokenZones: {} });
    const scene = mockScene({
      tokens: { t1: { uuid: "Scene.scene1.Token.t1" } },
    });
    const combat = {
      id: "combat-abc",
      turn: 0,
      combatants: [
        {
          id: "c1",
          tokenId: "t1",
          sceneId: "scene1",
          token: {
            name: "Grom",
            texture: { src: "grom.png" },
            disposition: 1,
            actor: {
              name: "Grom",
              img: "grom.png",
              system: {
                aspects: {},
                details: { fatePoints: { current: 0 } },
                tracks: {
                  phys: { name: "Physical Stress", enabled: true, boxes: 2, aspect: "No", box_values: [false, true] },
                  mild: { name: "Mild Consequence", enabled: true, boxes: 0, aspect: { when_marked: true, name: "Broken leg" }, box_values: [true] },
                },
              },
            },
          },
        },
      ],
    };
    const built = await buildConflictBoardDocuments(scene, state, combat, {});
    const card = built.cards.c1;
    assert.ok(card && card.length > 0, "conflict card descriptors must be produced");

    // The projection is the SAME minimal layout as ordinary actor widgets:
    // every part (incl. the invisible service drawings) is present, with the
    // conflictCard identity and its own part/index — never split into a
    // separate unlinked card.
    const parts = card.map((d) => d.part);
    assert.ok(parts.includes("widgetBackground"), "service widgetBackground part projected");
    assert.ok(parts.includes("widgetBounds"), "service widgetBounds part projected");
    assert.ok(parts.includes("name"), "name part projected");
    assert.ok(parts.includes("stressBoxRows"), "stress box parts projected");
    assert.ok(
      parts.includes("consequencesHeader") && parts.includes("consequenceCostRows"),
      "consequence header + cost rows projected",
    );
    // No consequence checkbox part is projected.
    assert.equal(parts.includes("consequenceBoxRows"), false);

    // The fitted card preserves the ordering contract of the minimal layout:
    // labels above their stress box row and the consequence header above its
    // cost rows. The same geometry as the ordinary actor widget build.
    const fitStressLabels = card.filter((d) => d.part === "stressTrackNames");
    const fitStressBoxes = card.filter((d) => d.part === "stressBoxRows");
    const fitConsHeaders = card.filter((d) => d.part === "consequencesHeader");
    const fitCostRows = card.filter((d) => d.part === "consequenceCostRows");
    assert.ok(fitStressLabels.length >= 1, "card projects stress labels");
    assert.ok(fitStressBoxes.length >= 1, "card projects stress boxes");
    assert.ok(fitConsHeaders.length >= 1, "card projects the consequence header");
    assert.ok(fitCostRows.length >= 1, "card projects consequence cost rows");
    assert.equal(fitCostRows[0].text, "Broken leg", "occupied consequence name is projected");
    fitStressLabels.forEach((label) => {
      const rowBoxes = fitStressBoxes.filter((b) => b.rowIndex === label.index);
      assert.ok(
        rowBoxes.every((b) => b.y > label.y),
        "fitted stress box row must be below its label",
      );
    });
    fitCostRows.forEach((row) =>
      assert.ok(
        row.y >= fitConsHeaders[0].y + fitConsHeaders[0].h,
        "fitted consequence cost row must be below its header",
      ),
    );
    // The fitted cost rows derive from the minimal layout's 260x20 rect and
    // fontSize 12: the whole descriptor scales by the same t.scale as the
    // ordinary actor widget build (so width stays proportional to the canvas
    // and the text does not wrap on the reduced font).
    const costRow = fitCostRows[0];
    const tScale = costRow.w / 260;
    assert.ok(tScale > 0, "cost row scales down from the 260px layout width");
    assert.ok(
      Math.abs(costRow.h - 20 * tScale) < 1e-6,
      `fitted cost row height (${costRow.h}) tracks the 260px layout width`,
    );
    assert.ok(
      Math.abs(costRow.size - 12 * tScale) < 1e-6,
      `fitted cost row font (${costRow.size}) derives from the layout fontSize 12 * t.scale`,
    );

    // widgetBounds carries the exact minimal-layout identity and layering
    // (ownerType conflictCard, part widgetBounds, index -1, bounds-style
    // elevation/sort); it is not a separate unrelated card.
    const bounds = card.find((d) => d.part === "widgetBounds");
    const bg = card.find((d) => d.part === "widgetBackground");
    assert.equal(bounds.index, -1);
    assert.equal(bounds.strokeColor, "#000000");
    assert.equal(bounds.strokeAlpha, 0.2);
    assert.equal(bounds.elevation, 10);
    assert.equal(bounds.sort, 1000);
    assert.equal(bg.index, -1);
    assert.equal(bg.fillType, 1);
    assert.equal(bg.fillAlpha, 1);

    // The whole fitted card spans a single widgetBounds rect that covers the
    // union of every part (the selection group users drag as one card).
    const wb = { x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h };
    for (const d of card) {
      assert.ok(d.x >= wb.x - 1e-6 && d.y >= wb.y - 1e-6, `${d.part} inside bounds (top-left)`);
      assert.ok(d.x + d.w <= wb.x + wb.w + 1e-6, `${d.part} inside bounds (right)`);
      assert.ok(d.y + d.h <= wb.y + wb.h + 1e-6, `${d.part} inside bounds (bottom)`);
    }

    // A full sync projects one widgetBounds per card, ownerType conflictCard.
    await scene.update(
      {
        [`flags.${FLAG_SCOPE}.${CONFLICT_BOARD_FLAG}`]: state,
        [`flags.${FLAG_SCOPE}.${CONFLICT_BOARD_WIDGET_FLAG}`]: {
          widgetId: "wBoard",
          anchor: { x: 1000, y: 800 },
          zoneWidgetIds: {},
          cardWidgetIds: { c1: "wCard1" },
        },
      },
      { fateOnTheTableSync: true },
    );
    const res = await syncConflictBoard(scene, { combat, forceProjection: true });
    assert.equal(res.ok, true);
    const cardDocs = scene.drawings.filter(
      (d) =>
        d.getFlag(FLAG_SCOPE, "ownerType") === CONFLICT_CARD_OWNER_TYPE &&
        d.getFlag(FLAG_SCOPE, "combatantId") === "c1",
    );
    assert.equal(
      cardDocs.filter((d) => d.getFlag(FLAG_SCOPE, "part") === "widgetBounds").length,
      1,
      "exactly one widgetBounds group per conflict card",
    );
    assert.equal(
      cardDocs.filter((d) => d.getFlag(FLAG_SCOPE, "part") === "widgetBackground").length,
      1,
      "exactly one widgetBackground per conflict card",
    );
  } finally {
    uninstallProjectionGlobals();
  }
});

test("transform of a small conflict card keeps every box part with a positive visible stroke and the widgetBounds group on top", async () => {
  installProjectionGlobals();
  try {
    const raw = JSON.parse(
      readFileSync(new URL("../layouts/minimal.json", import.meta.url), "utf8"),
    );
    const layout = analyzeLayout(raw).normalized;
    const plainActor = {
      name: "Card",
      img: "card.png",
      system: {
        aspects: {
          high: { value: "" },
          trouble: { value: "" },
        },
        details: { fatePoints: { current: 0 } },
        tracks: {
          phys: {
            name: "Physical Stress",
            enabled: true,
            boxes: 3,
            box_values: [false, true, false],
            aspect: "No",
          },
          mild: {
            name: "Mild Consequence",
            enabled: true,
            boxes: 0,
            box_values: [true],
            aspect: { when_marked: true, name: "Broken leg" },
          },
          severe: {
            name: "Severe Consequence",
            enabled: true,
            boxes: 0,
            box_values: [false],
            aspect: { when_marked: true },
          },
        },
      },
    };
    // Small card = the classic acted/eliminated pile slot.
    const position = { x: 0, y: 0, width: 120, height: 90, area: "acted" };
    const descriptors = await buildCardDescriptors(
      plainActor,
      layout,
      position,
      {
        fontFamily: "",
        textColor: "",
        fatePointImage: "",
        fatePointTileSize: 70,
        fatePointStep: 20,
        backgroundTexture: "",
      },
    );

    // Empty AND marked stress boxes both survive the scale-down as visible
    // frames; the consequence cost rows also survive as visible text.
    const boxes = descriptors.filter((d) => d.part === "stressBoxRows");
    assert.ok(boxes.length >= 3, "small card must keep all empty+marked stress box parts");
    const anyEmptyText = boxes.some((d) => d.text === "");
    assert.ok(anyEmptyText, "an empty (unchecked) stress box part is present");
    assert.ok(
      boxes.some((d) => d.text === "X"),
      "a marked stress box part is present",
    );
    boxes.forEach((d) => {
      assert.ok(d.stroke > 0, `${d.part}#${d.index} must keep a positive visible stroke`);
      assert.ok(Number.isFinite(d.strokeAlpha) && d.strokeAlpha >= 0, `${d.part} keeps strokeAlpha`);
    });
    // The consequence header + cost rows are projected; the boxes are gone.
    assert.equal(
      descriptors.some((d) => d.part === "consequenceBoxRows"),
      false,
      "no consequence checkbox parts on the small card",
    );
    const costRows = descriptors.filter((d) => d.part === "consequenceCostRows");
    assert.equal(costRows.length, 2, "mild + severe consequence cost rows projected");
    assert.equal(costRows[0].text, "Broken leg");

    // The service widgetBounds group is the single top-most selection rect.
    const bounds = descriptors.find((d) => d.part === "widgetBounds");
    assert.ok(bounds, "widgetBounds remains the top group on a small card");
    // Its rect encloses every projected part (the draggable selection group).
    for (const d of descriptors) {
      assert.ok(d.x >= bounds.x - 1e-6 && d.y >= bounds.y - 1e-6, `${d.part} inside bounds`);
      assert.ok(d.x + d.w <= bounds.x + bounds.w + 1e-6, `${d.part} inside bounds`);
      assert.ok(d.y + d.h <= bounds.y + bounds.h + 1e-6, `${d.part} inside bounds`);
    }
  } finally {
    uninstallProjectionGlobals();
  }
});

test("conflict card descriptors carry the linked actorUuid and per-row trackKey flags (stress + consequence cost rows)", async () => {
  installProjectionGlobals();
  const raw = JSON.parse(
    readFileSync(new URL("../layouts/minimal.json", import.meta.url), "utf8"),
  );
  addLayout(analyzeLayout(raw).normalized);
  try {
    const state = validState({ cards: { c1: { side: "friendly", area: "side", order: 0 } }, tokenZones: {} });
    const actor = {
      uuid: "Actor.grom",
      name: "Grom",
      img: "grom.png",
      system: {
        aspects: {},
        details: { fatePoints: { current: 0 } },
        tracks: {
          phys: { name: "Physical Stress", enabled: true, boxes: 2, aspect: "No", box_values: [false, true] },
          mild: { name: "Mild Consequence", enabled: true, boxes: 0, aspect: { when_marked: true, name: "Broken leg" }, box_values: [true], harm_can_absorb: 2 },
          severe: { name: "Severe Consequence", enabled: true, boxes: 0, aspect: { when_marked: true, name: "" }, box_values: [false], harm_can_absorb: 4 },
        },
      },
    };
    const scene = mockScene({ tokens: { t1: { uuid: "Scene.scene1.Token.t1", actor } } });
    const combat = {
      id: "combat-abc",
      turn: 0,
      combatants: [
        { id: "c1", tokenId: "t1", sceneId: "scene1", token: { name: "Grom", texture: { src: "grom.png" }, disposition: 1, actor } },
      ],
    };
    const built = await buildConflictBoardDocuments(scene, state, combat, {});
    const descriptors = built.cards.c1;
    assert.ok(descriptors && descriptors.length > 0);

    // Every card part carries the combat identity + the linked actorUuid.
    for (const d of descriptors) {
      assert.equal(d.flags.combatId, "combat-abc");
      assert.equal(d.flags.combatantId, "c1");
      assert.equal(d.flags.tokenUuid, "Scene.scene1.Token.t1");
      assert.equal(d.flags.actorUuid, "Actor.grom");
    }

    // Stress box rows pin their exact trackKey.
    const stressBoxes = descriptors.filter((d) => d.part === "stressBoxRows");
    assert.ok(stressBoxes.length >= 2, "two stress boxes projected");
    stressBoxes.forEach((d) => {
      assert.equal(d.flags.trackKey, "phys", `stress box ${d.index} maps to the phys track`);
      // index is preserved (stable flat box index for target mapping)
      assert.ok(Number.isInteger(d.index) && d.index >= 0);
    });

    // Consequence cost rows pin their trackKey via the cost-target helper.
    const costRows = descriptors.filter((d) => d.part === "consequenceCostRows");
    assert.equal(costRows.length, 2, "mild + severe cost rows projected");
    assert.equal(costRows[0].flags.trackKey, "mild");
    assert.equal(costRows[1].flags.trackKey, "severe");
    assert.deepEqual(costRows.map((d) => d.index), [0, 1], "stable row indexes");
    // The mild slot is occupied (name) and keeps its harm_can_absorb cost;
    // the severe is free (cost + underscores).
    assert.equal(costRows[0].text, "2 Broken leg");
    assert.ok(costRows[1].text.startsWith("4"), "free slot shows its harm_can_absorb cost");
    // No consequence checkbox parts are generated.
    assert.equal(descriptors.some((d) => d.part === "consequenceBoxRows"), false);
  } finally {
    uninstallProjectionGlobals();
  }
});

/* ------------------------------------------------------------------ *
 * reconcile (mocked scene, explicit combat)
 * ------------------------------------------------------------------ */

test("reconcileConflictBoardProjection removes orphan combatants and their docs", async () => {
  const state = validState();
  const registry = registryRecord();
  const drawings = [
    mockDoc("dCard1", "Drawing", docFlags({ widgetId: "wCard1", ownerType: CONFLICT_CARD_OWNER_TYPE, part: "name", index: -1 })),
    mockDoc("dCard2", "Drawing", docFlags({ widgetId: "wCard2", ownerType: CONFLICT_CARD_OWNER_TYPE, part: "name", index: -1 })),
    mockDoc("dBoard", "Drawing", docFlags({ widgetId: "wBoard", ownerType: CONFLICT_BOARD_OWNER_TYPE, part: CONFLICT_BOARD_BACKGROUND_PART, index: -1 })),
  ];
  const scene = mockScene({
    flags: {
      [FLAG_SCOPE]: {
        [CONFLICT_BOARD_FLAG]: state,
        [CONFLICT_BOARD_WIDGET_FLAG]: registry,
      },
    },
    drawings,
    tokens: { t1: { uuid: "Scene.scene1.Token.t1" } },
  });

  const combat = {
    id: "combat-abc",
    combatants: [
      { id: "c1", tokenId: "t1", sceneId: "scene1", token: { name: "A" } },
    ],
  };
  const res = await reconcileConflictBoardProjection(scene, { combat });
  assert.ok(res.changed);
  assert.deepEqual(res.removedCombatantIds, ["c2"]);
  assert.deepEqual(res.removedTokenUuids, ["Scene.scene1.Token.t2"]);

  const stored = readConflictBoard(scene);
  assert.deepEqual(Object.keys(stored.cards), ["c1"]);
  assert.deepEqual(stored.tokenZones, { "Scene.scene1.Token.t1": "zone-1" });
  // zones/board untouched
  assert.equal(stored.zones.length, 1);
  assert.deepEqual(stored.board.origin, { x: 1000, y: 800 });

  const reg = boardRegistry(scene);
  assert.deepEqual(reg.cardWidgetIds, { c1: "wCard1" });
  assert.deepEqual(reg.zoneWidgetIds, { "zone-1": "wZone1" });

  assert.ok(scene.deleted.Drawing.includes("dCard2"));
  assert.ok(!scene.deleted.Drawing.includes("dCard1"));
  assert.ok(!scene.deleted.Drawing.includes("dBoard"));
});

test("reconcile keeps assignments when the combat cannot be resolved", async () => {
  const state = validState();
  const scene = mockScene({
    flags: {
      [FLAG_SCOPE]: {
        [CONFLICT_BOARD_FLAG]: state,
        [CONFLICT_BOARD_WIDGET_FLAG]: registryRecord(),
      },
    },
    drawings: [
      mockDoc("dCard1", "Drawing", docFlags({ widgetId: "wCard1", ownerType: CONFLICT_CARD_OWNER_TYPE })),
    ],
  });
  const res = await reconcileConflictBoardProjection(scene, {});
  assert.equal(res.changed, false);
  assert.deepEqual(res.removedCombatantIds, []);
  // no state write, no doc deletion
  assert.equal(scene.updates.length, 0);
  assert.equal(scene.deleted.Drawing.length, 0);
});

/* ------------------------------------------------------------------ *
 * sync guard branches
 * ------------------------------------------------------------------ */

test("syncConflictBoard clears a stale registry when the flag is absent", async () => {
  const scene = mockScene({
    flags: { [FLAG_SCOPE]: { [CONFLICT_BOARD_WIDGET_FLAG]: registryRecord() } },
  });
  const res = await syncConflictBoard(scene, {});
  assert.equal(res.ok, true);
  assert.equal(res.changed, false);
  assert.equal(boardRegistry(scene), null);
});

test("syncConflictBoard never auto-creates a projection without a registry", async () => {
  const scene = mockScene({
    flags: { [FLAG_SCOPE]: { [CONFLICT_BOARD_FLAG]: validState() } },
  });
  const res = await syncConflictBoard(scene, {});
  assert.equal(res.ok, true);
  assert.equal(res.changed, false);
  assert.equal(boardRegistry(scene), null);
  assert.equal(scene.drawings.length, 0);
});

test("syncConflictBoard treats a missing projection as manual deletion", async () => {
  const scene = mockScene({
    flags: {
      [FLAG_SCOPE]: {
        [CONFLICT_BOARD_FLAG]: validState(),
        [CONFLICT_BOARD_WIDGET_FLAG]: registryRecord(),
      },
    },
  });
  const res = await syncConflictBoard(scene, {});
  assert.equal(res.ok, true);
  assert.equal(res.manuallyDeleted, true);
  assert.equal(boardRegistry(scene), null);
  // state is kept so an explicit re-place can restore the board
  assert.ok(readConflictBoard(scene));
});

test("placement commit flow keeps the registry and projects with forceProjection", async () => {
  // Simulates ConflictManager.commitBoardPlacement: write the state, then the
  // registry (both marked fateOnTheTableSync so the updateScene hook is
  // suppressed), then the explicit sync with forceProjection:true. Without
  // forceProjection the registry would be cleared by the manual-deletion
  // guard because no projection document exists yet.
  globalThis.CONST = {
    DRAWING_TYPES: { RECTANGLE: "r" },
    DRAWING_FILL_TYPES: { NONE: 0 },
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
    },
  };
  globalThis.game = { user: { id: "u1" } };
  try {
    const state = validState();
    const scene = mockScene({ tokens: { t1: { uuid: "Scene.scene1.Token.t1" } } });
    await writeConflictBoard(scene, state);
    await scene.update(
      {
        [`flags.${FLAG_SCOPE}.${CONFLICT_BOARD_WIDGET_FLAG}`]: {
          widgetId: "wBoard",
          anchor: { x: 1000, y: 800 },
          zoneWidgetIds: {},
          cardWidgetIds: {},
        },
      },
      { fateOnTheTableSync: true },
    );
    const res = await syncConflictBoard(scene, {
      combat: {
        id: "combat-abc",
        combatants: [
          { id: "c1", tokenId: "t1", sceneId: "scene1", token: { name: "A", texture: { src: "a.png" }, disposition: 1 } },
          { id: "c2", tokenId: "t2", sceneId: "scene1", token: { name: "B", texture: { src: "b.png" }, disposition: -1 } },
        ],
      },
      forceProjection: true,
    });
    assert.equal(res.ok, true);
    assert.equal(res.manuallyDeleted, undefined);
    assert.ok(boardRegistry(scene));
    assert.ok(readConflictBoard(scene));
    // v2 board: background + 5 frames (incl. field) +2 labels + divider + 1 named zone (body + label) = 11
    assert.equal(res.created, 11);
    assert.ok(scene.drawings.length >= 11);

    // A later ordinary sync (docs now exist) must NOT treat the board as
    // manually deleted.
    const later = await syncConflictBoard(scene, {});
    assert.equal(later.manuallyDeleted, undefined);
    assert.ok(boardRegistry(scene));
  } finally {
    delete globalThis.CONST;
    delete globalThis.foundry;
    delete globalThis.game;
  }
});

test("removeConflictBoardProjection removes docs + registry; state kept by default", async () => {
  const state = validState();
  const drawings = [
    mockDoc("dBoard", "Drawing", docFlags({ widgetId: "wBoard", ownerType: CONFLICT_BOARD_OWNER_TYPE })),
    mockDoc("dZone", "Drawing", docFlags({ widgetId: "wZone1", ownerType: CONFLICT_ZONE_OWNER_TYPE })),
    mockDoc("dCard", "Drawing", docFlags({ widgetId: "wCard1", ownerType: CONFLICT_CARD_OWNER_TYPE })),
  ];
  const scene = mockScene({
    flags: {
      [FLAG_SCOPE]: {
        [CONFLICT_BOARD_FLAG]: state,
        [CONFLICT_BOARD_WIDGET_FLAG]: registryRecord(),
      },
    },
    drawings,
  });
  const res = await removeConflictBoardProjection(scene);
  assert.equal(res.removed, 3);
  assert.equal(res.changed, true);
  assert.equal(boardRegistry(scene), null);
  assert.ok(readConflictBoard(scene));

  await removeConflictBoardProjection(scene, { clearState: true });
  assert.equal(readConflictBoard(scene), null);
});

/* ------------------------------------------------------------------ *
 * doc lookup helpers
 * ------------------------------------------------------------------ */

test("doc lookup helpers filter by widgetId and ownerType only", () => {
  const drawings = [
    mockDoc("d1", "Drawing", docFlags({ widgetId: "wBoard", ownerType: CONFLICT_BOARD_OWNER_TYPE, part: CONFLICT_BOARD_BACKGROUND_PART, index: -1 })),
    mockDoc("d2", "Drawing", docFlags({ widgetId: "wZone1", ownerType: CONFLICT_ZONE_OWNER_TYPE, part: CONFLICT_ZONE_BODY_PART, index: -1 })),
    mockDoc("d3", "Drawing", docFlags({ widgetId: "wCard1", ownerType: CONFLICT_CARD_OWNER_TYPE, part: "name", index: -1 })),
    mockDoc("dOther", "Drawing", docFlags({ widgetId: "wOther" })),
  ];
  const scene = mockScene({ drawings });
  assert.deepEqual(boardLevelDocs(scene, "wBoard").map((d) => d.id), ["d1"]);
  assert.deepEqual(zoneDocs(scene, "wZone1").map((d) => d.id), ["d2"]);
  assert.deepEqual(cardDocs(scene, "wCard1").map((d) => d.id), ["d3"]);
  assert.deepEqual(allConflictDocs(scene, registryRecord()).map((d) => d.id).sort(), ["d1", "d2", "d3"]);
});

/* ------------------------------------------------------------------ *
 * live turn-state projection (hasActed -> cards[].area)
 * ------------------------------------------------------------------ */

function mockFlagCombatant(id, tokenId, hasActed) {
  return {
    id,
    tokenId,
    sceneId: "scene1",
    token: { name: id, texture: { src: `${id}.png` }, disposition: 1 },
    getFlag(scope, key) {
      return scope === "fate-core-official" && key === "hasActed" ? hasActed : undefined;
    },
  };
}

function turnCombat(overrides = {}) {
  return {
    id: "combat-abc",
    turn: 0,
    round: 1,
    combatants: [
      mockFlagCombatant("c1", "t1", false),
      mockFlagCombatant("c2", "t2", true),
    ],
    ...overrides,
  };
}

test("reconcile projects hasActed into cards[].area through a scene.update write", async () => {
  const state = validState(); // c1 side, c2 side
  const scene = mockScene({
    flags: {
      [FLAG_SCOPE]: {
        [CONFLICT_BOARD_FLAG]: state,
        [CONFLICT_BOARD_WIDGET_FLAG]: registryRecord(),
      },
    },
    tokens: {
      t1: { uuid: "Scene.scene1.Token.t1" },
      t2: { uuid: "Scene.scene1.Token.t2" },
    },
  });

  const res = await reconcileConflictBoardProjection(scene, { combat: turnCombat() });
  assert.ok(res.changed);
  const stored = readConflictBoard(scene);
  assert.equal(stored.cards.c1.acted, undefined); // not acted -> no flag
  assert.equal(stored.cards.c1.area, "side");
  assert.equal(stored.cards.c2.acted, true); // hasActed -> acted flag
  assert.equal(stored.cards.c2.area, "side");
  assert.equal(stored.cards.c2.side, "hostile");
  assert.equal(stored.cards.c2.order, 1);
  // written only through the module-owned scene.update marked fateOnTheTableSync
  assert.ok(
    scene.updates.some(
      (u) =>
        u.options?.fateOnTheTableSync === true &&
        u.data[`flags.${FLAG_SCOPE}.${CONFLICT_BOARD_FLAG}`]?.cards?.c2?.acted === true,
    ),
  );
});

test("reconcile returns everyone to the side after a new round (hasActed reset)", async () => {
  const state = validState();
  state.cards.c1.acted = true;
  state.cards.c2.acted = true;
  const scene = mockScene({
    flags: {
      [FLAG_SCOPE]: {
        [CONFLICT_BOARD_FLAG]: state,
        [CONFLICT_BOARD_WIDGET_FLAG]: registryRecord(),
      },
    },
    tokens: {
      t1: { uuid: "Scene.scene1.Token.t1" },
      t2: { uuid: "Scene.scene1.Token.t2" },
    },
  });
  // new round: everyone hasActed === false
  const combat = turnCombat({
    turn: null,
    combatants: [
      mockFlagCombatant("c1", "t1", false),
      mockFlagCombatant("c2", "t2", false),
    ],
  });
  const res = await reconcileConflictBoardProjection(scene, { combat });
  assert.ok(res.changed);
  const stored = readConflictBoard(scene);
  assert.equal(stored.cards.c1.acted, undefined);
  assert.equal(stored.cards.c1.area, "side");
  assert.equal(stored.cards.c2.acted, undefined);
  assert.equal(stored.cards.c2.area, "side");
  assert.equal(stored.cards.c1.side, "friendly");
  assert.equal(stored.cards.c2.side, "hostile");
});

test("reconcile keeps the current combatant on the side and the previous current in the acted pile", async () => {
  // Fate Utilities popcorn state: c2 acted earlier (still hasActed), c1 is
  // the NEW current and is marked hasActed too — both are acted, only the
  // current one stays on its side (v2: acted flag, not area).
  const state = validState(); // c1 side, c2 side
  const scene = mockScene({
    flags: {
      [FLAG_SCOPE]: {
        [CONFLICT_BOARD_FLAG]: state,
        [CONFLICT_BOARD_WIDGET_FLAG]: registryRecord(),
      },
    },
    tokens: {
      t1: { uuid: "Scene.scene1.Token.t1" },
      t2: { uuid: "Scene.scene1.Token.t2" },
    },
  });
  const combat = {
    id: "combat-abc",
    turn: 0,
    round: 1,
    combatants: [
      mockFlagCombatant("c1", "t1", true),
      mockFlagCombatant("c2", "t2", true),
    ],
  };
  const res = await reconcileConflictBoardProjection(scene, { combat });
  assert.ok(res.changed);
  const stored = readConflictBoard(scene);
  assert.equal(stored.cards.c1.acted, undefined); // current -> not acted
  assert.equal(stored.cards.c1.area, "side");
  assert.equal(stored.cards.c1.side, "friendly");
  assert.equal(stored.cards.c2.acted, true); // previous current -> acted flag
  assert.equal(stored.cards.c2.area, "side");
  assert.equal(stored.cards.c2.side, "hostile");
});

test("return-turn projection: clearing hasActed moves a card back to its side, the current stays put", async () => {
  // The GM returned c1's turn: c1 hasActed cleared, c2 is still the current
  // actor (hasActed true, popcorn — stays on its side), combat.turn unchanged.
  const state = validState();
  state.cards.c1.acted = true; // c1 acted earlier
  state.cards.c2.acted = undefined; // c2 current, kept on the side
  const scene = mockScene({
    flags: {
      [FLAG_SCOPE]: {
        [CONFLICT_BOARD_FLAG]: state,
        [CONFLICT_BOARD_WIDGET_FLAG]: registryRecord(),
      },
    },
    tokens: {
      t1: { uuid: "Scene.scene1.Token.t1" },
      t2: { uuid: "Scene.scene1.Token.t2" },
    },
  });
  const combat = {
    id: "combat-abc",
    turn: 1,
    round: 1,
    combatants: [
      mockFlagCombatant("c1", "t1", false), // returned -> not acted
      mockFlagCombatant("c2", "t2", true), // still current + acted
    ],
  };
  const res = await reconcileConflictBoardProjection(scene, { combat });
  assert.ok(res.changed);
  const stored = readConflictBoard(scene);
  assert.equal(stored.cards.c1.acted, undefined); // back to not acted
  assert.equal(stored.cards.c1.area, "side");
  assert.equal(stored.cards.c1.side, "friendly"); // side preserved
  assert.equal(stored.cards.c1.order, 0); // order preserved
  assert.equal(stored.cards.c2.acted, undefined); // current stays not acted (popcorn)
  assert.equal(stored.cards.c2.area, "side");
  assert.equal(stored.cards.c2.side, "hostile");
});

test("reconcile resolves the current combatant through combat.turns (Fate Utilities order)", async () => {
  const state = validState();
  const scene = mockScene({
    flags: {
      [FLAG_SCOPE]: {
        [CONFLICT_BOARD_FLAG]: state,
        [CONFLICT_BOARD_WIDGET_FLAG]: registryRecord(),
      },
    },
    tokens: {
      t1: { uuid: "Scene.scene1.Token.t1" },
      t2: { uuid: "Scene.scene1.Token.t2" },
    },
  });
  const c1 = mockFlagCombatant("c1", "t1", true);
  const c2 = mockFlagCombatant("c2", "t2", true);
  const combat = {
    id: "combat-abc",
    turn: 1,
    round: 1,
    combatants: [c1, c2],
    turns: [c2, c1], // Fate Utilities order: turns[1] is c1
  };
  const res = await reconcileConflictBoardProjection(scene, { combat });
  assert.ok(res.changed);
  const stored = readConflictBoard(scene);
  assert.equal(stored.cards.c1.acted, undefined); // current (turns[1]) -> not acted
  assert.equal(stored.cards.c1.area, "side");
  assert.equal(stored.cards.c2.acted, true);
  assert.equal(stored.cards.c2.area, "side");
});

test("reconcile falls back to combat.combatants[turn] when turns is absent", async () => {
  const state = validState();
  const scene = mockScene({
    flags: {
      [FLAG_SCOPE]: {
        [CONFLICT_BOARD_FLAG]: state,
        [CONFLICT_BOARD_WIDGET_FLAG]: registryRecord(),
      },
    },
    tokens: {
      t1: { uuid: "Scene.scene1.Token.t1" },
      t2: { uuid: "Scene.scene1.Token.t2" },
    },
  });
  // no `turns` array — the plain/mocked combat falls back to combatants[turn]
  const combat = {
    id: "combat-abc",
    turn: 1,
    round: 1,
    combatants: [
      mockFlagCombatant("c1", "t1", true),
      mockFlagCombatant("c2", "t2", true),
    ],
  };
  const res = await reconcileConflictBoardProjection(scene, { combat });
  assert.ok(res.changed);
  const stored = readConflictBoard(scene);
  assert.equal(stored.cards.c2.acted, undefined); // current (combatants[1]) -> not acted
  assert.equal(stored.cards.c2.area, "side");
  assert.equal(stored.cards.c1.acted, true);
  assert.equal(stored.cards.c1.area, "side");
});

/* ------------------------------------------------------------------ *
 * serialized / idempotent projection syncs (regression)
 * ------------------------------------------------------------------ */

test("concurrent syncConflictBoard calls are serialized and never duplicate or touch missing _ids", async () => {
  globalThis.CONST = {
    DRAWING_TYPES: { RECTANGLE: "r" },
    DRAWING_FILL_TYPES: { NONE: 0 },
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
    },
  };
  globalThis.game = { user: { id: "u1" } };
  try {
    const state = validState();
    const scene = mockScene({
      flags: {
        [FLAG_SCOPE]: {
          [CONFLICT_BOARD_FLAG]: state,
          [CONFLICT_BOARD_WIDGET_FLAG]: registryRecord(),
        },
      },
      tokens: {
        t1: { uuid: "Scene.scene1.Token.t1" },
        t2: { uuid: "Scene.scene1.Token.t2" },
      },
    });
    const combat = turnCombat();

    // First placement projection (like the placement commit); later hooks run
    // ordinary syncs against an already-projecting board.
    const initial = await syncConflictBoard(scene, { combat, forceProjection: true });
    assert.equal(initial.ok, true);
    assert.equal(
      scene.drawings.filter((d) => d.getFlag(FLAG_SCOPE, "part") === CONFLICT_TURN_MARKER_PART).length,
      1,
    );

    const [r1, r2] = await Promise.all([
      syncConflictBoard(scene, { combat }),
      syncConflictBoard(scene, { combat }),
    ]);
    assert.equal(r1.ok, true);
    assert.equal(r2.ok, true);

    // exactly ONE turn marker is projected, never two
    const markerIds = scene.drawings
      .filter((d) => d.getFlag(FLAG_SCOPE, "part") === CONFLICT_TURN_MARKER_PART)
      .map((d) => d.id);
    assert.equal(markerIds.length, 1);

    // board-level parts are unique per part#index
    const boardKeys = scene.drawings
      .filter((d) => d.getFlag(FLAG_SCOPE, "ownerType") === CONFLICT_BOARD_OWNER_TYPE)
      .map((d) => `${d.getFlag(FLAG_SCOPE, "part")}#${d.getFlag(FLAG_SCOPE, "index") ?? -1}`);
    assert.equal(new Set(boardKeys).size, boardKeys.length);

    // the mock scene itself asserts no update/delete referenced a missing _id
    assert.equal(scene.embeddedUpdates.Drawing.length, 0);
    assert.equal(scene.deleted.Drawing.length, 0);
  } finally {
    delete globalThis.CONST;
    delete globalThis.foundry;
    delete globalThis.game;
  }
});

test("a later sync removes the turn marker when the combat has no current turn", async () => {
  globalThis.CONST = {
    DRAWING_TYPES: { RECTANGLE: "r" },
    DRAWING_FILL_TYPES: { NONE: 0 },
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
    },
  };
  globalThis.game = { user: { id: "u1" } };
  try {
    const state = validState();
    const scene = mockScene({
      flags: {
        [FLAG_SCOPE]: {
          [CONFLICT_BOARD_FLAG]: state,
          [CONFLICT_BOARD_WIDGET_FLAG]: registryRecord(),
        },
      },
      tokens: {
        t1: { uuid: "Scene.scene1.Token.t1" },
        t2: { uuid: "Scene.scene1.Token.t2" },
      },
    });

    const withTurn = await syncConflictBoard(scene, {
      combat: turnCombat({ turn: 0 }),
      forceProjection: true,
    });
    assert.equal(withTurn.ok, true);
    assert.equal(
      scene.drawings.filter((d) => d.getFlag(FLAG_SCOPE, "part") === CONFLICT_TURN_MARKER_PART).length,
      1,
    );

    // new round: turn === null -> the marker is removed, cards return to side
    const newRound = await syncConflictBoard(scene, {
      combat: turnCombat({
        turn: null,
        combatants: [
          mockFlagCombatant("c1", "t1", false),
          mockFlagCombatant("c2", "t2", false),
        ],
      }),
    });
    assert.equal(newRound.ok, true);
    assert.equal(
      scene.drawings.filter((d) => d.getFlag(FLAG_SCOPE, "part") === CONFLICT_TURN_MARKER_PART).length,
      0,
    );
    const stored = readConflictBoard(scene);
    assert.equal(stored.cards.c1.acted, undefined);
    assert.equal(stored.cards.c1.area, "side");
    assert.equal(stored.cards.c2.acted, undefined);
    assert.equal(stored.cards.c2.area, "side");
  } finally {
    delete globalThis.CONST;
    delete globalThis.foundry;
    delete globalThis.game;
  }
});

test("sync projects the popcorn turn state: current stays on the side with one active marker, previous in the acted pile", async () => {
  globalThis.CONST = {
    DRAWING_TYPES: { RECTANGLE: "r" },
    DRAWING_FILL_TYPES: { NONE: 0 },
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
    },
  };
  globalThis.game = { user: { id: "u1" } };
  try {
    const state = validState(); // c1 side, c2 side
    const scene = mockScene({
      flags: {
        [FLAG_SCOPE]: {
          [CONFLICT_BOARD_FLAG]: state,
          [CONFLICT_BOARD_WIDGET_FLAG]: registryRecord(),
        },
      },
      tokens: {
        t1: { uuid: "Scene.scene1.Token.t1" },
        t2: { uuid: "Scene.scene1.Token.t2" },
      },
    });
    // Fate Utilities popcorn state: c1 is the NEW current (hasActed true),
    // c2 acted earlier (hasActed true, no longer current).
    const combat = {
      id: "combat-abc",
      turn: 0,
      round: 1,
      combatants: [
        mockFlagCombatant("c1", "t1", true),
        mockFlagCombatant("c2", "t2", true),
      ],
    };
    const res = await syncConflictBoard(scene, { combat, forceProjection: true });
    assert.equal(res.ok, true);

    const stored = readConflictBoard(scene);
    assert.equal(stored.cards.c1.acted, undefined); // current stays not acted
    assert.equal(stored.cards.c1.area, "side");
    assert.equal(stored.cards.c2.acted, true); // previous current -> acted flag
    assert.equal(stored.cards.c2.area, "side");

    // exactly ONE turn marker, always in the active style
    const markers = scene.drawings.filter(
      (d) => d.getFlag(FLAG_SCOPE, "part") === CONFLICT_TURN_MARKER_PART,
    );
    assert.equal(markers.length, 1);
    assert.equal(markers[0].strokeColor, "#c62828");
    assert.equal(markers[0].textColor, "#c62828");

    // a new exchange (turn:null, hasActed reset) clears the marker and
    // returns every card to its side area
    const newExchange = await syncConflictBoard(scene, {
      combat: {
        id: "combat-abc",
        turn: null,
        round: 2,
        combatants: [
          mockFlagCombatant("c1", "t1", false),
          mockFlagCombatant("c2", "t2", false),
        ],
      },
    });
    assert.equal(newExchange.ok, true);
    assert.equal(
      scene.drawings.filter((d) => d.getFlag(FLAG_SCOPE, "part") === CONFLICT_TURN_MARKER_PART).length,
      0,
    );
    const afterExchange = readConflictBoard(scene);
    assert.equal(afterExchange.cards.c1.acted, undefined);
    assert.equal(afterExchange.cards.c1.area, "side");
    assert.equal(afterExchange.cards.c2.acted, undefined);
    assert.equal(afterExchange.cards.c2.area, "side");
  } finally {
    delete globalThis.CONST;
    delete globalThis.foundry;
    delete globalThis.game;
  }
});

/* ------------------------------------------------------------------ *
 * mid-conflict placement (regression)
 * ------------------------------------------------------------------ */

/** Globals the projection sync needs to build card/layout docs under Node. */
function installProjectionGlobals() {
  globalThis.CONST = {
    DRAWING_TYPES: { RECTANGLE: "r" },
    DRAWING_FILL_TYPES: { NONE: 0 },
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
    },
  };
  globalThis.game = {
    user: { id: "u1" },
    i18n: { localize: (key) => key },
    settings: { get: () => "" },
  };
  globalThis.CONFIG = { fontDefinitions: {} };
}

function uninstallProjectionGlobals() {
  delete globalThis.CONST;
  delete globalThis.foundry;
  delete globalThis.game;
  delete globalThis.CONFIG;
}

function midConflictCombatant(id, tokenId, hasActed, disposition) {
  return {
    id,
    tokenId,
    sceneId: "scene1",
    token: {
      name: id,
      texture: { src: `${id}.png` },
      disposition,
    },
    getFlag(scope, key) {
      return scope === "fate-core-official" && key === "hasActed"
        ? hasActed
        : undefined;
    },
  };
}

function midConflictCombat() {
  // Fate Utilities turn order with `combat.turn` as an index into `turns`:
  // round 2, c1 = old current (hasActed, no longer current), c2 = CURRENT
  // (hasActed true — popcorn), c3 = not started.
  const c1 = midConflictCombatant("c1", "t1", true, -1); // hostile side
  const c2 = midConflictCombatant("c2", "t2", true, 1); // friendly side
  const c3 = midConflictCombatant("c3", "t3", false, -1); // hostile side
  return {
    id: "combat-abc",
    turn: 1,
    round: 2,
    combatants: [c1, c2, c3],
    turns: [c1, c2, c3],
  };
}

/** Placement-time scene WITHOUT any flag: the state is written by the flow. */
function midConflictScene() {
  const state = validState();
  state.cards = {
    c1: { side: "hostile", area: "side", order: 0 },
    c2: { side: "friendly", area: "side", order: 1 },
    c3: { side: "hostile", area: "side", order: 2 },
  };
  state.tokenZones = {};
  const scene = mockScene({
    tokens: {
      t1: { uuid: "Scene.scene1.Token.t1" },
      t2: { uuid: "Scene.scene1.Token.t2" },
      t3: { uuid: "Scene.scene1.Token.t3" },
    },
  });
  return { state, scene };
}

test("mid-conflict placement: the mandatory first forceProjection sync immediately projects live turn state (areas, marker, card flags) and stays idempotent on re-sync/reload", async () => {
  installProjectionGlobals();
  // Register the minimal layout so card docs (and their identity flags) are
  // actually projected, exactly like the runtime's layoutLoader.
  const raw = JSON.parse(
    readFileSync(new URL("../layouts/minimal.json", import.meta.url), "utf8"),
  );
  addLayout(analyzeLayout(raw).normalized);
  try {
    // Simulates ConflictManager.commitBoardPlacement exactly: fresh state with
    // every card at area "side", the registry write marked fateOnTheTableSync,
    // then the mandatory FIRST sync with forceProjection:true. That sync must
    // reconcile the live combat.turn/hasActed immediately — the reconcile
    // phase is NOT optimized away for placement.
    const { state, scene } = midConflictScene();
    const written = await writeConflictBoard(scene, state);
    assert.equal(written.ok, true);
    await scene.update(
      {
        [`flags.${FLAG_SCOPE}.${CONFLICT_BOARD_WIDGET_FLAG}`]: {
          widgetId: "wBoard",
          anchor: { x: 1000, y: 800 },
          zoneWidgetIds: {},
          cardWidgetIds: {},
        },
      },
      { fateOnTheTableSync: true },
    );
    const combat = midConflictCombat();
    const placed = await syncConflictBoard(scene, { combat, forceProjection: true });
    assert.equal(placed.ok, true);

    // Live turn state projected into the state flag (v2: acted flag, not area):
    // - old current (c1, hasActed, no longer current) -> acted:true
    // - current (c2) -> stays not acted despite hasActed (popcorn)
    // - unacted (c3) -> not acted
    const stored = readConflictBoard(scene);
    assert.equal(stored.cards.c1.acted, true);
    assert.equal(stored.cards.c1.area, "side");
    assert.equal(stored.cards.c1.side, "hostile");
    assert.equal(stored.cards.c2.acted, undefined);
    assert.equal(stored.cards.c2.area, "side");
    assert.equal(stored.cards.c2.side, "friendly");
    assert.equal(stored.cards.c3.acted, undefined);
    assert.equal(stored.cards.c3.area, "side");
    assert.equal(stored.cards.c3.side, "hostile");

    // Exactly ONE active-style turn marker for the current combatant.
    const markers = scene.drawings.filter(
      (d) => d.getFlag(FLAG_SCOPE, "part") === CONFLICT_TURN_MARKER_PART,
    );
    assert.equal(markers.length, 1);
    assert.equal(markers[0].strokeColor, "#c62828");

    // Card docs carry the module identity flags incl. the projected area.
    // In v2 geometry all cards are in "side" (or "bottom") — acted flag is in state, not area.
    const cardAreasByCombatant = {};
    for (const d of scene.drawings) {
      if (d.getFlag(FLAG_SCOPE, "ownerType") !== CONFLICT_CARD_OWNER_TYPE) continue;
      const id = d.getFlag(FLAG_SCOPE, "combatantId");
      assert.equal(d.getFlag(FLAG_SCOPE, "combatId"), "combat-abc");
      (cardAreasByCombatant[id] ??= new Set()).add(
        d.getFlag(FLAG_SCOPE, "area"),
      );
    }
    assert.deepEqual([...cardAreasByCombatant.c1], ["side"]);
    assert.deepEqual([...cardAreasByCombatant.c2], ["side"]);
    assert.deepEqual([...cardAreasByCombatant.c3], ["side"]);
    const t1Docs = scene.drawings.filter(
      (d) =>
        d.getFlag(FLAG_SCOPE, "ownerType") === CONFLICT_CARD_OWNER_TYPE &&
        d.getFlag(FLAG_SCOPE, "combatantId") === "c1",
    );
    assert.ok(t1Docs.length > 0);
    assert.equal(
      t1Docs[0].getFlag(FLAG_SCOPE, "tokenUuid"),
      "Scene.scene1.Token.t1",
    );

    // Registry: every card/zone got a stable widget id; nothing lost.
    const reg = boardRegistry(scene);
    assert.deepEqual(Object.keys(reg.cardWidgetIds).sort(), ["c1", "c2", "c3"]);
    assert.deepEqual(Object.keys(reg.zoneWidgetIds), ["zone-1"]);

    // Re-sync (e.g. a follow-up combatant update) is idempotent: acted flags stay,
    // still exactly one marker, registry preserved.
    const again = await syncConflictBoard(scene, { combat });
    assert.equal(again.ok, true);
    assert.equal(
      scene.drawings.filter(
        (d) => d.getFlag(FLAG_SCOPE, "part") === CONFLICT_TURN_MARKER_PART,
      ).length,
      1,
    );
    const stored2 = readConflictBoard(scene);
    assert.equal(stored2.cards.c1.acted, true);
    assert.equal(stored2.cards.c1.area, "side");
    assert.equal(stored2.cards.c2.acted, undefined);
    assert.equal(stored2.cards.c2.area, "side");
    assert.equal(stored2.cards.c3.acted, undefined);
    assert.equal(stored2.cards.c3.area, "side");
    assert.deepEqual(
      Object.keys(boardRegistry(scene).cardWidgetIds).sort(),
      ["c1", "c2", "c3"],
    );

    // Reload (fresh scene object holding the same flag/docs): the ordinary
    // canvasReady sync must NOT treat the existing projection as a manual
    // deletion and must not lose the registry or the marker.
    const reloaded = mockScene({
      flags: {
        [FLAG_SCOPE]: {
          [CONFLICT_BOARD_FLAG]: readConflictBoard(scene),
          [CONFLICT_BOARD_WIDGET_FLAG]: boardRegistry(scene),
        },
      },
      drawings: [...scene.drawings],
      tiles: [...scene.tiles],
      tokens: {
        t1: { uuid: "Scene.scene1.Token.t1" },
        t2: { uuid: "Scene.scene1.Token.t2" },
        t3: { uuid: "Scene.scene1.Token.t3" },
      },
    });
    const reloadedSync = await syncConflictBoard(reloaded, { combat });
    assert.equal(reloadedSync.ok, true);
    assert.equal(reloadedSync.manuallyDeleted, undefined);
    assert.equal(
      reloaded.drawings.filter(
        (d) => d.getFlag(FLAG_SCOPE, "part") === CONFLICT_TURN_MARKER_PART,
      ).length,
      1,
    );
    assert.ok(boardRegistry(reloaded));
  } finally {
    uninstallProjectionGlobals();
  }
});

/* ------------------------------------------------------------------ *
 * mid-conflict entry: new combatant joins an active board (createCombatant)
 * ------------------------------------------------------------------ */

test("a new combatant entering an active board mid-conflict is admitted immediately (createCombatant path), existing cards/zones stay untouched, and a re-sync is idempotent", async () => {
  installProjectionGlobals();
  // Register the minimal layout so the newcomer's card docs (with identity
  // flags) are actually projected, exactly like the runtime's layoutLoader.
  const raw = JSON.parse(
    readFileSync(new URL("../layouts/minimal.json", import.meta.url), "utf8"),
  );
  addLayout(analyzeLayout(raw).normalized);
  try {
    // An already PLACED board (state + registry + projected docs): c1 and c2
    // have cards and are pinned to zone-1; the scene already hosts the
    // newcomer's token t3 which is NOT yet in combat.
    const state = validState();
    state.cards = {
      c1: { side: "hostile", area: "side", order: 0 },
      c2: { side: "friendly", area: "side", order: 1 },
    };
    const drawings = [
      mockDoc("dBoard", "Drawing", docFlags({ widgetId: "wBoard", ownerType: CONFLICT_BOARD_OWNER_TYPE, part: CONFLICT_BOARD_BACKGROUND_PART, index: -1 })),
      mockDoc("dZone", "Drawing", docFlags({ widgetId: "wZone1", ownerType: CONFLICT_ZONE_OWNER_TYPE, part: CONFLICT_ZONE_BODY_PART, index: -1 })),
      mockDoc("dCard1", "Drawing", docFlags({ widgetId: "wCard1", ownerType: CONFLICT_CARD_OWNER_TYPE, part: "name", index: -1 })),
      mockDoc("dCard2", "Drawing", docFlags({ widgetId: "wCard2", ownerType: CONFLICT_CARD_OWNER_TYPE, part: "name", index: -1 })),
    ];
    const scene = mockScene({
      flags: {
        [FLAG_SCOPE]: {
          [CONFLICT_BOARD_FLAG]: state,
          [CONFLICT_BOARD_WIDGET_FLAG]: registryRecord(),
        },
      },
      drawings,
      tokens: {
        t1: { uuid: "Scene.scene1.Token.t1" },
        t2: { uuid: "Scene.scene1.Token.t2" },
        t3: { uuid: "Scene.scene1.Token.t3" },
      },
    });

    // The GM toggles the existing t3 token into combat mode -> Foundry creates
    // a new Combatant. The module's `createCombatant` listener runs the SAME
    // serialized `syncConflictBoard(scene, { combat })` as `updateCombatant`.
    const beforeIds = scene.drawings.map((d) => d.id).sort();
    const combat = {
      id: "combat-abc",
      turn: 1,
      round: 2,
      combatants: [
        midConflictCombatant("c1", "t1", true, -1), // hostile, acted (old current)
        midConflictCombatant("c2", "t2", true, 1), // friendly, current (popcorn)
        midConflictCombatant("c3", "t3", false, 1), // friendly, not started
      ],
      turns: [
        midConflictCombatant("c1", "t1", true, -1),
        midConflictCombatant("c2", "t2", true, 1),
        midConflictCombatant("c3", "t3", false, 1),
      ],
    };
    const res = await syncConflictBoard(scene, { combat });
    assert.equal(res.ok, true);
    assert.deepEqual(res.admittedCombatantIds, ["c3"]);

    // The newcomer card is admitted with the primary-placement rules.
    const stored = readConflictBoard(scene);
    assert.deepEqual(stored.cards.c3, { side: "friendly", area: "side", order: 2 });
    // Existing cards keep their side/order, turn state projected onto acted flag (not area).
    assert.deepEqual(stored.cards.c1, { side: "hostile", area: "side", order: 0, acted: true });
    assert.deepEqual(stored.cards.c2, { side: "friendly", area: "side", order: 1 });
    // tokenZones untouched.
    assert.deepEqual(stored.tokenZones, {
      "Scene.scene1.Token.t1": "zone-1",
      "Scene.scene1.Token.t2": "zone-1",
    });

    // The registry gained a stable widget id for the newcomer; old ids kept.
    const reg = boardRegistry(scene);
    assert.deepEqual(Object.keys(reg.cardWidgetIds).sort(), ["c1", "c2", "c3"]);
    assert.equal(reg.cardWidgetIds.c1, "wCard1");
    assert.equal(reg.cardWidgetIds.c2, "wCard2");
    assert.ok(reg.cardWidgetIds.c3 && reg.cardWidgetIds.c3 !== "wCard1");
    assert.deepEqual(reg.zoneWidgetIds, { "zone-1": "wZone1" });

    // The newcomer's card docs appeared with identity flags; old docs survive.
    const c3Docs = scene.drawings.filter(
      (d) =>
        d.getFlag(FLAG_SCOPE, "ownerType") === CONFLICT_CARD_OWNER_TYPE &&
        d.getFlag(FLAG_SCOPE, "combatantId") === "c3",
    );
    assert.ok(c3Docs.length > 0, "newcomer card doc must be projected");
    assert.equal(c3Docs[0].getFlag(FLAG_SCOPE, "combatId"), "combat-abc");
    assert.equal(c3Docs[0].getFlag(FLAG_SCOPE, "tokenUuid"), "Scene.scene1.Token.t3");
    assert.deepEqual(scene.deleted.Drawing, []);
    for (const originalId of beforeIds) {
      assert.ok(scene.drawings.some((d) => d.id === originalId), `doc "${originalId}" must survive`);
    }

    // Idempotency: a repeated sync (e.g. the follow-up updateCombatant from the
    // tracker) must not admit again, must not duplicate card docs or registry
    // entries, and must keep the projected areas and the single turn marker.
    const again = await syncConflictBoard(scene, { combat });
    assert.equal(again.ok, true);
    assert.deepEqual(again.admittedCombatantIds, []);
    const stored2 = readConflictBoard(scene);
    assert.deepEqual(stored2.cards, stored.cards);
    assert.equal(
      scene.drawings.filter(
        (d) =>
          d.getFlag(FLAG_SCOPE, "ownerType") === CONFLICT_CARD_OWNER_TYPE &&
          d.getFlag(FLAG_SCOPE, "combatantId") === "c3",
      ).length,
      c3Docs.length,
    );
    assert.equal(boardRegistry(scene).cardWidgetIds.c3, reg.cardWidgetIds.c3);
    assert.equal(
      scene.drawings.filter(
        (d) => d.getFlag(FLAG_SCOPE, "part") === CONFLICT_TURN_MARKER_PART,
      ).length,
      1,
    );
  } finally {
    uninstallProjectionGlobals();
  }
});

/* ------------------------------------------------------------------ *
 * stress/consequence change re-projection (updateActor path)
 * ------------------------------------------------------------------ */

test("changing an actor's stress re-projects the box Drawings: text/parts updated in place, widgetBounds kept, no duplicates, repeated sync idempotent", async () => {
  installProjectionGlobals();
  // Register the minimal layout so card docs are projected with box parts.
  const raw = JSON.parse(
    readFileSync(new URL("../layouts/minimal.json", import.meta.url), "utf8"),
  );
  addLayout(analyzeLayout(raw).normalized);
  try {
    const state = validState({ cards: { c1: { side: "friendly", area: "side", order: 0 } }, tokenZones: {} });

    const cloneActorTracks = (boxValues) => ({
      phys: { name: "Physical Stress", enabled: true, boxes: 3, aspect: "No", box_values: boxValues },
      mild: { name: "Mild Consequence", enabled: true, boxes: 0, aspect: { when_marked: true, name: "Broken leg" }, box_values: [true] },
    });
    const actor = {
      name: "Grom",
      img: "grom.png",
      system: {
        aspects: {},
        details: { fatePoints: { current: 0 } },
        tracks: cloneActorTracks([false, true, false]),
      },
    };
    const scene = mockScene({
      tokens: {
        t1: {
          uuid: "Scene.scene1.Token.t1",
          actor,
        },
      },
    });
    await writeConflictBoard(scene, state);
    await scene.update(
      {
        [`flags.${FLAG_SCOPE}.${CONFLICT_BOARD_WIDGET_FLAG}`]: {
          widgetId: "wBoard",
          anchor: { x: 1000, y: 800 },
          zoneWidgetIds: {},
          cardWidgetIds: { c1: "wCard1" },
        },
      },
      { fateOnTheTableSync: true },
    );
    const combat = {
      id: "combat-abc",
      turn: 0,
      round: 1,
      combatants: [
        { id: "c1", tokenId: "t1", sceneId: "scene1", token: { name: "Grom", texture: { src: "grom.png" }, disposition: 1, actor } },
      ],
    };

    // Initial projection: empty + marked boxes AND the widgetBounds group.
    const first = await syncConflictBoard(scene, { combat, forceProjection: true });
    assert.equal(first.ok, true);
    const boxIds = (c) =>
      scene.drawings.filter(
        (d) =>
          d.getFlag(FLAG_SCOPE, "ownerType") === CONFLICT_CARD_OWNER_TYPE &&
          d.getFlag(FLAG_SCOPE, "combatantId") === "c1" &&
          d.getFlag(FLAG_SCOPE, "part") === "stressBoxRows",
      );
    let boxes = boxIds(scene);
    assert.ok(boxes.length >= 3, "initial projection includes empty+marked stress box parts");
    assert.equal(
      scene.drawings.filter(
        (d) =>
          d.getFlag(FLAG_SCOPE, "ownerType") === CONFLICT_CARD_OWNER_TYPE &&
          d.getFlag(FLAG_SCOPE, "combatantId") === "c1" &&
          d.getFlag(FLAG_SCOPE, "part") === "consequenceBoxRows",
      ).length,
      0,
      "no consequence checkbox parts are projected",
    );
    assert.equal(
      boxes.filter((d) => d.getFlag(FLAG_SCOPE, "part") === "stressBoxRows" && d.text === "").length,
      2,
      "two unchecked stress boxes initially",
    );
    assert.equal(
      boxes.filter((d) => d.getFlag(FLAG_SCOPE, "part") === "stressBoxRows" && d.text === "X").length,
      1,
      "one marked stress box initially",
    );
    assert.equal(
      scene.drawings.filter(
        (d) => d.getFlag(FLAG_SCOPE, "ownerType") === CONFLICT_CARD_OWNER_TYPE && d.getFlag(FLAG_SCOPE, "part") === "widgetBounds",
      ).length,
      1,
      "widgetBounds present after placement",
    );
    const boundsId = scene.drawings.find(
      (d) => d.getFlag(FLAG_SCOPE, "ownerType") === CONFLICT_CARD_OWNER_TYPE && d.getFlag(FLAG_SCOPE, "part") === "widgetBounds",
    ).id;
    const cardDocCount = scene.drawings.filter(
      (d) => d.getFlag(FLAG_SCOPE, "ownerType") === CONFLICT_CARD_OWNER_TYPE && d.getFlag(FLAG_SCOPE, "combatantId") === "c1",
    ).length;

    // Change the actor's stress: box 0 becomes checked, box 1 becomes empty.
    actor.system.tracks = cloneActorTracks([true, false, false]);
    const second = await syncConflictBoard(scene, { combat });
    assert.equal(second.ok, true);
    assert.ok(second.updated > 0, "the stress change must update existing box docs");

    boxes = boxIds(scene);
    assert.equal(
      boxes.filter((d) => d.getFlag(FLAG_SCOPE, "part") === "stressBoxRows" && d.text === "").length,
      2,
      "re-projection updates the marked box to empty",
    );
    assert.equal(
      boxes.filter((d) => d.getFlag(FLAG_SCOPE, "part") === "stressBoxRows" && d.text === "X").length,
      1,
      "re-projection marks box 0",
    );
    // Old box docs are updated, never duplicated, and the widgetBounds group
    // keeps its identity (_id) instead of being recreated.
    assert.equal(
      scene.drawings.filter(
        (d) => d.getFlag(FLAG_SCOPE, "ownerType") === CONFLICT_CARD_OWNER_TYPE && d.getFlag(FLAG_SCOPE, "combatantId") === "c1",
      ).length,
      cardDocCount,
      "no card docs added/duplicated on a stress change",
    );
    assert.ok(
      scene.drawings.some(
        (d) => d.getFlag(FLAG_SCOPE, "ownerType") === CONFLICT_CARD_OWNER_TYPE && d.getFlag(FLAG_SCOPE, "part") === "widgetBounds" && d.id === boundsId,
      ),
      "widgetBounds doc retained (not duplicated) across a stress re-sync",
    );
    assert.deepEqual(scene.deleted.Drawing, [], "no card doc deleted on a stress change");

    // A repeated sync with unchanged stress is idempotent (no further updates).
    const beforeEmbeddedUpdates = scene.embeddedUpdates.Drawing.length;
    const third = await syncConflictBoard(scene, { combat });
    assert.equal(third.ok, true);
    assert.equal(third.updated, 0, "repeated sync is idempotent (no doc changed)");
    assert.equal(
      scene.embeddedUpdates.Drawing.length,
      beforeEmbeddedUpdates,
      "idempotent sync performs no further updates",
    );
  } finally {
    uninstallProjectionGlobals();
  }
});

/* ------------------------------------------------------------------ *
 * serialized removal (regression)
 * ------------------------------------------------------------------ */

test("removeConflictBoard is serialized with syncs, deletes only module-owned docs, and the board never resurrects", async () => {
  installProjectionGlobals();
  try {
    const state = validState();
    const drawings = [
      mockDoc("dBoard", "Drawing", docFlags({ widgetId: "wBoard", ownerType: CONFLICT_BOARD_OWNER_TYPE, part: CONFLICT_BOARD_BACKGROUND_PART, index: -1 })),
      mockDoc("dZone", "Drawing", docFlags({ widgetId: "wZone1", ownerType: CONFLICT_ZONE_OWNER_TYPE, part: CONFLICT_ZONE_BODY_PART, index: -1 })),
      mockDoc("dCard1", "Drawing", docFlags({ widgetId: "wCard1", ownerType: CONFLICT_CARD_OWNER_TYPE, part: "name", index: -1 })),
      mockDoc("dForeign", "Drawing", docFlags({ widgetId: "wOther", ownerType: "actorWidget", part: "name", index: -1 })),
    ];
    const scene = mockScene({
      flags: {
        [FLAG_SCOPE]: {
          [CONFLICT_BOARD_FLAG]: state,
          [CONFLICT_BOARD_WIDGET_FLAG]: registryRecord(),
        },
      },
      drawings,
      tokens: {
        t1: { uuid: "Scene.scene1.Token.t1" },
        t2: { uuid: "Scene.scene1.Token.t2" },
      },
    });

    // A sync queued BEFORE the removal must settle first, then the removal
    // deletes the projected docs by registry widgetIds. The mock scene asserts
    // no delete/update ever references a missing _id (no "Drawing does not
    // exist" regression for concurrent sync/remove).
    const [syncRes, removeRes] = await Promise.all([
      syncConflictBoard(scene, { combat: turnCombat(), forceProjection: true }),
      removeConflictBoard(scene, { clearState: true }),
    ]);
    assert.equal(syncRes.ok, true);
    assert.equal(removeRes.changed, true);

    // Board docs are gone, registry and state are cleared...
    assert.equal(boardRegistry(scene), null);
    assert.equal(readConflictBoard(scene), null);
    const moduleOwned = scene.drawings.filter((d) =>
      [
        CONFLICT_BOARD_OWNER_TYPE,
        CONFLICT_ZONE_OWNER_TYPE,
        CONFLICT_CARD_OWNER_TYPE,
      ].includes(d.getFlag(FLAG_SCOPE, "ownerType")),
    );
    assert.equal(moduleOwned.length, 0);
    // ...but foreign docs are untouched.
    assert.ok(scene.drawings.some((d) => d.id === "dForeign"));

    // A sync queued after the removal (simulating the updateScene hook of the
    // registry/state unset) must not resurrect the board or its docs.
    const afterRemove = await syncConflictBoard(scene, { combat: turnCombat() });
    assert.equal(afterRemove.ok, true);
    assert.equal(boardRegistry(scene), null);
    assert.equal(scene.drawings.length, 1); // only the foreign doc remains
  } finally {
    uninstallProjectionGlobals();
  }
});

test("removeConflictBoard queued first keeps a later sync from resurrecting the board", async () => {
  const state = validState();
  const drawings = [
    mockDoc("dBoard", "Drawing", docFlags({ widgetId: "wBoard", ownerType: CONFLICT_BOARD_OWNER_TYPE, part: CONFLICT_BOARD_BACKGROUND_PART, index: -1 })),
  ];
  const scene = mockScene({
    flags: {
      [FLAG_SCOPE]: {
        [CONFLICT_BOARD_FLAG]: state,
        [CONFLICT_BOARD_WIDGET_FLAG]: registryRecord(),
      },
    },
    drawings,
  });

  // Removal without clearState: the board state survives so an explicit
  // re-place can restore the board, but the projection + registry are gone.
  const [removeRes, syncRes] = await Promise.all([
    removeConflictBoard(scene),
    syncConflictBoard(scene, {}),
  ]);
  assert.equal(removeRes.changed, true);
  assert.equal(removeRes.removed, 1);
  assert.equal(syncRes.ok, true);
  // The queued sync after the removal found the empty registry and must not
  // recreate any projection doc or re-register the board.
  assert.equal(boardRegistry(scene), null);
  assert.equal(scene.drawings.length, 0);
  assert.ok(readConflictBoard(scene));
});

/* ------------------------------------------------------------------ *
 * Card state markers — acted fade overlay & eliminated strike-through
 * ------------------------------------------------------------------ */

test("buildCardActedOverlayDescriptor matches card rect and style", () => {
  const pos = { x: 10, y: 20, width: 220, height: 150, area: "side", side: "friendly", order: 0 };
  const d = buildCardActedOverlayDescriptor(pos);
  assert.equal(d.part, CONFLICT_CARD_ACTED_OVERLAY_PART);
  assert.equal(d.index, -1);
  assert.equal(d.kind, "drawing");
  assert.deepEqual({ x: d.x, y: d.y, w: d.w, h: d.h }, { x: 10, y: 20, w: 220, h: 150 });
  assert.equal(d.fillType, 1);
  assert.equal(d.fillColor, "#808080");
  assert.equal(d.fillAlpha, 0.45);
  assert.equal(d.stroke, 0);
  assert.equal(d.elevation, 0);
  assert.equal(d.sort, 5);
  assert.equal(d.text, "");
});

test("buildCardEliminatedStrikeDescriptors are two diagonal red bars through card centre (rotation ±45)", () => {
  const pos = { x: 10, y: 20, width: 220, height: 150, area: "side", side: "friendly", order: 0 };
  const strikes = buildCardEliminatedStrikeDescriptors(pos);
  assert.equal(strikes.length, 2);
  const [a, b] = strikes;
  for (const s of strikes) {
    assert.equal(s.kind, "drawing");
    assert.equal(s.part, CONFLICT_CARD_ELIMINATED_STRIKE_PART);
    assert.equal(s.fillType, 1);
    assert.equal(s.fillColor, "#b71c1c");
    assert.equal(s.fillAlpha, 0.95);
    assert.equal(s.stroke, 0);
    assert.equal(s.elevation, 0);
    assert.equal(s.sort, 6);
    assert.equal(s.h, 6);
    const cx = pos.x + pos.width / 2;
    const cy = pos.y + pos.height / 2;
    assert.ok(Math.abs(s.x + s.w / 2 - cx) < 1e-6, "strike centred on card X");
    assert.ok(Math.abs(s.y + s.h / 2 - cy) < 1e-6, "strike centred on card Y");
    assert.equal(s.w, Math.round(Math.hypot(pos.width, pos.height)));
  }
  assert.deepEqual([a.index, b.index].sort(), [0, 1]);
  assert.ok((a.rotation === 45 && b.rotation === -45) || (a.rotation === -45 && b.rotation === 45));
});

test("buildConflictBoardDocuments: acted card adds grey overlay, ordinary card adds nothing", async () => {
  installProjectionGlobals();
  const raw = JSON.parse(readFileSync(new URL("../layouts/minimal.json", import.meta.url), "utf8"));
  addLayout(analyzeLayout(raw).normalized);
  try {
    const state = validState({
      cards: {
        c1: { side: "friendly", area: "side", order: 0, acted: true },
        c2: { side: "hostile", area: "side", order: 1 },
      },
      tokenZones: {},
    });
    const geometry = getConflictBoardGeometry({ sizePreset: "medium" });
    const { positions } = layoutConflictCards(geometry, state);
    const scene = mockScene({
      tokens: {
        t1: { uuid: "Scene.scene1.Token.t1" },
        t2: { uuid: "Scene.scene1.Token.t2" },
      },
    });
    const combat = {
      id: "combat-abc",
      combatants: [
        { id: "c1", tokenId: "t1", sceneId: "scene1", token: { name: "A", texture: { src: "a.png" }, disposition: 1 } },
        { id: "c2", tokenId: "t2", sceneId: "scene1", token: { name: "B", texture: { src: "b.png" }, disposition: -1 } },
      ],
    };
    const built = await buildConflictBoardDocuments(scene, state, combat, {});
    const c1 = built.cards.c1;
    const c2 = built.cards.c2;
    assert.ok(c1 && c1.length > 0);
    assert.ok(c2 && c2.length > 0);
    const overlay = c1.filter((d) => d.part === CONFLICT_CARD_ACTED_OVERLAY_PART);
    assert.equal(overlay.length, 1);
    assert.equal(overlay[0].index, -1);
    assert.deepEqual({ x: overlay[0].x, y: overlay[0].y, w: overlay[0].w, h: overlay[0].h }, { x: positions.c1.x, y: positions.c1.y, w: positions.c1.width, h: positions.c1.height });
    assert.equal(overlay[0].fillColor, "#808080");
    assert.equal(overlay[0].fillAlpha, 0.45);
    assert.equal(overlay[0].elevation, 0);
    assert.equal(overlay[0].sort, 5);
    assert.equal(overlay[0].flags.combatId, "combat-abc");
    assert.equal(overlay[0].flags.combatantId, "c1");
    assert.equal(overlay[0].flags.tokenUuid, "Scene.scene1.Token.t1");
    assert.equal(overlay[0].flags.area, positions.c1.area);
    assert.equal(c1.filter((d) => d.part === CONFLICT_CARD_ELIMINATED_STRIKE_PART).length, 0);
    assert.equal(c2.filter((d) => d.part === CONFLICT_CARD_ACTED_OVERLAY_PART).length, 0);
    assert.equal(c2.filter((d) => d.part === CONFLICT_CARD_ELIMINATED_STRIKE_PART).length, 0);
  } finally {
    uninstallProjectionGlobals();
  }
});

test("buildConflictBoardDocuments: eliminated card adds two diagonal strikes", async () => {
  installProjectionGlobals();
  const raw = JSON.parse(readFileSync(new URL("../layouts/minimal.json", import.meta.url), "utf8"));
  addLayout(analyzeLayout(raw).normalized);
  try {
    const state = validState({
      cards: {
        c1: { side: "friendly", area: "side", order: 0, eliminated: true },
      },
      tokenZones: {},
    });
    const geometry = getConflictBoardGeometry({ sizePreset: "medium" });
    const { positions } = layoutConflictCards(geometry, state);
    const scene = mockScene({ tokens: { t1: { uuid: "Scene.scene1.Token.t1" } } });
    const combat = {
      id: "combat-abc",
      combatants: [{ id: "c1", tokenId: "t1", sceneId: "scene1", token: { name: "A", texture: { src: "a.png" }, disposition: 1 } }],
    };
    const built = await buildConflictBoardDocuments(scene, state, combat, {});
    const c1 = built.cards.c1;
    const strikes = c1.filter((d) => d.part === CONFLICT_CARD_ELIMINATED_STRIKE_PART);
    assert.equal(strikes.length, 2);
    assert.deepEqual(strikes.map((d) => d.index).sort(), [0, 1]);
    for (const s of strikes) {
      assert.equal(s.fillColor, "#b71c1c");
      assert.equal(s.elevation, 0);
      assert.equal(s.sort, 6);
      assert.ok(Number.isFinite(s.rotation));
      assert.equal(s.flags.combatantId, "c1");
      assert.equal(s.flags.tokenUuid, "Scene.scene1.Token.t1");
      const cx = positions.c1.x + positions.c1.width / 2;
      const cy = positions.c1.y + positions.c1.height / 2;
      assert.ok(Math.abs(s.x + s.w / 2 - cx) < 1e-6);
      assert.ok(Math.abs(s.y + s.h / 2 - cy) < 1e-6);
    }
    assert.equal(c1.filter((d) => d.part === CONFLICT_CARD_ACTED_OVERLAY_PART).length, 0);
  } finally {
    uninstallProjectionGlobals();
  }
});

test("buildConflictBoardDocuments: eliminated+acted only strike (eliminated priority)", async () => {
  installProjectionGlobals();
  const raw = JSON.parse(readFileSync(new URL("../layouts/minimal.json", import.meta.url), "utf8"));
  addLayout(analyzeLayout(raw).normalized);
  try {
    const state = validState({
      cards: {
        c1: { side: "friendly", area: "side", order: 0, acted: true, eliminated: true },
      },
      tokenZones: {},
    });
    const scene = mockScene({ tokens: { t1: { uuid: "Scene.scene1.Token.t1" } } });
    const combat = {
      id: "combat-abc",
      combatants: [{ id: "c1", tokenId: "t1", sceneId: "scene1", token: { name: "A", texture: { src: "a.png" }, disposition: 1 } }],
    };
    const built = await buildConflictBoardDocuments(scene, state, combat, {});
    const c1 = built.cards.c1;
    assert.equal(c1.filter((d) => d.part === CONFLICT_CARD_ACTED_OVERLAY_PART).length, 0, "acted overlay omitted when eliminated");
    assert.equal(c1.filter((d) => d.part === CONFLICT_CARD_ELIMINATED_STRIKE_PART).length, 2);
  } finally {
    uninstallProjectionGlobals();
  }
});

test("syncConflictBoard: acted overlay created and removed via upsertParts batch (diff/flags/ownerType)", async () => {
  installProjectionGlobals();
  const raw = JSON.parse(readFileSync(new URL("../layouts/minimal.json", import.meta.url), "utf8"));
  addLayout(analyzeLayout(raw).normalized);
  try {
    const stateActed = validState({
      cards: {
        c1: { side: "friendly", area: "side", order: 0, acted: true },
      },
      tokenZones: {},
    });
    const stateClear = validState({
      cards: {
        c1: { side: "friendly", area: "side", order: 0 },
      },
      tokenZones: {},
    });
    const geometry = getConflictBoardGeometry({ sizePreset: "medium" });
    const { positions } = layoutConflictCards(geometry, stateActed);
    const expectedOverlay = buildCardActedOverlayDescriptor(positions.c1);
    const scene = mockScene({
      tokens: { t1: { uuid: "Scene.scene1.Token.t1" } },
    });
    await writeConflictBoard(scene, stateActed);
    await scene.update(
      { [`flags.${FLAG_SCOPE}.${CONFLICT_BOARD_WIDGET_FLAG}`]: { widgetId: "wBoard", zoneWidgetIds: {}, cardWidgetIds: { c1: "wCard1" } } },
      { fateOnTheTableSync: true },
    );
    const combatActed = {
      id: "combat-abc",
      turn: null,
      combatants: [{ id: "c1", tokenId: "t1", sceneId: "scene1", token: { name: "A", texture: { src: "a.png" }, disposition: 1 }, getFlag(scope, key) { return scope === "fate-core-official" && key === "hasActed" ? true : undefined; } }],
    };
    const combatClear = {
      id: "combat-abc",
      turn: null,
      combatants: [{ id: "c1", tokenId: "t1", sceneId: "scene1", token: { name: "A", texture: { src: "a.png" }, disposition: 1 }, getFlag(scope, key) { return scope === "fate-core-official" && key === "hasActed" ? false : undefined; } }],
    };
    const first = await syncConflictBoard(scene, { combat: combatActed, forceProjection: true });
    assert.equal(first.ok, true);
    let overlays = scene.drawings.filter((d) => d.getFlag(FLAG_SCOPE, "part") === CONFLICT_CARD_ACTED_OVERLAY_PART);
    assert.equal(overlays.length, 1);
    const doc = overlays[0];
    assert.equal(doc.getFlag(FLAG_SCOPE, "ownerType"), CONFLICT_CARD_OWNER_TYPE);
    assert.equal(doc.getFlag(FLAG_SCOPE, "widgetId"), "wCard1");
    assert.equal(doc.getFlag(FLAG_SCOPE, "combatantId"), "c1");
    assert.equal(doc.getFlag(FLAG_SCOPE, "tokenUuid"), "Scene.scene1.Token.t1");
    const ox = stateActed.board.origin.x;
    const oy = stateActed.board.origin.y;
    assert.equal(doc.x, Math.round(expectedOverlay.x + ox));
    assert.equal(doc.y, Math.round(expectedOverlay.y + oy));
    assert.deepEqual(doc.shape, { width: Math.round(expectedOverlay.w), height: Math.round(expectedOverlay.h) });
    assert.equal(doc.fillColor, "#808080");
    assert.equal(doc.fillAlpha, 0.45);
    assert.equal(doc.elevation, 0);
    assert.equal(doc.sort, 5);
    await writeConflictBoard(scene, stateClear);
    const second = await syncConflictBoard(scene, { combat: combatClear });
    assert.equal(second.ok, true);
    overlays = scene.drawings.filter((d) => d.getFlag(FLAG_SCOPE, "part") === CONFLICT_CARD_ACTED_OVERLAY_PART);
    assert.equal(overlays.length, 0, "acted overlay removed when flag cleared");
    const cardDocsNow = scene.drawings.filter((d) => d.getFlag(FLAG_SCOPE, "ownerType") === CONFLICT_CARD_OWNER_TYPE && d.getFlag(FLAG_SCOPE, "combatantId") === "c1");
    assert.ok(cardDocsNow.length > 0);
    await writeConflictBoard(scene, stateActed);
    const third = await syncConflictBoard(scene, { combat: combatActed });
    assert.equal(third.ok, true);
    assert.equal(scene.drawings.filter((d) => d.getFlag(FLAG_SCOPE, "part") === CONFLICT_CARD_ACTED_OVERLAY_PART).length, 1);
  } finally {
    uninstallProjectionGlobals();
  }
});

test("syncConflictBoard: eliminated strikes created and respect acted+eliminated priority, rotation field diff", async () => {
  installProjectionGlobals();
  const raw = JSON.parse(readFileSync(new URL("../layouts/minimal.json", import.meta.url), "utf8"));
  addLayout(analyzeLayout(raw).normalized);
  try {
    const stateElim = validState({
      cards: {
        c1: { side: "friendly", area: "side", order: 0, eliminated: true },
      },
      tokenZones: {},
    });
    const scene = mockScene({ tokens: { t1: { uuid: "Scene.scene1.Token.t1" } } });
    await writeConflictBoard(scene, stateElim);
    await scene.update(
      { [`flags.${FLAG_SCOPE}.${CONFLICT_BOARD_WIDGET_FLAG}`]: { widgetId: "wBoard", zoneWidgetIds: {}, cardWidgetIds: { c1: "wCard1" } } },
      { fateOnTheTableSync: true },
    );
    const combat = {
      id: "combat-abc",
      combatants: [{ id: "c1", tokenId: "t1", sceneId: "scene1", token: { name: "A", texture: { src: "a.png" }, disposition: 1 } }],
    };
    const first = await syncConflictBoard(scene, { combat, forceProjection: true });
    assert.equal(first.ok, true);
    let strikes = scene.drawings.filter((d) => d.getFlag(FLAG_SCOPE, "part") === CONFLICT_CARD_ELIMINATED_STRIKE_PART);
    assert.equal(strikes.length, 2);
    for (const s of strikes) {
      assert.equal(s.getFlag(FLAG_SCOPE, "ownerType"), CONFLICT_CARD_OWNER_TYPE);
      assert.equal(s.getFlag(FLAG_SCOPE, "widgetId"), "wCard1");
      assert.equal(s.strokeWidth, 0);
      assert.equal(s.fillColor, "#b71c1c");
      assert.equal(s.elevation, 0);
      assert.equal(s.sort, 6);
      assert.ok(Number.isFinite(s.rotation));
    }
    const byIndex = [...strikes].sort((a, b) => (a.getFlag(FLAG_SCOPE, "index") ?? -1) - (b.getFlag(FLAG_SCOPE, "index") ?? -1));
    assert.equal(byIndex[0].getFlag(FLAG_SCOPE, "index"), 0);
    assert.equal(byIndex[1].getFlag(FLAG_SCOPE, "index"), 1);
    assert.ok((byIndex[0].rotation === 45 && byIndex[1].rotation === -45) || (byIndex[0].rotation === -45 && byIndex[1].rotation === 45));
    const stateBoth = validState({
      cards: {
        c1: { side: "friendly", area: "side", order: 0, acted: true, eliminated: true },
      },
      tokenZones: {},
    });
    await writeConflictBoard(scene, stateBoth);
    const second = await syncConflictBoard(scene, { combat });
    assert.equal(second.ok, true);
    assert.equal(scene.drawings.filter((d) => d.getFlag(FLAG_SCOPE, "part") === CONFLICT_CARD_ACTED_OVERLAY_PART).length, 0);
    assert.equal(scene.drawings.filter((d) => d.getFlag(FLAG_SCOPE, "part") === CONFLICT_CARD_ELIMINATED_STRIKE_PART).length, 2);
    const beforeUpdates = scene.embeddedUpdates.Drawing.length;
    const third = await syncConflictBoard(scene, { combat });
    assert.equal(third.ok, true);
    assert.equal(third.updated, 0);
    assert.equal(scene.embeddedUpdates.Drawing.length, beforeUpdates);
  } finally {
    uninstallProjectionGlobals();
  }
});
