/**
 * Feature 5 — conflict board hooks (combat / combatant / token / actor) and the
 * per-scene debounced projection scheduler they share.
 */

import { MODULE_ID, TURN_MARKER_SETTING } from "../constants.js";
import { turnMarkerPatchFor } from "../turnMarkerQol.js";
import { syncConflictBoard, readConflictBoard, boardRegistry } from "../ConflictBoardSync.js";
import { reconcileTokenZoneMembership } from "../ConflictInteractions.js";
import { toArray } from "../utils.js";
import { createCombatDeletionTracker } from "./combatDeletion.js";
import { isSyncAuthority } from "../syncAuthority.js";
import { onTokenTrackDelta, onTokenDeletedFromScene } from "./situationAspects.js";

// Hook-driven conflict board syncs are coalesced per scene: one game event can
// fire several hooks (a "next round" reset fires one updateCombatant per
// participant, a turn change fires updateCombat + updateCombatant). The window
// collapses such a burst into ONE sync that runs with the newest request.
const CONFLICT_SYNC_DEBOUNCE_MS = 100;
const CONFLICT_TOKEN_DEBOUNCE_MS = 150;
const CONFLICT_ACTOR_DEBOUNCE_MS = 400;
const conflictSyncTimers = new Map();
/** sceneId -> { scene, options } of the pending scheduled sync. */
const conflictSyncRequests = new Map();
const conflictTokenTimers = new Map();
const conflictActorTimers = new Map();
// Token ids moved while the per-scene debounce is pending (a multi-token drag
// must reconcile every moved board token, not only the last update).
const pendingConflictTokensByScene = new Map();
// Combats whose deletion is in flight: the board is never auto-cleaned when a
// conflict/combat ends.
const deletingCombats = createCombatDeletionTracker();

/** True when a pending/firing sync request targets a combat being deleted. */
function requestTargetsDeletingCombat(scene, options) {
  return deletingCombats.isDeleting(options?.combat?.id, readConflictBoard(scene)?.combatId);
}

/**
 * Queues a debounced, per-scene conflict board projection sync. Repeated calls
 * inside the debounce window collapse into one `syncConflictBoard` call; the
 * newest request replaces the pending one so the sync always targets the live
 * scene state. The serialized queue in ConflictBoardSync keeps ordering against
 * direct calls (placement, manager actions, canvasReady).
 * @param {object} [scene]  Scene to project (defaults to the active scene).
 * @param {object} [options]  `syncConflictBoard` options (e.g. `{ combat }`).
 */
export function scheduleConflictSync(scene = canvas.scene, options = {}) {
  if (!scene?.id) return;
  conflictSyncRequests.set(scene.id, { scene, options });
  clearTimeout(conflictSyncTimers.get(scene.id));
  conflictSyncTimers.set(
    scene.id,
    setTimeout(() => {
      conflictSyncTimers.delete(scene.id);
      const request = conflictSyncRequests.get(scene.id)?.options ?? {};
      conflictSyncRequests.delete(scene.id);
      // A combat deletion owns the board: a deferred projection sync must
      // never prune cards while that combat's combatants are being removed.
      if (requestTargetsDeletingCombat(scene, request)) return;
      syncConflictBoard(scene, request).catch((err) =>
        console.error("[fate-on-the-table] conflict board sync failed:", err),
      );
    }, CONFLICT_SYNC_DEBOUNCE_MS),
  );
}

/** `preDeleteCombat`: freeze the combat's board and drop its pending syncs. */
export function onPreDeleteCombat(combat) {
  deletingCombats.begin(combat.id);
  for (const [sceneId, { scene, options }] of conflictSyncRequests) {
    if (!requestTargetsDeletingCombat(scene, options)) continue;
    clearTimeout(conflictSyncTimers.get(sceneId));
    conflictSyncTimers.delete(sceneId);
    conflictSyncRequests.delete(sceneId);
  }
}

/**
 * `deleteCombat`: the deletion completed. From here on the combat is gone from
 * `game.combats`, so `resolveSceneConflictCombat` returns `null` and every
 * combat-bound hook bails on its own.
 */
export function onDeleteCombat(combat) {
  deletingCombats.end(combat.id);
}

/**
 * The combat a board is bound to, but only when it is pinned to the given
 * scene: `game.combat` when its id matches `state.combatId`, otherwise the
 * world combat of that id. Returns `null` for a deleted/foreign combat so a
 * board is never auto-cleaned when a conflict/combat ends.
 */
