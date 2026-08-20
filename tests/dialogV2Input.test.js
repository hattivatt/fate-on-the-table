/**
 * Node regression tests for the DialogV2 input forms.
 *
 * Foundry v14 changed `DialogV2.prompt()` to resolve with the id of the
 * pressed button (`"ok"`), NOT the form fields — so every input form that read
 * `choice?.name`/`choice?.layout`/`choice?.id` produced empty values (the
 * "empty zone name" bug). These tests mock `DialogV2.input()` and verify that
 * the five forms:
 *   - extract the actually typed value from a plain-object result;
 *   - accept a FormData result as well;
 *   - reject cancel/null and whitespace-only input;
 *   - never fall back to `DialogV2.prompt()`.
 *
 * The import chain pulls in `settings` -> `LayoutImportExport`, which extends
 * `foundry.applications.api.ApplicationV2` at module scope, so a minimal
 * Foundry stub is installed BEFORE the dynamic imports.
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { analyzeLayout } from "../scripts/layoutSchema.js";
import { registerLayout, getLayoutJson } from "../scripts/layoutRegistry.js";
import { FLAG_SCOPE, WIDGETS_FLAG } from "../scripts/constants.js";

let promptCount = 0;
const DialogV2 = {
  input: async () => null,
  prompt: async () => {
    promptCount += 1;
    return "ok";
  },
  confirm: async () => true,
};

globalThis.foundry = {
  applications: {
    api: {
      ApplicationV2: class ApplicationV2 {},
      DialogV2,
    },
  },
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

globalThis.game = {
  i18n: {
    localize: (key) => key,
    format: (key, data) => key,
    has: () => false,
  },
  user: { isGM: true },
  settings: {
    get: (scope, key) => (key === "customLayouts" ? [] : undefined),
    set: async () => {},
    settings: new Map(),
  },
  modules: new Map(),
};

globalThis.ui = {
  notifications: {
    info: () => {},
    warn: () => {},
    error: () => {},
  },
};

/** Registers a (registry-scoped) layout record without a valid document. */
function registerScopedLayout(id, name) {
  registerLayout({ id, name }, { source: "registered" });
}

/** Registers a valid custom layout built from the default fixture. */
function registerCustomLayout(id, name) {
  const raw = JSON.parse(
    readFileSync(new URL("../layouts/default.json", import.meta.url), "utf8"),
  );
  const { normalized } = analyzeLayout(raw);
  normalized.id = id;
  normalized.name = name;
  registerLayout(normalized, { source: "custom" });
}

function setInput(value) {
  DialogV2.input = async () => value;
}

function mockActor() {
  return {
    name: "Bob",
    type: "npc",
    flags: {},
    getFlag(scope, key) {
      if (scope === FLAG_SCOPE && key === WIDGETS_FLAG) {
        return [{ widgetId: "w1", layoutId: "custom-a", version: 1 }];
      }
      return undefined;
    },
    async setFlag(scope, key, value) {
      if (scope === FLAG_SCOPE) this.flags[key] = value;
    },
  };
}

let zoneEditor;
let conflictInteractions;
let sheetButton;
let LayoutImportExport;

before(async () => {
  zoneEditor = await import("../scripts/ConflictZoneEditor.js");
  conflictInteractions = await import("../scripts/ConflictInteractions.js");
  sheetButton = await import("../scripts/sheetButton.js");
  const lie = await import("../scripts/LayoutImportExport.js");
  LayoutImportExport = lie.LayoutImportExport;
});

/* ------------------------------------------------------------------ *
 * ConflictZoneEditor.promptZoneName (field `name`)
 * ------------------------------------------------------------------ */

test("promptZoneName passes a typed name through (trimmed)", async () => {
  setInput({ name: "  Tavern  " });
  promptCount = 0;
  assert.equal(await zoneEditor.promptZoneName(), "Tavern");
  assert.equal(promptCount, 0, "prompt() must not be used for input forms");
});

test("promptZoneName accepts a FormData result", async () => {
  const fd = new FormData();
  fd.append("name", "Hall");
  setInput(fd);
  promptCount = 0;
  assert.equal(await zoneEditor.promptZoneName(), "Hall");
  assert.equal(promptCount, 0);
});

test("promptZoneName rejects cancel/null", async () => {
  setInput(null);
  promptCount = 0;
  assert.equal(await zoneEditor.promptZoneName(), null);
  assert.equal(promptCount, 0);
});

test("promptZoneName rejects empty and whitespace", async () => {
  setInput({ name: "" });
  assert.equal(await zoneEditor.promptZoneName(), null);
  setInput({ name: "   " });
  assert.equal(await zoneEditor.promptZoneName(), null);
  assert.equal(promptCount, 0);
});

/* ------------------------------------------------------------------ *
 * ConflictInteractions.promptZoneRename (field `name`)
 * ------------------------------------------------------------------ */

