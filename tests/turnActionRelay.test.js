/**
 * Node tests for turnActionRelay.js — the pure relay-request validator behind
 * the player → GM "Pass turn" bridge.
 *
 * The relay module is import-safe under Node (no `game`/`foundry` at import
 * time), so these tests exercise `validateRelayRequest` / `resolveRelayIdentity`
 * directly with pre-computed flags, plus the exported action allow-list and
 * socket event.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RELAY_ACTIONS,
  SOCKET_EVENT,
  _resetTurnActionRelayForTests,
  initTurnActionRelay,
  resolveRelayIdentity,
  validateRelayRequest,
} from "../scripts/turnActionRelay.js";

const REQUEST = {
  action: "passTurn",
  combatId: "combat-1",
  combatantId: "combatant-2",
  userId: "player-1",
};

test("only passTurn is allowed through the relay", () => {
  assert.deepEqual([...RELAY_ACTIONS], ["passTurn"]);
  assert.equal(typeof SOCKET_EVENT, "string");
  assert.ok(SOCKET_EVENT.length > 0);
});

test("unknown action is rejected", () => {
  assert.deepEqual(
    validateRelayRequest(
      { ...REQUEST, action: "newRound" },
      { userIsGm: true },
    ),
    { ok: false, reason: "unknownAction" },
  );
  assert.deepEqual(
    validateRelayRequest({ ...REQUEST, action: null }, { userIsGm: true }),
    { ok: false, reason: "unknownAction" },
  );
});

test("a missing or unknown combat is rejected with noCombat", () => {
  assert.deepEqual(
    validateRelayRequest({ ...REQUEST, combatId: null }, { userIsGm: true }),
    { ok: false, reason: "noCombat" },
  );
  assert.deepEqual(
    validateRelayRequest(REQUEST, { userIsGm: true, combatExists: false }),
    { ok: false, reason: "noCombat" },
  );
});

test("a missing or foreign combatant is rejected with unknownCombatant", () => {
  assert.deepEqual(
    validateRelayRequest(
      { ...REQUEST, combatantId: null },
      { userIsGm: true },
    ),
    { ok: false, reason: "unknownCombatant" },
  );
  assert.deepEqual(
    validateRelayRequest(REQUEST, { userIsGm: true, combatantExists: false }),
    { ok: false, reason: "unknownCombatant" },
  );
});

test("a player who does not own the current combatant is rejected", () => {
  assert.deepEqual(
    validateRelayRequest(REQUEST, {
      userIsGm: false,
      currentCombatantId: "combatant-1",
      currentCombatantOwnerIds: ["player-2"],
    }),
    { ok: false, reason: "permission" },
  );
});

test("a player is rejected when no current combatant exists", () => {
  assert.deepEqual(
    validateRelayRequest(REQUEST, {
      userIsGm: false,
      currentCombatantId: null,
      currentCombatantOwnerIds: ["player-1"],
    }),
    { ok: false, reason: "permission" },
  );
});

test("a player without a user id cannot pass the ownership gate", () => {
  assert.deepEqual(
    validateRelayRequest(
      { ...REQUEST, userId: null },
      {
        userIsGm: false,
        currentCombatantId: "combatant-1",
        currentCombatantOwnerIds: ["player-1"],
      },
    ),
    { ok: false, reason: "permission" },
  );
});

test("the owner of the current combatant may pass the turn", () => {
  const context = {
    userIsGm: false,
    currentCombatantId: "combatant-1",
    currentCombatantOwnerIds: ["player-1", "player-3"],
  };
  assert.deepEqual(validateRelayRequest(REQUEST, context), {
    ok: true,
    reason: null,
  });
});

test("returnTurn is no longer relayable (players cannot reset others' hasActed)", () => {
  const context = {
    userIsGm: false,
    currentCombatantId: "combatant-1",
    currentCombatantOwnerIds: ["player-1"],
  };
  assert.deepEqual(
    validateRelayRequest({ ...REQUEST, action: "returnTurn" }, context),
    { ok: false, reason: "unknownAction" },
  );
  // Even the GM is stopped by the allow-list before the ownership bypass.
  assert.deepEqual(
    validateRelayRequest(
      { ...REQUEST, action: "returnTurn" },
      { ...context, userIsGm: true },
    ),
    { ok: false, reason: "unknownAction" },
  );
});

test("a forged payload userId is rejected: identity comes from senderId", () => {
  // The payload claims to be the owner of the current combatant ("player-1"),
  // but the authenticated socket sender is an unrelated user. The GM handler
  // feeds the trusted sender id to the validator, which then fails ownership.
  const { userId, forged } = resolveRelayIdentity(
    { ...REQUEST, userId: "player-1" },
    "attacker",
  );
  assert.equal(userId, "attacker");
  assert.equal(forged, true);
  assert.deepEqual(
    validateRelayRequest(
      { ...REQUEST, userId },
      {
        userIsGm: false,
        currentCombatantId: "combatant-1",
        currentCombatantOwnerIds: ["player-1"],
      },
    ),
    { ok: false, reason: "permission" },
  );
});

test("a matching payload userId uses the trusted senderId", () => {
  const { userId, forged } = resolveRelayIdentity(REQUEST, "player-1");
  assert.equal(userId, "player-1");
  assert.equal(forged, false);
});

test("a missing senderId falls back to the payload userId (Forge test)", () => {
  const { userId, forged } = resolveRelayIdentity(REQUEST, undefined);
  // Fallback restores functionality: the claimed id is used (with a warning),
  // never flagged as forged so the owner may still pass the turn.
  assert.equal(userId, "player-1");
  assert.equal(forged, false);
  assert.deepEqual(
    validateRelayRequest(
      { ...REQUEST, userId },
      {
        userIsGm: false,
        currentCombatantId: "combatant-1",
        currentCombatantOwnerIds: ["player-1"],
      },
    ),
    { ok: true, reason: null },
  );
});

test("no senderId and no payload userId stays fail-closed", () => {
  const { userId, forged } = resolveRelayIdentity(
    { ...REQUEST, userId: null },
    undefined,
  );
  assert.equal(userId, null);
  assert.equal(forged, false);
  assert.deepEqual(
    validateRelayRequest(
      { ...REQUEST, userId },
      {
        userIsGm: false,
        currentCombatantId: "combatant-1",
        currentCombatantOwnerIds: ["player-1"],
      },
    ),
    { ok: false, reason: "permission" },
  );
});

test("the GM bypasses the ownership check", () => {
  assert.deepEqual(
    validateRelayRequest(REQUEST, {
      userIsGm: true,
      currentCombatantId: "combatant-1",
      currentCombatantOwnerIds: [],
    }),
    { ok: true, reason: null },
  );
});

test("validator never mutates its inputs", () => {
  const request = { ...REQUEST };
  const context = {
    userIsGm: false,
    currentCombatantId: "combatant-1",
    currentCombatantOwnerIds: ["player-1"],
  };
  const requestSnapshot = JSON.stringify(request);
  const contextSnapshot = JSON.stringify(context);
  validateRelayRequest(request, context);
  assert.equal(JSON.stringify(request), requestSnapshot);
  assert.equal(JSON.stringify(context), contextSnapshot);
});

test("handleRelayRequest always answers: a throwing context resolution still sends an error response", async () => {
  const emits = [];
  const socket = {
    handlers: new Map(),
    on(event, handler) {
      this.handlers.set(event, handler);
    },
    emit(event, data) {
      emits.push({ event, data });
    },
  };
  // `turns` throws on access, standing in for any unexpected exception during
  // combat/combatant/owner resolution (e.g. a synthetic token actor).
  const hostileCombat = {
    id: "combat-1",
    get turns() {
      throw new Error("boom");
    },
    combatants: [],
  };
  globalThis.game = {
    user: { id: "gm-1", isGM: true },
    users: [],
    socket,
    combat: hostileCombat,
  };
  _resetTurnActionRelayForTests();
  try {
    initTurnActionRelay();
    const handler = socket.handlers.get(SOCKET_EVENT);
    assert.equal(typeof handler, "function");
    handler(
      {
        kind: "request",
        requestId: "req-1",
        action: "passTurn",
        combatId: "combat-1",
        combatantId: "combatant-1",
        userId: "player-1",
      },
      undefined,
    );
    await new Promise((r) => setTimeout(r, 0));
  } finally {
    _resetTurnActionRelayForTests();
    delete globalThis.game;
  }
  const response = emits.find((e) => e.data?.kind === "response");
  assert.ok(response, "a response is always emitted");
  assert.equal(response.data.requestId, "req-1");
  assert.equal(response.data.action, "passTurn");
  assert.equal(response.data.ok, false);
  assert.equal(response.data.reason, "error");
});
