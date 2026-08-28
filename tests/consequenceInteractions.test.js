/**
 * Node tests for ConsequenceInteractions.js — the double-click consequence
 * input on conflict-card (and actor-widget) consequence COST rows. Covers
 * part recognition, the cancel/save double-click flow (linked actor update +
 * unlinked token delta), custom harm cost preservation, the situation-aspect
 * create/update/dedupe/remove lifecycle, permission gating and the
 * sheet-interception contract (the cost part is handled, the sheet is not).
 */

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  FLAG_SCOPE,
  CONFLICT_CARD_OWNER_TYPE,
  SITUATION_ASPECTS_SCOPE,
  SITUATION_ASPECTS_KEY,
} from "../scripts/constants.js";
import {
  isConsequenceCostPart,
  handleConsequenceCostDoubleClick,
  upsertSituationAspect,
  promptConsequenceName,
  CONSEQUENCE_COST_ROWS_PART,
} from "../scripts/ConsequenceInteractions.js";

let warned = [];
let dialogResult = null;
let fromUuidTarget = null;
let lastInputOpts = null;

globalThis.CONST = {
  DOCUMENT_OWNERSHIP_LEVELS: { OWNER: 2, LIMITED: 1 },
  DRAWING_TYPES: { RECTANGLE: "r" },
  DRAWING_FILL_TYPES: { NONE: 0 },
};
globalThis.foundry = {
  utils: { duplicate: (v) => structuredClone(v) },
  applications: {
    api: {
      ApplicationV2: class ApplicationV2 {},
      DialogV2: {
        input: (opts) => {
          lastInputOpts = opts;
          return Promise.resolve(dialogResult);
        },
      },
    },
  },
};
globalThis.game = {
  user: { id: "u1" },
  i18n: { localize: (key) => key },
  combats: { get: () => null },
};
globalThis.ui = { notifications: { warn: (m) => warned.push(m), info: () => {} } };
globalThis.fromUuid = async () => fromUuidTarget;
globalThis.canvas = { scene: null };

afterEach(() => {
  warned = [];
  dialogResult = null;
  fromUuidTarget = null;
  lastInputOpts = null;
  globalThis.canvas.scene = null;
  globalThis.game.combats = { get: () => null };
});

/** A consequence cost row Drawing document with identity flags. */
function costRow(n, overrides = {}) {
  const flags = {
    part: CONSEQUENCE_COST_ROWS_PART,
    index: n,
    ownerType: CONFLICT_CARD_OWNER_TYPE,
    combatId: "combat-abc",
    combatantId: "c1",
    tokenUuid: "Scene.scene1.Token.t1",
    ...overrides,
  };
  return {
    id: `row-${n}`,
    getFlag(scope, key) {
      if (scope !== FLAG_SCOPE) return undefined;
      return flags[key];
    },
  };
}

function consequenceActor({ owner = true, isToken = false, update } = {}) {
  return {
    uuid: "Actor.grom",
    name: "Grom",
    isToken,
    testUserPermission: () => owner,
    system: {
      tracks: {
        phys: { name: "Physical Stress", enabled: true, boxes: 2, aspect: "No", box_values: [false, false] },
        mild: {
          name: "Mild Consequence",
          enabled: true,
          boxes: 0,
          box_values: [false],
          harm_can_absorb: 2,
          aspect: { when_marked: true, name: "" },
        },
        severe: {
          name: "Severe Consequence",
          enabled: true,
          boxes: 0,
          box_values: [true],
          harm_can_absorb: 4,
          aspect: { when_marked: true, name: "Bleeding out" },
        },
      },
    },
    async update(data) {
      if (update) await update(data);
      return this;
    },
  };
}

