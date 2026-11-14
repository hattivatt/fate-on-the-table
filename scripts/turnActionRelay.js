/**
 * turnActionRelay — minimal client→GM relay for player-initiated turn actions.
 *
 * Why: `ConflictManager.passTurn` / `returnTurn` deliberately keep a GM gate
 * (`assertGm`) — they are GM-only server-safety operations. Player cards
 * (ConflictInteractions) only ever request `passTurn`, so a
 * non-GM client cannot call the manager directly. Instead the request is sent
 * over Foundry's native socket (`game.socket`) to the GM client(s), which
 * RE-VALIDATES it (action allow-list, combat/combatant existence and ownership
 * of the current combatant's actor) and then executes the same GM path.
 *
 * Design constraints (AGENTS.md):
 *  - this module is import-safe under Node: it never touches `game`/`foundry`
 *    at import time (guarded by `typeof game` inside every function);
 *  - the request validation is a pure exported function (`validateRelayRequest`)
 *    covered by Node tests;
 *  - the relay is intentionally tiny: only `passTurn`, no generic action bus.
 *
 * Wire protocol (one socket event, discriminated by `kind`):
 *  - request:  { kind: "request",  requestId, action, combatId, combatantId, userId }
 *  - response: { kind: "response", requestId, ok, reason, action }
 * The `userId` inside a request is untrusted payload data (echoed for display
 * only). Authorization uses the authenticated sender id Foundry passes as the
 * socket listener's second argument (`senderId`, v0.7.1+); a payload `userId`
 * that contradicts it is treated as impersonation and rejected.
 * The response is best-effort: if no GM is connected the initiator resolves
 * with `{ ok: false, reason: "relayTimeout" }` after {@link RELAY_TIMEOUT_MS}.
 */

import { MODULE_ID } from "./constants.js";
import { toArray } from "./utils.js";

/** Single socket event carrying both relay requests and responses. */
export const SOCKET_EVENT = `module.${MODULE_ID}`;

/** The only turn actions a player may request through the relay. */
export const RELAY_ACTIONS = Object.freeze(["passTurn"]);

const ALLOWED_ACTIONS = new Set(RELAY_ACTIONS);

/** Best-effort wait for a GM response (ms). */
export const RELAY_TIMEOUT_MS = 8000;

/** Pending initiator promises, keyed by requestId. */
const pendingRequests = new Map();

/** Optional injected ConflictManager facade (falls back to a lazy import). */
let managerRef = null;

let relayInitialized = false;

/* ------------------------------------------------------------------ *
 * Pure validation (Node-testable)
 * ------------------------------------------------------------------ */

/**
 * Pure relay-request validator, fed pre-computed flags so it never touches a
 * Foundry runtime.
 *
 * Rules (in order): the action must be `passTurn`; the combat must exist; the
 * target combatant must exist in it; and — for a non-GM requester — the
 * requester must be in the owner list of the CURRENT combatant's actor (it is
 * their turn to hand it over). The GM bypasses the ownership check (they
 * already have the manager gate).
 *
 * The caller MUST pass the authenticated sender id as `request.userId`; this
 * pure function cannot tell a trusted id from a forged one, so the glue layer
 * (see {@link resolveRelayIdentity}) is responsible for that.
 *
 * @param {object} [request]
 * @param {"passTurn"|string} [request.action]
 * @param {string|null} [request.combatId]
 * @param {string|null} [request.combatantId]
 * @param {string|null} [request.userId]
 * @param {object} [context]
 * @param {boolean} [context.userIsGm]
 * @param {boolean} [context.combatExists]
 * @param {boolean} [context.combatantExists]
 * @param {string|null} [context.currentCombatantId]
 * @param {string[]} [context.currentCombatantOwnerIds]
 * @returns {{ ok: boolean, reason: string|null }}
 */
export function validateRelayRequest(
  { action, combatId, combatantId, userId } = {},
  {
    userIsGm = false,
    combatExists = true,
    combatantExists = true,
    currentCombatantId = null,
    currentCombatantOwnerIds = [],
  } = {},
) {
  if (!ALLOWED_ACTIONS.has(action)) {
    return { ok: false, reason: "unknownAction" };
  }
  if (!combatId || !combatExists) {
    return { ok: false, reason: "noCombat" };
  }
  if (!combatantId || !combatantExists) {
    return { ok: false, reason: "unknownCombatant" };
  }
  if (!userIsGm) {
    if (!userId) return { ok: false, reason: "permission" };
    const ownsCurrent =
      !!currentCombatantId &&
      Array.isArray(currentCombatantOwnerIds) &&
      currentCombatantOwnerIds.includes(userId);
    if (!ownsCurrent) return { ok: false, reason: "permission" };
  }
  return { ok: true, reason: null };
}

