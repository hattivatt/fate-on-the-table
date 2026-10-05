/**
 * Node tests for challengeContestInteractions.js.
 *
 * The pure menu builders and the immutable state helpers are covered here.
 * The glue is exercised through a fake Drawing document whose `parent` scene
 * records the embedded updates/deletes, so the merged-flags / derived-text /
 * delete-group contracts are asserted without any Foundry runtime.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  challengeStateOf,
  contestStateOf,
  findChallengeStateCarrier,
  resolveChallengeState,
  buildChallengeMenuItems,
  buildContestMenuItems,
  handleChallengeContestContextMenu,
} from "../scripts/challengeContestInteractions.js";
import { FLAG_SCOPE } from "../scripts/constants.js";
import { closeCttMenu } from "../scripts/menu.js";

/** Fake scene recording every embedded write, with a group of documents. */
function makeScene() {
  return {
    drawings: [],
    tiles: [],
    updates: [],
    created: [],
    deleted: [],
    async updateEmbeddedDocuments(name, updates, options) {
      this.updates.push({ name, updates, options });
      return [];
    },
    async createEmbeddedDocuments(name, docs, options) {
      this.created.push({ name, docs, options });
      return docs;
    },
    async deleteEmbeddedDocuments(name, ids, options) {
      this.deleted.push({ name, ids, options });
      return ids;
    },
  };
}

/**
 * Fake Drawing doc (plain `{ getFlag }` shape) registered in `scene.drawings`.
 * Geometry/style fields let the menu builders read a realistic row.
 */
function makeDoc(scopeFlags, extraFlags = {}, { scene, id = "draw-1" } = {}) {
  const parent = scene ?? makeScene();
  const flags = {
    ...extraFlags,
    [FLAG_SCOPE]: scopeFlags,
  };
  const doc = {
    id,
    flags,
    parent,
    x: 0,
    y: 0,
    shape: { width: 500, height: 90 },
    fontSize: 40,
    textColor: "#000000",
    fontFamily: "Montserrat",
    elevation: 0,
    sort: 0,
    getFlag(scope, key) {
      return flags[scope]?.[key];
    },
  };
  parent.drawings.push(doc);
  return doc;
}

function challengeDoc(tasks, opts = {}) {
  return makeDoc({ widgetId: "w1", ownerType: "challenge", tasks }, {}, opts);
}

function contestDoc(sides) {
  return makeDoc({ widgetId: "w2", ownerType: "contest", sides });
}

/** A legacy challenge row Drawing carrying only its identity flags. */
function challengeRow(scene, { index, id }) {
  return makeDoc(
    { widgetId: "w1", ownerType: "challenge", part: "taskRow", index },
    {},
    { scene, id: id ?? `taskRow-${index}` },
  );
}

/** Stubs the lazy DialogV2.confirm access used by "Delete block". */
function installDialogConfirm(value) {
  const prev = globalThis.foundry;
  globalThis.foundry = {
    applications: { api: { DialogV2: { confirm: async () => value } } },
  };
  return {
    restore() {
      if (prev === undefined) delete globalThis.foundry;
      else globalThis.foundry = prev;
    },
  };
}

function withGm(fn) {
  const prev = globalThis.game;
  globalThis.game = { user: { isGM: true }, i18n: { localize: (k) => k } };
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (prev === undefined) delete globalThis.game;
      else globalThis.game = prev;
    });
}

/* ------------------------------------------------------------------ *
 * State readers
 * ------------------------------------------------------------------ */

test("challengeStateOf / contestStateOf return copies and tolerate garbage", () => {
  const doc = challengeDoc([{ text: "A", difficulty: 1, status: "pending" }]);
  const tasks = challengeStateOf(doc);
  assert.deepEqual(tasks, [{ text: "A", difficulty: 1, status: "pending" }]);
  assert.notEqual(tasks[0], doc.getFlag(FLAG_SCOPE, "tasks")[0], "copy");

  assert.deepEqual(contestStateOf(doc), []);
  assert.deepEqual(challengeStateOf(null), []);
  assert.deepEqual(contestStateOf({}), []);
});

/* ------------------------------------------------------------------ *
 * Challenge menu
 * ------------------------------------------------------------------ */

