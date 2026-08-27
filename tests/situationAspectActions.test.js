/**
 * Node tests for situationAspectActions.js — the mutation logic behind the
 * GM context menu of the situation aspects widget:
 *
 * - `adjustInvokesInList`: pure +/- on free_invokes (up / down / floor at
 *   zero, unknown fields preserved, source list untouched);
 * - `removeAspectFromList`: pure removal (middle / edges / invalid indexes);
 * - `saAspectMenuItems`: pure builder of the per-aspect context menu,
 *   including the disabled state of "remove invoke" at 0 free invokes;
 * - `saWidgetMenuItems`: pure builder of the widget (empty-place) menu;
 * - `adjustInvokes` / `removeAspectAt`: GM-guarded scene operations on a
 *   mock scene (getFlag/setFlag stubs as in the neighbouring tests).
 *
 * Foundry globals are stubbed minimally before importing the module chain
 * (situationAspectActions -> SituationAspectSync -> settings.js extends
 * ApplicationV2 at top level) — same approach as situationAspectSync.test.js.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

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
  },
};
globalThis.CONST = {
  DRAWING_TYPES: { RECTANGLE: "r" },
  DRAWING_FILL_TYPES: { NONE: 0, SOLID: 1, PATTERN: 2 },
};
globalThis.CONFIG = { fontDefinitions: {}, tileMappings: {} };

const {
  adjustInvokesInList,
  removeAspectFromList,
  saAspectMenuItems,
  saWidgetMenuItems,
  adjustInvokes,
  removeAspectAt,
} = await import("../scripts/situationAspectActions.js");
const {
  SITUATION_ASPECTS_SCOPE,
  SITUATION_ASPECTS_KEY,
} = await import("../scripts/constants.js");

/* ------------------------------------------------------------------ *
 * Fixtures & mocks
 * ------------------------------------------------------------------ */

/** Fresh aspect list fixture (already normalized shape). */
function makeList() {
  return [
    { name: "Fire", free_invokes: 2, linked: "actor-1" },
    { name: "Dark corridor", free_invokes: 0 },
    { name: "Bribed guard (Goblin)", free_invokes: 1 },
  ];
}

/** Mock scene with flag storage + setFlag call recording. */
function mockScene(flags = {}) {
  const scene = {
    id: "scene1",
    flags,
    setFlagCalls: [],
    getFlag(scope, key) {
      return this.flags[scope]?.[key];
    },
    async setFlag(scope, key, value) {
      this.setFlagCalls.push({ scope, key, value });
      (this.flags[scope] ??= {})[key] = structuredClone(value);
      return this;
    },
  };
  return scene;
}

function sceneWithAspects(list) {
  return mockScene({
    [SITUATION_ASPECTS_SCOPE]: {
      [SITUATION_ASPECTS_KEY]: structuredClone(list),
    },
  });
}

function storedList(scene) {
  return scene.getFlag(SITUATION_ASPECTS_SCOPE, SITUATION_ASPECTS_KEY);
}

function installGame(isGM) {
  globalThis.game = {
    user: { isGM },
    i18n: { localize: (k) => k, format: (k) => k },
    settings: { get: () => undefined },
  };
}

/* ------------------------------------------------------------------ *
 * adjustInvokesInList (pure)
 * ------------------------------------------------------------------ */

test("adjustInvokesInList: +1 changes only the target aspect", () => {
  const source = makeList();
  const next = adjustInvokesInList(source, 1, +1);
  assert.ok(Array.isArray(next));
  assert.equal(next.length, 3);
  assert.equal(next[1].free_invokes, 1);
  // Neighbours are equal but distinct copies; values untouched.
  assert.deepEqual(
    next.filter((_, i) => i !== 1),
    [source[0], source[2]],
  );
});

test("adjustInvokesInList: unknown extra fields survive the copy", () => {
  const next = adjustInvokesInList(makeList(), 0, +1);
  assert.equal(next[0].linked, "actor-1");
});

test("adjustInvokesInList: the source list is never mutated", () => {
  const source = makeList();
  const snapshot = structuredClone(source);
  adjustInvokesInList(source, 0, +1);
  adjustInvokesInList(source, 2, -1);
  assert.deepEqual(source, snapshot);
});

test("adjustInvokesInList: down never goes below zero", () => {
  assert.equal(adjustInvokesInList(makeList(), 0, -5)[0].free_invokes, 0);
  assert.equal(adjustInvokesInList(makeList(), 2, -1)[2].free_invokes, 0);
  // Zero stays zero.
  assert.equal(adjustInvokesInList(makeList(), 1, -1)[1].free_invokes, 0);
});

test("adjustInvokesInList: numeric garbage is coerced like normalizeAspects", () => {
  const weird = [{ name: "X", free_invokes: "3" }];
  assert.equal(adjustInvokesInList(weird, 0, +1)[0].free_invokes, 4);
  const negative = [{ name: "Y", free_invokes: -7 }];
  assert.equal(adjustInvokesInList(negative, 0, +1)[0].free_invokes, 0);
});

