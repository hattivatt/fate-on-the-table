/**
 * Node tests for ConflictManager.js — the GM conflict manager / turn-order
 * actions of feature 5. Covers the pure/async turn logic (passTurn, nextTurn,
 * previousTurn, endTurn, startNextRound), the participant actions
 * (addCombatantFromToken, removeCombatant, moveCombatant), the after-change
 * `onStateChanged` callback, and the scene binding / placement guard helpers
 * (`getActiveConflictForScene`, `canPlaceConflictBoard`, `placeBoard`).
 *
 * No Foundry runtime is stubbed beyond minimal plain-object mocks; `game` /
 * `canvas` are defined only inside the tests that need them and are cleaned
 * up afterwards. `game.combat` is NEVER the source of truth in these tests —
 * every action receives its combat explicitly.
 */

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  passTurn,
  returnTurn,
  nextTurn,
  previousTurn,
  endTurn,
  startNextRound,
  addCombatantFromToken,
  removeCombatant,
  moveCombatant,
  getActiveConflictForScene,
  canPlaceConflictBoard,
  placeBoard,
  openConflictManager,
  ConflictManager,
  newRound,
  addCombatant,
} from "../scripts/ConflictManager.js";
import { createConflictBoard } from "../scripts/conflictBoardSchema.js";
import { FLAG_SCOPE } from "../scripts/constants.js";

afterEach(() => {
  delete globalThis.game;
  delete globalThis.canvas;
});

/* ------------------------------------------------------------------ *
 * Mocks (plain objects, no globals)
 * ------------------------------------------------------------------ */

const SYSTEM_SCOPE = "fate-core-official";
const HAS_ACTED_KEY = "hasActed";

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

function mockCombatant(id, overrides = {}) {
  const flags = { [SYSTEM_SCOPE]: { [HAS_ACTED_KEY]: overrides.hasActed ?? false } };
  return {
    id,
    tokenId: overrides.tokenId ?? `t-${id}`,
    name: overrides.name ?? id,
    defeated: overrides.defeated ?? false,
    sort: overrides.sort ?? 0,
    token: overrides.token ?? { name: overrides.name ?? id },
    flags,
    setFlagCalls: [],
    updateCalls: [],
    deleted: false,
    getFlag(scope, key) {
      return this.flags[scope]?.[key];
    },
    async setFlag(scope, key, value) {
      this.flags[scope] = { ...(this.flags[scope] ?? {}), [key]: value };
      this.setFlagCalls.push({ scope, key, value });
    },
    async update(data) {
      Object.assign(this, data);
      this.updateCalls.push(data);
    },
    async delete() {
      this.deleted = true;
    },
  };
}

let createdCounter = 0;

function mockCombat({
  id = "combat1",
  round = 1,
  turn = null,
  combatants = [],
  scene = { id: "scene1" },
} = {}) {
  const combat = {
    id,
    scene,
    sceneId: scene?.id ?? null,
    round,
    turn,
    combatants,
    updates: [],
    embeddedUpdates: { Combatant: [] },
    deleted: { Combatant: [] },
    created: { Combatant: [] },
    async update(data) {
      Object.assign(this, data);
      this.updates.push(data);
      return this;
    },
    async updateEmbeddedDocuments(type, updates) {
      if (type !== "Combatant") return this;
      this.embeddedUpdates.Combatant.push(...updates);
      for (const u of updates) {
        const c = combatants.find((x) => x.id === u._id);
        if (!c) continue;
        for (const [k, v] of Object.entries(u)) {
          if (k === "_id") continue;
          setPath(c, k, v);
        }
      }
      return this;
    },
    async deleteEmbeddedDocuments(type, ids) {
      if (type !== "Combatant") return this;
      this.deleted.Combatant.push(...ids);
      for (const id of ids) {
        const i = combatants.findIndex((x) => x.id === id);
        if (i >= 0) combatants.splice(i, 1);
      }
      return this;
    },
    async createEmbeddedDocuments(type, docs) {
      if (type !== "Combatant") return this;
      const created = docs.map(
        (d, i) =>
          mockCombatant(`c-new-${i}-${createdCounter++}`, { tokenId: d.tokenId }),
      );
      combatants.push(...created);
      this.created.Combatant.push(...created);
      return created;
    },
  };
  return combat;
}

const hasActedOf = (c) => c?.getFlag?.(SYSTEM_SCOPE, HAS_ACTED_KEY);