test("buildChallengeMenuItems: marks, icons, iconColor and status submenu", () => {
  const doc = challengeDoc([
    { text: "Open", difficulty: 1, status: "pending" },
    { text: "Won", difficulty: 3, status: "success" },
    { text: "Lost", difficulty: 4, status: "failed" },
  ]);
  const items = buildChallengeMenuItems(doc);
  // One item per task + separator + delete block.
  assert.equal(items.length, 5);
  assert.equal(items[3].sep, true);
  assert.equal(items[4].icon, "fa-trash");

  assert.equal(items[0].icon, "fa-minus");
  assert.equal(items[0].label, "Open +1");
  assert.equal(items[0].iconColor, undefined);
  assert.equal(items[1].icon, "fa-check");
  assert.equal(items[1].label, "✅ Won +3");
  assert.equal(items[1].iconColor, "#2e7d32");
  assert.equal(items[2].icon, "fa-xmark");
  assert.equal(items[2].label, "❌ Lost +4");
  assert.equal(items[2].iconColor, "#c62828");

  for (const item of items.slice(0, 3)) {
    assert.equal(item.children.length, 3);
    assert.equal(item.children[0].label, "Success");
    assert.equal(item.children[1].label, "Failed");
    assert.equal(item.children[2].label, "Reset");
    assert.equal(item.children[0].iconColor, "#2e7d32");
    assert.equal(item.children[1].iconColor, "#c62828");
    assert.equal(item.children[2].iconColor, undefined);
  }
  // The currently-set status option is disabled.
  assert.equal(items[0].children[0].disabled, false);
  assert.equal(items[0].children[1].disabled, false);
  assert.equal(items[0].children[2].disabled, true, "pending -> reset disabled");
  assert.equal(items[1].children[0].disabled, true, "success -> disabled");
  assert.equal(items[1].children[2].disabled, false, "success -> reset enabled");
  assert.equal(items[2].children[1].disabled, true, "failed -> disabled");

  // Localized labels override the defaults.
  const localized = buildChallengeMenuItems(doc, doc.parent, {
    success: "Успешна",
    failed: "Провалена",
    reset: "Сбросить",
    removeBlock: "Удалить блок",
  });
  assert.equal(localized[0].children[0].label, "Успешна");
  assert.equal(localized[0].children[1].label, "Провалена");
  assert.equal(localized[0].children[2].label, "Сбросить");
  assert.equal(localized[4].label, "Удалить блок");
});

test("challenge menu onClick: sets status, derives text, preserves ADT flags", async () => {
  const scene = makeScene();
  const carrier = challengeDoc(
    [
      { text: "A", difficulty: 1, status: "pending" },
      { text: "B", difficulty: 2, status: "pending" },
    ],
    { scene, id: "row-0" },
  );
  // Legacy ADT flags must survive the state merge.
  carrier.flags.adt = { dropShadow: false };
  carrier.flags["advanced-drawing-tools"] = { textStyle: { dropShadow: false } };

  await buildChallengeMenuItems(carrier, scene)[1].children[0].onClick();

  assert.equal(scene.updates.length, 1);
  const [{ name, updates, options }] = scene.updates;
  assert.equal(name, "Drawing");
  assert.equal(options.fateOnTheTableSync, true);
  assert.equal(updates.length, 1, "one embedded update for the single drawing");
  assert.equal(updates[0]._id, "row-0");
  assert.equal(updates[0].text, "A +1\n\n✅ B +2");
  assert.deepEqual(updates[0].flags[FLAG_SCOPE].tasks, [
    { text: "A", difficulty: 1, status: "pending" },
    { text: "B", difficulty: 2, status: "success" },
  ]);
  assert.deepEqual(updates[0].flags.adt, { dropShadow: false });
  assert.deepEqual(updates[0].flags["advanced-drawing-tools"], {
    textStyle: { dropShadow: false },
  });
  // No strike overlay drawings are ever created or deleted.
  assert.equal(scene.created.length, 0);
  assert.equal(scene.deleted.length, 0);
});

