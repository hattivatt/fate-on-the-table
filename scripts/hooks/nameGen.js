/**
 * Random token name generation for unlinked tokens (adapted from Token Mold —
 * trigram model). Pure logic lives in nameGenerator.js / nameGenLanguages.js;
 * this file only wires Foundry.
 */

import { pickNewName } from "../nameGenerator.js";
import {
  NAME_GEN_LANGUAGES,
  resolveLanguage,
  loadNameGenDict,
  getCachedNameGenDict,
  preloadNameGenDicts,
  resolveNameGenLanguageKeys,
} from "../nameGenLanguages.js";
import { isNameGenEnabled, getNameGenOptions } from "../settings.js";

// Cache-miss languages already warned about (avoids console spam).
const warnedMissingDictLangs = new Set();

function pickLanguageKey(language) {
  if (language !== "random") return resolveLanguage(language);
  const keys = Object.keys(NAME_GEN_LANGUAGES);
  return keys[Math.floor(Math.random() * keys.length)];
}

/**
 * `preCreateToken`: give an unlinked token a generated name. Must stay SYNC —
 * Foundry does not await async preCreate* handlers. Dicts are preloaded on
 * `ready`; on a cache miss the cache is warmed for the next token.
 */
export function onPreCreateToken(tokenDoc) {
  try {
    if (!game.user.isGM) return;
    if (!isNameGenEnabled()) return;
    // Only unlinked tokens; linked tokens keep their actor name.
    if (tokenDoc.actorLink !== false) return;
    const opts = getNameGenOptions();
    const langKey = pickLanguageKey(opts.language);
    const dict = getCachedNameGenDict(langKey);
    if (!dict) {
      loadNameGenDict(langKey).catch((err) =>
        console.warn(`[fate-on-the-table] name dict load failed for "${langKey}":`, err),
      );
      if (!warnedMissingDictLangs.has(langKey)) {
        warnedMissingDictLangs.add(langKey);
        console.warn(
          `[fate-on-the-table] name dict not cached for "${langKey}" — will use default name, warming cache for next token`,
        );
      }
      return;
    }
    const newName = pickNewName(dict, { min: opts.min, max: opts.max });
    if (!newName || typeof newName !== "string") return;
    tokenDoc.updateSource({ name: newName });
  } catch (err) {
    // Never block token creation on a naming failure.
    console.warn("[fate-on-the-table] preCreateToken name generation failed:", err);
  }
}

/**
 * Fire-and-forget dict preload (`ready`) so the first unlinked token after F5
 * gets a generated name synchronously.
 */
export function preloadNameGenerationDicts() {
  try {
    if (!isNameGenEnabled()) return;
    const keys = resolveNameGenLanguageKeys(getNameGenOptions());
    preloadNameGenDicts(keys).catch((err) =>
      console.warn("[fate-on-the-table] name dict preload failed:", err),
    );
  } catch (err) {
    console.warn("[fate-on-the-table] name dict preload check failed:", err);
  }
}