function mockScene({ tokens = [] } = {}) {
  const tokenMap = Object.fromEntries(tokens.map((t) => [t.id, t]));
  return {
    id: "scene1",
    drawings: [],
    tiles: [],
    tokens: {
      get: (id) => tokenMap[id] ?? null,
      [Symbol.iterator]: function* () {
        yield* tokens;
      },
    },
    flags: {},
    getFlag(scope, key) {
      return this.flags[scope]?.[key];
    },
    async setFlag(scope, key, value) {
      this.flags[scope] = { ...(this.flags[scope] ?? {}), [key]: value };
    },
    async unsetFlag(scope, key) {
      if (this.flags[scope]) delete this.flags[scope][key];
    },
    async update() {
      return this;
    },
    async updateEmbeddedDocuments() {
      return this;
    },
    async createEmbeddedDocuments() {
      return this;
    },
    async deleteEmbeddedDocuments() {
      return this;
    },
  };
}

/* ------------------------------------------------------------------ *
 * passTurn
 * ------------------------------------------------------------------ */

test("passTurn marks the current combatant acted, marks the target and moves the turn", async () => {
  const c1 = mockCombatant("c1");
  const c2 = mockCombatant("c2");
  const c3 = mockCombatant("c3");
  const combat = mockCombat({ turn: 0, combatants: [c1, c2, c3] });

  const res = await passTurn(combat, "c2", { sync: false });
  assert.equal(res.ok, true);
  assert.equal(res.turn, 1);
  assert.equal(combat.turn, 1);
  assert.equal(hasActedOf(c1), true); // previous current completes its turn
  assert.equal(hasActedOf(c2), true); // target is acted AND current (popcorn)
  assert.equal(hasActedOf(c3), false);
});

test("passTurn with no current turn marks the selected target acted and makes it current", async () => {
  const c1 = mockCombatant("c1");
  const c2 = mockCombatant("c2");
  const combat = mockCombat({ turn: null, combatants: [c1, c2] });

  const res = await passTurn(combat, "c2", { sync: false });
  assert.equal(res.ok, true);
  assert.equal(combat.turn, 1);
  assert.equal(hasActedOf(c1), false);
  assert.equal(hasActedOf(c2), true); // only the selected target is marked
});

test("passTurn blocks current, already-acted and unknown targets", async () => {
  const c1 = mockCombatant("c1");
  const c2 = mockCombatant("c2");
  const c3a = mockCombatant("c3", { hasActed: true });
  const combat = mockCombat({ turn: 0, combatants: [c1, c2, c3a] });

  const current = await passTurn(combat, "c1", { sync: false });
  assert.equal(current.ok, false);
  assert.equal(current.reason, "currentTarget");

  const acted = await passTurn(combat, "c3", { sync: false });
  assert.equal(acted.ok, false);
  assert.equal(acted.reason, "alreadyActed");

  const unknown = await passTurn(combat, "nope", { sync: false });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.reason, "unknownCombatant");
});

test("passTurn never passes to a defeated target", async () => {
  // Defeated combatants are never navigable in the turn order (same rule as
  // nextTurn/endTurn/startNextRound): the turn marker must not jump to them.
  const c1 = mockCombatant("c1");
  const c2 = mockCombatant("c2", { defeated: true });
  const combat = mockCombat({ turn: 0, combatants: [c1, c2] });

  const res = await passTurn(combat, "c2", { sync: false });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "defeated");
  assert.equal(combat.turn, 0); // marker untouched
  assert.equal(hasActedOf(c1), false); // current not completed
  assert.equal(hasActedOf(c2), false); // target not marked
});

test("passTurn is GM-only", async () => {
  const c1 = mockCombatant("c1");
  const c2 = mockCombatant("c2");
  const combat = mockCombat({ turn: 0, combatants: [c1, c2] });
  globalThis.game = { user: { isGM: false } };
  const res = await passTurn(combat, "c2", { sync: false });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "permission");
  assert.equal(combat.turn, 0);
  assert.equal(hasActedOf(c1), false);
});

/* ------------------------------------------------------------------ *
 * returnTurn (the FU `unact` analogue)
 * ------------------------------------------------------------------ */

