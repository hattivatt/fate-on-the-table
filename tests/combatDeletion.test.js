import { test } from "node:test";
import assert from "node:assert/strict";
import { createCombatDeletionTracker } from "../scripts/hooks/combatDeletion.js";

test("a combat is tracked only between preDeleteCombat and deleteCombat", () => {
  const t = createCombatDeletionTracker();
  assert.equal(t.isDeleting("c1"), false);
  t.begin("c1");
  assert.equal(t.isDeleting("c1"), true);
  t.end("c1");
  assert.equal(t.isDeleting("c1"), false);
  assert.equal(t.size, 0);
});

test("deletions are tracked per combat id (no cross-combat freeze)", () => {
  const t = createCombatDeletionTracker();
  t.begin("c1");
  assert.equal(t.isDeleting("c2"), false);
  assert.equal(t.isDeleting(undefined, "c2"), false);
  assert.equal(t.isDeleting("c2", "c1"), true, "any matching id counts");
  t.begin("c2");
  t.end("c1");
  assert.equal(t.isDeleting("c1"), false);
  assert.equal(t.isDeleting("c2"), true);
});

test("empty ids are ignored", () => {
  const t = createCombatDeletionTracker();
  t.begin(null);
  t.begin("");
  assert.equal(t.size, 0);
  assert.equal(t.isDeleting(null, undefined, ""), false);
});

test("a cancelled deletion (no deleteCombat) expires after the TTL", () => {
  let clock = 1000;
  const t = createCombatDeletionTracker({ ttlMs: 500, now: () => clock });
  t.begin("c1");
  clock += 500;
  assert.equal(t.isDeleting("c1"), true, "still in flight at the TTL boundary");
  clock += 1;
  assert.equal(t.isDeleting("c1"), false);
  assert.equal(t.size, 0);
});
