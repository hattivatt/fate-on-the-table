/**
 * ConflictManager — GM conflict manager for feature 5 ("Розыгрыш конфликта
 * на столе", PLAN.md). Provides:
 *
 *  1. GM-only ApplicationV2 window (read-only for players) listing the
 *     combatants of the ACTIVE combat bound to the current scene, their
 *     turn order, round and current/acted state, with turn controls
 *     (previous/next/end turn, new round) and participant controls
 *     (add from token, remove, move up/down).
 *  2. Pure/async turn-order actions that operate on a passed Combat
 *     document and keep `game.combat` / the passed combat as the SINGLE
 *     source of truth (combatants/turns/turn/round). `hasActed` is read
 *     from `combatant.getFlag("fate-core-official", "hasActed")` and only
 *     written through the standard embedded-document API
 *     (`combat.updateEmbeddedDocuments("Combatant", ...)`) or
 *     `combatant.setFlag` — it is NEVER duplicated into the conflictBoard
 *     scene flag.
 *  3. The single `placeBoard()` entry point used by the Combat Tracker and
 *     Fate Utilities buttons: size dialog -> PlacementManager preview over
 *     the FULL `getConflictBoardGeometry().bounds` -> initial state written
 *     through `writeConflictBoard` -> projection via
 *     `ConflictBoardSync.syncConflictBoard(scene, { combat })`.
 *
 * ==========================================================================
 * API CONTRACT (for the module.js integration agent)
 * ==========================================================================
 *
 * All combat-aware functions accept an explicit Combat document. They never
 * read `game.combat` themselves for the SOURCE OF TRUTH (the caller decides
 * which combat to operate on); `game.combat` is only used as a default when
 * a scene is given and no combat was passed.
 *
 * Options accepted by every combat-aware action (and placeBoard):
 *   { scene, sync, onStateChanged, assumeGm }
 *     - scene:         target Scene for `syncConflictBoard`. Defaults to the
 *                      combat's own scene resolved at runtime.
 *     - sync:          false to skip the automatic `syncConflictBoard(scene,
 *                      { combat })` call after the mutation (caller takes
 *                      over via `onStateChanged` or its own hook).
 *     - onStateChanged: async ({ action, combat, scene }) => void  called
 *                      after every mutation (regardless of `sync`).
 *     - assumeGm:      bypass the GM permission check (pure tests).
 *
 * Exports:
 *
 *   class ConflictManager
 *       static open(options?)                     -> openConflictManager
 *       static placeBoard(options?)               -> placeBoard
 *   openConflictManager(options?)                 -> void (opens/re-renders)
 *   getActiveConflictForScene(scene?)             -> Combat | null
 *   canPlaceConflictBoard(scene?, combat?)        -> boolean
 *   placeBoard(options?)                          -> Promise<{ ok, cancelled?,
 *                                                     reason?, scene, state?,
 *                                                     reused? }>
 *
 *   Turn / participant actions (all return a Promise; the result is an
 *   object `{ ok: boolean, reason?: string, ... }` — see the per-function
 *   docs for the full result shape):
 *
 *   passTurn(combat, combatantId, options?)
 *   returnTurn(combat, combatantId, options?)
 *   nextTurn(combat, options?)
 *   previousTurn(combat, options?)
 *   endTurn(combat, options?)
 *   startNextRound(combat, options?)
 *   addCombatantFromToken(combat, token, options?)
 *   removeCombatant(combat, combatantId, options?)
 *   moveCombatant(combat, combatantId, direction, options?)   // "up"|"down"
 *
 *   Aliases (identical behaviour, kept for caller convenience):
 *   newRound = startNextRound, addCombatant = addCombatantFromToken,
 *   openConflictManagerDialog = openConflictManager.
 *
 * `reason` values used by the result objects:
 *   "permission" | "noScene" | "noCombat" | "notOnScene" | "noTokens" |
 *   "emptyCombat" | "noCurrentTurn" | "noNextTurn" | "pendingTurns" |
 *   "unknownCombatant" | "currentTarget" | "alreadyActed" | "notActed" |
 *   "defeated" | "alreadyPresent" | "noToken" | "atBoundary" | "badDirection" |
 *   "busy" | "cancelled" | "stateWriteFailed" | "noCombatantApi"
 *
 * The manager HTML uses the existing `.ctt-conflict-*` CSS classes and
 * `fate-on-the-table.conflict.*` / `fate-on-the-table.conflict.placement.*`
 * i18n keys (see languages/en.json). No new keys/classes are introduced.
 *
 * The module imports ONLY pure modules at load time (constants, schema,
 * geometry, ConflictBoardSync) so it stays importable under Node for the
 * pure test suite. `settings.js` and `PlacementManager.js` are loaded
 * lazily at runtime (they extend ApplicationV2 / touch Foundry globals).
 * ApplicationV2 itself is guarded: when the globals are absent the manager
 * window simply cannot open and placeBoard degrades gracefully.
 */

import {
  MODULE_ID,
  FLAG_SCOPE,
  GM_FP_SCOPE,
} from "./constants.js";
import {
  createConflictBoard,
  assignInitialCardAreas,
} from "./conflictBoardSchema.js";
import { getConflictBoardGeometry } from "./conflictBoardGeometry.js";
import {
  writeConflictBoard,
  syncConflictBoard,
  readConflictBoard,
  boardRegistry,
  combatantDescriptors,
  CONFLICT_BOARD_WIDGET_FLAG,
} from "./ConflictBoardSync.js";

/* ------------------------------------------------------------------ *
 * Runtime feature flags / lazy imports
 * ------------------------------------------------------------------ */

/** The Foundry v14 ApplicationV2 base class, or null outside Foundry. */
const ApplicationV2 =
  typeof foundry !== "undefined" && foundry?.applications?.api?.ApplicationV2
    ? foundry.applications.api.ApplicationV2
    : null;

let runtimeModules = null;
/**
 * Lazy-loads the Foundry-coupled modules (settings.js, PlacementManager.js).
 * Called only from runtime paths; never from Node tests.
 * @returns {Promise<{getConflictBoardOptions: Function, PlacementManager: object}>}
 */
async function runtime() {
  if (!runtimeModules) {
    const [settings, placement] = await Promise.all([
      import("./settings.js"),
      import("./PlacementManager.js"),
    ]);
    runtimeModules = {
      getConflictBoardOptions: settings.getConflictBoardOptions,
      PlacementManager: placement.PlacementManager,
    };
  }
  return runtimeModules;
}

/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */

/** System flag scope + key carrying `hasActed` on Combatants. */
const SYSTEM_FLAG_SCOPE = GM_FP_SCOPE;
const HAS_ACTED_KEY = "hasActed";

/** ApplicationV2 dialog id of the Conflict Manager window. */
const CONFLICT_MANAGER_DIALOG_ID = "fate-on-the-table-conflict-manager";

/** True while a manager operation is running (double-click guard). */
let busy = false;

/* ------------------------------------------------------------------ *
 * Small combat/combatant helpers (document-shaped, runtime-free)
 * ------------------------------------------------------------------ */

function combatantsOf(combat) {
  if (Array.isArray(combat?.combatants)) return combat.combatants;
  if (Array.isArray(combat?.combatants?.contents)) return combat.combatants.contents;
  return [];
}

/**
 * The combatants in the SAME order the system and the Foundry combat tracker
 * use: `combat.turns` (the array Fate Utilities indexes with
 * `game.combat.turns.indexOf(combatant)` and the board projection reads via
 * `currentCombatantIdOf`), with a fallback to `combat.combatants` for
 * plain/mocked combats. `combat.turn` is an index INTO THIS ORDER, so every
 * manager turn action must resolve its target/current indices here — never
 * against `combat.combatants`, whose iteration order can diverge from
 * `combat.turns` after combatants are reordered (sort/initiative).
 */