test("returnTurn clears only the hasActed flag and never touches turn/round/order/other flags", async () => {
  const c1 = mockCombatant("c1");
  const c2 = mockCombatant("c2", { hasActed: true });
  const c3 = mockCombatant("c3");
  const combat = mockCombat({ round: 2, turn: 1, combatants: [c1, c2, c3] });
  combat.turns = [c1, c2, c3];

  const events = [];
  const res = await returnTurn(combat, "c2", {
    sync: false,
    onStateChanged: (e) => events.push(e),
  });
  assert.equal(res.ok, true);
  assert.equal(res.combatantId, "c2");
  assert.equal(hasActedOf(c2), false);
  // every other flag untouched
  assert.equal(hasActedOf(c1), false);
  assert.equal(hasActedOf(c3), false);
  // turn / round / combatant list / order untouched — no combat.update at all
  assert.equal(combat.turn, 1);
  assert.equal(combat.round, 2);
  assert.deepEqual(combat.combatants.map((c) => c.id), ["c1", "c2", "c3"]);
  assert.deepEqual(combat.updates, []);
  // only the one embedded flag write for the target
  assert.deepEqual(combat.embeddedUpdates.Combatant, [
    { _id: "c2", [`flags.${SYSTEM_SCOPE}.${HAS_ACTED_KEY}`]: false },
  ]);
  // afterChange fired the onStateChanged callback with the action name
  assert.equal(events.length, 1);
  assert.equal(events[0].action, "returnTurn");
  assert.equal(events[0].combat, combat);
});

test("returnTurn succeeds for turn:null, current and non-current acted targets", async () => {
  // turn === null: the flag is cleared, turn stays null
  const c1 = mockCombatant("c1", { hasActed: true });
  const combat1 = mockCombat({ turn: null, combatants: [c1] });
  const r1 = await returnTurn(combat1, "c1", { sync: false });
  assert.equal(r1.ok, true);
  assert.equal(hasActedOf(c1), false);
  assert.equal(combat1.turn, null);

  // current combatant with hasActed (popcorn): flag cleared, marker stays
  const a1 = mockCombatant("a1", { hasActed: true });
  const a2 = mockCombatant("a2", { hasActed: true });
  const combat2 = mockCombat({ turn: 0, combatants: [a1, a2] });
  const r2 = await returnTurn(combat2, "a1", { sync: false });
  assert.equal(r2.ok, true);
  assert.equal(hasActedOf(a1), false);
  assert.equal(combat2.turn, 0);
  assert.equal(hasActedOf(a2), true); // other combatants untouched

  // non-current acted target: the turn marker never moves
  const b1 = mockCombatant("b1", { hasActed: true });
  const b2 = mockCombatant("b2", { hasActed: true });
  const combat3 = mockCombat({ turn: 1, combatants: [b1, b2] });
  const r3 = await returnTurn(combat3, "b1", { sync: false });
  assert.equal(r3.ok, true);
  assert.equal(hasActedOf(b1), false);
  assert.equal(combat3.turn, 1);
});

test("returnTurn guards: notActed, defeated, unknown and non-GM", async () => {
  // already not acted -> safe {ok:false, reason:"notActed"}
  const c1 = mockCombatant("c1");
  const combat1 = mockCombat({ turn: 0, combatants: [c1] });
  const notActed = await returnTurn(combat1, "c1", { sync: false });
  assert.equal(notActed.ok, false);
  assert.equal(notActed.reason, "notActed");
  assert.equal(hasActedOf(c1), false);

  // defeated combatants are never returned (same rule as the card menu)
  const d1 = mockCombatant("d1", { hasActed: true, defeated: true });
  const combat2 = mockCombat({ combatants: [d1] });
  const defeated = await returnTurn(combat2, "d1", { sync: false });
  assert.equal(defeated.ok, false);
  assert.equal(defeated.reason, "defeated");
  assert.equal(hasActedOf(d1), true); // untouched

  // unknown combatant
  const u1 = mockCombatant("u1", { hasActed: true });
  const combat3 = mockCombat({ combatants: [u1] });
  const unknown = await returnTurn(combat3, "nope", { sync: false });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.reason, "unknownCombatant");

  // missing combat
  const noCombat = await returnTurn(null, "x", { sync: false });
  assert.equal(noCombat.ok, false);
  assert.equal(noCombat.reason, "noCombat");

  // non-GM
  const g1 = mockCombatant("g1", { hasActed: true });
  const combat4 = mockCombat({ combatants: [g1] });
  globalThis.game = { user: { isGM: false } };
  const perm = await returnTurn(combat4, "g1", { sync: false });
  assert.equal(perm.ok, false);
  assert.equal(perm.reason, "permission");
  assert.equal(hasActedOf(g1), true); // untouched
});

test("returnTurn with an enabled sync calls the serialized board sync safely", async () => {
  const c1 = mockCombatant("c1");
  const c2 = mockCombatant("c2", { hasActed: true });
  const combat = mockCombat({ turn: 0, combatants: [c1, c2] });
  const scene = mockScene({});
  const res = await returnTurn(combat, "c2", { scene, sync: true });
  assert.equal(res.ok, true);
  assert.equal(hasActedOf(c2), false);
  assert.equal(combat.turn, 0); // the marker never moves
  // the board sync ran through the shared API without throwing; the Fate
  // Utilities refresh was skipped gracefully (no Foundry runtime)
});

