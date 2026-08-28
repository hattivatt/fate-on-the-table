/**
 * Tests for situationAspectConsequences pure helpers + integration with
 * SituationAspectSync (marker rendering + reconciliation) and
 * ConsequenceInteractions.upsertSituationAspect meta handling.
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
      for (const k of String(path).split(".") ) {
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
globalThis.canvas = { scene: null };
globalThis.ui = { notifications: { warn: () => {}, info: () => {} } };

const {
  CONSEQUENCE_MARKERS,
  CONSEQUENCE_MARKER_DEFAULT,
  consequenceMarker,
  isConsequenceTrack,
  consequenceTracksOf,
  buildConsequenceMeta,
  reconcileConsequences,
} = await import("../scripts/situationAspectConsequences.js");

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
const { upsertSituationAspect } = await import("../scripts/ConsequenceInteractions.js");
import { SA_ZONE_MARKER } from "../scripts/situationAspectZones.js";

// helpers for mocks
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
function withAspects(scene, rawAspects){ scene.flags[SITUATION_ASPECTS_SCOPE]={[SITUATION_ASPECTS_KEY]: structuredClone(rawAspects)}; }

/* ------------------------------------------------------------------ *
 * pure: consequenceMarker
 * ------------------------------------------------------------------ */
test("consequenceMarker maps 2/4/6 and defaults otherwise", () => {
  assert.equal(consequenceMarker(2), "✚");
  assert.equal(consequenceMarker(4), "⚠");
  assert.equal(consequenceMarker(6), "☠");
  assert.equal(consequenceMarker(3), CONSEQUENCE_MARKER_DEFAULT);
  assert.equal(consequenceMarker(undefined), CONSEQUENCE_MARKER_DEFAULT);
  assert.equal(consequenceMarker(0), CONSEQUENCE_MARKER_DEFAULT);
  assert.equal(consequenceMarker(null), CONSEQUENCE_MARKER_DEFAULT);
  assert.equal(consequenceMarker(-1), CONSEQUENCE_MARKER_DEFAULT);
  assert.equal(consequenceMarker("4"), "⚠");
  assert.equal(consequenceMarker("bad"), CONSEQUENCE_MARKER_DEFAULT);
  assert.equal(CONSEQUENCE_MARKERS[2], "✚");
  assert.equal(CONSEQUENCE_MARKERS[4], "⚠");
  assert.equal(CONSEQUENCE_MARKERS[6], "☠");
  assert.equal(CONSEQUENCE_MARKER_DEFAULT, "✚");
});

test("isConsequenceTrack checks harm_can_absorb >0", () => {
  assert.equal(isConsequenceTrack({harm_can_absorb:2}), true);
  assert.equal(isConsequenceTrack({harm_can_absorb:4}), true);
  assert.equal(isConsequenceTrack({harm_can_absorb:6}), true);
  assert.equal(isConsequenceTrack({harm_can_absorb:0}), false);
  assert.equal(isConsequenceTrack({harm_can_absorb:undefined}), false);
  assert.equal(isConsequenceTrack({harm_can_absorb:null}), false);
  assert.equal(isConsequenceTrack({harm_can_absorb:"2"}), true);
  assert.equal(isConsequenceTrack({harm_can_absorb:"0"}), false);
  assert.equal(isConsequenceTrack(null), false);
  assert.equal(isConsequenceTrack({}), false);
});

test("consequenceTracksOf returns tracks with harm>0 and non-empty text in entries order", () => {
  const tracks = {
    mild: { harm_can_absorb:2, aspect:{name:" Broken leg "} },
    severe: { harm_can_absorb:4, aspect:{name:""} },
    moderate: { harm_can_absorb:0, aspect:{name:"Should skip harm 0"} },
    light: { harm_can_absorb:6, aspect:{name:"Bleeding"} },
    stress: { harm_can_absorb:undefined, aspect:{name:"Also skip"} },
    emptyAspect: { harm_can_absorb:2, aspect:{name:"   "} },
  };
  const out = consequenceTracksOf(tracks);
  assert.deepEqual(out, [
    { trackKey:"mild", cost:2, text:"Broken leg" },
    { trackKey:"light", cost:6, text:"Bleeding" },
  ]);
});