function combatantsInTurnOrder(combat) {
  if (Array.isArray(combat?.turns)) return combat.turns;
  if (Array.isArray(combat?.turns?.contents)) return combat.turns.contents;
  return combatantsOf(combat);
}

function hasActed(combatant) {
  return !!combatant?.getFlag?.(SYSTEM_FLAG_SCOPE, HAS_ACTED_KEY);
}

function isDefeated(combatant) {
  return !!combatant?.defeated;
}

/** Exists, not defeated — navigable in the turn order. */
function isActive(combatant) {
  return !!combatant && !isDefeated(combatant);
}

/** Can still take a turn: active (not defeated) and not yet acted. */
function isAvailable(combatant) {
  return isActive(combatant) && !hasActed(combatant);
}

/** True when the combatant actually has a TokenDocument on the scene. */
function isCombatantOnScene(combatant, scene) {
  if (!combatant || !scene) return false;
  if (combatant.sceneId && scene.id && combatant.sceneId !== scene.id) return false;
  if (!combatant.tokenId) return false;
  return !!scene.tokens?.get?.(combatant.tokenId);
}

function combatantsOnScene(combat, scene) {
  return combatantsOf(combat).filter((c) => isCombatantOnScene(c, scene));
}

/**
 * The scene a combat is bound to: `combat.scene.id` (relationship) with a
 * `combat.sceneId` fallback, then a safe "combatants on the scene" check.
 */
function isCombatOnScene(combat, scene) {
  if (!combat || !scene) return false;
  const combatSceneId = combat.scene?.id ?? combat.sceneId ?? null;
  if (combatSceneId) return combatSceneId === scene.id;
  return combatantsOnScene(combat, scene).length > 0;
}

/** The currently active scene: canvas scene first, then the viewed scene. */
function activeScene() {
  if (typeof canvas !== "undefined" && canvas?.scene) return canvas.scene;
  if (typeof game !== "undefined" && game?.scenes?.viewed) return game.scenes.viewed;
  return null;
}

/** GM permission gate; pure environments (no `game`) are allowed. */
function assertGm(options = {}) {
  if (options.assumeGm) return true;
  if (typeof game === "undefined" || typeof game?.user === "undefined") return true;
  return game.user.isGM === true;
}

function nextActiveIndex(combatants, fromIndex) {
  for (let i = fromIndex + 1; i < combatants.length; i++) {
    if (isActive(combatants[i])) return i;
  }
  return null;
}

function previousActiveIndex(combatants, fromIndex) {
  for (let i = fromIndex - 1; i >= 0; i--) {
    if (isActive(combatants[i])) return i;
  }
  return null;
}

function firstActiveIndex(combatants) {
  for (let i = 0; i < combatants.length; i++) {
    if (isActive(combatants[i])) return i;
  }
  return null;
}

function lastActiveIndex(combatants) {
  for (let i = combatants.length - 1; i >= 0; i--) {
    if (isActive(combatants[i])) return i;
  }
  return null;
}