/* ------------------------------------------------------------------ *
 * endTurn
 * ------------------------------------------------------------------ */

test("endTurn marks the current combatant acted and advances to the next available", async () => {
  const c1 = mockCombatant("c1");
  const c2a = mockCombatant("c2", { hasActed: true });
  const c3 = mockCombatant("c3");
  const combat = mockCombat({ turn: 0, combatants: [c1, c2a, c3] });

  const res = await endTurn(combat, { sync: false });
  assert.equal(res.ok, true);
  assert.equal(res.turn, 2);
  assert.equal(combat.turn, 2);
  assert.equal(hasActedOf(c1), true);
  assert.equal(hasActedOf(c3), true); // the new current is marked acted too
});

test("endTurn skips defeated combatants when advancing", async () => {
  const c1 = mockCombatant("c1");
  const c2d = mockCombatant("c2", { defeated: true });
  const c3 = mockCombatant("c3");
  const combat = mockCombat({ turn: 0, combatants: [c1, c2d, c3] });

  const res = await endTurn(combat, { sync: false });
  assert.equal(res.ok, true);
  assert.equal(res.turn, 2);
});

test("endTurn reports noNextTurn without touching the turn when nothing is available", async () => {
  const c1 = mockCombatant("c1");
  const c2 = mockCombatant("c2");
  const c3 = mockCombatant("c3");
  const combat = mockCombat({ turn: 2, combatants: [c1, c2, c3] });

  const res = await endTurn(combat, { sync: false });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "noNextTurn");
  assert.equal(combat.turn, 2); // unchanged — no self-cleaning
  assert.equal(hasActedOf(c3), true);
});

test("endTurn requires an active current turn", async () => {
  const c1 = mockCombatant("c1");
  const combat = mockCombat({ turn: null, combatants: [c1] });
  const res = await endTurn(combat, { sync: false });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "noCurrentTurn");
});

/* ------------------------------------------------------------------ *
 * startNextRound
 * ------------------------------------------------------------------ */

test("startNextRound is blocked while any combatant can still act", async () => {
  const c1 = mockCombatant("c1");
  const c2 = mockCombatant("c2");
  const c3 = mockCombatant("c3");
  const combat = mockCombat({ turn: 0, combatants: [c1, c2, c3] });

  const res = await startNextRound(combat, { sync: false });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "pendingTurns");
  assert.equal(combat.round, 1);
});

test("startNextRound resets hasActed, increments round and nulls the turn", async () => {
  const c1 = mockCombatant("c1");
  const c2 = mockCombatant("c2");
  const c3 = mockCombatant("c3");
  const combat = mockCombat({ round: 3, turn: 0, combatants: [c1, c2, c3] });

  // everyone acts in order
  let r = await passTurn(combat, "c2", { sync: false });
  assert.equal(r.ok, true);
  r = await endTurn(combat, { sync: false });
  assert.equal(r.ok, true);
  r = await endTurn(combat, { sync: false });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "noNextTurn");

  const res = await startNextRound(combat, { sync: false });
  assert.equal(res.ok, true);
  assert.equal(res.round, 4);
  assert.equal(combat.round, 4);
  assert.equal(combat.turn, null);
  assert.equal(hasActedOf(c1), false);
  assert.equal(hasActedOf(c2), false);
  assert.equal(hasActedOf(c3), false);
});

/* ------------------------------------------------------------------ *
 * nextTurn / previousTurn
 * ------------------------------------------------------------------ */

test("nextTurn marks the current combatant acted and advances to the next available", async () => {
  const c1 = mockCombatant("c1");
  const c2d = mockCombatant("c2", { defeated: true });
  const c3 = mockCombatant("c3");
  const combat = mockCombat({ turn: 0, combatants: [c1, c2d, c3] });

  const res = await nextTurn(combat, { sync: false });
  assert.equal(res.ok, true);
  assert.equal(res.turn, 2);
  assert.equal(combat.turn, 2);
  assert.equal(res.newRound, false);
  assert.equal(hasActedOf(c1), true); // previous current marked acted
  assert.equal(hasActedOf(c2d), false); // defeated combatants are never marked
  assert.equal(hasActedOf(c3), true); // the selected new current is marked acted
});

test("nextTurn skips already-acted combatants and marks the new current acted", async () => {
  const c1 = mockCombatant("c1", { hasActed: true });
  const c2 = mockCombatant("c2", { hasActed: true });
  const c3 = mockCombatant("c3");
  const combat = mockCombat({ turn: 1, combatants: [c1, c2, c3] });

  const res = await nextTurn(combat, { sync: false });
  assert.equal(res.ok, true);
  assert.equal(res.turn, 2);
  assert.equal(hasActedOf(c2), true); // still acted
  assert.equal(hasActedOf(c3), true); // new current is marked acted
});

