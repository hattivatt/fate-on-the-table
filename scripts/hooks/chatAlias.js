/**
 * Restores core semantics: messages spoken from a token use the token's name
 * as alias. fate-core-official rollSkill() does `msg.alias = actor.name`, which
 * for unlinked synthetic actors resolves to the prototype ("New Character")
 * instead of the token name. Intentionally global (every token-speaker
 * message, not only skill rolls).
 */

import { correctedAlias } from "../chatSpeaker.js";

/** `preCreateChatMessage(message, data, options, userId)` handler. */
export function onPreCreateChatMessage(message) {
  try {
    const speaker = message.speaker;
    const tokenId = speaker?.token;
    if (!tokenId) return;
    const tokenDoc =
      game.scenes.get(speaker.scene)?.tokens.get(tokenId) ?? canvas.scene?.tokens.get(tokenId);
    const alias = correctedAlias(speaker, tokenDoc?.name);
    if (!alias) return;
    message.updateSource({ "speaker.alias": alias });
  } catch (err) {
    console.warn("[fate-on-the-table] preCreateChatMessage alias correction failed:", err);
  }
}
