/**
 * Tests for structural zone binding of situation aspects:
 * - situationAspectZones.js pure helpers
 * - SituationAspectSync.js normalizeAspects + saAspectLine + sync migration
 * - situationAspectActions pure helpers preserve zoneIds
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FLAG_SCOPE,
  SITUATION_ASPECTS_SCOPE,
  SITUATION_ASPECTS_KEY,
  SITUATION_ASPECTS_WIDGET_FLAG,
  SA_OWNER_TYPE,
  SA_TEXT_PART,
  SA_FRAME_PART,
  SA_BACKGROUND_PART,
  CONFLICT_BOARD_FLAG,
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
let settingsOverrides = {};
globalThis.game = {
  user: { id: "u1" },
  i18n: { localize: (k) => k, format: (k) => k },
  settings: { get: (_m, key) => settingsOverrides[key] },
};

const {
  normalizeZoneIds,
  aspectZoneIds,
  aspectsForZone,
  stripZoneSuffix,
  migrateZoneSuffixes,
  SA_ZONE_MARKER,
} = await import("../scripts/situationAspectZones.js");
const {
  normalizeAspects,
  saAspectLine,
  syncSituationAspects,
  buildSaTextDocs,
  buildSaFrameDoc,
  buildSaBackgroundDoc,
} = await import("../scripts/SituationAspectSync.js");
const { toDocumentData } = await import("../scripts/WidgetBuilder.js");
const { CONFLICT_BOARD_VERSION } = await import("../scripts/conflictBoardSchema.js");
const { adjustInvokesInList, removeAspectFromList } = await import("../scripts/situationAspectActions.js");

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
function mockScene({ flags = {}, drawings = [], tokens = [] } = {}) {
  const scene = {
    id: "scene1",
    drawings: [...drawings],
    tiles: [],
    tokens: [...tokens],
    flags,
    calls: { create: [], update: [], delete: [], unset: [], setFlag: [] },
    getFlag(scope, key) { return this.flags[scope]?.[key]; },
    async setFlag(scope, key, value) {
      this.calls.setFlag.push({ scope, key, value: structuredClone(value) });
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
        if (i >= 0) arr.splice(i, 1);
      }
      return this;
    },
    async updateEmbeddedDocuments(kind, docs) {
      this.calls.update.push(...docs.map((d) => d._id));
      const arr = kind === "Drawing" ? this.drawings : this.tiles;
      for (const d of docs ?? []) {
        const target = arr.find((x) => x.id === d._id);
        if (target) for (const [k,v] of Object.entries(d)) if (k!=="_id") setPath(target,k,v);
      }
      return this;
    },
    async createEmbeddedDocuments(kind, docs) {
      const arr = kind === "Drawing" ? this.drawings : this.tiles;
      for (const d of docs ?? []) {
        arr.push({ id: `created-${this.calls.create.length}`, documentName: kind, ...d, getFlag(scope,key){return d.flags?.[scope]?.[key];}});
        this.calls.create.push(d);
      }
      return this;
    },
  };
  return scene;
}
function flagOf(doc,key){return doc.getFlag(FLAG_SCOPE,key);}
function partDocs(scene, part){ return scene.drawings.filter(d=>flagOf(d,"part")===part); }
const OPTS = { width:500,height:800,fontFamily:"Montserrat",fontSize:32,textColor:"#000000",backgroundTexture:"",backgroundColor:"#ffffff",backgroundAlpha:1 };
const WIDGET_ID="sa-widget-1";
const ANCHOR={x:100,y:200};
function validBoard(overrides={}){ return { version:CONFLICT_BOARD_VERSION, combatId:"combat-abc", sizePreset:"medium", board:{origin:{x:1000,y:800}}, zones:[], cards:{}, ...overrides }; }
function zone(id,name){ return { id,name, rect:{x:10,y:10,width:100,height:100}, style:{fill:"#ffffff",alpha:0.12,stroke:"#000000"}, sort:0 }; }
async function placeWidget(scene, rawAspects, { legacy=false }={}){
  withAspects(scene, rawAspects);
  const normalized = normalizeAspects(rawAspects);
  const docs = legacy? [buildSaFrameDoc(OPTS), buildSaBackgroundDoc(OPTS)] : [...buildSaTextDocs(normalized,OPTS), buildSaFrameDoc(OPTS), buildSaBackgroundDoc(OPTS)];
  // For legacy test we need text doc too, but our new OPTS builds per-aspect; just use per-aspect for new tests
  // Simpler: always use buildSaTextDocs
  const allDocs = [...buildSaTextDocs(normalized,OPTS), buildSaFrameDoc(OPTS), buildSaBackgroundDoc(OPTS)];
  for(const doc of allDocs){
    const payload = toDocumentData({ ...doc, x:doc.x+ANCHOR.x, y:doc.y+ANCHOR.y }, { widgetId:WIDGET_ID, part:doc.part, index:doc.index, ownerType:SA_OWNER_TYPE });
    await scene.createEmbeddedDocuments("Drawing",[payload]);
  }
  await scene.setFlag(FLAG_SCOPE, SITUATION_ASPECTS_WIDGET_FLAG, { widgetId:WIDGET_ID, anchor:ANCHOR });
}
function withAspects(scene, rawAspects){ scene.flags[SITUATION_ASPECTS_SCOPE]={[SITUATION_ASPECTS_KEY]: structuredClone(rawAspects)}; }

/* ------------------------------------------------------------------ *
 * normalizeZoneIds
 * ------------------------------------------------------------------ */