test("nextTurn with turn === null selects and marks the first active combatant", async () => {
  const c1 = mockCombatant("c1");
  const c2d = mockCombatant("c2", { defeated: true });
  const c3 = mockCombatant("c3");
  const combat = mockCombat({ turn: null, combatants: [c1, c2d, c3] });

  const res = await nextTurn(combat, { sync: false });
  assert.equal(res.ok, true);
  assert.equal(res.turn, 0);
  assert.equal(hasActedOf(c1), true); // the selected current is marked acted
});

test("nextTurn starts a new round after the last available participant completes", async () => {
  const c1 = mockCombatant("c1", { hasActed: true });
  const c2 = mockCombatant("c2", { hasActed: true });
  const c3 = mockCombatant("c3");
  const combat = mockCombat({ round: 1, turn: 2, combatants: [c1, c2, c3] });

  const res = await nextTurn(combat, { sync: false });
  assert.equal(res.ok, true);
  assert.equal(res.newRound, true);
  assert.equal(res.round, 2);
  assert.equal(res.turn, null);
  assert.equal(res.combatantId, "c3");
  assert.equal(combat.round, 2);
  assert.equal(combat.turn, null);
  assert.equal(hasActedOf(c1), false);
  assert.equal(hasActedOf(c2), false);
  assert.equal(hasActedOf(c3), false);
});

test("nextTurn stops at the end without auto-starting while someone is still available", async () => {
  const c1 = mockCombatant("c1"); // not acted yet — someone can still act
  const c2 = mockCombatant("c2", { hasActed: true });
  const c3 = mockCombatant("c3");
  const combat = mockCombat({ round: 1, turn: 2, combatants: [c1, c2, c3] });

  const res = await nextTurn(combat, { sync: false });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "atBoundary");
  assert.equal(combat.turn, 2);
  assert.equal(combat.round, 1);
  assert.equal(hasActedOf(c3), true); // current was still marked acted
  assert.equal(hasActedOf(c1), false);
});

test("nextTurn reports atBoundary when nothing active exists", async () => {
  const combat = mockCombat({
    turn: null,
    combatants: [
      mockCombatant("c1", { defeated: true }),
      mockCombatant("c2", { defeated: true }),
    ],
  });
  const res = await nextTurn(combat, { sync: false });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "atBoundary");
});

test("previousTurn goes back to the previous active combatant", async () => {
  const c1 = mockCombatant("c1");
  const c2d = mockCombatant("c2", { defeated: true });
  const c3 = mockCombatant("c3");
  const combat = mockCombat({ turn: 2, combatants: [c1, c2d, c3] });

  const res = await previousTurn(combat, { sync: false });
  assert.equal(res.ok, true);
  assert.equal(res.turn, 0);
});

test("previousTurn with turn === null selects the last active combatant", async () => {
  const c1 = mockCombatant("c1");
  const c2 = mockCombatant("c2");
  const c3 = mockCombatant("c3");
  const combat = mockCombat({ turn: null, combatants: [c1, c2, c3] });

  const res = await previousTurn(combat, { sync: false });
  assert.equal(res.turn, 2);
});

test("previousTurn stops at the beginning of the list", async () => {
  const c1 = mockCombatant("c1");
  const c2 = mockCombatant("c2");
  const combat = mockCombat({ turn: 0, combatants: [c1, c2] });
  const res = await previousTurn(combat, { sync: false });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "atBoundary");
  assert.equal(combat.turn, 0);
});

test("previousTurn never rewrites the hasActed flags", async () => {
  const c1 = mockCombatant("c1", { hasActed: true });
  const c2 = mockCombatant("c2", { hasActed: false });
  const combat = mockCombat({ turn: 1, combatants: [c1, c2] });

  const res = await previousTurn(combat, { sync: false });
  assert.equal(res.ok, true);
  assert.equal(res.turn, 0);
  assert.equal(combat.turn, 0);
  assert.equal(hasActedOf(c1), true); // untouched
  assert.equal(hasActedOf(c2), false); // untouched
});

/* ------------------------------------------------------------------ *
 * turn-index resolution against combat.turns (Fate Utilities order)
 *
 * Fate Utilities sets `combat.turn` to `game.combat.turns.indexOf(combatant)`
 * and reads the current back from `combat.turns[combat.turn]` — the order the
 * Foundry combat tracker displays, which can diverge from the
 * `combat.combatants` iteration order after a reorder (sort/initiative). The
 * manager actions must resolve their current/next/previous/target indices
 * against that SAME array (with `combatants` as the fallback) so they never
 * create a separate order.
 * ------------------------------------------------------------------ */

