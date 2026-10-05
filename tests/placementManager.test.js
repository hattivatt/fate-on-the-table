/**
 * Contract tests for `PlacementManager.placeGroup` — the generic placement flow
 * that both actor widgets and the GM/conflict tooling share.
 *
 * Regression (review finding): `placeGroup` destructured `successKey` but never
 * forwarded it to the `PlacementManager` constructor, so every custom success
 * notification (e.g. `conflict.zone.placeSuccess`) silently fell back to the
 * default key. These tests drive the REAL `placeGroup` (only `run()` is
 * stubbed to skip the interactive PIXI loop) and assert the value reaches the
 * constructed manager and the success notification.
 */

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { MODULE_ID } from "../scripts/constants.js";

// The import chain pulls `settings` -> `LayoutImportExport`, which extends
// `foundry.applications.api.ApplicationV2` at module scope; install the minimal
// stub BEFORE the dynamic import (same shape as conflictInteractions.test.js).
globalThis.foundry = {
  applications: { api: { ApplicationV2: class ApplicationV2 {} } },
  utils: {
    randomID: () => "widget-id",
    getProperty: (obj, path) => {
      let t = obj;
      for (const key of String(path).split(".")) {
        if (t == null) return undefined;
        t = t[key];
      }
      return t;
    },
    htmlToText: (value) => String(value ?? ""),
  },
};

const { PlacementManager } = await import("../scripts/PlacementManager.js");

/** Installs the globals `placeGroup` reads and returns captured notifications. */
function installGlobals() {
  const info = [];
  globalThis.ui = {
    notifications: { info: (msg) => info.push(msg), warn() {}, error() {} },
  };
  globalThis.game = { user: { isGM: true }, i18n: { localize: (key) => key } };
  globalThis.canvas = { ready: true, scene: { id: "scene1" } };
  return info;
}

afterEach(() => {
  delete globalThis.ui;
  delete globalThis.game;
  delete globalThis.canvas;
});

/** Runs `placeGroup` with `run()` stubbed; returns the constructed manager. */
async function placeWithStubbedRun(cfg) {
  const originalRun = PlacementManager.prototype.run;
  let captured = null;
  PlacementManager.prototype.run = function () {
    captured = this;
    return Promise.resolve(cfg.runResult ?? { x: 12, y: 34 });
  };
  try {
    await PlacementManager.placeGroup(cfg);
  } finally {
    PlacementManager.prototype.run = originalRun;
  }
  return captured;
}

test("placeGroup forwards a custom successKey to the manager", async () => {
  const info = installGlobals();
  let committed = false;
  const manager = await placeWithStubbedRun({
    docs: [],
    bounds: { x: 0, y: 0, width: 10, height: 10 },
    label: "Zone",
    options: {},
    hintKey: "conflict.zone.placeHint",
    successKey: "conflict.zone.placeSuccess",
    commit: async () => {
      committed = true;
    },
  });

  assert.ok(manager, "a manager instance was constructed");
  assert.equal(manager.successKey, "conflict.zone.placeSuccess");
  assert.equal(committed, true, "the commit callback ran");
  assert.deepEqual(info, ["conflict.zone.placeSuccess"]);
});

test("placeGroup keeps the default success key when cfg omits it", async () => {
  installGlobals();
  const manager = await placeWithStubbedRun({
    docs: [],
    bounds: {},
    label: "Actor",
    options: {},
    hintKey: "placeOnTable.hint",
    commit: async () => {},
    runResult: null, // cancelled before commit
  });

  assert.ok(manager);
  assert.equal(manager.successKey, `${MODULE_ID}.placement.success`);
});
