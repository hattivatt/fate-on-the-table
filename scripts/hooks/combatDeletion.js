/**
 * Pure tracker of Combat documents currently being deleted (between
 * `preDeleteCombat` and `deleteCombat`). While a combat's deletion is in
 * flight, hook-driven conflict board syncs bound to it must not run, so the
 * board is never auto-cleaned when a combat ends. Foundry-free (Node tests).
 *
 * `deleteCombat` is the normal way an entry is cleared. A deletion that is
 * cancelled or fails after `preDeleteCombat` never fires `deleteCombat`, so
 * every entry also expires after `ttlMs` — a safety net only, far longer than
 * any real deletion round-trip.
 */
export const COMBAT_DELETION_TTL_MS = 30_000;

export function createCombatDeletionTracker({
  ttlMs = COMBAT_DELETION_TTL_MS,
  now = () => Date.now(),
} = {}) {
  /** @type {Map<string, number>} combat id → begin timestamp */
  const ids = new Map();
  const live = (id) => {
    const started = ids.get(id);
    if (started === undefined) return false;
    if (now() - started > ttlMs) {
      ids.delete(id);
      return false;
    }
    return true;
  };
  return {
    /** `preDeleteCombat`: the combat's deletion has been requested. */
    begin(combatId) {
      if (combatId) ids.set(combatId, now());
    },
    /** `deleteCombat`: the deletion has completed. */
    end(combatId) {
      ids.delete(combatId);
    },
    /** True when any of the given combat ids is being deleted. */
    isDeleting(...combatIds) {
      return combatIds.some((id) => !!id && live(id));
    },
    get size() {
      for (const id of [...ids.keys()]) live(id);
      return ids.size;
    },
  };
}