/** Next combatant (forward only, no wrap) that can still take a turn. */
function nextAvailableIndex(combatants, fromIndex) {
  for (let i = fromIndex + 1; i < combatants.length; i++) {
    if (isAvailable(combatants[i])) return i;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Standard write helpers (embedded documents / setFlag only)
 * ------------------------------------------------------------------ */

async function setTurn(combat, turn) {
  await combat?.update?.({ turn });
}

async function applyCombatantUpdates(combat, updates) {
  if (!updates?.length) return;
  if (combat?.updateEmbeddedDocuments) {
    await combat.updateEmbeddedDocuments("Combatant", updates);
    return;
  }
  for (const u of updates) {
    const c = combatantsOf(combat).find((x) => x.id === u._id);
    await c?.update?.(u);
  }
}

async function setCombatantFlag(combat, combatant, scope, key, value) {
  if (!combatant) return;
  if (combat?.updateEmbeddedDocuments) {
    await combat.updateEmbeddedDocuments("Combatant", [
      { _id: combatant.id, [`flags.${scope}.${key}`]: value },
    ]);
    return;
  }
  await combatant?.setFlag?.(scope, key, value);
}

async function setCombatantFlags(combat, scope, key, value) {
  const combatants = combatantsOf(combat).filter((c) => c?.id);
  if (!combatants.length) return;
  if (combat?.updateEmbeddedDocuments) {
    await combat.updateEmbeddedDocuments(
      "Combatant",
      combatants.map((c) => ({
        _id: c.id,
        [`flags.${scope}.${key}`]: value,
      })),
    );
    return;
  }
  for (const c of combatants) {
    await c?.setFlag?.(scope, key, value);
  }
}

/* ------------------------------------------------------------------ *
 * After-change hook: board sync + onStateChanged callback
 * ------------------------------------------------------------------ */

/**
 * Resolves the scene whose board should be re-synced after a turn mutation:
 * an explicit `options.scene` (when it matches the combat), else the active
 * canvas scene, else the combat's own scene from the world collection.
 */
function resolveSyncScene(combat, options = {}) {
  if (!combat) return null;
  if (options.scene && isCombatOnScene(combat, options.scene)) return options.scene;
  if (typeof game === "undefined") return null;
  const canvasScene = typeof canvas !== "undefined" ? canvas?.scene : null;
  if (canvasScene && isCombatOnScene(combat, canvasScene)) return canvasScene;
  const combatSceneId = combat.scene?.id ?? combat.sceneId ?? null;
  if (combatSceneId && game?.scenes?.get) {
    return game.scenes.get(combatSceneId) ?? null;
  }
  return null;
}

/**
 * Optional refresh of the system's Fate Utilities window after a module-owned
 * turn mutation. The instance (if any) is read from Foundry's applications
 * registry — never crashed on, and no system code is modified. This only
 * keeps the system UI instance in sync with the turn state we just changed;
 * it is NOT a second source of truth (turn/round/combatants/hasActed remain
 * `game.combat`-owned).
 */
function refreshFateUtilities() {
  try {
    const app =
      typeof foundry === "undefined"
        ? null
        : foundry?.applications?.instances?.get?.("FateUtilities");
    if (app && typeof app.render === "function" && !app.closing) {
      app.render(false);
    }
  } catch (err) {
    // Optional refresh only — never crash when the API is missing.
  }
}

/**
 * Called after every mutation. Unless `options.sync === false`, re-projects
 * the conflict board of the combat's scene through
 * `syncConflictBoard(scene, { combat })`. Always fires the documented
 * `options.onStateChanged` callback (`({ action, combat, scene }) => ...`).
 */
async function afterChange(combat, options = {}, action) {
  const scene = resolveSyncScene(combat, options);
  if (scene && options.sync !== false) {
    try {
      await syncConflictBoard(scene, { combat });
    } catch (err) {
      console.warn?.("[fate-on-the-table] conflict board sync failed:", err);
    }
  }
  if (typeof options.onStateChanged === "function") {
    try {
      await options.onStateChanged({ action, combat, scene });
    } catch (err) {
      console.warn?.("[fate-on-the-table] onStateChanged callback failed:", err);
    }
  }
  refreshFateUtilities();
}

/* ------------------------------------------------------------------ *
 * Turn / participant actions (pure + async; combat passed explicitly)
 * ------------------------------------------------------------------ */

/**
 * Passes the turn to a specific combatant (GM only).
 * - target must not be the current combatant, must not have acted and must
 *   not be defeated (defeated combatants are never navigable in the turn
 *   order — same rule as `nextTurn`/`endTurn`/`startNextRound`);
 * - the TARGET is marked `hasActed: true` and becomes current (`combat.turn`
 *   set to its index within `combat.turns`, the same array Fate Utilities
 *   indexes with `game.combat.turns.indexOf(combatant)`) — exactly like the
 *   Fate Utilities `popcorn` action (`combatant.setFlag("fate-core-official",
 *   "hasActed", true)` followed by `game.combat.update({ turn: ... })`);
 * - when a current combatant exists (and differs from the target) it is also
 *   marked `hasActed: true` (it completes its turn);
 * - when there is no current turn (`turn === null`), only the selected target
 *   is marked acted and becomes current.
 * @param {object} combat
 * @param {string} combatantId
 * @param {object} [options]  See header.
 * @returns {Promise<{ok: true, turn: number, combatantId: string} |
 *   {ok: false, reason: string}>}
 */
export async function passTurn(combat, combatantId, options = {}) {
  if (!assertGm(options)) return { ok: false, reason: "permission" };
  if (!combat) return { ok: false, reason: "noCombat" };
  const order = combatantsInTurnOrder(combat);
  const targetIndex = order.findIndex((c) => c?.id === combatantId);
  if (targetIndex < 0) return { ok: false, reason: "unknownCombatant" };
  const target = order[targetIndex];
  if (hasActed(target)) return { ok: false, reason: "alreadyActed" };
  if (isDefeated(target)) return { ok: false, reason: "defeated" };
  const turn = combat?.turn;
  const current =
    Number.isInteger(turn) && turn >= 0 && turn < order.length
      ? order[turn]
      : null;
  if (current && current.id === combatantId) {
    return { ok: false, reason: "currentTarget" };
  }
  if (current) {
    await setCombatantFlag(combat, current, SYSTEM_FLAG_SCOPE, HAS_ACTED_KEY, true);
  }
  await setCombatantFlag(combat, target, SYSTEM_FLAG_SCOPE, HAS_ACTED_KEY, true);
  await setTurn(combat, targetIndex);
  await afterChange(combat, options, "passTurn");
  return { ok: true, turn: targetIndex, combatantId };
}

/**
 * Returns a combatant's turn state to "has not acted" (GM only) — the board
 * analogue of the Fate Utilities `unact` action. Unlike `passTurn` /
 * `endTurn` / `nextTurn`, this NEVER touches `combat.turn`, `combat.round`,
 * the combatant order or the combatant list: only
 * `combatant.flags["fate-core-official"].hasActed` is cleared, through the
 * standard embedded-document API (`combat.updateEmbeddedDocuments` or
 * `combatant.setFlag`). `afterChange` then re-syncs the board, so the live
 * projection moves the card from the acted pile back to its own side area —
 * the current-turn marker and `combat.turn` never move.
 *
 * Guards (in order): GM only; missing combat; unknown combatant; defeated
 * combatants are never returned (same rule as the card context menu);
 * already not-acted targets are a safe `{ ok: false, reason: "notActed" }`.
 * @param {object} combat
 * @param {string} combatantId
 * @param {object} [options]  See header.
 * @returns {Promise<{ok: true, combatantId: string} |
 *   {ok: false, reason: string}>}
 */
export async function returnTurn(combat, combatantId, options = {}) {
  if (!assertGm(options)) return { ok: false, reason: "permission" };
  if (!combat) return { ok: false, reason: "noCombat" };
  const target = combatantsOf(combat).find((c) => c?.id === combatantId) ?? null;
  if (!target) return { ok: false, reason: "unknownCombatant" };
  if (isDefeated(target)) return { ok: false, reason: "defeated" };
  if (!hasActed(target)) return { ok: false, reason: "notActed" };
  await setCombatantFlag(combat, target, SYSTEM_FLAG_SCOPE, HAS_ACTED_KEY, false);
  await afterChange(combat, options, "returnTurn");
  return { ok: true, combatantId };
}

/**
 * Advances the turn to the next combatant that can still act.
 *
 * - All indices are resolved against `combat.turns` (the order the system and
 *   the combat tracker use, with `combat.combatants` as a fallback), never a
 *   separate order.
 * - When a current turn exists, the current combatant is marked
 *   `hasActed: true` through the standard `fate-core-official` flag API and
 *   the marker moves to the next AVAILABLE combatant in order (defeated,
 *   already-acted and missing combatants are skipped). The newly selected
 *   combatant is ALSO marked `hasActed: true` (Fate Utilities popcorn
 *   semantics: the acting combatant is `hasActed` AND current at once).
 * - When no combatant after the current can act but EVERY combatant of the
 *   combat has already acted, the round is finished and a new round is
 *   started: `hasActed` is reset for all combatants, `combat.round` is
 *   incremented and `combat.turn` is set to `null` (the next participant is
 *   chosen manually) via one `combat.update`. This is the "last participant
 *   -> new round" transition.
 * - `turn === null` selects the first active combatant and marks it acted.
 * - The round is NEVER auto-started while some combatant (anywhere in the
 *   order) is still available: in that case the marker stays put and the
 *   result is `{ ok: false, reason: "atBoundary" }` (use `passTurn` or
 *   `previousTurn` to reach the remaining participant).
 *
 * Board zones / cards / tokenZones are never touched here.
 * @returns {Promise<{ok: true, turn: number, combatantId: string, newRound: false}
 *   | {ok: true, turn: null, round: number, combatantId: string, newRound: true}
 *   | {ok: false, reason: string}>}
 */
export async function nextTurn(combat, options = {}) {
  if (!assertGm(options)) return { ok: false, reason: "permission" };
  if (!combat) return { ok: false, reason: "noCombat" };
  const order = combatantsInTurnOrder(combat);
  if (!order.length) return { ok: false, reason: "emptyCombat" };
  const turn = combat?.turn;
  const currentIndex =
    Number.isInteger(turn) && turn >= 0 && turn < order.length ? turn : -1;

  // No current turn: select the first active combatant and mark it acted
  // (the acting combatant is hasActed AND current).
  if (currentIndex < 0) {
    const first = firstActiveIndex(order);
    if (first === null) return { ok: false, reason: "atBoundary" };
    await setCombatantFlag(
      combat,
      order[first],
      SYSTEM_FLAG_SCOPE,
      HAS_ACTED_KEY,
      true,
    );
    await setTurn(combat, first);
    await afterChange(combat, options, "nextTurn");
    return { ok: true, turn: first, newRound: false };
  }

  const current = order[currentIndex];
  await setCombatantFlag(combat, current, SYSTEM_FLAG_SCOPE, HAS_ACTED_KEY, true);

  const next = nextAvailableIndex(order, currentIndex);
  if (next !== null) {
    await setCombatantFlag(
      combat,
      order[next],
      SYSTEM_FLAG_SCOPE,
      HAS_ACTED_KEY,
      true,
    );
    await setTurn(combat, next);
    await afterChange(combat, options, "nextTurn");
    return { ok: true, turn: next, combatantId: current.id, newRound: false };
  }

  // Forward exhausted: auto-start a new round only when every combatant has
  // acted (same guard as `startNextRound`); otherwise stop without moving.
  if (order.some(isAvailable)) {
    return {
      ok: false,
      reason: "atBoundary",
      turn: currentIndex,
      combatantId: current.id,
    };
  }
  const nextRound = await startRoundNow(combat);
  await afterChange(combat, options, "nextTurn");
  return {
    ok: true,
    turn: null,
    round: nextRound,
    combatantId: current.id,
    newRound: true,
  };
}

/**
 * Moves the current-turn marker to the previous ACTIVE combatant (in the
 * `combat.turns` order, with a `combat.combatants` fallback). With
 * `turn === null` selects the last active one. Stops at the beginning.
 * @returns {Promise<{ok: true, turn: number} | {ok: false, reason: string}>}
 */
export async function previousTurn(combat, options = {}) {
  if (!assertGm(options)) return { ok: false, reason: "permission" };
  if (!combat) return { ok: false, reason: "noCombat" };
  const order = combatantsInTurnOrder(combat);
  if (!order.length) return { ok: false, reason: "emptyCombat" };
  const turn = combat?.turn;
  const currentIndex =
    Number.isInteger(turn) && turn >= 0 && turn < order.length ? turn : -1;
  const next =
    currentIndex < 0
      ? lastActiveIndex(order)
      : previousActiveIndex(order, currentIndex);
  if (next === null || next === currentIndex) return { ok: false, reason: "atBoundary" };
  await setTurn(combat, next);
  await afterChange(combat, options, "previousTurn");
  return { ok: true, turn: next };
}

/**
 * Ends the current turn: marks the current combatant `hasActed: true`,
 * marks the newly selected next combatant `hasActed: true` as well (Fate
 * Utilities popcorn semantics: acting == `hasActed` == current) and advances
 * to the next AVAILABLE combatant (forward only). All indices resolve against
 * `combat.turns` (the system/tracker order, `combat.combatants` fallback).
 * When no combatant after the current can act, the current stays acted and
 * the result is `{ ok: false, reason: "noNextTurn" }` — the module does NOT
 * auto-clean; the UI policy offers `startNextRound` (its "New round" button
 * becomes valid once everyone has acted).
 * @returns {Promise<{ok: true, turn: number, combatantId: string} |
 *   {ok: false, reason: string, turn?: number, combatantId?: string}>}
 */
export async function endTurn(combat, options = {}) {
  if (!assertGm(options)) return { ok: false, reason: "permission" };
  if (!combat) return { ok: false, reason: "noCombat" };
  const order = combatantsInTurnOrder(combat);
  const turn = combat?.turn;
  if (!Number.isInteger(turn) || turn < 0 || turn >= order.length) {
    return { ok: false, reason: "noCurrentTurn" };
  }
  const current = order[turn];
  if (!current) return { ok: false, reason: "noCurrentTurn" };
  await setCombatantFlag(combat, current, SYSTEM_FLAG_SCOPE, HAS_ACTED_KEY, true);
  const next = nextAvailableIndex(order, turn);
  if (next === null) {
    await afterChange(combat, options, "endTurn");
    return { ok: false, reason: "noNextTurn", turn, combatantId: current.id };
  }
  await setCombatantFlag(
    combat,
    order[next],
    SYSTEM_FLAG_SCOPE,
    HAS_ACTED_KEY,
    true,
  );
  await setTurn(combat, next);
  await afterChange(combat, options, "endTurn");
  return { ok: true, turn: next, combatantId: current.id };
}

/**
 * Core round-start write shared by `startNextRound` and `nextTurn` (its
 * "last participant -> new round" transition): resets `hasActed` for every
 * combatant through the standard `fate-core-official` flag API, increments
 * `combat.round` and sets `combat.turn` to `null` via one `combat.update`.
 * Board zones/cards/tokenZones are never touched.
 * @param {object} combat
 * @returns {Promise<number>}  The new round number.
 */
async function startRoundNow(combat) {
  await setCombatantFlags(combat, SYSTEM_FLAG_SCOPE, HAS_ACTED_KEY, false);
  const nextRound = (Number(combat.round) || 0) + 1;
  await combat?.update?.({ round: nextRound, turn: null });
  return nextRound;
}

/**
 * Starts the next round (GM only). Blocked while ANY combatant can still
 * take a turn in the current round (the current participant included).
 * When allowed: resets `hasActed` for every combatant through the standard
 * API, increments `combat.round` and sets `combat.turn` to `null` via one
 * `combat.update`. Zones/tokenZones in the board state are never touched.
 * @returns {Promise<{ok: true, round: number} | {ok: false, reason: string}>}
 */
export async function startNextRound(combat, options = {}) {
  if (!assertGm(options)) return { ok: false, reason: "permission" };
  if (!combat) return { ok: false, reason: "noCombat" };
  const combatants = combatantsOf(combat);
  if (!combatants.length) return { ok: false, reason: "emptyCombat" };
  if (combatants.some(isAvailable)) return { ok: false, reason: "pendingTurns" };
  const nextRound = await startRoundNow(combat);
  await afterChange(combat, options, "startNextRound");
  return { ok: true, round: nextRound };
}

/**
 * Adds a combatant from a scene TokenDocument to the combat (GM only).
 * Uses `combat.createCombatant` when available, otherwise
 * `combat.createEmbeddedDocuments("Combatant", [...])`.
 * @param {object} combat
 * @param {object} token  TokenDocument.
 * @param {object} [options]
 * @returns {Promise<{ok: true, combatant: object|null} | {ok: false, reason: string}>}
 */
export async function addCombatantFromToken(combat, token, options = {}) {
  if (!assertGm(options)) return { ok: false, reason: "permission" };
  if (!combat) return { ok: false, reason: "noCombat" };
  if (!token) return { ok: false, reason: "noToken" };
  const combatants = combatantsOf(combat);
  if (combatants.some((c) => c?.tokenId && c.tokenId === token.id)) {
    return { ok: false, reason: "alreadyPresent" };
  }
  const data = { tokenId: token.id, actorId: token.actor?.id ?? null, hidden: false };
  let created = null;
  if (typeof combat.createCombatant === "function") {
    created = await combat.createCombatant(data);
  } else if (combat.createEmbeddedDocuments) {
    const docs = await combat.createEmbeddedDocuments("Combatant", [data]);
    created = docs?.[0] ?? null;
  } else {
    return { ok: false, reason: "noCombatantApi" };
  }
  await afterChange(combat, options, "addCombatant");
  return { ok: true, combatant: created };
}

/**
 * Removes a combatant from the combat (GM only) via
 * `combat.deleteEmbeddedDocuments("Combatant", [id])` (fallback:
 * `combatant.delete()`).
 * @returns {Promise<{ok: true, combatantId: string} | {ok: false, reason: string}>}
 */
export async function removeCombatant(combat, combatantId, options = {}) {
  if (!assertGm(options)) return { ok: false, reason: "permission" };
  if (!combat) return { ok: false, reason: "noCombat" };
  const combatants = combatantsOf(combat);
  if (!combatants.some((c) => c?.id === combatantId)) {
    return { ok: false, reason: "unknownCombatant" };
  }
  if (combat.deleteEmbeddedDocuments) {
    await combat.deleteEmbeddedDocuments("Combatant", [combatantId]);
  } else {
    const target = combatants.find((c) => c.id === combatantId);
    await target?.delete?.();
  }
  await afterChange(combat, options, "removeCombatant");
  return { ok: true, combatantId };
}

/**
 * Moves a combatant up ("up", towards the top) or down ("down") in the
 * turn order by reindexing the combatant `sort` values through the standard
 * embedded-document API (`updateEmbeddedDocuments("Combatant", ...)`). The
 * move applies to `combat.turns` (the order the combat tracker displays;
 * `combat.combatants` is the fallback), so the written `sort` values always
 * reproduce the same visible order the GM edited.
 * @param {object} combat
 * @param {string} combatantId
 * @param {"up"|"down"} direction
 * @param {object} [options]
 * @returns {Promise<{ok: true, index: number, combatantId: string} |
 *   {ok: false, reason: string}>}
 */
export async function moveCombatant(combat, combatantId, direction, options = {}) {
  if (!assertGm(options)) return { ok: false, reason: "permission" };
  if (!combat) return { ok: false, reason: "noCombat" };
  if (direction !== "up" && direction !== "down") {
    return { ok: false, reason: "badDirection" };
  }
  const order = combatantsInTurnOrder(combat);
  const index = order.findIndex((c) => c?.id === combatantId);
  if (index < 0) return { ok: false, reason: "unknownCombatant" };
  const other = direction === "up" ? index - 1 : index + 1;
  if (other < 0 || other >= order.length) return { ok: false, reason: "atBoundary" };
  if (!order[index] || !order[other]) return { ok: false, reason: "atBoundary" };

  const ids = order.map((c) => c.id);
  const tmp = ids[index];
  ids[index] = ids[other];
  ids[other] = tmp;

  const updates = [];
  const byId = new Map(order.map((c) => [c.id, c]));
  ids.forEach((id, i) => {
    const sort = i * 10 + 5;
    const combatant = byId.get(id);
    if (combatant && Number(combatant.sort) !== sort) {
      updates.push({ _id: id, sort });
    }
  });
  await applyCombatantUpdates(combat, updates);
  await afterChange(combat, options, "moveCombatant");
  return { ok: true, index: other, combatantId };
}

/* ------------------------------------------------------------------ *
 * Scene binding / placement eligibility
 * ------------------------------------------------------------------ */

/**
 * The ACTIVE combat of the world bound to a scene (safe equivalent of
 * `combat.scene.id === scene.id`). Without a scene it returns the raw
 * `game.combat`. Returns `null` when there is no active combat or it is
 * not bound to the given scene.
 * @param {object} [scene]  Scene document (or canvas scene).
 * @returns {object|null}
 */
export function getActiveConflictForScene(scene) {
  if (typeof game === "undefined" || !game?.combat) return null;
  const combat = game.combat;
  if (!scene) return combat;
  return isCombatOnScene(combat, scene) ? combat : null;
}

/**
 * Detailed placement eligibility used internally by `placeBoard` and by the
 * Combat Tracker / Fate Utilities buttons to enable/disable the "Place
 * conflict board" control.
 * @param {object} [scene]  Scene document.
 * @param {object} [combat]  Combat to place (defaults to `game.combat`).
 * @returns {{ok: boolean, reason?: string, scene?: object, combat?: object,
 *   combatants?: object[]}}
 */
function resolvePlacementContext(scene, combat) {
  if (typeof game === "undefined" || !game?.user?.isGM) {
    return { ok: false, reason: "permission", scene: scene ?? null };
  }
  const s = scene ?? activeScene();
  if (!s) return { ok: false, reason: "noScene", scene: null };
  const c = combat ?? game.combat ?? null;
  if (!c) return { ok: false, reason: "noCombat", scene: s };
  if (!isCombatOnScene(c, s)) return { ok: false, reason: "notOnScene", scene: s };
  const available = combatantsOnScene(c, s);
  if (!available.length) return { ok: false, reason: "noTokens", scene: s };
  return { ok: true, scene: s, combat: c, combatants: available };
}

/**
 * True when the conflict board can currently be placed: GM, an active
 * combat bound to the scene, and at least one combatant with a token on
 * the scene. No side effects.
 * @param {object} [scene]
 * @param {object} [combat]
 * @returns {boolean}
 */
export function canPlaceConflictBoard(scene, combat) {
  return resolvePlacementContext(scene, combat).ok === true;
}

/* ------------------------------------------------------------------ *
 * Placement
 * ------------------------------------------------------------------ */

/**
 * Single entry point to place the conflict board (used by the Combat
 * Tracker and Fate Utilities buttons).
 *
 * Flow: GM + active combat bound to the scene + available tokens (otherwise
 * `{ ok: false, reason }` with a clear i18n notification) -> size dialog
 * (small/medium/large from the module settings) -> interactive placement via
 * `PlacementManager.placeGroup` (preview covers the FULL
 * `getConflictBoardGeometry().bounds`) -> initial state written through
 * `writeConflictBoard` + `syncConflictBoard(scene, { combat })`.
 *
 * Calling it again for an already-placed board does NOT create a second
 * board: it re-syncs the existing board and opens the manager
 * (`{ ok: true, reused: true }`).
 *
 * @param {object} [options]  { scene, combat, onStateChanged, assumeGm }
 * @returns {Promise<{ok: boolean, cancelled?: boolean, reason?: string,
 *   scene?: object|null, state?: object|null, reused?: boolean}>}
 */
export async function placeBoard(options = {}) {
  const ctx = resolvePlacementContext(options.scene, options.combat);
  if (!ctx.ok) {
    notifyReason(ctx.reason);
    return { ok: false, reason: ctx.reason, scene: ctx.scene ?? null, state: null };
  }
  const { scene, combat } = ctx;

  const existingState = readConflictBoard(scene);
  const existingRegistry = boardRegistry(scene);
  if (existingState && existingRegistry?.widgetId) {
    await syncConflictBoard(scene, { combat });
    openConflictManager({ scene, combat });
    return {
      ok: true,
      reused: true,
      scene,
      state: readConflictBoard(scene) ?? existingState,
    };
  }

  const sizePreset = await promptBoardSize(scene, combat);
  if (!sizePreset) {
    if (typeof game !== "undefined" && typeof ui !== "undefined") {
      ui.notifications?.info?.(
        game.i18n.localize(`${MODULE_ID}.conflict.placement.cancelled`),
      );
    }
    return { ok: false, cancelled: true, reason: "cancelled", scene, state: null };
  }

  const { getConflictBoardOptions } = await runtime();
  const opts = getConflictBoardOptions();
  const side = opts.sizePresets[sizePreset] ?? opts.sizePresets.medium;
  const boardSize = { width: side, height: side };

  if (typeof canvas === "undefined" || !canvas?.ready || !canvas?.scene) {
    notifyReason("noScene");
    return { ok: false, reason: "noScene", scene, state: null };
  }
  const { PlacementManager } = await runtime();
  if (PlacementManager.active) {
    notifyReason("busy");
    return { ok: false, reason: "busy", scene, state: null };
  }

  const geometry = getConflictBoardGeometry({ sizePreset, boardSize });
  const available = combatantsOnScene(combat, scene);
  let committed = null;

  await PlacementManager.placeGroup({
    docs: [], // the board projection is created by ConflictBoardSync after commit
    bounds: geometry.bounds,
    label: game.i18n.localize(`${MODULE_ID}.conflict.placement.title`),
    options: {},
    hintKey: `${MODULE_ID}.conflict.placement.hint`,
    successKey: `${MODULE_ID}.conflict.placement.placed`,
    commit: async (anchor, widgetId) => {
      committed = await commitBoardPlacement(scene, combat, {
        anchor,
        widgetId,
        sizePreset,
        boardSize,
        available,
      });
    },
  });

  if (!committed) {
    return { ok: false, cancelled: true, reason: "cancelled", scene, state: null };
  }
  return committed;
}

/** Commit handler for the interactive placement: writes state + syncs. */
async function commitBoardPlacement(
  scene,
  combat,
  { anchor, widgetId, sizePreset, boardSize, available },
) {
  const { getConflictBoardOptions } = await runtime();
  const opts = getConflictBoardOptions();

  const state = createConflictBoard({
    combatId: combat.id,
    sizePreset,
    origin: { x: anchor.x, y: anchor.y },
  });
  state.board.boardSize = {
    width: Math.max(1, Math.round(boardSize.width)),
    height: Math.max(1, Math.round(boardSize.height)),
  };
  state.board.background = {
    color: opts.background.color,
    texture: opts.background.texture,
    alpha: opts.background.alpha,
  };
  const { cards } = assignInitialCardAreas(combatantDescriptors(available));
  state.cards = cards;

  const written = await writeConflictBoard(scene, state);
  if (!written.ok) {
    console.error?.(
      "[fate-on-the-table] conflict board state write failed:",
      written.errors,
    );
    return { ok: false, reason: "stateWriteFailed", scene, state: null };
  }

  // The registry write is marked `fateOnTheTableSync: true` (unlike
  // `scene.setFlag`, which cannot pass options): otherwise the updateScene
  // hook would run `syncConflictBoard` before any projection document
  // exists, hit the manual whole-board deletion guard and clear the
  // registry — permanently preventing the first projection. The commit's own
  // sync below passes `forceProjection: true` to build the board.
  await scene.update(
    {
      [`flags.${FLAG_SCOPE}.${CONFLICT_BOARD_WIDGET_FLAG}`]: {
        widgetId,
        anchor,
        zoneWidgetIds: {},
        cardWidgetIds: {},
      },
    },
    { fateOnTheTableSync: true },
  );

  await syncConflictBoard(scene, { combat, forceProjection: true });
  return { ok: true, scene, state: written.state };
}

/** Prompts for a board size preset; resolves the preset name or null. */
function promptBoardSize(scene, combat) {
  return new Promise((resolve) => {
    if (!ApplicationV2) {
      resolve(null);
      return;
    }
    new BoardSizeDialog(scene, combat, resolve).render({ force: true });
  });
}

/* ------------------------------------------------------------------ *
 * i18n helpers
 * ------------------------------------------------------------------ */

/** Maps an action `reason` to an existing `fate-on-the-table.conflict.*` key. */
function reasonMessageKey(reason) {
  switch (reason) {
    case "permission":
      return `${MODULE_ID}.conflict.permission.gmOnly`;
    case "noScene":
      return `${MODULE_ID}.conflict.error.noScene`;
    case "noCombat":
      return `${MODULE_ID}.conflict.error.noCombat`;
    case "notOnScene":
      return `${MODULE_ID}.conflict.error.notOnScene`;
    case "noTokens":
      return `${MODULE_ID}.conflict.error.noTokens`;
    case "noCurrentTurn":
    case "pendingTurns":
      return `${MODULE_ID}.conflict.turnState.notStarted`;
    case "noNextTurn":
    case "alreadyActed":
      return `${MODULE_ID}.conflict.turnState.complete`;
    case "notActed":
      return `${MODULE_ID}.conflict.turnState.notActed`;
    case "defeated":
      return `${MODULE_ID}.conflict.card.eliminated`;
    case "busy":
      return `${MODULE_ID}.conflict.placement.busy`;
    default:
      return `${MODULE_ID}.conflict.error.generic`;
  }
}

function notifyReason(reason) {
  if (typeof game === "undefined" || typeof ui === "undefined") return;
  ui.notifications?.warn?.(game.i18n.localize(reasonMessageKey(reason)));
}

function escapeHtml(text) {
  return String(text ?? "").replace(/[&<>"']/g, (c) => {
    const map = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return map[c];
  });
}

function combatantDisplayName(combatant) {
  if (!combatant) return "";
  const token = combatant.token;
  return token?.name ?? combatant.name ?? combatant.actor?.name ?? "";
}

function turnStateOf(combat, combatant, index) {
  if (Number.isInteger(combat?.turn) && combat.turn === index) return "current";
  if (hasActed(combatant)) return "acted";
  return "notStarted";
}

/* ------------------------------------------------------------------ *
 * ApplicationV2 windows (guarded: only defined when Foundry globals exist)
 * ------------------------------------------------------------------ */

let ConflictManagerDialog = null;
let BoardSizeDialog = null;
let TokenPickerDialog = null;

if (ApplicationV2) {
  /* --- Conflict Manager window --- */
  ConflictManagerDialog = class ConflictManagerDialog extends ApplicationV2 {
    constructor(options = {}) {
      super();
      this._scene = options.scene ?? null;
    }

    static DEFAULT_OPTIONS = {
      id: CONFLICT_MANAGER_DIALOG_ID,
      classes: ["fate-on-the-table", "ctt-conflict-manager"],
      position: { width: 440, height: "auto" },
      // Foundry localizes window.title itself — pass the raw i18n key.
      window: { title: `${MODULE_ID}.conflict.title` },
      tag: "form",
      form: { submitOnChange: false, closeOnSubmit: false },
      actions: {
        next: (event, target) => runManagerAction(target, "next"),
        previous: (event, target) => runManagerAction(target, "previous"),
        endTurn: (event, target) => runManagerAction(target, "endTurn"),
        newRound: (event, target) => runManagerAction(target, "newRound"),
        pass: (event, target) => runManagerAction(target, "pass"),
        addCombatant: (event, target) => runManagerAction(target, "addCombatant"),
        remove: (event, target) => runManagerAction(target, "remove"),
        moveUp: (event, target) => runManagerAction(target, "moveUp"),
        moveDown: (event, target) => runManagerAction(target, "moveDown"),
        place: (event, target) => runManagerAction(target, "place"),
        close: (event, target) => runManagerAction(target, "close"),
      },
    };

    async _renderHTML(context, options) {
      const div = document.createElement("div");
      div.innerHTML = renderManagerContent(this);
      return div;
    }

    _replaceHTML(result, content, options) {
      content.innerHTML = "";
      content.append(result);
      content.closest?.(".ctt-conflict-manager")?.classList.toggle(
        "ctt-conflict-readonly",
        game.user?.isGM !== true,
      );
    }

    _onClose(options) {
      busy = false;
    }
  };

  /* --- Board size picker (placement) --- */
  BoardSizeDialog = class BoardSizeDialog extends ApplicationV2 {
    constructor(scene, combat, resolve) {
      super();
      this.scene = scene;
      this.combat = combat;
      this._resolve = resolve;
    }

    static DEFAULT_OPTIONS = {
      id: "fate-on-the-table-conflict-size",
      classes: ["fate-on-the-table", "ctt-conflict-size"],
      position: { width: 340, height: "auto" },
      window: { title: `${MODULE_ID}.conflict.placement.sizeDialogTitle` },
      tag: "form",
      form: { submitOnChange: false, closeOnSubmit: false },
      actions: {
        confirm() {
          this.#confirm();
        },
        cancel() {
          this.#cancel();
        },
      },
    };

    async _renderHTML(context, options) {
      const { getConflictBoardOptions } = await runtime();
      const div = document.createElement("div");
      div.innerHTML = renderSizeContent(getConflictBoardOptions());
      return div;
    }

    _replaceHTML(result, content, options) {
      content.innerHTML = "";
      content.append(result);
    }

    #confirm() {
      const selected =
        this.element.querySelector('input[name="ctt-conflict-size"]:checked')
          ?.value ?? "medium";
      this._resolve?.(selected);
      this._resolve = null;
      this.close();
    }

    #cancel() {
      this._resolve?.(null);
      this._resolve = null;
      this.close();
    }

    _onClose(options) {
      if (this._resolve) {
        this._resolve(null);
        this._resolve = null;
      }
    }
  };

  /* --- Token picker (add combatant) --- */
  TokenPickerDialog = class TokenPickerDialog extends ApplicationV2 {
    constructor(tokens, resolve) {
      super();
      this.tokens = tokens;
      this._resolve = resolve;
    }

    static DEFAULT_OPTIONS = {
      id: "fate-on-the-table-conflict-token-picker",
      classes: ["fate-on-the-table", "ctt-conflict-manager"],
      position: { width: 360, height: "auto" },
      window: { title: `${MODULE_ID}.conflict.addCombatant` },
      tag: "form",
      form: { submitOnChange: false, closeOnSubmit: false },
      actions: {
        pick(event, target) {
          this.#pick(target.dataset.tokenId);
        },
        cancel() {
          this.#cancel();
        },
      },
    };

    async _renderHTML(context, options) {
      const t = (key) => game.i18n.localize(`${MODULE_ID}.conflict.${key}`);
      const rows = this.tokens
        .map(
          (token) => `
        <li class="ctt-conflict-row">
          <span class="ctt-conflict-name" title="${escapeHtml(token.name ?? "")}">${escapeHtml(
            token.name ?? "",
          )}</span>
          <div class="ctt-conflict-actions">
            <button type="button" class="ctt-conflict-btn-wide" data-action="pick" data-token-id="${escapeHtml(
              token.id,
            )}"><i class="fas fa-plus"></i> ${escapeHtml(t("addCombatant"))}</button>
          </div>
        </li>`,
        )
        .join("");
      const div = document.createElement("div");
      div.innerHTML = `<div class="ctt-conflict">
        <ul class="ctt-conflict-list">${rows}</ul>
        <button type="button" class="ctt-conflict-btn-wide" data-action="cancel" style="margin-top:6px"><i class="fas fa-times"></i> ${escapeHtml(
          game.i18n.localize(`${MODULE_ID}.conflict.placement.cancel`),
        )}</button>
      </div>`;
      return div;
    }

    _replaceHTML(result, content, options) {
      content.innerHTML = "";
      content.append(result);
    }

    #pick(tokenId) {
      const token = this.tokens.find((t) => t.id === tokenId) ?? null;
      this._resolve?.(token);
      this._resolve = null;
      this.close();
    }

    #cancel() {
      this._resolve?.(null);
      this._resolve = null;
      this.close();
    }

    _onClose(options) {
      if (this._resolve) {
        this._resolve(null);
        this._resolve = null;
      }
    }
  };
}