export function resolveSceneConflictCombat(scene, state) {
  const combatId = state?.combatId;
  if (!combatId) return null;
  const combat = game.combat?.id === combatId ? game.combat : (game.combats.get(combatId) ?? null);
  if (!combat) return null;
  return isCombatBoundToScene(combat, scene) ? combat : null;
}

/** True when a combat is pinned to the scene (sceneId or tokens on it). */
function isCombatBoundToScene(combat, scene) {
  if (!combat || !scene) return false;
  const combatSceneId = combat.scene?.id ?? combat.sceneId ?? null;
  if (combatSceneId) return combatSceneId === scene.id;
  return toArray(combat.combatants).some((c) => c?.tokenId && scene.tokens.get(c.tokenId));
}

/** True when the active scene hosts a board bound to the given combat id. */
function hasActiveBoardForCombat(combatId) {
  const scene = canvas.scene;
  if (!scene || !combatId) return false;
  const state = readConflictBoard(scene);
  if (!state || state.combatId !== combatId) return false;
  return !!boardRegistry(scene)?.widgetId;
}

/**
 * Resolves the combat id of a Combatant document. Foundry v14 removed the
 * `combatId` property: the relationship lives on `combatant.combat` /
 * `combatant.parent`. A deleted combatant may have lost both links already,
 * so the active scene's board `combatId` is used as a last-resort fallback
 * only when the combatant's token is still present on that scene.
 */
function combatIdOfCombatant(combatant) {
  const id = combatant?.combat?.id ?? combatant?.parent?.id ?? null;
  if (id) return id;
  const scene = canvas.scene;
  if (!scene || !combatant?.tokenId) return null;
  const state = readConflictBoard(scene);
  if (!state?.combatId || !scene.tokens.get(combatant.tokenId)) return null;
  return state.combatId;
}

/**
 * Shared guard + schedule for combat-bound hooks: GM only, not the module's
 * own write, not a combat being deleted, and only for the active scene's board.
 * @returns {object|null} The board-bound combat when a sync was scheduled.
 */
function scheduleForCombatId(combatId, options) {
  if (!isSyncAuthority()) return null;
  if (options?.fateOnTheTableSync) return null;
  if (!combatId || deletingCombats.isDeleting(combatId)) return null;
  if (!hasActiveBoardForCombat(combatId)) return null;
  const combat = resolveSceneConflictCombat(canvas.scene, { combatId });
  if (!combat) return null;
  scheduleConflictSync(canvas.scene, { combat });
  return combat;
}

/** Combat document updated (turn/round/started): re-project the board. */
export function onUpdateCombat(combat, changed, options) {
  scheduleForCombatId(combat?.id, options);
}

/** Combatant updated (hasActed, sort, flags): re-project the board. */
export function onUpdateCombatant(combatant, changed, options) {
  scheduleForCombatId(combatIdOfCombatant(combatant), options);
}

/**
 * Combatant created (a token enters combat mode mid-conflict). Foundry v14
 * fires ONLY `createCombatant` for a new embedded Combatant — the parent
 * Combat emits no `updateCombat` — so this is the single runtime path for "a
 * new token joins an active board". The projection's
 * `reconcileConflictBoardProjection` -> `admitMissingCards` admits the card,
 * but only when the token is on the pinned active scene.
 * Hook signature: `(combatant, options, userId)`.
 */
export function onCreateCombatant(combatant, options) {
  const combatId = combatIdOfCombatant(combatant);
  if (!scheduleForCombatId(combatId, options)) return;
  // QoL — auto-enable turn marker for the new combatant's token (setting-gated).
  maybeEnableTurnMarkerForCombatant(combatant, combatId).catch((err) =>
    console.warn("[fate-on-the-table] turn marker auto-enable failed:", err),
  );
}

/** Combatant removed: prune its orphan card/zone projections (module-owned). */
export function onDeleteCombatant(combatant, options) {
  scheduleForCombatId(combatIdOfCombatant(combatant), options);
}

/**
 * Setting-gated auto-enable of a newly created combatant's token turnMarker.
 * No-op when the setting is off, the combat is not on the active board, the
 * token is not on the board scene, or the marker is already enabled.
 */
async function maybeEnableTurnMarkerForCombatant(combatant, combatId) {
  if (!game.settings.get(MODULE_ID, TURN_MARKER_SETTING)) return;
  if (!combatant?.tokenId || !hasActiveBoardForCombat(combatId)) return;
  const tokenDoc = canvas.scene?.tokens.get(combatant.tokenId);
  if (!tokenDoc) return;
  const patch = turnMarkerPatchFor(tokenDoc.turnMarker);
  if (!patch) return;
  await tokenDoc.update({ turnMarker: patch });
}