test("buildConsequenceMeta normalizes cost via Number", () => {
  assert.deepEqual(buildConsequenceMeta("mild", 2, "Grom"), {trackKey:"mild", cost:2, actorName:"Grom"});
  assert.deepEqual(buildConsequenceMeta("mild", "4", "Grom"), {trackKey:"mild", cost:4, actorName:"Grom"});
  assert.ok(Number.isNaN(buildConsequenceMeta("mild", undefined, "Grom").cost));
  assert.equal(buildConsequenceMeta("mild", 0, "Grom").cost, 0);
});

/* ------------------------------------------------------------------ *
 * pure: reconcileConsequences
 * ------------------------------------------------------------------ */
test("reconcile: rename when track text changes", () => {
  const list = [{ name:"Broken leg (Grom)", free_invokes:1, linked:true, zoneIds:["z1"], consequence:{trackKey:"mild", cost:2, actorName:"Grom"} }];
  const actors = [{ name:"Grom", tracks:{ mild:{ harm_can_absorb:2, aspect:{name:"Broken arm"} } } }];
  const { list: out, changed } = reconcileConsequences(list, actors);
  assert.equal(changed,true);
  assert.deepEqual(out, [{ name:"Broken arm (Grom)", free_invokes:1, linked:true, zoneIds:["z1"], consequence:{trackKey:"mild", cost:2, actorName:"Grom"} }]);
});

test("reconcile: delete when track text empty", () => {
  const list = [{ name:"Broken leg (Grom)", free_invokes:1, linked:true, consequence:{trackKey:"mild", cost:2, actorName:"Grom"} }];
  const actors = [{ name:"Grom", tracks:{ mild:{ harm_can_absorb:2, aspect:{name:""} } } }];
  const { list: out, changed } = reconcileConsequences(list, actors);
  assert.equal(changed,true);
  assert.deepEqual(out, []);
});

test("reconcile: delete when track missing", () => {
  const list = [{ name:"Broken leg (Grom)", free_invokes:1, linked:true, consequence:{trackKey:"mild", cost:2, actorName:"Grom"} }];
  const actors = [{ name:"Grom", tracks:{} }];
  const { list: out, changed } = reconcileConsequences(list, actors);
  assert.equal(changed,true);
  assert.deepEqual(out, []);
});

test("reconcile: delete when actor not found (last token gone)", () => {
  const list = [{ name:"Broken leg (Grom)", free_invokes:1, linked:true, consequence:{trackKey:"mild", cost:2, actorName:"Grom"} }];
  const { list: out, changed } = reconcileConsequences(list, []);
  assert.equal(changed,true);
  assert.deepEqual(out, []);
});

test("reconcile: cost change updates meta", () => {
  const list = [{ name:"Broken leg (Grom)", free_invokes:1, linked:true, consequence:{trackKey:"mild", cost:2, actorName:"Grom"} }];
  const actors = [{ name:"Grom", tracks:{ mild:{ harm_can_absorb:4, aspect:{name:"Broken leg"} } } }];
  const { list: out, changed } = reconcileConsequences(list, actors);
  assert.equal(changed,true);
  assert.deepEqual(out, [{ name:"Broken leg (Grom)", free_invokes:1, linked:true, consequence:{trackKey:"mild", cost:4, actorName:"Grom"} }]);
});

test("reconcile: harm 0 with live text -> keep and update cost to 0 (glyph default)", () => {
  const list = [{ name:"Broken leg (Grom)", free_invokes:1, linked:true, consequence:{trackKey:"mild", cost:2, actorName:"Grom"} }];
  const actors = [{ name:"Grom", tracks:{ mild:{ harm_can_absorb:0, aspect:{name:"Broken leg"} } } }];
  const { list: out, changed } = reconcileConsequences(list, actors);
  assert.equal(changed,true);
  // Should not delete; cost becomes 0
  assert.equal(out.length,1);
  assert.equal(out[0].name,"Broken leg (Grom)");
  assert.equal(out[0].consequence.cost,0);
});

test("reconcile: adoption of FU record (linked without meta)", () => {
  const list = [{ name:"Broken leg (Grom)", free_invokes:1, linked:true }];
  const actors = [{ name:"Grom", tracks:{ mild:{ harm_can_absorb:2, aspect:{name:"Broken leg"} } } }];
  const { list: out, changed } = reconcileConsequences(list, actors);
  assert.equal(changed,true);
  assert.deepEqual(out, [{ name:"Broken leg (Grom)", free_invokes:1, linked:true, consequence:{trackKey:"mild", cost:2, actorName:"Grom"} }]);
});