test("challenge menu onClick: failed and reset derive the matching mark", async () => {
  const scene = makeScene();
  const doc = challengeDoc([{ text: "A", difficulty: 1, status: "pending" }], {
    scene,
    id: "row-0",
  });
  await buildChallengeMenuItems(doc, scene)[0].children[1].onClick(); // failed
  assert.equal(scene.updates[0].updates[0].text, "❌ A +1");
  assert.deepEqual(scene.updates[0].updates[0].flags[FLAG_SCOPE].tasks, [
    { text: "A", difficulty: 1, status: "failed" },
  ]);

  const scene2 = makeScene();
  const doc2 = challengeDoc([{ text: "A", difficulty: 1, status: "success" }], {
    scene: scene2,
    id: "row-0",
  });
  await buildChallengeMenuItems(doc2, scene2)[0].children[2].onClick(); // reset
  assert.equal(scene2.updates[0].updates[0].text, "A +1");
  assert.deepEqual(scene2.updates[0].updates[0].flags[FLAG_SCOPE].tasks, [
    { text: "A", difficulty: 1, status: "pending" },
  ]);
});

test("challenge menu onClick: legacy done boolean renders a check on first set", async () => {
  const scene = makeScene();
  const doc = makeDoc(
    {
      widgetId: "w1",
      ownerType: "challenge",
      tasks: [{ text: "A", difficulty: 1, done: true }],
    },
    {},
    { scene, id: "row-0" },
  );
  // The menu renders the legacy task as success...
  const items = buildChallengeMenuItems(doc, scene);
  assert.equal(items[0].label, "✅ A +1");
  // ...and resetting it drops the mark.
  await items[0].children[2].onClick();
  assert.equal(scene.updates[0].updates[0].text, "A +1");
  assert.deepEqual(scene.updates[0].updates[0].flags[FLAG_SCOPE].tasks, [
    { text: "A", difficulty: 1, status: "pending" },
  ]);
});

test("challenge menu onClick: invalid index / empty menu is a no-op", async () => {
  const doc = makeDoc({ widgetId: "w", ownerType: "challenge", tasks: [] });
  const items = buildChallengeMenuItems(doc);
  assert.deepEqual(items, []);
  assert.equal(doc.parent.updates.length, 0);
});

test("challenge menu: normalized index sets the VISIBLE task, not a hidden blank row", async () => {
  const doc = makeDoc({
    widgetId: "w1",
    ownerType: "challenge",
    tasks: [
      { text: "", difficulty: 1, status: "pending" }, // dropped by normalization
      { text: "A", difficulty: 2, status: "pending" }, // visible item, normalized index 0
    ],
  });
  const items = buildChallengeMenuItems(doc);
  assert.equal(items.length, 3, "blank row is not shown (task + sep + delete)");
  assert.equal(items[0].label, "A +2");

  await items[0].children[0].onClick();
  const update = doc.parent.updates[0].updates[0];
  assert.deepEqual(update.flags[FLAG_SCOPE].tasks, [
    { text: "A", difficulty: 2, status: "success" },
  ]);
  assert.equal(update.text, "✅ A +2");
});

/* ------------------------------------------------------------------ *
 * State resolution from a legacy sibling row
 * ------------------------------------------------------------------ */

test("findChallengeStateCarrier: the single drawing is its own carrier", () => {
  const scene = makeScene();
  const carrier = challengeDoc([{ text: "A", difficulty: 1, status: "pending" }], {
    scene,
    id: "row-0",
  });
  assert.equal(findChallengeStateCarrier(scene, carrier), carrier);
  assert.deepEqual(resolveChallengeState(scene, carrier), [
    { text: "A", difficulty: 1, status: "pending" },
  ]);
  assert.equal(findChallengeStateCarrier(scene, { getFlag: () => undefined }), null);
});

test("findChallengeStateCarrier: a legacy row resolves the index-0 sibling", () => {
  const scene = makeScene();
  const carrier = makeDoc(
    {
      widgetId: "w1",
      ownerType: "challenge",
      part: "taskRow",
      index: 0,
      tasks: [{ text: "A", difficulty: 1, status: "pending" }],
    },
    {},
    { scene, id: "row-0" },
  );
  const row1 = challengeRow(scene, { index: 1, id: "row-1" });

  assert.equal(findChallengeStateCarrier(scene, row1), carrier);
  assert.deepEqual(resolveChallengeState(scene, row1), [
    { text: "A", difficulty: 1, status: "pending" },
  ]);
  assert.equal(buildChallengeMenuItems(row1, scene)[0].label, "A +1");
});