/* ------------------------------------------------------------------ *
 * Manager rendering
 * ------------------------------------------------------------------ */

function renderManagerContent(app) {
  const isGm = game.user?.isGM === true;
  const scene = app._scene ?? (typeof canvas !== "undefined" ? canvas?.scene : null);
  const combat = getActiveConflictForScene(scene);
  const t = (key) => game.i18n.localize(`${MODULE_ID}.conflict.${key}`);

  const combatants = combat ? combatantsInTurnOrder(combat) : [];
  const round = Number(combat?.round) || 0;
  const placed =
    !!scene && !!boardRegistry(scene)?.widgetId && !!readConflictBoard(scene);

  let listHtml = "";
  if (!combat) {
    listHtml = `<p class="ctt-conflict-empty">${escapeHtml(t("noCombat"))}</p>`;
  } else if (!combatants.length) {
    listHtml = `<p class="ctt-conflict-empty">${escapeHtml(t("empty"))}</p>`;
  } else {
    listHtml = combatants
      .map((c, index) => {
        const name = combatantDisplayName(c);
        const state = turnStateOf(combat, c, index);
        const stateClass =
          state === "current"
            ? "ctt-conflict-state-current"
            : state === "acted"
              ? "ctt-conflict-state-acted"
              : "";
        const stateText =
          state === "current"
            ? t("turnState.now")
            : state === "acted"
              ? t("turnState.complete")
              : t("turnState.notStarted");
        const canPass = state === "notStarted";
        const actions = isGm
          ? `<div class="ctt-conflict-actions">
              <button type="button" class="ctt-conflict-btn" data-action="moveUp" data-combatant-id="${escapeHtml(
                c.id,
              )}" title="${escapeHtml(t("moveUp"))}" ${
                index === 0 ? "disabled" : ""
              }><i class="fas fa-arrow-up"></i></button>
              <button type="button" class="ctt-conflict-btn" data-action="moveDown" data-combatant-id="${escapeHtml(
                c.id,
              )}" title="${escapeHtml(t("moveDown"))}" ${
                index === combatants.length - 1 ? "disabled" : ""
              }><i class="fas fa-arrow-down"></i></button>
              <button type="button" class="ctt-conflict-btn" data-action="pass" data-combatant-id="${escapeHtml(
                c.id,
              )}" title="${escapeHtml(t("turn.pass"))}" ${
                canPass ? "" : "disabled"
              }><i class="fas fa-forward"></i></button>
              <button type="button" class="ctt-conflict-btn" data-action="remove" data-combatant-id="${escapeHtml(
                c.id,
              )}" title="${escapeHtml(t("removeCombatant"))}"><i class="fas fa-trash"></i></button>
            </div>`
          : "";
        return `<li class="ctt-conflict-row" data-combatant-id="${escapeHtml(c.id)}">
          <span class="ctt-conflict-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
          <span class="ctt-conflict-state ${stateClass}">${escapeHtml(stateText)}</span>
          ${actions}
        </li>`;
      })
      .join("");
  }

  const canEndTurn =
    !!combat && Number.isInteger(combat.turn) && !!combatants[combat.turn];
  const canNewRound = !!combat && !combatants.some(isAvailable);

  const turnSection = isGm
    ? `
      <div class="ctt-conflict-section">
        <h3>${escapeHtml(t("currentTurn"))}</h3>
        <div class="ctt-conflict-turn-actions">
          <button type="button" class="ctt-conflict-btn" data-action="previous" title="${escapeHtml(
            t("turn.previous"),
          )}"><i class="fas fa-step-backward"></i></button>
          <button type="button" class="ctt-conflict-btn-wide" data-action="next" title="${escapeHtml(
            t("turn.next"),
          )}"><i class="fas fa-step-forward"></i></button>
          <button type="button" class="ctt-conflict-btn-wide" data-action="endTurn" ${
            canEndTurn ? "" : "disabled"
          }>${escapeHtml(t("turn.endTurn"))}</button>
          <button type="button" class="ctt-conflict-btn-wide" data-action="newRound" ${
            canNewRound ? "" : "disabled"
          }>${escapeHtml(t("turn.newRound"))}</button>
        </div>
        <div class="ctt-conflict-actions" style="margin-top:6px">
          <button type="button" class="ctt-conflict-btn-wide" data-action="addCombatant"><i class="fas fa-user-plus"></i> ${escapeHtml(
            t("addCombatant"),
          )}</button>
          <button type="button" class="ctt-conflict-btn-wide" data-action="place"><i class="fas ${
            placed ? "fa-arrows-alt" : "fa-level-down-alt"
          }"></i> ${escapeHtml(t(placed ? "manageFromCombatTracker" : "placement.fromCombatTracker"))}</button>
        </div>
        <button type="button" class="ctt-conflict-btn-wide" data-action="close" style="margin-top:6px"><i class="fas fa-times"></i> ${escapeHtml(
          t("close"),
        )}</button>
      </div>`
    : `
      <div class="ctt-conflict-section">
        <div class="ctt-conflict-readonly-note">${escapeHtml(t("readOnly"))}</div>
        <button type="button" class="ctt-conflict-btn-wide" data-action="close"><i class="fas fa-times"></i> ${escapeHtml(
          t("close"),
        )}</button>
      </div>`;

  return `<div class="ctt-conflict">
    <div class="ctt-conflict-section">
      <div class="ctt-conflict-round">${escapeHtml(
        game.i18n.format(`${MODULE_ID}.conflict.round`, { round }),
      )}</div>
    </div>
    <div class="ctt-conflict-section">
      <h3>${escapeHtml(t(isGm ? "combatantsHeader" : "readOnlyHeader"))}</h3>
      <ul class="ctt-conflict-list">${listHtml}</ul>
    </div>
    ${turnSection}
  </div>`;
}