test("reconcile: linked but not a consequence (no matching track) -> not touched", () => {
  const list = [{ name:"Stealthy (Grom)", free_invokes:1, linked:true }];
  const actors = [{ name:"Grom", tracks:{ mild:{ harm_can_absorb:2, aspect:{name:"Broken leg"} } } }];
  const { list: out, changed } = reconcileConsequences(list, actors);
  assert.equal(changed,false);
  assert.equal(out, list); // same instance when not changed
});

test("reconcile: aspects without linked not touched", () => {
  const list = [{ name:"Dark room", free_invokes:2 }, { name:"Broken leg (Grom)", free_invokes:1 }];
  const actors = [{ name:"Grom", tracks:{ mild:{ harm_can_absorb:2, aspect:{name:"Broken leg"} } } }];
  const { list: out, changed } = reconcileConsequences(list, actors);
  // First untouched, second has no linked -> untouched
  assert.equal(changed,false);
});

test("reconcile: idempotent", () => {
  const list = [{ name:"Broken leg (Grom)", free_invokes:1, linked:true, consequence:{trackKey:"mild", cost:2, actorName:"Grom"} }];
  const actors = [{ name:"Grom", tracks:{ mild:{ harm_can_absorb:2, aspect:{name:"Broken leg"} } } }];
  const first = reconcileConsequences(list, actors);
  assert.equal(first.changed,false);
  // adoption case idempotent too
  const adoptList = [{ name:"Broken leg (Grom)", free_invokes:1, linked:true }];
  const a1 = reconcileConsequences(adoptList, actors);
  assert.equal(a1.changed,true);
  const a2 = reconcileConsequences(a1.list, actors);
  assert.equal(a2.changed,false);
  assert.deepEqual(a2.list, a1.list);
});

test("reconcile: multiple actors", () => {
  const list = [
    { name:"Cut (Grom)", free_invokes:1, linked:true, consequence:{trackKey:"mild", cost:2, actorName:"Grom"} },
    { name:"Burn (Mira)", free_invokes:1, linked:true, consequence:{trackKey:"severe", cost:4, actorName:"Mira"} },
  ];
  const actors = [
    { name:"Grom", tracks:{ mild:{ harm_can_absorb:2, aspect:{name:"Cut"} } } },
    { name:"Mira", tracks:{ severe:{ harm_can_absorb:4, aspect:{name:"Burned"} } } },
  ];
  const { list: out, changed } = reconcileConsequences(list, actors);
  assert.equal(changed,true);
  assert.deepEqual(out[0].name,"Cut (Grom)");
  assert.deepEqual(out[1].name,"Burned (Mira)");
});

test("reconcile: meta source of truth when suffix mismatches", () => {
  // aspect name suffix (Bob) differs from meta.actorName (Grom), but actor Grom exists. Meta wins.
  const list = [{ name:"Broken leg (Bob)", free_invokes:1, linked:true, consequence:{trackKey:"mild", cost:2, actorName:"Grom"} }];
  const actors = [{ name:"Grom", tracks:{ mild:{ harm_can_absorb:2, aspect:{name:"Broken arm"} } } }, { name:"Bob", tracks:{ mild:{ harm_can_absorb:2, aspect:{name:"Something"} } } }];
  const { list: out, changed } = reconcileConsequences(list, actors);
  assert.equal(changed,true);
  assert.equal(out[0].name,"Broken arm (Grom)");
  // opposite: meta actor not on scene but suffix actor is -> still delete because meta is source
  const list2 = [{ name:"Broken leg (Bob)", free_invokes:1, linked:true, consequence:{trackKey:"mild", cost:2, actorName:"Grom"} }];
  const actors2 = [{ name:"Bob", tracks:{ mild:{ harm_can_absorb:2, aspect:{name:"Broken leg"} } } }];
  const r2 = reconcileConsequences(list2, actors2);
  assert.equal(r2.changed,true);
  assert.deepEqual(r2.list, []);
});

test("reconcile: name rename preserves free_invokes/zoneIds/linked", () => {
  const list = [{ name:"Old (Grom)", free_invokes:3, linked:true, zoneIds:["z1"], consequence:{trackKey:"mild", cost:2, actorName:"Grom"} }];
  const actors = [{ name:"Grom", tracks:{ mild:{ harm_can_absorb:2, aspect:{name:"New"} } } }];
  const { list: out } = reconcileConsequences(list, actors);
  assert.equal(out[0].free_invokes,3);
  assert.deepEqual(out[0].zoneIds,["z1"]);
  assert.equal(out[0].linked,true);
});