/** Minimal scene mock: situation aspects + board flag (none) + setFlag. */
function mockScene(initialAspects = []) {
  const flags = {
    [SITUATION_ASPECTS_SCOPE]: { [SITUATION_ASPECTS_KEY]: initialAspects },
    [FLAG_SCOPE]: {},
  };
  return {
    id: "scene1",
    uuid: "Scene.scene1",
    changedFlags: [],
    getFlag(scope, key) {
      return flags[scope]?.[key];
    },
    async setFlag(scope, key, value) {
      flags[scope] ??= {};
      flags[scope][key] = value;
      this.changedFlags.push({ scope, key, value });
      return this;
    },
  };
}

function installLinkedCombat(actor) {
  globalThis.game.combats = {
    get: () => ({ id: "combat-abc", combatants: [{ id: "c1", token: { actor }, actor }] }),
  };
}

/* ------------------------------------------------------------------ *
 * Recognition
 * ------------------------------------------------------------------ */

test("isConsequenceCostPart recognizes conflict-card and actor-widget cost rows", () => {
  assert.equal(isConsequenceCostPart(costRow(0)), true);
  assert.equal(isConsequenceCostPart(costRow(1)), true);
  assert.equal(isConsequenceCostPart(costRow(0, { ownerType: undefined, actorUuid: "Actor.a" })), true);
  // not cost rows: wrong part, bad index, other owner type without actorUuid
  assert.equal(isConsequenceCostPart(costRow(0, { part: "name" })), false);
  assert.equal(isConsequenceCostPart(costRow(-1)), false);
  assert.equal(isConsequenceCostPart(costRow(0, { ownerType: "conflictZone" })), false);
  assert.equal(isConsequenceCostPart(costRow(0, { ownerType: undefined })), false);
  assert.equal(isConsequenceCostPart(null), false);
  assert.equal(isConsequenceCostPart({}), false);
});

/* ------------------------------------------------------------------ *
 * Double-click flow
 * ------------------------------------------------------------------ */

test("cancelling the dialog is a no-op (no actor/track/aspect writes)", async () => {
  dialogResult = "cancel"; // non-ok button id -> no field value
  const actor = consequenceActor({
    update: () => assert.fail("no update on cancel"),
  });
  installLinkedCombat(actor);
  const scene = mockScene([]);
  globalThis.canvas.scene = scene;
  let syncCalled = false;
  const handled = await handleConsequenceCostDoubleClick(costRow(0), null);
  assert.equal(handled, true);
  assert.deepEqual(scene.changedFlags, []);
  assert.equal(warned.length, 0);
});

test("save on a linked actor writes the aspect name with box_values normalized to [] (no consequence checkbox), preserving harm_can_absorb", async () => {
  dialogResult = { name: "Broken leg" };
  let applied = null;
  const actor = consequenceActor({
    update: (data) => {
      applied = data;
    },
  });
  installLinkedCombat(actor);
  const scene = mockScene([]);
  globalThis.canvas.scene = scene;
  const handled = await handleConsequenceCostDoubleClick(costRow(0, { trackKey: "mild" }), null);
  assert.equal(handled, true);
  assert.ok(applied, "the actor must be updated on save");
  const mild = applied["system.tracks"].mild;
  // Regression: the mild track starts with box_values [false] (a leftover
  // empty checkbox from earlier writes); writing a name normalizes it to []
  // so the Fate Core sheet (which iterates box_values) draws NO consequence
  // checkbox at all — an empty array, not an empty box and not a marked X.
  assert.deepEqual(mild.box_values, []);
  assert.equal(mild.aspect.name, "Broken leg");
  assert.equal(mild.aspect.when_marked, true);
  assert.ok(!("harm_can_absorb" in mild), "custom harm cost is never overwritten");
  // The linked situation aspect is created with the actor name suffix and structural meta.
  const aspects = scene.getFlag(SITUATION_ASPECTS_SCOPE, SITUATION_ASPECTS_KEY);
  assert.deepEqual(aspects, [{ name: "Broken leg (Grom)", free_invokes: 1, linked: true, consequence: { trackKey: "mild", cost: 2, actorName: "Grom" } }]);
});