test("normalizeZoneIds: non-array -> []", () => {
  assert.deepEqual(normalizeZoneIds(undefined), []);
  assert.deepEqual(normalizeZoneIds(null), []);
  assert.deepEqual(normalizeZoneIds("z1"), []);
  assert.deepEqual(normalizeZoneIds({}), []);
});
test("normalizeZoneIds: filters non-strings, empty, dedupes, preserves order", () => {
  assert.deepEqual(normalizeZoneIds(["z1","", "z2", 123, null, "z1", "z3", "z2"]), ["z1","z2","z3"]);
});
test("normalizeZoneIds: validIds filters to existing only", () => {
  assert.deepEqual(normalizeZoneIds(["z1","z2","z3"], ["z1","z3"]), ["z1","z3"]);
  assert.deepEqual(normalizeZoneIds(["z1","z2","z1"], new Set(["z1"])), ["z1"]);
});
test("normalizeZoneIds: without validIds keeps all strings deduped", () => {
  assert.deepEqual(normalizeZoneIds(["z1","z2","z1"]), ["z1","z2"]);
});

/* ------------------------------------------------------------------ *
 * aspectZoneIds / aspectsForZone
 * ------------------------------------------------------------------ */
test("aspectZoneIds safe access", () => {
  assert.deepEqual(aspectZoneIds(null), []);
  assert.deepEqual(aspectZoneIds({}), []);
  assert.deepEqual(aspectZoneIds({zoneIds:"z1"}), []);
  assert.deepEqual(aspectZoneIds({zoneIds:["z1","z2"]}), ["z1","z2"]);
  assert.deepEqual(aspectZoneIds({zoneIds:["z1",123,""]}), ["z1"]);
});
test("aspectsForZone filters by zoneId", () => {
  const list = [{name:"A", zoneIds:["z1"]},{name:"B", zoneIds:["z2"]},{name:"C", zoneIds:["z1","z2"]},{name:"D"}];
  assert.deepEqual(aspectsForZone(list,"z1").map(a=>a.name), ["A","C"]);
  assert.deepEqual(aspectsForZone(list,"z2").map(a=>a.name), ["B","C"]);
  assert.deepEqual(aspectsForZone(list,"z9"), []);
  assert.deepEqual(aspectsForZone(null,"z1"), []);
});

/* ------------------------------------------------------------------ *
 * stripZoneSuffix
 * ------------------------------------------------------------------ */