function renderSizeContent(opts) {
  const t = (key) => game.i18n.localize(`${MODULE_ID}.conflict.placement.${key}`);
  const presets = ["small", "medium", "large"];
  const options = presets
    .map((p) => {
      const side = opts.sizePresets[p];
      const labelKey = `size${p[0].toUpperCase()}${p.slice(1)}`;
      return `<label class="ctt-conflict-size-option">
        <input type="radio" name="ctt-conflict-size" value="${p}" ${
          p === "medium" ? "checked" : ""
        }>
        <span class="ctt-conflict-size-label">${escapeHtml(t(labelKey))}</span>
        <span class="ctt-conflict-size-dim">${side} × ${side}</span>
      </label>`;
    })
    .join("");
  return `<div>
    <p>${escapeHtml(t("sizeDialogHint"))}</p>
    <div class="ctt-conflict-size-options">${options}</div>
    <div class="ctt-conflict-size-actions">
      <button type="button" data-action="confirm"><i class="fas fa-check"></i> ${escapeHtml(
        t("confirm"),
      )}</button>
      <button type="button" data-action="cancel"><i class="fas fa-times"></i> ${escapeHtml(
        t("cancel"),
      )}</button>
    </div>
  </div>`;
}

/* ------------------------------------------------------------------ *
 * Manager actions
 * ------------------------------------------------------------------ */