/**
 * Token updated: reconcile `tokenZones` membership on a manual x/y change
 * (never on the module's own drop/sync) and re-project the board. Debounced
 * per scene so continuous drags do not hammer the scene; the moved token ids
 * are accumulated so every token of a multi-token move is reconciled. A
 * synthetic (unlinked token) actor data change also arrives here as a `delta`
 * update and re-projects the card, like `updateActor` does for linked actors.
 */
export function onUpdateToken(token, changed, options) {
  try {
    onTokenTrackDelta(token, changed);
  } catch (err) {
    console.warn("[fate-on-the-table] situation aspect token sync failed:", err);
  }

  if (options?.fateOnTheTableSync || !isSyncAuthority()) return;
  const scene = canvas.scene;
  if (!scene || token.parent?.id !== scene.id) return;
  const state = readConflictBoard(scene);
  if (!state?.combatId || !boardRegistry(scene)?.widgetId) return;
  if (changed?.x !== undefined || changed?.y !== undefined) {
    let set = pendingConflictTokensByScene.get(scene.id);
    if (!set) {
      set = new Set();
      pendingConflictTokensByScene.set(scene.id, set);
    }
    set.add(token.id);
  }
  clearTimeout(conflictTokenTimers.get(scene.id));
  conflictTokenTimers.set(
    scene.id,
    setTimeout(() => {
      conflictTokenTimers.delete(scene.id);
      const pendingSet = pendingConflictTokensByScene.get(scene.id);
      const pending = pendingSet ? [...pendingSet] : [];
      pendingSet?.clear();
      Promise.all(
        pending.map((id) => {
          const doc = scene.tokens.get(id);
          return doc ? reconcileTokenZoneMembership(scene, doc) : null;
        }),
      )
        .catch((err) =>
          console.error("[fate-on-the-table] conflict token zone reconcile failed:", err),
        )
        .then(() => syncConflictBoard(scene))
        .catch((err) => console.error("[fate-on-the-table] conflict board sync failed:", err));
    }, CONFLICT_TOKEN_DEBOUNCE_MS),
  );
}

/** Token deleted: safely clean up orphan card/tokenZone projections. */
export function onDeleteToken(token, options) {
  try {
    onTokenDeletedFromScene(token);
  } catch (err) {
    console.warn("[fate-on-the-table] situation aspect token cleanup failed:", err);
  }

  if (options?.fateOnTheTableSync || !isSyncAuthority()) return;
  const scene = canvas.scene;
  if (!scene) return;
  const state = readConflictBoard(scene);
  if (!state?.combatId || !boardRegistry(scene)?.widgetId) return;
  scheduleConflictSync(scene);
}

/**
 * True when the ACTOR document is the data source of a card on the active
 * board: a board combatant whose token actor (or the combatant's own actor)
 * is this actor, on this scene.
 */
function actorDrivesBoardCard(scene, combat, actor) {
  const actorUuid = actor?.uuid ?? null;
  const actorId = actor?.id ?? null;
  if (!actorUuid && !actorId) return false;
  return toArray(combat?.combatants).some((c) => {
    if (!c?.tokenId) return false;
    const token = scene.tokens.get(c.tokenId);
    const a = token ? (token.actor ?? c.actor ?? null) : null;
    if (!a) return false;
    return (actorUuid && a.uuid === actorUuid) || (actorId && a.id === actorId);
  });
}

/**
 * `updateActor`: re-project the active conflict board when the actor drives a
 * card (linked token actor → stress/consequences/aspects/skills/items).
 * Independent of the actor-widget `scheduleActorSync` debounce. Synthetic
 * actor changes arrive through `updateToken` instead.
 */
export function onConflictBoardActorUpdate(actor, changed, options) {
  if (options?.fateOnTheTableSync || !isSyncAuthority()) return;
  const scene = canvas.scene;
  if (!scene?.id || !actor) return;
  const state = readConflictBoard(scene);
  if (!state?.combatId || !boardRegistry(scene)?.widgetId) return;
  const combat = resolveSceneConflictCombat(scene, state);
  if (!combat) return;
  if (!actorDrivesBoardCard(scene, combat, actor)) return;
  // Per-scene debounce, last wins; `scene`/`combat` are captured at schedule time.
  clearTimeout(conflictActorTimers.get(scene.id));
  conflictActorTimers.set(
    scene.id,
    setTimeout(() => {
      conflictActorTimers.delete(scene.id);
      syncConflictBoard(scene, { combat }).catch((err) =>
        console.error("[fate-on-the-table] conflict board sync failed:", err),
      );
    }, CONFLICT_ACTOR_DEBOUNCE_MS),
  );
}