test("passTurn writes the turns-order index (Fate Utilities order)", async () => {
  const c1 = mockCombatant("c1");
  const c2 = mockCombatant("c2");
  const c3 = mockCombatant("c3");
  const combat = mockCombat({ turn: 0, combatants: [c1, c2, c3] });
  combat.turns = [c2, c1, c3]; // displayed order differs from insertion order

  // current per turns is c2; the target c1 -> turn = turns.indexOf(c1) = 1
  const res = await passTurn(combat, "c1", { sync: false });
  assert.equal(res.ok, true);
  assert.equal(res.turn, 1);
  assert.equal(combat.turn, 1);
  assert.equal(combat.turns[combat.turn].id, "c1"); // current read-back matches FU
  assert.equal(hasActedOf(c1), true); // target is acted AND current (popcorn)
  assert.equal(hasActedOf(c2), true); // previous current completes its turn
  assert.equal(hasActedOf(c3), false);
});

test("nextTurn advances within combat.turns after a reorder", async () => {
  const c1 = mockCombatant("c1");
  const c2 = mockCombatant("c2", { hasActed: true });
  const c3 = mockCombatant("c3");
  const combat = mockCombat({ turn: 0, combatants: [c1, c2, c3] });
  combat.turns = [c2, c1, c3]; // current (turns[0]) is c2, already acted

  const res = await nextTurn(combat, { sync: false });
  // next available in turns order after c2 is c1 (turns[1]); c3 stays put
  assert.equal(res.ok, true);
  assert.equal(res.turn, 1);
  assert.equal(combat.turns[combat.turn].id, "c1");
  assert.equal(hasActedOf(c1), true); // new current marked acted
  assert.equal(hasActedOf(c3), false);
});

test("endTurn resolves the current and the next within combat.turns", async () => {
  const c1 = mockCombatant("c1");
  const c2 = mockCombatant("c2");
  const c3 = mockCombatant("c3");
  const combat = mockCombat({ turn: 1, combatants: [c1, c2, c3] });
  combat.turns = [c3, c1, c2]; // turns[1] = c1 is current

  const res = await endTurn(combat, { sync: false });
  assert.equal(res.ok, true);
  assert.equal(res.combatantId, "c1");
  // next available after c1 in turns order is c2 (turns[2])
  assert.equal(res.turn, 2);
  assert.equal(combat.turns[combat.turn].id, "c2");
  assert.equal(hasActedOf(c1), true);
  assert.equal(hasActedOf(c2), true); // new current marked acted
  assert.equal(hasActedOf(c3), false);
});

test("previousTurn moves within combat.turns", async () => {
  const c1 = mockCombatant("c1");
  const c2 = mockCombatant("c2");
  const c3 = mockCombatant("c3");
  const combat = mockCombat({ turn: 1, combatants: [c1, c2, c3] });
  combat.turns = [c3, c1, c2]; // turns[1] = c1 is current

  const res = await previousTurn(combat, { sync: false });
  assert.equal(res.ok, true);
  assert.equal(res.turn, 0);
  assert.equal(combat.turns[combat.turn].id, "c3"); // previous active is turns[0]
});

test("moveCombatant reindexes the combat.turns order, not the insertion order", async () => {
  const c1 = mockCombatant("c1", { sort: 5 });
  const c2 = mockCombatant("c2", { sort: 15 });
  const c3 = mockCombatant("c3", { sort: 25 });
  const combat = mockCombat({ turn: 0, combatants: [c1, c2, c3] });
  combat.turns = [c3, c1, c2]; // displayed order already diverged

  const res = await moveCombatant(combat, "c1", "down", { sync: false });
  assert.equal(res.ok, true);
  assert.equal(res.index, 2);
  // written sort values reproduce the edited DISPLAYED order [c3, c2, c1]
  assert.equal(c3.sort, 5);
  assert.equal(c2.sort, 15);
  assert.equal(c1.sort, 25);
});

/* ------------------------------------------------------------------ *
 * addCombatantFromToken / removeCombatant / moveCombatant
 * ------------------------------------------------------------------ */

test("addCombatantFromToken adds a combatant through createCombatant", async () => {
  const c1 = mockCombatant("c1");
  const combat = mockCombat({ combatants: [c1] });
  const createCalls = [];
  combat.createCombatant = async (data) => {
    createCalls.push(data);
    const c = mockCombatant("c-token1", { tokenId: data.tokenId });
    combat.combatants.push(c);
    return c;
  };

  const token = { id: "token1", actor: { id: "actor1" } };
  const res = await addCombatantFromToken(combat, token, { sync: false });
  assert.equal(res.ok, true);
  assert.deepEqual(createCalls, [{ tokenId: "token1", actorId: "actor1", hidden: false }]);
  assert.equal(res.combatant.id, "c-token1");
});