test("promptZoneRename passes a typed name through (trimmed)", async () => {
  setInput({ name: "  Corridor  " });
  promptCount = 0;
  assert.equal(await conflictInteractions.promptZoneRename("Corridor"), "Corridor");
  assert.equal(promptCount, 0);
});

test("promptZoneRename accepts a FormData result", async () => {
  const fd = new FormData();
  fd.append("name", "Dungeon");
  setInput(fd);
  promptCount = 0;
  assert.equal(await conflictInteractions.promptZoneRename("Old"), "Dungeon");
  assert.equal(promptCount, 0);
});

test("promptZoneRename rejects cancel/null and whitespace", async () => {
  setInput(null);
  assert.equal(await conflictInteractions.promptZoneRename("Old"), null);
  setInput({ name: "   " });
  assert.equal(await conflictInteractions.promptZoneRename("Old"), null);
  assert.equal(promptCount, 0);
});

/* ------------------------------------------------------------------ *
 * sheetButton.changeWidgetLayout (field `layout`)
 * ------------------------------------------------------------------ */

test("changeWidgetLayout applies the typed layout id", async () => {
  registerScopedLayout("custom-a", "A");
  registerScopedLayout("custom-b", "B");
  setInput({ layout: "  custom-b  " });
  promptCount = 0;
  const actor = mockActor();
  await sheetButton.changeWidgetLayout(actor);
  assert.equal(actor.flags[WIDGETS_FLAG][0].layoutId, "custom-b");
  assert.equal(promptCount, 0);
});

test("changeWidgetLayout accepts a FormData result", async () => {
  const fd = new FormData();
  fd.append("layout", "custom-a");
  setInput(fd);
  promptCount = 0;
  const actor = mockActor();
  await sheetButton.changeWidgetLayout(actor);
  assert.equal(actor.flags[WIDGETS_FLAG][0].layoutId, "custom-a");
  assert.equal(promptCount, 0);
});

test("changeWidgetLayout rejects cancel/null and whitespace", async () => {
  setInput(null);
  const cancelled = mockActor();
  await sheetButton.changeWidgetLayout(cancelled);
  assert.equal(cancelled.flags[WIDGETS_FLAG], undefined);

  setInput({ layout: "   " });
  const blank = mockActor();
  await sheetButton.changeWidgetLayout(blank);
  assert.equal(blank.flags[WIDGETS_FLAG], undefined);
  assert.equal(promptCount, 0);
});

/* ------------------------------------------------------------------ *
 * LayoutImportExport.resolveCollisionId (field `id`)
 * ------------------------------------------------------------------ */

test("resolveCollisionId passes a typed id through (trimmed)", async () => {
  setInput({ id: "  custom-new  " });
  promptCount = 0;
  assert.equal(await LayoutImportExport.resolveCollisionId("custom-a"), "custom-new");
  assert.equal(promptCount, 0);
});

test("resolveCollisionId accepts a FormData result", async () => {
  const fd = new FormData();
  fd.append("id", "custom-from-form");
  setInput(fd);
  promptCount = 0;
  assert.equal(await LayoutImportExport.resolveCollisionId("custom-a"), "custom-from-form");
  assert.equal(promptCount, 0);
});

test("resolveCollisionId rejects cancel/null and whitespace", async () => {
  setInput(null);
  assert.equal(await LayoutImportExport.resolveCollisionId("custom-a"), null);
  setInput({ id: "   " });
  assert.equal(await LayoutImportExport.resolveCollisionId("custom-a"), null);
  assert.equal(promptCount, 0);
});

test("resolveCollisionId rejects an id that is already taken", async () => {
  registerScopedLayout("taken-id", "Taken");
  setInput({ id: "taken-id" });
  promptCount = 0;
  assert.equal(await LayoutImportExport.resolveCollisionId("custom-a"), null);
  assert.equal(promptCount, 0);
});

/* ------------------------------------------------------------------ *
 * LayoutImportExport.renameLayout (field `name`)
 * ------------------------------------------------------------------ */

test("renameLayout applies the typed name", async () => {
  registerCustomLayout("rename-custom", "Old Name");
  setInput({ name: "  New Name  " });
  promptCount = 0;
  const ok = await LayoutImportExport.renameLayout("rename-custom");
  assert.equal(ok, true);
  assert.equal(getLayoutJson("rename-custom").name, "New Name");
  assert.equal(promptCount, 0);
});

test("renameLayout accepts a FormData result", async () => {
  registerCustomLayout("rename-fd", "Old Name");
  const fd = new FormData();
  fd.append("name", "FormData Name");
  setInput(fd);
  promptCount = 0;
  assert.equal(await LayoutImportExport.renameLayout("rename-fd"), true);
  assert.equal(promptCount, 0);
});

test("renameLayout rejects cancel/null and whitespace", async () => {
  registerCustomLayout("rename-empty", "Old Name");
  setInput(null);
  assert.equal(await LayoutImportExport.renameLayout("rename-empty"), false);
  setInput({ name: "   " });
  assert.equal(await LayoutImportExport.renameLayout("rename-empty"), false);
  assert.equal(promptCount, 0);
});
