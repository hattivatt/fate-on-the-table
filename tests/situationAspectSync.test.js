/**
 * Node tests for SituationAspectSync.js — the situation aspects widget
 * projection. The widget keeps frame/background as single Drawing parts and
 * projects the aspect LIST as ONE TEXT DRAWING PER ASPECT
 * (`part = "situationAspectsText"`, `index` = list position), so every
 * aspect becomes an independently clickable part with its position encoded
 * in the flags.
 *
 * Covered here:
 * - per-aspect text descriptors (line format, slot geometry, placeholder);
 * - normalizeAspects preserving unknown system fields (`linked`);
 * - no registry -> nothing is ever created;
 * - legacy single-text-part widgets are migrated to per-aspect parts;
 * - deleting an aspect from the middle rebuilds the parts with correct
 *   indexes (no stale leftovers);
 * - a repeated sync without data changes is a strict no-op;
 * - a FRESH placement of the full per-aspect part set (the current
 *   placeWidget shape) is idempotent — its next sync is a strict no-op too;
 * - settings-only changes go through the delta-update path (no churn);
 * - unknown widget parts are cleaned, foreign widgets are never touched;
 * - a manually fully-deleted group clears the registry.
 *
 * Foundry globals are stubbed minimally before importing the module chain
 * (SituationAspectSync -> settings.js -> LayoutImportExport extends
 * ApplicationV2 at module top level).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FLAG_SCOPE,
  SA_OWNER_TYPE,
  SA_TEXT_PART,
  SA_FRAME_PART,
  SA_BACKGROUND_PART,
  SITUATION_ASPECTS_WIDGET_FLAG,
  SITUATION_ASPECTS_SCOPE,
  SITUATION_ASPECTS_KEY,
} from "../scripts/constants.js";

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
  syncSituationAspects,
  buildSaTextDocs,
  buildSaTextDoc,
  buildSaFrameDoc,
  buildSaBackgroundDoc,
  normalizeAspects,
} = await import("../scripts/SituationAspectSync.js");
const { toDocumentData } = await import("../scripts/WidgetBuilder.js");

/* ------------------------------------------------------------------ *
 * Mocks
 * ------------------------------------------------------------------ */

// Options equal to the module defaults produced by the settings stub below
// (every game.settings.get(...) returns undefined).
const OPTS = {
  width: 500,
  height: 800,
  fontFamily: "Montserrat",
  fontSize: 32,
  textColor: "#000000",
  backgroundTexture: "",
  backgroundColor: "#ffffff",
  backgroundAlpha: 1,
};
// Derived geometry: PIXI line height 32*1.25 = 40, slot = row + blank line.
const LINE_H = 40;
const SLOT_H = 80;

const WIDGET_ID = "sa-widget-1";
const ANCHOR = { x: 100, y: 200 };

/** Settings overrides consumed by the game stub (key -> value). */
let settingsOverrides = {};