test("stripZoneSuffix strips matching zone suffix", () => {
  assert.deepEqual(stripZoneSuffix("Fire (Bridge)", {"Bridge":"z1"}), { name:"Fire", zoneId:"z1", matched:true });
  assert.deepEqual(stripZoneSuffix("Fire (Unknown)", {"Bridge":"z1"}).matched, false);
  assert.deepEqual(stripZoneSuffix("Fire", {"Bridge":"z1"}).matched, false);
  // whitespace tolerance via parseBinding
  assert.deepEqual(stripZoneSuffix("Fire   (Bridge) ", {"Bridge":"z1"}).name, "Fire");
});

/* ------------------------------------------------------------------ *
 * migrateZoneSuffixes
 * ------------------------------------------------------------------ */
test("migrateZoneSuffixes: zone suffix converted and cut", () => {
  const list = [{name:"Fire (Bridge)", free_invokes:1}];
  const { list: out, changed } = migrateZoneSuffixes(list, {"Bridge":"z1"}, new Set());
  assert.equal(changed,true);
  assert.deepEqual(out, [{name:"Fire", free_invokes:1, zoneIds:["z1"]}]);
});
test("migrateZoneSuffixes: character suffix NOT touched", () => {
  const list = [{name:"Fire (Goblin)", free_invokes:1}];
  const { changed, list: out } = migrateZoneSuffixes(list, {"Goblin":"z1"}, new Set(["Goblin"]));
  assert.equal(changed,false);
  assert.deepEqual(out, list);
});
test("migrateZoneSuffixes: collision zone=character -> character priority", () => {
  const list = [{name:"Fire (Bridge)", free_invokes:1}];
  const { changed } = migrateZoneSuffixes(list, {"Bridge":"z1"}, new Set(["Bridge"]));
  assert.equal(changed,false);
});
test("migrateZoneSuffixes: idempotent and preserves existing zoneIds", () => {
  const list = [{name:"Fire (Bridge)", free_invokes:1}];
  const first = migrateZoneSuffixes(list, {"Bridge":"z1"}, new Set());
  assert.equal(first.changed,true);
  const second = migrateZoneSuffixes(first.list, {"Bridge":"z1"}, new Set());
  assert.equal(second.changed,false);
  assert.deepEqual(second.list, first.list);
  const withIds = [{name:"Fire (Bridge)", free_invokes:1, zoneIds:["z1"]}];
  const { changed: c2 } = migrateZoneSuffixes(withIds, {"Bridge":"z1"}, new Set());
  assert.equal(c2,false);
});
test("migrateZoneSuffixes: non-matching and no suffix untouched", () => {
  const list = [{name:"Fire", free_invokes:1},{name:"Trap (old) door", free_invokes:0}];
  const { changed } = migrateZoneSuffixes(list, {"Bridge":"z1"}, new Set());
  assert.equal(changed,false);
});

/* ------------------------------------------------------------------ *
 * saAspectLine marker
 * ------------------------------------------------------------------ */
test("saAspectLine marker present when zoneIds non-empty", () => {
  assert.equal(saAspectLine({name:"Fire", free_invokes:2, zoneIds:["z1"]}), `${SA_ZONE_MARKER} Fire (2)`);
  assert.equal(SA_ZONE_MARKER, "◈");
});
test("saAspectLine no marker when no zoneIds", () => {
  assert.equal(saAspectLine({name:"Fire", free_invokes:2}), "Fire (2)");
  assert.equal(saAspectLine({name:"Fire", free_invokes:2, zoneIds:[]}), "Fire (2)");
});

/* ------------------------------------------------------------------ *
 * situationAspectActions preserves zoneIds
 * ------------------------------------------------------------------ */
test("adjustInvokesInList preserves zoneIds", () => {
  const list = [{name:"A", free_invokes:1, zoneIds:["z1"], linked:"x"}];
  const next = adjustInvokesInList(list,0,1);
  assert.deepEqual(next[0].zoneIds, ["z1"]);
  assert.equal(next[0].linked,"x");
});
test("removeAspectFromList preserves neighbours zoneIds", () => {
  const list = [{name:"A", zoneIds:["z1"]},{name:"B", zoneIds:["z2"]},{name:"C"}];
  const next = removeAspectFromList(list,1);
  assert.deepEqual(next[0].zoneIds, ["z1"]);
  assert.equal(next[1].name,"C");
});