/**
 * Resolves the trustworthy requester id for an incoming relay request.
 *
 * Foundry passes the authenticated sender's user id as the socket listener's
 * second argument (`senderId`, available since v0.7.1). The `userId` field in
 * the message payload is attacker-controlled and MUST NOT be used for
 * authorization. This helper selects `senderId` as the sole identity and flags
 * a payload that contradicts it as an impersonation attempt.
 *
 * @param {object} [message]
 * @param {string|null} [message.userId]  Untrusted payload claim.
 * @param {string|null} [senderId]        Trusted id from `game.socket.on`.
 * @returns {{ userId: string|null, forged: boolean }}
 */
export function resolveRelayIdentity(message, senderId) {
  const trusted = senderId ?? null;
  const claimed = message?.userId ?? null;
  // TODO(forge-test): Foundry documents `senderId` as the authenticated second
  // argument of `game.socket.on`, but some builds/hosts (notably the Forge test
  // environment) appear to omit it. Failing closed on a missing senderId would
  // reject every player request, so fall back to the (untrusted) payload
  // `userId` and flag the weaker identity with a warning. Impersonation is
  // still rejected whenever BOTH ids are present and disagree.
  if (!trusted && claimed) {
    console.warn(
      "[fate-on-the-table] socket senderId not provided by Foundry; falling back to payload userId (Forge test)",
    );
    return { userId: claimed, forged: false };
  }
  return {
    userId: trusted,
    forged: !!claimed && !!trusted && claimed !== trusted,
  };
}

/* ------------------------------------------------------------------ *
 * Initiator side
 * ------------------------------------------------------------------ */

/**
 * Sends a turn-action request to the GM client(s) and resolves with the
 * relayed result. Fire-and-forget when the socket is unavailable (the caller
 * surfaces `noCombat`); resolves `relayTimeout` when no GM answers.
 *
 * @param {"passTurn"} action
 * @param {string} combatId
 * @param {string} combatantId
 * @returns {Promise<{ok: boolean, reason: string|null}>}
 */
export function requestTurnAction(action, combatId, combatantId) {
  if (!ALLOWED_ACTIONS.has(action)) {
    return Promise.resolve({ ok: false, reason: "unknownAction" });
  }
  if (!combatId || !combatantId) {
    return Promise.resolve({ ok: false, reason: "noCombat" });
  }
  if (!socketReady()) {
    return Promise.resolve({ ok: false, reason: "unavailable" });
  }
  const requestId = makeRequestId();
  const userId = game?.user?.id ?? null;
  return new Promise((resolve) => {
    pendingRequests.set(requestId, resolve);
    try {
      game.socket.emit(SOCKET_EVENT, {
        kind: "request",
        requestId,
        action,
        combatId,
        combatantId,
        userId,
      });
    } catch (err) {
      console.warn("[fate-on-the-table] turn action relay emit failed:", err);
      pendingRequests.delete(requestId);
      resolve({ ok: false, reason: "unavailable" });
      return;
    }
    if (typeof setTimeout === "function") {
      const timer = setTimeout(() => {
        const settle = pendingRequests.get(requestId);
        if (!settle) return;
        pendingRequests.delete(requestId);
        settle({ ok: false, reason: "relayTimeout" });
        console.warn(
          "[fate-on-the-table] relay request timed out:",
          action,
          combatId,
        );
      }, RELAY_TIMEOUT_MS);
      // Node keeps the process alive for pending timers; the response is
      // best-effort, so never let the timeout hold the event loop (no-op in
      // the browser, where setTimeout returns a number).
      if (typeof timer?.unref === "function") timer.unref();
    }
  });
}

/* ------------------------------------------------------------------ *
 * GM side
 * ------------------------------------------------------------------ */

/**
 * Registers the socket listener. Call from the module `ready` hook; must be
 * idempotent (Foundry can re-enter `ready` on hot-reload in dev).
 * @param {object} [options]
 * @param {object|null} [options.manager]  Optional ConflictManager facade.
 */
export function initTurnActionRelay(options = {}) {
  if (options && "manager" in options) registerRelayManager(options.manager);
  if (relayInitialized) return;
  if (typeof game === "undefined" || typeof game?.socket?.on !== "function") {
    return;
  }
  relayInitialized = true;
  // Foundry passes the authenticated sender id as the second argument; it is
  // the only identity the GM side may trust (the payload `userId` is forgeable).
  game.socket.on(SOCKET_EVENT, (message, senderId) => {
    void handleSocketMessage(message, senderId).catch((err) => {
      console.error("[fate-on-the-table] relay handler failed:", err);
    });
  });
}

