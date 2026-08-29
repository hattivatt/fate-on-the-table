/**
 * chatSpeaker — pure helpers for correcting ChatMessage speaker aliases.
 *
 * Context: fate-core-official's Actor.rollSkill() does
 *   let msg = ChatMessage.getSpeaker({actor:this}); msg.alias = this.name;
 * For unlinked tokens `this` is a synthetic actor whose `.name` in v14 resolves
 * to the prototype actor name ("New Character") instead of the token's name.
 * The module restores core semantics (alias = token name when speaking from a
 * token) via a preCreateChatMessage hook. This file is pure (no Foundry
 * globals) so it is unit-testable.
 */

/**
 * Returns the corrected alias that should be used for a speaker, or null when
 * no correction is needed.
 *
 * Rules (per spec):
 *  - null/undefined speaker → null
 *  - speaker without token (falsy/empty) → null
 *  - tokenName non-string or empty/whitespace-only → null (nothing to correct to)
 *  - if speaker.alias !== tokenName → return tokenName (covers empty/undefined alias)
 *  - otherwise (alias already equals tokenName) → null
 *
 * @param {{token?: string|null, alias?: string|null}|null|undefined} speaker
 * @param {string|null|undefined} tokenName
 * @returns {string|null}
 */
export function correctedAlias(speaker, tokenName) {
  if (!speaker) return null;
  const tokenId = speaker.token;
  if (!tokenId) return null;
  if (typeof tokenId === "string" && tokenId.trim() === "") return null;
  if (typeof tokenName !== "string") return null;
  if (tokenName.trim() === "") return null;
  if (speaker.alias !== tokenName) return tokenName;
  return null;
}

/**
 * Resolves the token id from a speaker, or null when absent.
 * @param {{token?: string|null}|null|undefined} speaker
 * @returns {string|null}
 */
export function resolveSpeakerTokenId(speaker) {
  if (!speaker) return null;
  return speaker.token ?? null;
}