async function runManagerAction(target, action) {
  if (busy) return;
  busy = true;
  const element = target?.closest?.(".ctt-conflict-manager");
  element?.classList.add("ctt-conflict-busy");
  try {
    const scene =
      typeof canvas !== "undefined" && canvas?.scene ? canvas.scene : null;
    const combat = getActiveConflictForScene(scene);
    const opts = { scene };
    switch (action) {
      case "next":
        await nextTurn(combat, opts);
        break;
      case "previous":
        await previousTurn(combat, opts);
        break;
      case "endTurn":
        await runEndTurn(combat, opts);
        break;
      case "newRound":
        await runNewRound(combat, opts);
        break;
      case "pass":
        await runPass(combat, target, opts);
        break;
      case "addCombatant":
        await runAddCombatant(combat, opts);
        break;
      case "remove":
        await runRemove(combat, target, opts);
        break;
      case "moveUp":
        await moveCombatant(combat, target.dataset.combatantId, "up", opts);
        break;
      case "moveDown":
        await moveCombatant(combat, target.dataset.combatantId, "down", opts);
        break;
      case "place":
        await placeBoard({ scene, combat });
        break;
      case "close": {
        const app = foundry.applications.instances.get(CONFLICT_MANAGER_DIALOG_ID);
        if (app && !app.closing) {
          app.closing = true;
          await app.close();
        }
        break;
      }
    }
  } catch (err) {
    console.error?.("[fate-on-the-table] conflict manager operation failed:", err);
    ui?.notifications?.error?.(
      game.i18n.localize(`${MODULE_ID}.conflict.error.generic`),
    );
  } finally {
    busy = false;
    element?.classList.remove("ctt-conflict-busy");
    const live = foundry.applications.instances.get(CONFLICT_MANAGER_DIALOG_ID);
    if (live && !live.closing) live.render({ force: true });
  }
}