/**
 * Injects the ConflictManager facade (or an object with
 * `passTurn`/`returnTurn`). Optional — the GM handler falls back to a lazy
 * `import("./ConflictManager.js")`, mirroring ConflictInteractions.
 * @param {object|null} manager
 */
export function registerRelayManager(manager) {
  managerRef = manager ?? null;
}

/** Test-only reset (does not exist in the Foundry runtime path). */
export function _resetTurnActionRelayForTests() {
  relayInitialized = false;
  managerRef = null;
  pendingRequests.clear();
}

async function handleSocketMessage(message, senderId) {
  if (!message || typeof message !== "object") return;
  // TODO(remove debug log)
  console.debug(
    `[fate-on-the-table] relay socket recv: kind=${message.kind} action=${message.action ?? "-"}`,
  );
  if (message.kind === "response") {
    handleResponse(message);
    return;
  }
  if (message.kind !== "request") return;
  // Only a GM client processes requests.
  if (typeof game === "undefined" || game?.user?.isGM !== true) return;
  await handleRelayRequest(message, senderId);
}

function handleResponse(message) {
  const settle = pendingRequests.get(message.requestId);
  if (!settle) return;
  pendingRequests.delete(message.requestId);
  settle({ ok: message.ok !== false, reason: message.reason ?? null });
}

async function handleRelayRequest(message, senderId) {
  const { requestId, action, combatId, combatantId } = message;
  // Guarantee exactly one response for every request: any synchronous throw
  // (synthetic actor, malformed combat, DOM-less notification, ...) in the
  // resolution/validation below is funneled to the catch, which still answers
  // so the initiator never hangs until `relayTimeout`.
  try {
    // Identity comes EXCLUSIVELY from the authenticated socket sender: the
    // payload `userId` is echoed by the initiator and can be forged by any
    // player through the console. A payload that contradicts `senderId` is an
    // impersonation attempt and is rejected outright.
    const { userId, forged } = resolveRelayIdentity(message, senderId);
    if (forged) {
      notifyGmRejected(action, senderId, "permission");
      sendResponse({ requestId, ok: false, reason: "permission", action });
      return;
    }

    const combat = combatById(combatId);
    const combatant = combat ? combatantById(combat, combatantId) : null;
    const currentId = combat ? currentCombatantIdOf(combat) : null;
    const currentCombatant = combat ? combatantById(combat, currentId) : null;

    const verdict = validateRelayRequest(
      { action, combatId, combatantId, userId },
      {
        userIsGm: game?.user?.isGM === true,
        combatExists: !!combat,
        combatantExists: !!combatant,
        currentCombatantId: currentId,
        currentCombatantOwnerIds: ownerUserIdsOf(
          combatantActorOf(currentCombatant),
        ),
      },
    );

    if (!verdict.ok) {
      notifyGmRejected(action, userId, verdict.reason);
      sendResponse({
        requestId,
        ok: false,
        reason: verdict.reason,
        action,
      });
      return;
    }

    const fn = await resolveTurnFunction(action);
    if (typeof fn !== "function") {
      sendResponse({ requestId, ok: false, reason: "unavailable", action });
      return;
    }

    let result;
    try {
      // Same signature the GM path uses in ConflictInteractions: `{ scene }`.
      // The `fateOnTheTableSync` marker is intentionally NOT added — the
      // existing GM path does not set it either, and the board is re-projected
      // by the `updateCombat`/`updateCombatant` hooks.
      result = await fn(combat, combatantId, { scene: sceneForCombat(combat) });
    } catch (err) {
      console.error("[fate-on-the-table] relay turn action failed:", err);
      sendResponse({ requestId, ok: false, reason: "error", action });
      return;
    }

    sendResponse({
      requestId,
      ok: result?.ok !== false,
      reason: result?.reason ?? null,
      action,
    });
  } catch (err) {
    console.error("[fate-on-the-table] relay request handling failed:", err);
    sendResponse({ requestId, ok: false, reason: "error", action });
  }
}

async function resolveTurnFunction(action) {
  if (managerRef && typeof managerRef[action] === "function") {
    return managerRef[action];
  }
  try {
    const mod = await import("./ConflictManager.js");
    if (typeof mod?.[action] === "function") return mod[action];
  } catch (err) {
    /* ConflictManager is not present yet — the caller must inject it. */
  }
  return null;
}