test("addCombatantFromToken falls back to createEmbeddedDocuments", async () => {
  const c1 = mockCombatant("c1");
  const combat = mockCombat({ combatants: [c1] });
  delete combat.createCombatant;

  const token = { id: "token1", actor: { id: "actor1" } };
  const res = await addCombatantFromToken(combat, token, { sync: false });
  assert.equal(res.ok, true);
  assert.equal(combat.created.Combatant.length, 1);
  assert.equal(combat.created.Combatant[0].tokenId, "token1");
});

test("addCombatantFromToken rejects duplicates, missing tokens and empty combats", async () => {
  const c1 = mockCombatant("c1"); // tokenId "t-c1"
  const combat = mockCombat({ combatants: [c1] });

  const dup = await addCombatantFromToken(
    combat,
    { id: "t-c1", actor: { id: "a" } },
    { sync: false },
  );
  assert.equal(dup.ok, false);
  assert.equal(dup.reason, "alreadyPresent");

  const noToken = await addCombatantFromToken(combat, null, { sync: false });
  assert.equal(noToken.ok, false);
  assert.equal(noToken.reason, "noToken");

  const noCombat = await addCombatantFromToken(null, { id: "x" }, { sync: false });
  assert.equal(noCombat.reason, "noCombat");
});

test("removeCombatant deletes the embedded combatant document", async () => {
  const c1 = mockCombatant("c1");
  const c2 = mockCombatant("c2");
  const combat = mockCombat({ combatants: [c1, c2] });

  const res = await removeCombatant(combat, "c1", { sync: false });
  assert.equal(res.ok, true);
  assert.deepEqual(combat.deleted.Combatant, ["c1"]);
  assert.deepEqual(combat.combatants.map((c) => c.id), ["c2"]);

  const unknown = await removeCombatant(combat, "missing", { sync: false });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.reason, "unknownCombatant");
});

test("moveCombatant reorders by reindexing sort values", async () => {
  const c1 = mockCombatant("c1", { sort: 0 });
  const c2 = mockCombatant("c2", { sort: 1 });
  const c3 = mockCombatant("c3", { sort: 2 });
  const combat = mockCombat({ combatants: [c1, c2, c3] });

  const res = await moveCombatant(combat, "c2", "up", { sync: false });
  assert.equal(res.ok, true);
  assert.equal(res.index, 0);
  assert.equal(c2.sort, 5);
  assert.equal(c1.sort, 15);
  assert.equal(c3.sort, 25);
});

test("moveCombatant rejects bad directions and boundary moves", async () => {
  const c1 = mockCombatant("c1", { sort: 0 });
  const c2 = mockCombatant("c2", { sort: 1 });
  const combat = mockCombat({ combatants: [c1, c2] });

  const bad = await moveCombatant(combat, "c1", "sideways", { sync: false });
  assert.equal(bad.reason, "badDirection");

  const up = await moveCombatant(combat, "c1", "up", { sync: false });
  assert.equal(up.reason, "atBoundary");

  const down = await moveCombatant(combat, "c2", "down", { sync: false });
  assert.equal(down.reason, "atBoundary");
});

/* ------------------------------------------------------------------ *
 * after-change callback
 * ------------------------------------------------------------------ */

test("onStateChanged fires after a mutation with the action payload", async () => {
  const c1 = mockCombatant("c1");
  const c2 = mockCombatant("c2");
  const combat = mockCombat({ turn: 0, combatants: [c1, c2] });

  const events = [];
  const res = await passTurn(combat, "c2", {
    sync: false,
    onStateChanged: (e) => events.push(e),
  });
  assert.equal(res.ok, true);
  assert.equal(events.length, 1);
  assert.equal(events[0].action, "passTurn");
  assert.equal(events[0].combat, combat);
  assert.equal(events[0].scene, null); // no scene resolvable in Node
});