test("reconcile: both name and cost change in one pass", () => {
  const list = [{ name:"Old (Grom)", free_invokes:1, linked:true, consequence:{trackKey:"mild", cost:2, actorName:"Grom"} }];
  const actors = [{ name:"Grom", tracks:{ mild:{ harm_can_absorb:6, aspect:{name:"New"} } } }];
  const { list: out, changed } = reconcileConsequences(list, actors);
  assert.equal(changed,true);
  assert.equal(out[0].name,"New (Grom)");
  assert.equal(out[0].consequence.cost,6);
});

test("reconcile: adoption chooses correct track when multiple", () => {
  const list = [{ name:"Burn (Grom)", free_invokes:1, linked:true }];
  const actors = [{ name:"Grom", tracks:{
    mild:{ harm_can_absorb:2, aspect:{name:"Cut"} },
    severe:{ harm_can_absorb:4, aspect:{name:"Burn"} },
  } }];
  const { list: out } = reconcileConsequences(list, actors);
  assert.equal(out[0].consequence.trackKey,"severe");
  assert.equal(out[0].consequence.cost,4);
});

/* ------------------------------------------------------------------ *
 * saAspectLine markers
 * ------------------------------------------------------------------ */
test("saAspectLine renders zone and consequence markers in order", () => {
  assert.equal(saAspectLine({name:"Fire", free_invokes:2, zoneIds:["z1"]}), `${SA_ZONE_MARKER} Fire (2)`);
  assert.equal(saAspectLine({name:"Fire", free_invokes:2, consequence:{cost:2}}), `✚ Fire (2)`);
  assert.equal(saAspectLine({name:"Fire", free_invokes:2, consequence:{cost:4}}), `⚠ Fire (2)`);
  assert.equal(saAspectLine({name:"Fire", free_invokes:2, consequence:{cost:6}}), `☠ Fire (2)`);
  assert.equal(saAspectLine({name:"Fire", free_invokes:2, consequence:{cost:99}}), `✚ Fire (2)`);
  assert.equal(saAspectLine({name:"Fire", free_invokes:2, zoneIds:["z1"], consequence:{cost:4}}), `◈ ⚠ Fire (2)`);
  assert.equal(saAspectLine({name:"Fire", free_invokes:2, zoneIds:[], consequence:{cost:2}}), `✚ Fire (2)`);
  assert.equal(saAspectLine({name:"Fire", free_invokes:2}), `Fire (2)`);
});

/* ------------------------------------------------------------------ *
 * syncSituationAspects integration
 * ------------------------------------------------------------------ */
test("sync renames consequence aspect when track text changes, updates widget marker", async () => {
  const actorTracks = { mild:{ harm_can_absorb:2, aspect:{name:"Broken leg"} } };
  const aspectWithMeta = { name:"Broken leg (Grom)", free_invokes:1, linked:true, consequence:{trackKey:"mild", cost:2, actorName:"Grom"} };
  const scene = mockScene({
    flags:{
      [FLAG_SCOPE]:{ [SITUATION_ASPECTS_WIDGET_FLAG]:{widgetId:WIDGET_ID, anchor:ANCHOR}, [CONFLICT_BOARD_FLAG]: validBoard() },
      [SITUATION_ASPECTS_SCOPE]:{[SITUATION_ASPECTS_KEY]: [aspectWithMeta]},
    },
    tokens:[{ name:"Grom", actor:{ name:"Grom", system:{ tracks: actorTracks } } }],
  });
  // place widget with current aspect
  const normalized = normalizeAspects([aspectWithMeta]);
  const docs = [...buildSaTextDocs(normalized,OPTS), buildSaFrameDoc(OPTS), buildSaBackgroundDoc(OPTS)];
  for(const doc of docs){
    const payload = toDocumentData({ ...doc, x:doc.x+ANCHOR.x, y:doc.y+ANCHOR.y }, { widgetId:WIDGET_ID, part:doc.part, index:doc.index, ownerType:SA_OWNER_TYPE });
    await scene.createEmbeddedDocuments("Drawing",[payload]);
  }
  // change track text to Broken arm, cost to 4 (⚠)
  scene.tokens[0].actor.system.tracks.mild.aspect.name = "Broken arm";
  scene.tokens[0].actor.system.tracks.mild.harm_can_absorb = 4;
  await syncSituationAspects(scene);
  const stored = scene.getFlag(SITUATION_ASPECTS_SCOPE, SITUATION_ASPECTS_KEY);
  assert.equal(stored.length,1);
  assert.equal(stored[0].name,"Broken arm (Grom)");
  assert.equal(stored[0].consequence.cost,4);
  const texts = partDocs(scene, SA_TEXT_PART).sort((a,b)=> flagOf(a,"index")-flagOf(b,"index"));
  assert.equal(texts[0].text, `⚠ Broken arm (Grom) (1)`);
  // second sync is no-op (no extra setFlag, no drawing churn)
  const beforeSetFlag = scene.calls.setFlag.length;
  const beforeCreate = scene.calls.create.length;
  const beforeUpdate = scene.calls.update.length;
  const beforeDelete = scene.calls.delete.length;
  await syncSituationAspects(scene);
  assert.equal(scene.calls.setFlag.length, beforeSetFlag, "second sync no flag write");
  assert.equal(scene.calls.create.length, beforeCreate);
  assert.equal(scene.calls.update.length, beforeUpdate);
  assert.equal(scene.calls.delete.length, beforeDelete);
});

