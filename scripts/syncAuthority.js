/**
 * Sync authority: exactly one client may run automatic, hook-driven writes
 * (Drawings/Tiles, the `conflictBoard` scene flag). `game.user.isGM` is also
 * true for Assistant GMs, so with two GM-role users online both would react
 * to the same hook and write concurrently. Only the active GM is authority.
 *
 * Pure module: reads the `game` global lazily, never at import time.
 */

/**
 * @returns {boolean} True when this client must perform automatic sync writes.
 *   Without a `game` global (Node tests) or without a `game.user` the call
 *   sites historically treated the client as allowed, so that is kept.
 */
export function isSyncAuthority() {
  if (typeof game === "undefined" || !game?.user) return true;
  const user = game.user;
  if (user.isGM === false) return false;
  if (typeof user.isActiveGM === "boolean") return user.isActiveGM;
  const active = game.users?.activeGM;
  if (active) return active.isSelf === true || active.id === user.id;
  // No active-GM information available (legacy stubs): fall back to isGM.
  return true;
}

/**
 * Gate for sync entry points that serve both hooks and explicit user actions.
 * @param {{manual?: boolean}} [options]  `manual: true` — the acting user
 *   triggered the write from their own UI, so any GM may perform it.
 * @returns {boolean}
 */
export function canRunSync(options = {}) {
  if (options?.manual === true) {
    return typeof game === "undefined" || game?.user?.isGM !== false;
  }
  return isSyncAuthority();
}