/* ------------------------------------------------------------------ *
 * syncSituationAspects migration + dangling end-to-end
 * ------------------------------------------------------------------ */
test("sync migrates zone suffix, widget redrawn, second sync no-op", async () => {
  const board = validBoard({ zones:[zone("z1","Bridge")] });
  const scene = mockScene({ flags:{ [FLAG_SCOPE]:{ [CONFLICT_BOARD_FLAG]: board, [SITUATION_ASPECTS_WIDGET_FLAG]:{widgetId:WIDGET_ID, anchor:ANCHOR} }, [SITUATION_ASPECTS_SCOPE]:{[SITUATION_ASPECTS_KEY]:[{name:"Fire (Bridge)", free_invokes:2}]} }, tokens:[{name:"Goblin"}] });
  // place widget per-aspect with OLD name (includes suffix) to simulate legacy stored aspects before migration
  // Use normalized old list for placement? Place with old list then sync will migrate and rebuild
  const normalizedOld = [{name:"Fire (Bridge)", free_invokes:2, zoneIds:[]}];
  const docs = [...buildSaTextDocs(normalizedOld,OPTS), buildSaFrameDoc(OPTS), buildSaBackgroundDoc(OPTS)];
  for(const doc of docs){
    const payload = toDocumentData({ ...doc, x:doc.x+ANCHOR.x, y:doc.y+ANCHOR.y }, { widgetId:WIDGET_ID, part:doc.part, index:doc.index, ownerType:SA_OWNER_TYPE });
    await scene.createEmbeddedDocuments("Drawing",[payload]);
  }
  const beforeFlagCalls = scene.calls.setFlag.length;
  await syncSituationAspects(scene);
  // flag migrated
  const stored = scene.getFlag(SITUATION_ASPECTS_SCOPE, SITUATION_ASPECTS_KEY);
  assert.deepEqual(stored, [{name:"Fire", free_invokes:2, zoneIds:["z1"]}]);
  // widget text now has marker
  const texts = partDocs(scene, SA_TEXT_PART).sort((a,b)=> flagOf(a,"index")-flagOf(b,"index"));
  assert.equal(texts[0].text, `${SA_ZONE_MARKER} Fire (2)`);
  // second sync no-op: no additional flag write, no drawing churn
  scene.calls.setFlag.length=0;
  const snapshot = scene.calls.setFlag.length;
  const beforeCreate = scene.calls.create.length;
  const beforeUpdate = scene.calls.update.length;
  const beforeDelete = scene.calls.delete.length;
  await syncSituationAspects(scene);
  assert.equal(scene.calls.setFlag.length, 0, "second sync must not write flag");
  assert.equal(scene.calls.create.length, beforeCreate, "no creates");
  assert.equal(scene.calls.update.length, beforeUpdate, "no updates");
  assert.equal(scene.calls.delete.length, beforeDelete, "no deletes");
});