test("sync deletes consequence aspect when last token leaves scene", async () => {
  const aspectWithMeta = { name:"Cut (Grom)", free_invokes:1, linked:true, consequence:{trackKey:"mild", cost:2, actorName:"Grom"} };
  const scene = mockScene({
    flags:{
      [FLAG_SCOPE]:{ [SITUATION_ASPECTS_WIDGET_FLAG]:{widgetId:WIDGET_ID, anchor:ANCHOR}, [CONFLICT_BOARD_FLAG]: validBoard() },
      [SITUATION_ASPECTS_SCOPE]:{[SITUATION_ASPECTS_KEY]: [aspectWithMeta, {name:"Dark room", free_invokes:0}]},
    },
    tokens:[{ name:"Grom", actor:{ name:"Grom", system:{ tracks:{ mild:{ harm_can_absorb:2, aspect:{name:"Cut"} } } } } }],
  });
  const normalized = normalizeAspects([aspectWithMeta, {name:"Dark room", free_invokes:0}]);
  const docs = [...buildSaTextDocs(normalized,OPTS), buildSaFrameDoc(OPTS), buildSaBackgroundDoc(OPTS)];
  for(const doc of docs){
    const payload = toDocumentData({ ...doc, x:doc.x+ANCHOR.x, y:doc.y+ANCHOR.y }, { widgetId:WIDGET_ID, part:doc.part, index:doc.index, ownerType:SA_OWNER_TYPE });
    await scene.createEmbeddedDocuments("Drawing",[payload]);
  }
  // tokens gone
  scene.tokens = [];
  await syncSituationAspects(scene);
  const stored = scene.getFlag(SITUATION_ASPECTS_SCOPE, SITUATION_ASPECTS_KEY);
  assert.deepEqual(stored, [{name:"Dark room", free_invokes:0}]);
  const texts = partDocs(scene, SA_TEXT_PART).sort((a,b)=> flagOf(a,"index")-flagOf(b,"index"));
  assert.equal(texts.length,1);
  assert.equal(texts[0].text,"Dark room (0)");
});

test("sync adoption of FU record via reconciliation", async () => {
  // FU writes without meta
  const fuAspect = { name:"Bruised (Grom)", free_invokes:1, linked:true };
  const scene = mockScene({
    flags:{
      [FLAG_SCOPE]:{ [SITUATION_ASPECTS_WIDGET_FLAG]:{widgetId:WIDGET_ID, anchor:ANCHOR}, [CONFLICT_BOARD_FLAG]: validBoard() },
      [SITUATION_ASPECTS_SCOPE]:{[SITUATION_ASPECTS_KEY]: [fuAspect]},
    },
    tokens:[{ name:"Grom", actor:{ name:"Grom", system:{ tracks:{ mild:{ harm_can_absorb:2, aspect:{name:"Bruised"} } } } } }],
  });
  const normalized = normalizeAspects([fuAspect]);
  const docs = [...buildSaTextDocs(normalized,OPTS), buildSaFrameDoc(OPTS), buildSaBackgroundDoc(OPTS)];
  for(const doc of docs){
    const payload = toDocumentData({ ...doc, x:doc.x+ANCHOR.x, y:doc.y+ANCHOR.y }, { widgetId:WIDGET_ID, part:doc.part, index:doc.index, ownerType:SA_OWNER_TYPE });
    await scene.createEmbeddedDocuments("Drawing",[payload]);
  }
  await syncSituationAspects(scene);
  const stored = scene.getFlag(SITUATION_ASPECTS_SCOPE, SITUATION_ASPECTS_KEY);
  assert.equal(stored[0].consequence.trackKey,"mild");
  assert.equal(stored[0].consequence.cost,2);
  const texts = partDocs(scene, SA_TEXT_PART);
  assert.equal(texts[0].text, `✚ Bruised (Grom) (1)`);
});