test("legacy multi-drawing block: setting status updates the task row text", async () => {
  const scene = makeScene();
  const carrier = makeDoc(
    {
      widgetId: "w1",
      ownerType: "challenge",
      part: "taskRow",
      index: 0,
      tasks: [
        { text: "A", difficulty: 1, status: "pending" },
        { text: "B", difficulty: 2, status: "pending" },
      ],
    },
    {},
    { scene, id: "row-0" },
  );
  const row1 = challengeRow(scene, { index: 1, id: "row-1" });

  const items = buildChallengeMenuItems(row1, scene);
  assert.equal(items.length, 4, "two tasks + separator + delete block");
  await items[1].children[0].onClick(); // success on B

  assert.equal(scene.updates.length, 1);
  const updates = scene.updates[0].updates;
  const carrierUpdate = updates.find((u) => u._id === "row-0");
  assert.deepEqual(carrierUpdate.flags[FLAG_SCOPE].tasks, [
    { text: "A", difficulty: 1, status: "pending" },
    { text: "B", difficulty: 2, status: "success" },
  ]);
  assert.equal(carrierUpdate.text, undefined, "carrier row text is untouched");
  const rowUpdate = updates.find((u) => u._id === "row-1");
  assert.equal(rowUpdate.text, "✅ B +2");
  assert.equal(scene.created.length, 0, "no strike overlay");
  assert.equal(scene.deleted.length, 0);
});

/* ------------------------------------------------------------------ *
 * Delete block
 * ------------------------------------------------------------------ */

test("challenge 'Delete block' confirms then deletes every group drawing", async () => {
  await withGm(async () => {
    const scene = makeScene();
    const doc = challengeDoc([{ text: "A", difficulty: 1, status: "pending" }], {
      scene,
      id: "row-0",
    });
    challengeRow(scene, { index: 1, id: "row-1" }); // legacy sibling
    const dialog = installDialogConfirm(true);
    try {
      const items = buildChallengeMenuItems(doc, scene);
      const remove = items[items.length - 1];
      await remove.onClick();
      assert.equal(scene.deleted.length, 1);
      assert.equal(scene.deleted[0].name, "Drawing");
      assert.deepEqual([...scene.deleted[0].ids].sort(), ["row-0", "row-1"]);
      assert.equal(scene.deleted[0].options.fateOnTheTableSync, true);
    } finally {
      dialog.restore();
    }
  });
});

test("contest 'Delete block' is cancelled by the confirm dialog", async () => {
  await withGm(async () => {
    const scene = makeScene();
    const doc = contestDoc([{ name: "S", boxes: 2, done: 0 }]);
    // Re-parent the contest doc onto the recording scene.
    doc.parent = scene;
    scene.drawings.push(doc);
    const dialog = installDialogConfirm(false);
    try {
      const items = buildContestMenuItems(doc, {}, scene);
      const remove = items[items.length - 1];
      await remove.onClick();
      assert.equal(scene.deleted.length, 0);
    } finally {
      dialog.restore();
    }
  });
});

/* ------------------------------------------------------------------ *
 * Context-menu handler (GM-only, empty menu must not consume)
 * ------------------------------------------------------------------ */

/** Minimal browser stub just rich enough for menu.js to render a menu. */
function installDomStub() {
  class El {
    constructor(tag) {
      this.tagName = String(tag).toUpperCase();
      this.children = [];
      this.listeners = {};
      this.style = {};
      this.className = "";
      this.classList = { add() {}, remove() {} };
      this.innerHTML = "";
      this.type = "";
      this.disabled = false;
      this.parentNode = null;
    }
    append(...nodes) {
      for (const node of nodes) {
        node.parentNode = this;
        this.children.push(node);
      }
    }
    addEventListener(type, fn) {
      (this.listeners[type] ??= []).push(fn);
    }
    removeEventListener(type, fn) {
      this.listeners[type] = (this.listeners[type] ?? []).filter((f) => f !== fn);
    }
    get childElementCount() {
      return this.children.length;
    }
    getBoundingClientRect() {
      return { width: 120, height: 40, left: 0, top: 0, right: 120, bottom: 40 };
    }
    contains() {
      return false;
    }
    remove() {
      this.parentNode = null;
    }
  }
  const body = new El("body");
  globalThis.document = { createElement: (tag) => new El(tag), body };
  globalThis.window = {
    innerWidth: 1000,
    innerHeight: 800,
    addEventListener() {},
    removeEventListener() {},
  };
  return {
    restore() {
      delete globalThis.document;
      delete globalThis.window;
    },
  };
}