test("sync cleans dangling zoneId after zone deletion", async () => {
  const boardBefore = validBoard({ zones:[zone("z1","Bridge"), zone("z2","Cellar")] });
  const boardAfter = validBoard({ zones:[zone("z1","Bridge")] });
  const scene = mockScene({ flags:{ [FLAG_SCOPE]:{ [CONFLICT_BOARD_FLAG]: boardAfter, [SITUATION_ASPECTS_WIDGET_FLAG]:{widgetId:WIDGET_ID, anchor:ANCHOR} }, [SITUATION_ASPECTS_SCOPE]:{[SITUATION_ASPECTS_KEY]:[{name:"Fire", free_invokes:1, zoneIds:["z1","z2"]},{name:"Ice", free_invokes:0, zoneIds:["z2"]}]} }, tokens:[] });
  // place widget with old aspects (with dangling)
  const normalizedOld = normalizeAspects(scene.getFlag(SITUATION_ASPECTS_SCOPE,SITUATION_ASPECTS_KEY));
  const docs = [...buildSaTextDocs(normalizedOld,OPTS), buildSaFrameDoc(OPTS), buildSaBackgroundDoc(OPTS)];
  for(const doc of docs){
    const payload = toDocumentData({ ...doc, x:doc.x+ANCHOR.x, y:doc.y+ANCHOR.y }, { widgetId:WIDGET_ID, part:doc.part, index:doc.index, ownerType:SA_OWNER_TYPE });
    await scene.createEmbeddedDocuments("Drawing",[payload]);
  }
  await syncSituationAspects(scene);
  const stored = scene.getFlag(SITUATION_ASPECTS_SCOPE, SITUATION_ASPECTS_KEY);
  // z2 is dangling (zone removed), so Fire keeps only z1, Ice loses zoneIds entirely
  assert.deepEqual(stored, [{name:"Fire", free_invokes:1, zoneIds:["z1"]}, {name:"Ice", free_invokes:0}]);
  // widget after cleanup: first aspect has marker, second not
  const texts = partDocs(scene, SA_TEXT_PART).sort((a,b)=> flagOf(a,"index")-flagOf(b,"index"));
  assert.equal(texts[0].text, `${SA_ZONE_MARKER} Fire (1)`);
  assert.equal(texts[1].text, "Ice (0)");
  // second sync no-op
  scene.calls.setFlag.length=0;
  await syncSituationAspects(scene);
  assert.equal(scene.calls.setFlag.length, 0);
});

test("sync coalesces zone migration and consequence reconciliation into a single setFlag", async () => {
  const board = validBoard({ zones:[zone("z1","Bridge")] });
  const tokens = [
    {
      name: "Grom",
      actor: {
        name: "Grom",
        system: {
          tracks: {
            mild: { harm_can_absorb: 2, aspect: { name: "Broken leg", when_marked: true } },
          },
        },
      },
    },
  ];
  const rawAspects = [
    { name: "Fire (Bridge)", free_invokes: 1 },
    { name: "Broken leg (Grom)", free_invokes: 1, linked: true },
  ];
  const scene = mockScene({
    flags: {
      [FLAG_SCOPE]: { [CONFLICT_BOARD_FLAG]: board, [SITUATION_ASPECTS_WIDGET_FLAG]: { widgetId: WIDGET_ID, anchor: ANCHOR } },
      [SITUATION_ASPECTS_SCOPE]: { [SITUATION_ASPECTS_KEY]: rawAspects },
    },
    tokens,
  });
  const normalizedOld = normalizeAspects(rawAspects);
  const docs = [...buildSaTextDocs(normalizedOld, OPTS), buildSaFrameDoc(OPTS), buildSaBackgroundDoc(OPTS)];
  for (const doc of docs) {
    const payload = toDocumentData({ ...doc, x: doc.x + ANCHOR.x, y: doc.y + ANCHOR.y }, { widgetId: WIDGET_ID, part: doc.part, index: doc.index, ownerType: SA_OWNER_TYPE });
    await scene.createEmbeddedDocuments("Drawing", [payload]);
  }
  scene.calls.setFlag.length = 0;
  await syncSituationAspects(scene);
  const stored = scene.getFlag(SITUATION_ASPECTS_SCOPE, SITUATION_ASPECTS_KEY);
  assert.deepEqual(stored, [
    { name: "Fire", free_invokes: 1, zoneIds: ["z1"] },
    { name: "Broken leg (Grom)", free_invokes: 1, linked: true, consequence: { trackKey: "mild", cost: 2, actorName: "Grom" } },
  ]);
  assert.equal(scene.calls.setFlag.length, 1, "zone + consequence changes must coalesce into a single setFlag");
  assert.equal(scene.calls.setFlag[0].scope, SITUATION_ASPECTS_SCOPE);
  scene.calls.setFlag.length = 0;
  await syncSituationAspects(scene);
  assert.equal(scene.calls.setFlag.length, 0, "second sync must be no-op");
});