test("save writes a token delta for an unlinked synthetic token actor (text only, no consequence box)", async () => {
  dialogResult = { name: "On fire" };
  let tokenDelta = null;
  const actor = consequenceActor({ isToken: true });
  const token = {
    id: "t1",
    actor,
    update: (data) => {
      tokenDelta = data;
      return Promise.resolve(token);
    },
  };
  globalThis.game.combats = {
    get: () => ({ id: "combat-abc", combatants: [{ id: "c1", token, actor }] }),
  };
  const scene = mockScene([]);
  globalThis.canvas.scene = scene;
  await handleConsequenceCostDoubleClick(costRow(1, { trackKey: "severe" }), null);
  assert.ok(tokenDelta, "the unlinked token must be updated");
  const severe = tokenDelta.delta.system.tracks.severe;
  // Regression: the severe track starts with box_values [true] (a stale X);
  // the delta normalizes it to [] so the sheet draws no consequence checkbox.
  assert.deepEqual(severe.box_values, []);
  assert.equal(severe.aspect.name, "On fire");
  assert.ok(!("harm_can_absorb" in severe), "custom harm cost preserved on token delta");
});

test("empty OK clears the slot (box_values normalized to [], no consequence checkbox) and removes the linked situation aspect", async () => {
  dialogResult = { name: "" }; // empty -> clear
  let applied = null;
  const actor = consequenceActor({
    update: (data) => {
      applied = data;
    },
  });
  actor.system.tracks.mild = {
    name: "Mild Consequence",
    enabled: true,
    boxes: 0,
    box_values: [true],
    harm_can_absorb: 2,
    aspect: { when_marked: true, name: "Broken leg" },
  };
  installLinkedCombat(actor);
  const oldAspect = { name: "Broken leg (Grom)", free_invokes: 1, linked: true };
  const scene = mockScene([oldAspect, { name: "Room is dark", free_invokes: 2 }]);
  globalThis.canvas.scene = scene;
  await handleConsequenceCostDoubleClick(costRow(0, { trackKey: "mild" }), null);
  const mild = applied["system.tracks"].mild;
  // Regression: the slot starts with box_values [true] (a stale X); clearing
  // the name normalizes it to [] — the X is removed and no empty checkbox is
  // left behind, so the sheet's consequence row is just text + cost.
  assert.deepEqual(mild.box_values, []);
  assert.equal(mild.aspect.name, "");
  assert.ok(!("harm_can_absorb" in mild), "custom harm cost is never overwritten");
  // foreign aspect preserved, the cleared linked one removed
  assert.deepEqual(scene.getFlag(SITUATION_ASPECTS_SCOPE, SITUATION_ASPECTS_KEY), [
    { name: "Room is dark", free_invokes: 2 },
  ]);
});

test("non-owner is denied: warns, no actor write, no aspect change", async () => {
  dialogResult = { name: "Broken leg" };
  let applied = null;
  const actor = consequenceActor({
    owner: false,
    update: (data) => {
      applied = data;
    },
  });
  installLinkedCombat(actor);
  const scene = mockScene([]);
  globalThis.canvas.scene = scene;
  const handled = await handleConsequenceCostDoubleClick(costRow(0, { trackKey: "mild" }), null);
  assert.equal(handled, true);
  assert.equal(applied, null);
  assert.equal(scene.changedFlags.length, 0);
  assert.equal(warned.length, 1);
  assert.ok(warned[0].includes("consequence"));
});

test("consequence row double-click is consumed before the sheet opens (no sheet render)", async () => {
  dialogResult = { name: "Stunned" };
  let sheetRendered = false;
  const actor = consequenceActor({ update: () => {} });
  actor.sheet = { render: () => { sheetRendered = true; } };
  installLinkedCombat(actor);
  const scene = mockScene([]);
  globalThis.canvas.scene = scene;
  const handled = await handleConsequenceCostDoubleClick(costRow(0, { trackKey: "mild" }), null);
  assert.equal(handled, true);
  assert.equal(sheetRendered, false, "the consequence input must intercept the sheet open");
});

