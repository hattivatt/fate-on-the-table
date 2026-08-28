/**
 * Reviewer supplemental coverage — closes gaps noted in the feature review
 * without touching product code. Focuses on:
 *  - aspect without meta whose actor left → must STAY (not deleted)
 *  - two consequence tracks with identical text → adoption picks first in entries order
 *  - NaN / string "4" cost normalization & idempotence (no eternal changed)
 *  - rename preserves zoneIds, free_invokes and unknown fields
 *  - upsert dust-lifecycle: FU record without meta is not duplicated; meta added via reconcile
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
    hasProperty: (obj, path) => {
      let t = obj;
      for (const k of String(path).split(".")) {
        if (t == null || !(k in t)) return false;
        t = t[k];
      }
      return true;
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
  consequenceMarker,
  CONSEQUENCE_MARKER_DEFAULT,
  buildConsequenceMeta,
  reconcileConsequences,
} = await import("../scripts/situationAspectConsequences.js");

const { upsertSituationAspect } = await import("../scripts/ConsequenceInteractions.js");
import { SITUATION_ASPECTS_SCOPE, SITUATION_ASPECTS_KEY } from "../scripts/constants.js";

test("reconcile: aspect WITHOUT meta whose suffix actor left must STAY (deletion only for meta-bound aspects)", () => {
  // Linked aspect without meta matches a consequence text, but actor is absent.
  // Rule: only aspects WITH meta are garbage-collected on actor disappearance.
  const list = [
    { name: "Broken leg (Grom)", free_invokes: 1, linked: true },
    { name: "Dark room", free_invokes: 0 },
    { name: "Another (Mira)", free_invokes: 1, linked: true },
  ];
  // No actors on scene -> suffix actors missing. Without-meta entries must survive.
  const { list: out, changed } = reconcileConsequences(list, []);
  assert.equal(changed, false); // idempotent no-op
  assert.equal(out, list); // same reference when not changed
  assert.deepEqual(out, list);
  // Now add Grom with a DIFFERENT consequence text — still should not adopt/delete the "Broken leg" without-meta entry because base mismatch -> remains
  const actors = [{ name: "Grom", tracks: { mild: { harm_can_absorb: 2, aspect: { name: "Other wound" } } } }];
  const r2 = reconcileConsequences(list, actors);
  assert.equal(r2.changed, false);
  assert.deepEqual(r2.list[0], list[0]);
});

test("reconcile: two tracks with identical text — adoption picks first in entries order", () => {
  const list = [{ name: "Burn (Grom)", free_invokes: 1, linked: true }];
  const actors = [
    {
      name: "Grom",
      tracks: {
        mild: { harm_can_absorb: 2, aspect: { name: "Burn" } },
        severe: { harm_can_absorb: 4, aspect: { name: "Burn" } }, // same text, later key
        extra: { harm_can_absorb: 6, aspect: { name: "Burn" } },
      },
    },
  ];
  const { list: out, changed } = reconcileConsequences(list, actors);
  assert.equal(changed, true);
  // Should adopt the FIRST matching track (mild, cost 2) — Object.entries order
  assert.equal(out[0].consequence.trackKey, "mild");
  assert.equal(out[0].consequence.cost, 2);
  assert.equal(out[0].consequence.actorName, "Grom");
  // Idempotent second pass
  const second = reconcileConsequences(out, actors);
  assert.equal(second.changed, false);
});

test("reconcile: NaN cost does not cause eternal changed (Object.is)", () => {
  // Track with non-numeric harm (e.g., edited to "bad") yields NaN cost
  const list = [
    {
      name: "Weird (Grom)",
      free_invokes: 1,
      linked: true,
      consequence: { trackKey: "mild", cost: 2, actorName: "Grom" },
    },
  ];
  const actorsNaN = [{ name: "Grom", tracks: { mild: { harm_can_absorb: "bad", aspect: { name: "Weird" } } } }];
  const first = reconcileConsequences(list, actorsNaN);
  assert.equal(first.changed, true);
  assert.ok(Number.isNaN(first.list[0].consequence.cost), "cost becomes NaN");
  // Second call with same NaN must be no-op (Object.is(NaN, NaN) === true)
  const second = reconcileConsequences(first.list, actorsNaN);
  assert.equal(second.changed, false);
  assert.equal(second.list, first.list);
  // String "4" vs number 4 — normalized to same, no churn
  const actors4 = [{ name: "Grom", tracks: { mild: { harm_can_absorb: "4", aspect: { name: "Weird" } } } }];
  const listWith4 = [
    { name: "Weird (Grom)", free_invokes: 1, linked: true, consequence: { trackKey: "mild", cost: 4, actorName: "Grom" } },
  ];
  const r = reconcileConsequences(listWith4, actors4);
  assert.equal(r.changed, false);
});

test("reconcile: rename preserves zoneIds, free_invokes, linked and unknown fields", () => {
  const list = [
    {
      name: "Old (Grom)",
      free_invokes: 3,
      linked: true,
      zoneIds: ["z1", "z2"],
      consequence: { trackKey: "mild", cost: 2, actorName: "Grom" },
      extraField: "keep me",
      nested: { a: 1 },
    },
  ];
  const actors = [{ name: "Grom", tracks: { mild: { harm_can_absorb: 6, aspect: { name: "New" } } } }];
  const { list: out, changed } = reconcileConsequences(list, actors);
  assert.equal(changed, true);
  assert.equal(out[0].name, "New (Grom)");
  assert.equal(out[0].free_invokes, 3);
  assert.deepEqual(out[0].zoneIds, ["z1", "z2"]);
  assert.equal(out[0].linked, true);
  assert.equal(out[0].extraField, "keep me");
  assert.deepEqual(out[0].nested, { a: 1 });
  assert.equal(out[0].consequence.cost, 6);
});

test("consequenceMarker: string cost normalization", () => {
  assert.equal(consequenceMarker("2"), "✚");
  assert.equal(consequenceMarker("6"), "☠");
  assert.equal(consequenceMarker("bad"), CONSEQUENCE_MARKER_DEFAULT);
  assert.equal(buildConsequenceMeta("mild", "4", "Grom").cost, 4);
});

test("upsert: FU record without meta is deduped without adding meta (adoption deferred to reconcile)", async () => {
  // Mirrors the existing behavior but explicitly documents the deferred-adoption contract
  const scene = {
    flags: { [SITUATION_ASPECTS_SCOPE]: { [SITUATION_ASPECTS_KEY]: [{ name: "Broken leg (Grom)", free_invokes: 1, linked: true }] } },
    getFlag(scope, key) { return this.flags[scope]?.[key]; },
    async setFlag(scope, key, value) { (this.flags[scope] ??= {})[key] = structuredClone(value); return this; },
  };
  const meta = { trackKey: "mild", cost: 2, actorName: "Grom" };
  await upsertSituationAspect(scene, "Grom", "Broken leg", "", meta);
  const list = scene.getFlag(SITUATION_ASPECTS_SCOPE, SITUATION_ASPECTS_KEY);
  assert.equal(list.length, 1);
  assert.equal(list[0].name, "Broken leg (Grom)");
  // meta NOT added by upsert — reconcile will adopt
  assert.equal(list[0].consequence, undefined);
  const actors = [{ name: "Grom", tracks: { mild: { harm_can_absorb: 2, aspect: { name: "Broken leg" } } } }];
  const reconciled = reconcileConsequences(list, actors);
  assert.equal(reconciled.changed, true);
  assert.deepEqual(reconciled.list[0].consequence, meta);
});