test("adjustInvokesInList: invalid list or index yields null", () => {
  const list = makeList();
  assert.equal(adjustInvokesInList(list, -1, +1), null);
  assert.equal(adjustInvokesInList(list, 3, +1), null);
  assert.equal(adjustInvokesInList(list, 1.5, +1), null);
  assert.equal(adjustInvokesInList(list, "1", +1), null);
  assert.equal(adjustInvokesInList(null, 0, +1), null);
  assert.equal(adjustInvokesInList(undefined, 0, +1), null);
  assert.equal(adjustInvokesInList("nope", 0, +1), null);
});

/* ------------------------------------------------------------------ *
 * removeAspectFromList (pure)
 * ------------------------------------------------------------------ */

test("removeAspectFromList: removes the middle element, keeps the rest", () => {
  const source = makeList();
  const next = removeAspectFromList(source, 1);
  assert.deepEqual(next, [source[0], source[2]]);
  assert.deepEqual(source, makeList(), "source untouched");
});

test("removeAspectFromList: removes the first and the last element", () => {
  const source = makeList();
  assert.deepEqual(removeAspectFromList(source, 0), [source[1], source[2]]);
  assert.deepEqual(removeAspectFromList(source, 2), [source[0], source[1]]);
});

test("removeAspectFromList: removed element keeps its unknown fields", () => {
  const next = removeAspectFromList(makeList(), 1);
  assert.equal(next.length, 2);
  assert.equal(next[1].name, "Bribed guard (Goblin)");
  assert.deepEqual(next, [
    { name: "Fire", free_invokes: 2, linked: "actor-1" },
    { name: "Bribed guard (Goblin)", free_invokes: 1 },
  ]);
});

test("removeAspectFromList: invalid list or index yields null", () => {
  const list = makeList();
  assert.equal(removeAspectFromList(list, -1), null);
  assert.equal(removeAspectFromList(list, 3), null);
  assert.equal(removeAspectFromList(list, 2.5), null);
  assert.equal(removeAspectFromList([], 0), null);
  assert.equal(removeAspectFromList(null, 0), null);
});

/* ------------------------------------------------------------------ *
 * saAspectMenuItems (pure builder)
 * ------------------------------------------------------------------ */

test("saAspectMenuItems: layout, icons and separator position", () => {
  const items = saAspectMenuItems({ freeInvokes: 2 });
  assert.equal(items.length, 5);
  assert.deepEqual(
    items.map((i) => i.icon),
    ["fa-plus", "fa-minus", "", "fa-pen", "fa-trash"],
  );
  assert.equal(items[2].sep, true, "third entry is the separator");
  assert.ok(items.slice(0, 2).concat(items.slice(3)).every((i) => !i.sep));
});

test("saAspectMenuItems: labels pass through verbatim", () => {
  const items = saAspectMenuItems({
    freeInvokes: 1,
    labels: {
      addInvoke: "A",
      removeInvoke: "R",
      edit: "E",
      delete: "D",
    },
  });
  assert.deepEqual(
    items.map((i) => i.label),
    ["A", "R", "", "E", "D"],
  );
});

test("saAspectMenuItems: remove invoke is DISABLED at zero free invokes", () => {
  const items = saAspectMenuItems({ freeInvokes: 0 });
  assert.equal(items[1].disabled, true);
  assert.equal(items[0].disabled, undefined);
  assert.equal(items[3].disabled, undefined);
  assert.equal(items[4].disabled, undefined);
});

test("saAspectMenuItems: remove invoke is enabled above zero", () => {
  const items = saAspectMenuItems({ freeInvokes: 2 });
  assert.notEqual(items[1].disabled, true);
  const fractional = saAspectMenuItems({ freeInvokes: 0.5 });
  assert.notEqual(fractional[1].disabled, true);
});

test("saAspectMenuItems: handlers are wired to their items", async () => {
  let calls = [];
  const items = saAspectMenuItems({
    freeInvokes: 0,
    handlers: {
      addInvoke: () => calls.push("add"),
      removeInvoke: () => calls.push("remove"),
      edit: () => calls.push("edit"),
      delete: () => calls.push("delete"),
    },
  });
  for (const idx of [0, 2, 3, 4]) await items[idx].onClick?.();
  assert.deepEqual(calls, ["add", "edit", "delete"]);
  // Disabled item keeps its handler (the renderer enforces the guard).
  assert.equal(typeof items[1].onClick, "function");
  await items[1].onClick();
  assert.deepEqual(calls, ["add", "edit", "delete", "remove"]);
});

/* ------------------------------------------------------------------ *
 * saWidgetMenuItems (pure builder)
 * ------------------------------------------------------------------ */