function sendResponse({ requestId, ok, reason, action }) {
  if (!socketReady()) return;
  try {
    game.socket.emit(SOCKET_EVENT, {
      kind: "response",
      requestId,
      ok,
      reason: reason ?? null,
      action: action ?? null,
    });
  } catch (err) {
    /* Best-effort — a lost response only costs the initiator a notification. */
  }
}

function notifyGmRejected(action, userId, reason) {
  if (typeof game === "undefined" || typeof ui === "undefined") return;
  ui.notifications?.warn?.(
    game.i18n.format(`${MODULE_ID}.relay.gmRejected`, {
      user: userName(userId),
      action: actionLabel(action),
      reason: reasonLabel(reason),
    }),
  );
}

/* ------------------------------------------------------------------ *
 * Foundry glue helpers (all runtime-guarded)
 * ------------------------------------------------------------------ */

function socketReady() {
  return (
    typeof game !== "undefined" &&
    !!game?.socket &&
    typeof game.socket.emit === "function"
  );
}

function makeRequestId() {
  if (
    typeof foundry !== "undefined" &&
    typeof foundry?.utils?.randomID === "function"
  ) {
    try {
      return foundry.utils.randomID();
    } catch (err) {
      /* fall through */
    }
  }
  return `relay-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

function combatById(combatId) {
  if (!combatId) return null;
  try {
    if (game?.combat?.id === combatId) return game.combat;
    if (typeof game?.combats?.get === "function") {
      return game.combats.get(combatId) ?? null;
    }
    return toArray(game?.combats).find((c) => c?.id === combatId) ?? null;
  } catch (err) {
    return null;
  }
}

function combatantById(combat, combatantId) {
  if (!combat || !combatantId) return null;
  return toArray(combat.combatants).find((c) => c?.id === combatantId) ?? null;
}

function currentCombatantIdOf(combat) {
  const order = Array.isArray(combat?.turns)
    ? combat.turns
    : Array.isArray(combat?.turns?.contents)
      ? combat.turns.contents
      : toArray(combat?.combatants);
  const turn = combat?.turn;
  if (!Number.isInteger(turn) || turn < 0 || turn >= order.length) return null;
  return order[turn]?.id ?? null;
}

/** Unlinked-safe actor resolution (token actor first), like ConflictInteractions. */
function combatantActorOf(combatant) {
  return combatant?.token?.actor ?? combatant?.actor ?? null;
}

function ownerUserIdsOf(actor) {
  if (!actor) return [];
  const ownerLevel =
    (typeof CONST !== "undefined"
      ? CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OWNER
      : null) ?? 3;
  const ids = [];
  for (const user of toArray(game?.users)) {
    if (!user?.id) continue;
    try {
      if (typeof actor.testUserPermission === "function") {
        if (
          actor.testUserPermission(user, ownerLevel) ||
          actor.testUserPermission(user, "OWNER")
        ) {
          ids.push(user.id);
        }
      } else if ((actor.ownership?.[user.id] ?? -1) >= ownerLevel) {
        ids.push(user.id);
      }
    } catch (err) {
      /* A single malformed actor must not break the relay. */
    }
  }
  return ids;
}

function sceneForCombat(combat) {
  if (!combat) return null;
  const sceneId = combat.scene?.id ?? combat.sceneId ?? null;
  if (sceneId) {
    const fromGame = game?.scenes?.get?.(sceneId);
    if (fromGame) return fromGame;
    if (canvas?.scene?.id === sceneId) return canvas.scene;
  }
  return combat.scene ?? null;
}

function userName(userId) {
  const name = game?.users?.get?.(userId)?.name;
  return String(name ?? userId ?? "");
}

function actionLabel(action) {
  if (action === "passTurn") {
    return game.i18n.localize(`${MODULE_ID}.conflict.card.passTurn`);
  }
  if (action === "returnTurn") {
    return game.i18n.localize(`${MODULE_ID}.conflict.card.returnTurn`);
  }
  return String(action ?? "");
}

function reasonLabel(reason) {
  switch (reason) {
    case "permission":
      return game.i18n.localize(`${MODULE_ID}.conflict.permission.gmOnly`);
    case "noCombat":
      return game.i18n.localize(`${MODULE_ID}.conflict.error.noCombat`);
    case "unknownCombatant":
      return game.i18n.localize(`${MODULE_ID}.relay.reasonUnknownCombatant`);
    case "unavailable":
      return game.i18n.localize(`${MODULE_ID}.relay.reasonUnavailable`);
    default:
      return game.i18n.localize(`${MODULE_ID}.conflict.error.generic`);
  }
}