test("handleChallengeContestContextMenu: empty menu returns false and does NOT consume the event", async () => {
  await withGm(async () => {
    const consumed = [];
    const event = {
      preventDefault: () => consumed.push("preventDefault"),
      stopPropagation: () => consumed.push("stopPropagation"),
    };
    const doc = challengeDoc([]);
    assert.equal(await handleChallengeContestContextMenu(doc, event), false);
    assert.deepEqual(consumed, [], "native context menu must survive an empty menu");
  });
});

test("handleChallengeContestContextMenu: a shown menu consumes the event and returns true", async () => {
  const { restore } = installDomStub();
  try {
    await withGm(async () => {
      const consumed = [];
      const event = {
        clientX: 10,
        clientY: 20,
        preventDefault: () => consumed.push("preventDefault"),
        stopPropagation: () => consumed.push("stopPropagation"),
      };
      const doc = challengeDoc([{ text: "A", difficulty: 1, status: "pending" }]);
      assert.equal(await handleChallengeContestContextMenu(doc, event), true);
      assert.deepEqual(consumed, ["preventDefault", "stopPropagation"]);
      closeCttMenu();
    });
  } finally {
    restore();
  }
});

/* ------------------------------------------------------------------ *
 * Contest menu
 * ------------------------------------------------------------------ */

test("buildContestMenuItems: parent enabled, boundary child options disabled", () => {
  const doc = contestDoc([
    { name: "Heroes", boxes: 3, done: 0 },
    { name: "Villains", boxes: 3, done: 3 },
  ]);
  const items = buildContestMenuItems(doc);
  // Two sides + separator + delete block.
  assert.equal(items.length, 4);
  assert.equal(items[2].sep, true);
  assert.equal(items[3].icon, "fa-trash");

  // Parent must NOT be disabled (menu.js only opens submenus for enabled items).
  assert.equal(items[0].disabled, undefined);
  assert.equal(items[0].label, "Heroes");
  assert.equal(items[0].children.length, 2);
  assert.equal(items[0].children[0].label, "Advance forward");
  assert.equal(items[0].children[1].label, "Advance back");
  // Heroes at done 0: forward allowed, back disabled.
  assert.equal(items[0].children[0].disabled, false);
  assert.equal(items[0].children[1].disabled, true);

  // Villains at done == boxes: forward disabled, back allowed.
  assert.equal(items[1].children[0].disabled, true);
  assert.equal(items[1].children[1].disabled, false);
});

test("buildContestMenuItems: localized child labels are used", () => {
  const doc = contestDoc([{ name: "S", boxes: 2, done: 1 }]);
  const items = buildContestMenuItems(doc, {
    advanceForward: "FW",
    advanceBack: "BW",
    removeBlock: "RB",
  });
  assert.equal(items[0].children[0].label, "FW");
  assert.equal(items[0].children[1].label, "BW");
  assert.equal(items[2].label, "RB");
});

test("contest menu forward/back onClick: clamped state + derived text", async () => {
  const doc = contestDoc([{ name: "S", boxes: 2, done: 1 }]);
  await buildContestMenuItems(doc)[0].children[0].onClick();
  let update = doc.parent.updates[0].updates[0];
  assert.equal(update.text, "S: [ X ][ X ]");
  assert.deepEqual(update.flags[FLAG_SCOPE].sides, [
    { name: "S", boxes: 2, done: 2 },
  ]);

  const doc2 = contestDoc([{ name: "S", boxes: 2, done: 1 }]);
  await buildContestMenuItems(doc2)[0].children[1].onClick();
  update = doc2.parent.updates[0].updates[0];
  assert.equal(update.text, "S: [   ][   ]");
  assert.deepEqual(update.flags[FLAG_SCOPE].sides, [
    { name: "S", boxes: 2, done: 0 },
  ]);
});