async function runEndTurn(combat, options = {}) {
  const res = await endTurn(combat, options);
  // "noNextTurn": everyone has acted — the "New round" button is now
  // enabled by UI policy; the module never auto-starts a round.
  if (res.ok === false && res.reason !== "noNextTurn") {
    notifyReason(res.reason);
  }
}

async function runNewRound(combat, options = {}) {
  const res = await startNextRound(combat, options);
  if (res.ok === false) notifyReason(res.reason);
}

async function runPass(combat, target, options = {}) {
  const combatantId = target.dataset.combatantId;
  const targetCombatant = combatantsOf(combat).find((c) => c.id === combatantId);
  if (!targetCombatant) return;
  if (typeof foundry === "undefined") return;
  const confirmed = await foundry.applications.api.DialogV2.confirm({
    window: { title: game.i18n.localize(`${MODULE_ID}.conflict.card.passTitle`) },
    content: game.i18n.format(`${MODULE_ID}.conflict.card.passConfirm`, {
      name: combatantDisplayName(targetCombatant),
    }),
    rejectClose: false,
  });
  if (!confirmed) return;
  const res = await passTurn(combat, combatantId, options);
  if (res.ok === false) notifyReason(res.reason);
}

async function runAddCombatant(combat, options = {}) {
  const scene = options.scene ?? activeScene();
  if (!scene) {
    notifyReason("noScene");
    return;
  }
  const existing = new Set(combatantsOf(combat).map((c) => c.tokenId).filter(Boolean));
  const tokens = [...(scene.tokens ?? [])].filter((t) => t && !existing.has(t.id));
  if (!tokens.length) {
    notifyReason("noTokens");
    return;
  }
  const token = await promptToken(tokens);
  if (!token) return;
  const res = await addCombatantFromToken(combat, token, options);
  if (res.ok === false) notifyReason(res.reason);
}