/* ------------------------------------------------------------------ *
 * Situation aspect lifecycle (pure helper)
 * ------------------------------------------------------------------ */

test("upsertSituationAspect creates, updates, dedupes and removes linked aspects", async () => {
  const scene = mockScene([
    { name: "Existing foreign", free_invokes: 3 },
  ]);
  // create
  await upsertSituationAspect(scene, "Grom", "Broken leg", "");
  assert.deepEqual(scene.getFlag(SITUATION_ASPECTS_SCOPE, SITUATION_ASPECTS_KEY), [
    { name: "Existing foreign", free_invokes: 3 },
    { name: "Broken leg (Grom)", free_invokes: 1, linked: true },
  ]);
  // dedupe: same name pushed twice does not add a second record
  await upsertSituationAspect(scene, "Grom", "Broken leg", "");
  assert.equal(scene.getFlag(SITUATION_ASPECTS_SCOPE, SITUATION_ASPECTS_KEY).length, 2);
  // rename in place
  await upsertSituationAspect(scene, "Grom", "Broken arm", "Broken leg");
  assert.deepEqual(scene.getFlag(SITUATION_ASPECTS_SCOPE, SITUATION_ASPECTS_KEY), [
    { name: "Existing foreign", free_invokes: 3 },
    { name: "Broken arm (Grom)", free_invokes: 1, linked: true },
  ]);
  // remove on clear
  await upsertSituationAspect(scene, "Grom", "", "Broken arm");
  assert.deepEqual(scene.getFlag(SITUATION_ASPECTS_SCOPE, SITUATION_ASPECTS_KEY), [
    { name: "Existing foreign", free_invokes: 3 },
  ]);
});

test("promptConsequenceName resolves a name and null on cancel", async () => {
  dialogResult = { name: "  Bruised  " };
  assert.equal(await promptConsequenceName(""), "Bruised");
  dialogResult = "cancel";
  assert.equal(await promptConsequenceName("Broken leg"), null);
});

test("promptConsequenceName shows a visible localized Cancel next to OK and keeps cancel/ESC a no-op", async () => {
  // The v12+/v14 DialogV2.input config accepts a `cancel` button entry: an
  // explicit localized Cancel renders next to OK and dismisses (resolves like
  // the close path), which our handler must treat as a no-op.
  dialogResult = { name: "Entered" };
  lastInputOpts = null;
  const name = await promptConsequenceName("Existing");
  assert.equal(name, "Entered");
  assert.ok(lastInputOpts, "DialogV2.input must receive a config object");
  assert.deepEqual(
    lastInputOpts.ok,
    { label: "fate-on-the-table.consequence.ok" },
    "the OK/Save button keeps its localized label",
  );
  assert.deepEqual(
    lastInputOpts.cancel,
    { label: "fate-on-the-table.consequence.cancel" },
    "an explicit localized Cancel button is configured next to OK",
  );
  assert.equal(lastInputOpts.rejectClose, false, "close/ESC stays a graceful cancel, not a rejection");
  assert.ok(
    String(lastInputOpts.content).includes('value="Existing"'),
    "the current name is preserved as the initial value",
  );

  // Cancel (v14 resolves the pressed non-ok button id / null on close) is a no-op.
  dialogResult = "cancel";
  assert.equal(await promptConsequenceName("Existing"), null);
  dialogResult = null;
  assert.equal(await promptConsequenceName("Existing"), null);

  // Entering nothing and pressing OK is a valid "clear the slot" (handled by
  // the caller), not a cancel.
  dialogResult = { name: "" };
  assert.equal(await promptConsequenceName("Existing"), "");
});

test("promptConsequenceName degrades to a graceful cancel without DialogV2.input", async () => {
  const original = globalThis.foundry.applications.api.DialogV2;
  try {
    delete globalThis.foundry.applications.api.DialogV2;
    assert.equal(await promptConsequenceName("Existing"), null);
  } finally {
    globalThis.foundry.applications.api.DialogV2 = original;
  }
});