test("turn actions with an enabled sync call the serialized board sync safely", async () => {
  const c1 = mockCombatant("c1");
  const c2 = mockCombatant("c2");
  const c3 = mockCombatant("c3");
  const combat = mockCombat({ turn: 0, combatants: [c1, c2, c3] });
  const scene = mockScene({});
  const res = await passTurn(combat, "c2", { scene, sync: true });
  assert.equal(res.ok, true);
  assert.equal(combat.turn, 1);
  assert.equal(hasActedOf(c1), true); // previous current completes its turn
  assert.equal(hasActedOf(c2), true); // target is acted AND current (popcorn)
  // the board sync ran through the shared (serialized) API without throwing,
  // and the Fate Utilities refresh was skipped gracefully (no Foundry runtime)
  const roundRes = await startNextRound(combat, { scene });
  // c3 has not acted yet -> the round is still blocked by the turn-order policy
  assert.equal(roundRes.ok, false);
  assert.equal(roundRes.reason, "pendingTurns");
});

/* ------------------------------------------------------------------ *
 * Scene binding / placement guards (game + canvas mocks)
 * ------------------------------------------------------------------ */

test("getActiveConflictForScene returns the active combat bound to the scene", () => {
  const combat = mockCombat({ scene: { id: "scene1" } });
  globalThis.game = { combat };

  assert.equal(getActiveConflictForScene(null), combat);
  assert.equal(getActiveConflictForScene({ id: "scene1" }), combat);
  assert.equal(getActiveConflictForScene({ id: "other" }), null);

  globalThis.game = { combat: null };
  assert.equal(getActiveConflictForScene(null), null);
});

test("getActiveConflictForScene is null without a game runtime", () => {
  assert.equal(getActiveConflictForScene(null), null);
});

test("canPlaceConflictBoard requires GM, active combat, scene binding and tokens", () => {
  const c1 = mockCombatant("c1", { tokenId: "t-c1" });
  const combat = mockCombat({ scene: { id: "scene1" }, combatants: [c1] });
  const scene = { id: "scene1", tokens: { get: (id) => (id === "t-c1" ? { id: "t-c1" } : null) } };

  globalThis.game = { combat, user: { isGM: true }, scenes: { get: () => scene } };
  globalThis.canvas = { scene };
  assert.equal(canPlaceConflictBoard(scene, combat), true);

  globalThis.game = { combat, user: { isGM: false }, scenes: { get: () => scene } };
  assert.equal(canPlaceConflictBoard(scene, combat), false);

  globalThis.game = { combat: null, user: { isGM: true }, scenes: { get: () => scene } };
  assert.equal(canPlaceConflictBoard(scene, null), false);
});

test("placeBoard returns a clear failure for a non-GM or missing combat", async () => {
  const scene = { id: "scene1", tokens: { get: () => null } };
  globalThis.canvas = { scene };

  globalThis.game = { user: { isGM: false }, combat: null };
  const perm = await placeBoard({ scene });
  assert.equal(perm.ok, false);
  assert.equal(perm.reason, "permission");

  globalThis.game = { user: { isGM: true }, combat: null };
  const noCombat = await placeBoard({ scene });
  assert.equal(noCombat.ok, false);
  assert.equal(noCombat.reason, "noCombat");
});

test("placeBoard rejects a combat not bound to the scene", async () => {
  const c1 = mockCombatant("c1", { tokenId: "t-c1" });
  const combat = mockCombat({ scene: { id: "other" }, combatants: [c1] });
  const scene = { id: "scene1", tokens: { get: (id) => ({ id }) } };
  globalThis.canvas = { scene };
  globalThis.game = { combat, user: { isGM: true } };

  const res = await placeBoard({ scene, combat });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "notOnScene");
});

test("placeBoard requires combatants with tokens on the scene", async () => {
  const c1 = mockCombatant("c1", { tokenId: "t-missing" });
  const combat = mockCombat({ scene: { id: "scene1" }, combatants: [c1] });
  const scene = { id: "scene1", tokens: { get: () => null } };
  globalThis.canvas = { scene };
  globalThis.game = { combat, user: { isGM: true } };

  const res = await placeBoard({ scene, combat });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "noTokens");
});

test("placeBoard reuses an already placed board instead of creating a second one", async () => {
  const c1 = mockCombatant("c1", { tokenId: "t-c1" });
  const combat = mockCombat({ scene: { id: "scene1" }, combatants: [c1] });
  const state = createConflictBoard({
    combatId: "combat1",
    sizePreset: "medium",
    origin: { x: 0, y: 0 },
  });
  const scene = mockScene({ tokens: [{ id: "t-c1" }] });
  scene.flags[FLAG_SCOPE] = {
    conflictBoard: state,
    conflictBoardWidget: { widgetId: "w", zoneWidgetIds: {}, cardWidgetIds: {} },
  };
  globalThis.canvas = { scene };
  globalThis.game = { combat, user: { isGM: true } };

  const res = await placeBoard({ scene, combat });
  assert.equal(res.ok, true);
  assert.equal(res.reused, true);
  assert.equal(res.state.combatId, "combat1");
});