/* ------------------------------------------------------------------ *
 * upsertSituationAspect meta handling
 * ------------------------------------------------------------------ */
test("upsertSituationAspect writes meta on create", async () => {
  const scene = {
    flags:{ [SITUATION_ASPECTS_SCOPE]:{[SITUATION_ASPECTS_KEY]:[]} },
    getFlag(scope,key){return this.flags[scope]?.[key];},
    async setFlag(scope,key,value){ (this.flags[scope]??={})[key]=structuredClone(value); return this;},
  };
  const meta = {trackKey:"mild", cost:2, actorName:"Grom"};
  await upsertSituationAspect(scene, "Grom", "Broken leg", "", meta);
  const list = scene.getFlag(SITUATION_ASPECTS_SCOPE, SITUATION_ASPECTS_KEY);
  assert.deepEqual(list, [{name:"Broken leg (Grom)", free_invokes:1, linked:true, consequence:meta}]);
});

test("upsertSituationAspect dedupe with system record without meta enriches with meta (no duplicate)", async () => {
  const existing = {name:"Broken leg (Grom)", free_invokes:1, linked:true}; // no meta
  const scene = {
    flags:{ [SITUATION_ASPECTS_SCOPE]:{[SITUATION_ASPECTS_KEY]:[existing]} },
    getFlag(scope,key){return this.flags[scope]?.[key];},
    async setFlag(scope,key,value){ (this.flags[scope]??={})[key]=structuredClone(value); return this;},
  };
  const meta = {trackKey:"mild", cost:2, actorName:"Grom"};
  await upsertSituationAspect(scene, "Grom", "Broken leg", "", meta);
  const list = scene.getFlag(SITUATION_ASPECTS_SCOPE, SITUATION_ASPECTS_KEY);
  assert.equal(list.length,1);
  assert.deepEqual(list[0], {name:"Broken leg (Grom)", free_invokes:1, linked:true, consequence: meta});
});

test("upsertSituationAspect rename preserves previous meta when new meta not passed", async () => {
  const existing = {name:"Old (Grom)", free_invokes:1, linked:true, consequence:{trackKey:"mild", cost:2, actorName:"Grom"}};
  const scene = {
    flags:{ [SITUATION_ASPECTS_SCOPE]:{[SITUATION_ASPECTS_KEY]:[existing]} },
    getFlag(scope,key){return this.flags[scope]?.[key];},
    async setFlag(scope,key,value){ (this.flags[scope]??={})[key]=structuredClone(value); return this;},
  };
  await upsertSituationAspect(scene, "Grom", "New", "Old");
  const list = scene.getFlag(SITUATION_ASPECTS_SCOPE, SITUATION_ASPECTS_KEY);
  assert.deepEqual(list, [{name:"New (Grom)", free_invokes:1, linked:true, consequence:{trackKey:"mild", cost:2, actorName:"Grom"}}]);
});

test("upsertSituationAspect rename updates meta when new meta passed", async () => {
  const existing = {name:"Old (Grom)", free_invokes:1, linked:true, consequence:{trackKey:"mild", cost:2, actorName:"Grom"}};
  const scene = {
    flags:{ [SITUATION_ASPECTS_SCOPE]:{[SITUATION_ASPECTS_KEY]:[existing]} },
    getFlag(scope,key){return this.flags[scope]?.[key];},
    async setFlag(scope,key,value){ (this.flags[scope]??={})[key]=structuredClone(value); return this;},
  };
  const newMeta = {trackKey:"mild", cost:4, actorName:"Grom"};
  await upsertSituationAspect(scene, "Grom", "New", "Old", newMeta);
  const list = scene.getFlag(SITUATION_ASPECTS_SCOPE, SITUATION_ASPECTS_KEY);
  assert.deepEqual(list, [{name:"New (Grom)", free_invokes:1, linked:true, consequence:newMeta}]);
});