function installGame() {
  globalThis.game = {
    user: { id: "u1" },
    i18n: { localize: (k) => k, format: (k) => k },
    settings: {
      get: (_module, key) => settingsOverrides[key],
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

function mockScene({ flags = {}, drawings = [] } = {}) {
  const scene = {
    id: "scene1",
    drawings: [...drawings],
    tiles: [],
    flags,
    calls: { create: [], update: [], delete: [], unset: [] },
    getFlag(scope, key) {
      return this.flags[scope]?.[key];
    },
    async setFlag(scope, key, value) {
      (this.flags[scope] ??= {})[key] = structuredClone(value);
      return this;
    },
    async unsetFlag(scope, key) {
      if (this.flags[scope]) delete this.flags[scope][key];
      this.calls.unset.push({ scope, key });
      return this;
    },
    async deleteEmbeddedDocuments(kind, ids) {
      this.calls.delete.push(...ids);
      const arr = kind === "Drawing" ? this.drawings : this.tiles;
      for (const id of ids ?? []) {
        const i = arr.findIndex((x) => x.id === id);
        assert.ok(i >= 0, `delete referenced missing id "${id}"`);
        arr.splice(i, 1);
      }
      return this;
    },
    async updateEmbeddedDocuments(kind, docs) {
      this.calls.update.push(...docs.map((d) => d._id));
      const arr = kind === "Drawing" ? this.drawings : this.tiles;
      for (const d of docs ?? []) {
        const target = arr.find((x) => x.id === d._id);
        assert.ok(target, `update referenced missing id "${d._id}"`);
        for (const [k, v] of Object.entries(d)) {
          if (k === "_id") continue;
          setPath(target, k, v);
        }
      }
      return this;
    },
    async createEmbeddedDocuments(kind, docs) {
      const arr = kind === "Drawing" ? this.drawings : this.tiles;
      for (const d of docs ?? []) {
        arr.push({
          id: `created-${this.calls.create.length}`,
          documentName: kind,
          ...d,
          getFlag(scope, key) {
            return d.flags?.[scope]?.[key];
          },
        });
        this.calls.create.push(d);
      }
      return this;
    },
  };
  return scene;
}

function flagOf(doc, key) {
  return doc.getFlag(FLAG_SCOPE, key);
}

function partDocs(scene, part) {
  return scene.drawings.filter((d) => flagOf(d, "part") === part);
}

/**
 * Simulates SituationAspectManager.placeWidget's commit: builds the widget
 * documents (by default the LEGACY trio with one combined-text Drawing),
 * converts them like the manager does and stores them together with the
 * scene registry.
 */
async function placeWidget(scene, rawAspects, { legacy = true } = {}) {
  // The manager persists the list BEFORE placing (source of truth first).
  withAspects(scene, rawAspects);
  const normalized = normalizeAspects(rawAspects);
  const docs = legacy
    ? [
        buildSaTextDoc(normalized, OPTS),
        buildSaFrameDoc(OPTS),
        buildSaBackgroundDoc(OPTS),
      ]
    : [
        ...buildSaTextDocs(normalized, OPTS),
        buildSaFrameDoc(OPTS),
        buildSaBackgroundDoc(OPTS),
      ];
  for (const doc of docs) {
    const payload = toDocumentData(
      { ...doc, x: doc.x + ANCHOR.x, y: doc.y + ANCHOR.y },
      {
        widgetId: WIDGET_ID,
        part: doc.part,
        index: doc.index,
        ownerType: SA_OWNER_TYPE,
      },
    );
    await scene.createEmbeddedDocuments("Drawing", [payload]);
  }
  await scene.setFlag(FLAG_SCOPE, SITUATION_ASPECTS_WIDGET_FLAG, {
    widgetId: WIDGET_ID,
    anchor: ANCHOR,
  });
}

function withAspects(scene, rawAspects) {
  scene.flags[SITUATION_ASPECTS_SCOPE] = {
    [SITUATION_ASPECTS_KEY]: structuredClone(rawAspects),
  };
}

function resetCalls(scene) {
  scene.calls.create.length = 0;
  scene.calls.update.length = 0;
  scene.calls.delete.length = 0;
}

/* ------------------------------------------------------------------ *
 * Pure builders / normalizer
 * ------------------------------------------------------------------ */

test("buildSaTextDocs renders one part per aspect with legacy line format and centered slots", () => {
  const docs = buildSaTextDocs(
    [
      { name: "Broken leg", free_invokes: 0 },
      { name: "High ground", free_invokes: 2 },
    ],
    OPTS,
  );
  assert.equal(docs.length, 2);
  // block = 2*80 - 40 = 120 -> top = (800-120)/2 = 340
  assert.deepEqual(
    docs.map((d) => [d.index, d.text]),
    [
      [0, "Broken leg (0)"],
      [1, "High ground (2)"],
    ],
  );
  assert.deepEqual(
    docs.map((d) => [d.x, d.y, d.w, d.h]),
    [
      [0, 340, 500, 80],
      [0, 420, 500, 80],
    ],
  );
  for (const d of docs) {
    assert.equal(d.part, SA_TEXT_PART);
    assert.equal(d.align, "center");
    assert.equal(d.font, OPTS.fontFamily);
    assert.equal(d.size, OPTS.fontSize);
    assert.equal(d.color, OPTS.textColor);
    assert.equal(d.fillType, CONST.DRAWING_FILL_TYPES.NONE);
    assert.equal(d.fillAlpha, 0);
  }
});

test("buildSaTextDocs keeps an empty list visible as a single near-invisible placeholder", () => {
  const docs = buildSaTextDocs([], OPTS);
  assert.equal(docs.length, 1);
  const p = docs[0];
  assert.equal(p.index, 0);
  assert.equal(p.text, "");
  assert.equal(p.w, 500);
  assert.equal(p.h, 800);
  assert.equal(p.fillType, CONST.DRAWING_FILL_TYPES.SOLID);
  assert.equal(p.fillAlpha, 0.01);
});

test("normalizeAspects preserves unknown system fields (linked) and coerces invokes", () => {
  const out = normalizeAspects([
    { name: " In the trees ", free_invokes: "2", linked: "skill.stealth" },
    null,
    { free_invokes: 5 },
    { name: "Zero", free_invokes: -3 },
  ]);
  assert.deepEqual(out, [
    { name: "In the trees", free_invokes: 2, linked: "skill.stealth" },
    { name: "Zero", free_invokes: 0 },
  ]);
});

/* ------------------------------------------------------------------ *
 * Sync
 * ------------------------------------------------------------------ */

test("without a registry record nothing is created or changed", async () => {
  installGame();
  const scene = mockScene();
  withAspects(scene, [{ name: "A", free_invokes: 1 }]);
  assert.equal(await syncSituationAspects(scene), false);
  assert.equal(scene.calls.create.length, 0);
  assert.equal(scene.drawings.length, 0);
  assert.equal(scene.calls.unset.length, 0);
});

test("legacy single-text widget migrates to one clickable part per aspect", async () => {
  installGame();
  const scene = mockScene();
  await placeWidget(scene, [
    { name: "A", free_invokes: 1 },
    { name: "B", free_invokes: 2 },
    { name: "C", free_invokes: 3 },
  ]);
  const legacyTextIds = partDocs(scene, SA_TEXT_PART).map((d) => d.id);
  assert.equal(legacyTextIds.length, 1);

  assert.equal(await syncSituationAspects(scene), true);

  // The combined-text Drawing was replaced by three per-aspect parts.
  assert.deepEqual(scene.calls.delete.sort(), legacyTextIds);
  const texts = partDocs(scene, SA_TEXT_PART);
  assert.equal(texts.length, 3);
  // block = 3*80 - 40 = 200 -> top = 300 (+anchor.y 200)
  assert.deepEqual(
    texts
      .sort((a, b) => flagOf(a, "index") - flagOf(b, "index"))
      .map((d) => ({
        index: flagOf(d, "index"),
        text: d.text,
        x: d.x,
        y: d.y,
        w: d.shape.width,
        h: d.shape.height,
      })),
    [
      { index: 0, text: "A (1)", x: 100, y: 500, w: 500, h: 80 },
      { index: 1, text: "B (2)", x: 100, y: 580, w: 500, h: 80 },
      { index: 2, text: "C (3)", x: 100, y: 660, w: 500, h: 80 },
    ],
  );
  for (const d of texts) {
    assert.equal(flagOf(d, "widgetId"), WIDGET_ID);
    assert.equal(flagOf(d, "ownerType"), SA_OWNER_TYPE);
    assert.equal(flagOf(d, "part"), SA_TEXT_PART);
    // Text stays above the background (elevation -10/sort -1000) and below
    // the frame (10/1000) — same z-order as the legacy single text part.
    assert.equal(d.elevation, 0);
    assert.equal(d.sort, 0);
  }
  // Frame/background were neither updated nor deleted.
  assert.deepEqual(scene.calls.update, []);
  assert.equal(partDocs(scene, SA_FRAME_PART).length, 1);
  assert.equal(partDocs(scene, SA_BACKGROUND_PART).length, 1);
  // The system source-of-truth flag was never rewritten by the sync.
  assert.deepEqual(scene.flags[SITUATION_ASPECTS_SCOPE][SITUATION_ASPECTS_KEY], [
    { name: "A", free_invokes: 1 },
    { name: "B", free_invokes: 2 },
    { name: "C", free_invokes: 3 },
  ]);
});

test("removing an aspect from the middle reindexes the remaining parts", async () => {
  installGame();
  const scene = mockScene();
  await placeWidget(scene, [
    { name: "A", free_invokes: 1 },
    { name: "B", free_invokes: 2 },
    { name: "C", free_invokes: 3 },
  ]);
  await syncSituationAspects(scene);

  withAspects(scene, [
    { name: "A", free_invokes: 1 },
    { name: "C", free_invokes: 3 },
  ]);
  resetCalls(scene);
  assert.equal(await syncSituationAspects(scene), true);

  // Set mismatch -> every stale text part is removed, none updated.
  assert.equal(scene.calls.update.length, 0);
  assert.equal(scene.calls.delete.length, 3);
  assert.equal(scene.calls.create.length, 2);
  const texts = partDocs(scene, SA_TEXT_PART)
    .sort((a, b) => flagOf(a, "index") - flagOf(b, "index"));
  assert.deepEqual(
    texts.map((d) => [flagOf(d, "index"), d.text]),
    [
      [0, "A (1)"],
      [1, "C (3)"],
    ],
  );
  // No stale index-2 part survives; geometry follows the shorter list.
  assert.equal(texts.some((d) => flagOf(d, "index") === 2), false);
  assert.deepEqual(
    texts.map((d) => [d.x, d.y, d.shape.height]),
    [
      [100, 540, 80], // top 340 + anchor 200
      [100, 620, 80],
    ],
  );
  assert.equal(partDocs(scene, SA_FRAME_PART).length, 1);
  assert.equal(partDocs(scene, SA_BACKGROUND_PART).length, 1);
});

test("renaming an aspect (same count) also rebuilds the text parts", async () => {
  installGame();
  const scene = mockScene();
  await placeWidget(scene, [
    { name: "A", free_invokes: 1 },
    { name: "B", free_invokes: 2 },
  ]);
  await syncSituationAspects(scene);
  withAspects(scene, [
    { name: "A", free_invokes: 1 },
    { name: "X", free_invokes: 2 },
  ]);
  resetCalls(scene);
  await syncSituationAspects(scene);
  assert.equal(scene.calls.update.length, 0);
  assert.equal(scene.calls.delete.length, 2);
  assert.equal(scene.calls.create.length, 2);
  assert.deepEqual(
    partDocs(scene, SA_TEXT_PART)
      .sort((a, b) => flagOf(a, "index") - flagOf(b, "index"))
      .map((d) => d.text),
    ["A (1)", "X (2)"],
  );
});

test("a repeated sync without data changes is a strict no-op", async () => {
  installGame();
  const scene = mockScene();
  await placeWidget(scene, [
    { name: "A", free_invokes: 1 },
    { name: "B", free_invokes: 2 },
  ]);
  await syncSituationAspects(scene);
  await syncSituationAspects(scene); // settle once more, then measure

  resetCalls(scene);
  assert.equal(await syncSituationAspects(scene), true);
  assert.equal(scene.calls.create.length, 0, "no creates");
  assert.equal(scene.calls.update.length, 0, "no updates");
  assert.equal(scene.calls.delete.length, 0, "no deletes");
});

test("a FRESH per-aspect placement is idempotent: the next sync writes nothing", async () => {
  installGame();
  const scene = mockScene();
  // Exactly what SituationAspectManager.placeWidget builds today: ONE text
  // Drawing PER ASPECT (buildSaTextDocs) plus frame and background — not the
  // legacy single-text trio the other tests migrate from.
  await placeWidget(
    scene,
    [
      { name: "A", free_invokes: 1 },
      { name: "B", free_invokes: 2 },
      { name: "C", free_invokes: 3 },
    ],
    { legacy: false },
  );

  // The very first sync after placement already finds the stored set in
  // sync (same builders, same options, same anchor math).
  resetCalls(scene);
  assert.equal(await syncSituationAspects(scene), true);
  assert.equal(scene.calls.create.length, 0, "fresh set needs no creates");
  assert.equal(scene.calls.update.length, 0, "fresh set needs no updates");
  assert.equal(scene.calls.delete.length, 0, "fresh set needs no deletes");

  // And a second sync stays a strict no-op as well.
  resetCalls(scene);
  assert.equal(await syncSituationAspects(scene), true);
  assert.equal(scene.calls.create.length, 0, "no creates");
  assert.equal(scene.calls.update.length, 0, "no updates");
  assert.equal(scene.calls.delete.length, 0, "no deletes");

  // The group is intact and correctly identified.
  assert.equal(partDocs(scene, SA_TEXT_PART).length, 3);
  assert.equal(partDocs(scene, SA_FRAME_PART).length, 1);
  assert.equal(partDocs(scene, SA_BACKGROUND_PART).length, 1);
});

test("a settings-only change delta-updates the matching parts without churn", async () => {
  installGame();
  const scene = mockScene();
  await placeWidget(scene, [{ name: "Only", free_invokes: 4 }]);
  await syncSituationAspects(scene);
  resetCalls(scene);

  settingsOverrides = { situationAspectsFontSize: 48 };
  try {
    assert.equal(await syncSituationAspects(scene), true);
    assert.equal(scene.calls.create.length, 0, "same index+text -> no recreate");
    assert.equal(scene.calls.delete.length, 0);
    // Only the text part's geometry/fontSize differ -> one delta update.
    assert.equal(scene.calls.update.length, 1);
  } finally {
    settingsOverrides = {};
  }
  const text = partDocs(scene, SA_TEXT_PART)[0];
  assert.equal(text.fontSize, 48);
  assert.equal(text.shape.height, 120); // 48*1.25*2
  assert.equal(text.text, "Only (4)");
});

test("zero aspects keep a single near-invisible placeholder part; the first aspect replaces it", async () => {
  installGame();
  const scene = mockScene();
  await placeWidget(scene, []);
  await syncSituationAspects(scene);

  let texts = partDocs(scene, SA_TEXT_PART);
  assert.equal(texts.length, 1);
  assert.equal(flagOf(texts[0], "index"), 0);
  assert.equal(texts[0].text, "");
  assert.equal(texts[0].shape.width, 500);
  assert.equal(texts[0].shape.height, 800);
  assert.equal(texts[0].fillType, CONST.DRAWING_FILL_TYPES.SOLID);
  assert.equal(texts[0].fillAlpha, 0.01);

  withAspects(scene, [{ name: "First", free_invokes: 9 }]);
  resetCalls(scene);
  assert.equal(await syncSituationAspects(scene), true);
  assert.equal(scene.calls.delete.length, 1);
  assert.equal(scene.calls.create.length, 1);
  texts = partDocs(scene, SA_TEXT_PART);
  assert.equal(texts.length, 1);
  assert.equal(texts[0].text, "First (9)");
  assert.equal(texts[0].fillType, CONST.DRAWING_FILL_TYPES.NONE);
  assert.equal(texts[0].shape.height, SLOT_H);
  assert.equal(texts[0].y, ANCHOR.y + 380); // single row: top (800-40)/2 = 380
});

test("unknown parts of the group are cleaned; foreign widgets survive", async () => {
  installGame();
  const scene = mockScene();
  await placeWidget(scene, [{ name: "A", free_invokes: 1 }]);
  await syncSituationAspects(scene);
  resetCalls(scene);
  scene.drawings.push({
    id: "junk",
    documentName: "Drawing",
    text: "",
    getFlag(scope, key) {
      return (
        scope === FLAG_SCOPE && {
          widgetId: WIDGET_ID,
          ownerType: SA_OWNER_TYPE,
          part: "someoneElsesPart",
          index: -1,
        }[key]
      );
    },
  });
  scene.drawings.push({
    id: "foreign",
    documentName: "Drawing",
    getFlag(scope, key) {
      return (
        scope === FLAG_SCOPE && { widgetId: "other-widget", part: "x" }[key]
      );
    },
  });

  assert.equal(await syncSituationAspects(scene), true);
  assert.deepEqual(scene.calls.delete, ["junk"]);
  assert.ok(scene.drawings.some((d) => d.id === "foreign"));
});

test("a manually fully-deleted group clears the registry", async () => {
  installGame();
  const scene = mockScene();
  await placeWidget(scene, [{ name: "A", free_invokes: 1 }]);
  scene.drawings.length = 0; // manual deletion of the whole group

  assert.equal(await syncSituationAspects(scene), false);
  assert.deepEqual(scene.calls.unset, [
    { scope: FLAG_SCOPE, key: SITUATION_ASPECTS_WIDGET_FLAG },
  ]);
  assert.equal(scene.getFlag(FLAG_SCOPE, SITUATION_ASPECTS_WIDGET_FLAG), undefined);
});