async function runRemove(combat, target, options = {}) {
  const res = await removeCombatant(combat, target.dataset.combatantId, options);
  if (res.ok === false) notifyReason(res.reason);
}

function promptToken(tokens) {
  return new Promise((resolve) => {
    if (!ApplicationV2 || !TokenPickerDialog) {
      resolve(tokens[0] ?? null);
      return;
    }
    new TokenPickerDialog(tokens, resolve).render({ force: true });
  });
}

/* ------------------------------------------------------------------ *
 * Public entry points
 * ------------------------------------------------------------------ */

/**
 * Opens (or re-renders) the Conflict Manager window. GM users get the full
 * controls; players get a read-only window (order/current/acted only).
 * @param {object} [options]  { scene }
 * @returns {void}
 */
export function openConflictManager(options = {}) {
  if (typeof game === "undefined" || !game?.user) return;
  if (!ApplicationV2 || !ConflictManagerDialog) return;
  const existing = foundry.applications?.instances?.get(CONFLICT_MANAGER_DIALOG_ID);
  if (existing && !existing.closing) {
    existing.render({ force: true });
    return;
  }
  new ConflictManagerDialog(options).render({ force: true });
}

/**
 * GM conflict manager facade.
 */
export class ConflictManager {
  /** Opens the Conflict Manager window. @param {object} [options] { scene } */
  static open(options = {}) {
    return openConflictManager(options);
  }

  /** Places (or reuses) the conflict board. @param {object} [options] */
  static placeBoard(options = {}) {
    return placeBoard(options);
  }
}

/* ------------------------------------------------------------------ *
 * Aliases (identical behaviour; kept for caller convenience)
 * ------------------------------------------------------------------ */

/** Alias of `startNextRound`. */
export const newRound = startNextRound;
/** Alias of `addCombatantFromToken`. */
export const addCombatant = addCombatantFromToken;
/** Alias of `openConflictManager`. */
export const openConflictManagerDialog = openConflictManager;
