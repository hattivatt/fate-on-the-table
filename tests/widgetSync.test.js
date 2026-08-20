/**
 * Node tests for WidgetSync.js module-owned stale consequence CHECKBOX
 * cleanup (`cleanupStaleConsequenceBoxes`). Consequences are text COST rows
 * now (no interactive checkbox Drawing), so a leftover `consequenceBoxRows`
 * part (or a legacy `consequences` `[ ]`/`[X]` text row) left by an older
 * module version must be removed when an actor on a scene is synced /
 * reconciled, while conflict-card docs and foreign drawings are preserved.
 *
 * The tested function is called at the top of `syncActor`, which both the
 * debounced `updateActor` hook and `reconcileScene` route through, so these
 * tests exercise the exact identity flags the runtime cleanup uses.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { FLAG_SCOPE } from "../scripts/constants.js";

// WidgetSync pulls in settings.js which imports LayoutImportExport (a
// Foundry ApplicationV2 subclass) at module top level, so provide the
// minimal Foundry runtime stubs before importing it.
globalThis.foundry = {
  applications: { api: { ApplicationV2: class {} } },
  utils: { duplicate: (v) => structuredClone(v) },
};
globalThis.CONST = {
  DOCUMENT_OWNERSHIP_LEVELS: { OWNER: 2 },
  DRAWING_TYPES: { RECTANGLE: 1 },
};
globalThis.CONFIG = { tileMappings: {} };
const { cleanupStaleConsequenceBoxes } = await import("../scripts/WidgetSync.js");

function mockDoc(id, documentName, flags, extra = {}) {
  return {
    id,
    documentName,
    text: extra.text ?? "",
    texture: extra.texture ?? null,
    getFlag(scope, key) {
      return flags[scope]?.[key];
    },
  };
}

function mockScene({ drawings = [], tiles = [] } = {}) {
  return {
    id: "scene1",
    drawings: [...drawings],
    tiles: [...tiles],
    deleted: { Drawing: [], Tile: [] },
    async deleteEmbeddedDocuments(kind, ids) {
      this.deleted[kind].push(...ids);
      const arr = kind === "Drawing" ? this.drawings : this.tiles;
      for (const id of ids ?? []) {
        const i = arr.findIndex((x) => x.id === id);
        assert.ok(i >= 0, `deleteEmbeddedDocuments("${kind}") referenced missing id "${id}"`);
        arr.splice(i, 1);
      }
      return this;
    },
  };
}

/** A module-owned Drawing of an ordinary actor widget. */
function actorDoc(id, part, flagsExtra = {}) {
  return mockDoc(id, "Drawing", {
    [FLAG_SCOPE]: {
      widgetId: "w1",
      actorUuid: "Actor.abc",
      part,
      index: 0,
      ...flagsExtra,
    },
  });
}

const actor = { uuid: "Actor.abc" };

test("cleanupStaleConsequenceBoxes removes a stale consequenceBoxRows box of the actor", async () => {
  const box = actorDoc("dBox", "consequenceBoxRows");
  const name = actorDoc("dName", "name");
  const scene = mockScene({ drawings: [box, name] });
  await cleanupStaleConsequenceBoxes(scene, actor);
  assert.deepEqual(scene.deleted.Drawing, ["dBox"]);
  assert.equal(scene.drawings.some((d) => d.id === "dBox"), false);
  assert.equal(scene.drawings.some((d) => d.id === "dName"), true, "non-checkbox parts preserved");
});

test("cleanupStaleConsequenceBoxes removes a legacy [ ]/[X] consequences text row", async () => {
  const legacy = mockDoc("dLegacy", "Drawing", {
    [FLAG_SCOPE]: { widgetId: "w1", actorUuid: "Actor.abc", part: "consequences", index: 0 },
  }, { text: "[X] Broken leg" });
  const scene = mockScene({ drawings: [legacy] });
  await cleanupStaleConsequenceBoxes(scene, actor);
  assert.deepEqual(scene.deleted.Drawing, ["dLegacy"]);
});

test("cleanupStaleConsequenceBoxes does NOT remove a non-marker consequences row", async () => {
  // A plain (name-only, no checkbox bracket) consequences row is not the old
  // checkbox/name form and is left alone.
  const plain = mockDoc("dPlain", "Drawing", {
    [FLAG_SCOPE]: { widgetId: "w1", actorUuid: "Actor.abc", part: "consequences", index: 0 },
  }, { text: "Broken leg" });
  const scene = mockScene({ drawings: [plain] });
  await cleanupStaleConsequenceBoxes(scene, actor);
  assert.deepEqual(scene.deleted.Drawing, []);
  assert.equal(scene.drawings.some((d) => d.id === "dPlain"), true);
});

test("cleanupStaleConsequenceBoxes does not touch conflict-card or foreign docs", async () => {
  const conflictCard = mockDoc("dCard", "Drawing", {
    [FLAG_SCOPE]: {
      widgetId: "wCard",
      ownerType: "conflictCard",
      part: "consequenceBoxRows",
      actorUuid: "Actor.abc", // a card carries the linked actorUuid too
      index: 0,
    },
  });
  const conflictZone = mockDoc("dZone", "Drawing", {
    [FLAG_SCOPE]: { widgetId: "wZone", ownerType: "conflictZone", part: "consequenceBoxRows", actorUuid: "Actor.abc", index: 0 },
  });
  const conflictBoard = mockDoc("dBoard", "Drawing", {
    [FLAG_SCOPE]: { widgetId: "wBoard", ownerType: "conflictBoard", part: "consequenceBoxRows", actorUuid: "Actor.abc", index: 0 },
  });
  // A foreign drawing: same part string but no module identity flag.
  const foreign = mockDoc("dForeign", "Drawing", {}, { text: "consequence" });
  // A different actor's consequence box.
  const otherActor = actorDoc("dOther", "consequenceBoxRows");
  otherActor.getFlag = (scope, key) => {
    if (scope === FLAG_SCOPE && key === "actorUuid") return "Actor.zzz";
    return undefined;
  };
  const scene = mockScene({
    drawings: [conflictCard, conflictZone, conflictBoard, foreign, otherActor],
  });
  await cleanupStaleConsequenceBoxes(scene, actor);
  assert.deepEqual(scene.deleted.Drawing, [], "no conflict/foreign/other-actor docs removed");
  assert.equal(scene.drawings.length, 5);
});

test("cleanupStaleConsequenceBoxes is a safe no-op for a missing actorUuid", async () => {
  const box = actorDoc("dBox", "consequenceBoxRows");
  const scene = mockScene({ drawings: [box] });
  await cleanupStaleConsequenceBoxes(scene, { uuid: null });
  assert.deepEqual(scene.deleted.Drawing, []);
  await cleanupStaleConsequenceBoxes(scene, null);
  assert.deepEqual(scene.deleted.Drawing, []);
});
