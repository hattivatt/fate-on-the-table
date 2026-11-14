/**
 * Situation-aspect sync scheduling and the actor/token reactions that feed it.
 * Consequence aspects are linked by the suffix " (ActorName)" and resolved via
 * tokens on the same scene, so actor track edits, unlinked token `delta`
 * edits and the removal of an actor's last token all reconcile the per-scene
 * `situation_aspects` flag. None of these are gated by `fateOnTheTableSync`:
 * the sync only writes that flag, and the loop
 * `sync → onUpdateScene → schedule → sync` is idempotent and self-extinguishing.
 */

import { syncSituationAspects } from "../SituationAspectSync.js";
import { toArray } from "../utils.js";

const SA_SYNC_DEBOUNCE_MS = 400;
// Per-scene debounce: situation_aspects is a per-scene flag, so a global timer
// would drop scene A's pending sync when scene B is scheduled.
const saSyncTimers = new Map();

/** Debounced (per scene, last call wins) situation-aspect sync. */
export function scheduleSituationAspectSync(scene = canvas.scene) {
  if (!scene?.id) return;
  clearTimeout(saSyncTimers.get(scene.id));
  saSyncTimers.set(
    scene.id,
    setTimeout(() => {
      saSyncTimers.delete(scene.id);
      syncSituationAspects(scene).catch((err) =>
        console.error("[fate-on-the-table] situation aspects sync failed:", err),
      );
    }, SA_SYNC_DEBOUNCE_MS),
  );
}

/** True when `scene` has a token of `actorId` other than `excludeTokenId`. */
function sceneHasActorToken(scene, actorId, excludeTokenId = null) {
  return toArray(scene.tokens).some(
    (t) => t && t.id !== excludeTokenId && (t.actorId ?? t.actor?.id) === actorId,
  );
}

/** "New Scene" from the FatePointManager: update an already placed widget. */
export function onNewScene({ scene } = {}) {
  scheduleSituationAspectSync(scene);
}

/**
 * `updateActor`: a consequence track or the actor name changed. Only the
 * active scene is relevant, and only when the actor has a token on it.
 */
export function onActorConsequenceSync(actor, changed) {
  if (!foundry.utils.hasProperty(changed, "system.tracks") && changed?.name === undefined) return;
  const scene = canvas.scene;
  if (!scene || !actor?.id) return;
  if (!sceneHasActorToken(scene, actor.id)) return;
  scheduleSituationAspectSync(scene);
}

/**
 * `updateToken` part: synthetic (unlinked) tokens store actor data in
 * `token.delta`, so a consequence edit arrives as `delta.system.tracks`.
 */
export function onTokenTrackDelta(token, changed) {
  if (!foundry.utils.hasProperty(changed, "delta.system.tracks")) return;
  const scene = token.parent ?? canvas.scene;
  if (scene) scheduleSituationAspectSync(scene);
}

/**
 * `deleteToken` part: when the last token of an actor leaves its scene, the
 * actor's consequence aspects must be removed there. The document may be
 * half-deleted, so `actorId` is read from the token's own fields.
 */
export function onTokenDeletedFromScene(token) {
  const scene = token.parent ?? canvas.scene;
  const actorId = token.actorId ?? token.actor?.id ?? null;
  if (!scene || !actorId) return;
  if (sceneHasActorToken(scene, actorId, token.id)) return;
  scheduleSituationAspectSync(scene);
}