test("saWidgetMenuItems: layout, icons and separator", () => {
  const items = saWidgetMenuItems({});
  assert.equal(items.length, 4);
  assert.deepEqual(
    items.map((i) => i.icon),
    ["fa-list-ul", "fa-plus", "", "fa-trash"],
  );
  assert.equal(items[2].sep, true);
  assert.deepEqual(
    items.map((i) => i.disabled ?? false),
    [false, false, false, false],
  );
});

test("saWidgetMenuItems: remove widget disabled without a placed widget", () => {
  const items = saWidgetMenuItems({ widgetPlaced: false });
  assert.equal(items[3].disabled, true);
  const ok = saWidgetMenuItems({ widgetPlaced: true });
  assert.notEqual(ok[3].disabled, true);
});

test("saWidgetMenuItems: handlers are wired to their items", async () => {
  const calls = [];
  const items = saWidgetMenuItems({
    handlers: {
      openManager: () => calls.push("open"),
      addAspect: () => calls.push("add"),
      removeWidget: () => calls.push("remove"),
    },
  });
  await items[0].onClick?.();
  await items[1].onClick?.();
  await items[3].onClick?.();
  assert.deepEqual(calls, ["open", "add", "remove"]);
});

/* ------------------------------------------------------------------ *
 * adjustInvokes / removeAspectAt (GM-guarded scene operations)
 * ------------------------------------------------------------------ */

test("adjustInvokes: GM writes the mutated list to the scene flag", async () => {
  installGame(true);
  const scene = sceneWithAspects(makeList());
  const result = await adjustInvokes(scene, 0, +1);
  assert.equal(result, true);
  const stored = storedList(scene);
  assert.equal(stored[0].free_invokes, 3);
  assert.equal(stored[0].linked, "actor-1");
  assert.equal(stored[1].free_invokes, 0);
  assert.equal(scene.setFlagCalls.length, 1, "exactly one setFlag commit");
  assert.equal(scene.setFlagCalls[0].scope, SITUATION_ASPECTS_SCOPE);
  assert.equal(scene.setFlagCalls[0].key, SITUATION_ASPECTS_KEY);
});

test("adjustInvokes: down-clamped result is persisted", async () => {
  installGame(true);
  const scene = sceneWithAspects(makeList());
  await adjustInvokes(scene, 2, -1);
  assert.equal(storedList(scene)[2].free_invokes, 0);
});

test("adjustInvokes: non-GM users never touch the flag", async () => {
  installGame(false);
  const scene = sceneWithAspects(makeList());
  const snapshot = structuredClone(scene.flags);
  assert.equal(await adjustInvokes(scene, 0, +1), false);
  assert.deepEqual(scene.flags, snapshot);
  assert.equal(scene.setFlagCalls.length, 0);
});

test("adjustInvokes: out-of-range index is a no-op", async () => {
  installGame(true);
  const scene = sceneWithAspects(makeList());
  const snapshot = structuredClone(scene.flags);
  assert.equal(await adjustInvokes(scene, 42, +1), false);
  assert.equal(await adjustInvokes(scene, -1, +1), false);
  assert.deepEqual(scene.flags, snapshot);
});

test("adjustInvokes: missing scene yields false", async () => {
  installGame(true);
  assert.equal(await adjustInvokes(null, 0, +1), false);
  assert.equal(await adjustInvokes(undefined, 0, +1), false);
});

test("removeAspectAt: GM removes the middle aspect and persists", async () => {
  installGame(true);
  const scene = sceneWithAspects(makeList());
  const result = await removeAspectAt(scene, 1);
  assert.equal(result, true);
  const stored = storedList(scene);
  assert.deepEqual(
    stored.map((a) => a.name),
    ["Fire", "Bribed guard (Goblin)"],
  );
  assert.equal(stored[0].free_invokes, 2, "other rows unchanged");
});

test("removeAspectAt: removes the first and the last aspect", async () => {
  installGame(true);
  const scene = sceneWithAspects(makeList());
  await removeAspectAt(scene, 0);
  assert.deepEqual(
    storedList(scene).map((a) => a.name),
    ["Dark corridor", "Bribed guard (Goblin)"],
  );
  const scene2 = sceneWithAspects(makeList());
  await removeAspectAt(scene2, 2);
  assert.deepEqual(
    storedList(scene2).map((a) => a.name),
    ["Fire", "Dark corridor"],
  );
});

test("removeAspectAt: invalid index or non-GM leaves the flag untouched", async () => {
  installGame(true);
  const scene = sceneWithAspects(makeList());
  const snapshot = structuredClone(scene.flags);
  assert.equal(await removeAspectAt(scene, 9), false);
  assert.deepEqual(scene.flags, snapshot);

  installGame(false);
  const scene2 = sceneWithAspects(makeList());
  const snapshot2 = structuredClone(scene2.flags);
  assert.equal(await removeAspectAt(scene2, 0), false);
  assert.deepEqual(scene2.flags, snapshot2);
  assert.equal(scene2.setFlagCalls.length, 0);
});
