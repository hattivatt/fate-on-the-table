/**
 * fate-on-the-table — language registry for name generation.
 */

export const NAME_GEN_LANGUAGES = Object.freeze({
  english: "English",
  russian: "Русский",
});

/**
 * Resolve a language setting value to a concrete language key.
 * "random" → random key; otherwise the key itself (fallback to random if unknown).
 * @param {string} setting
 * @returns {string}
 */
export function resolveLanguage(setting) {
  if (setting === "random") {
    const keys = Object.keys(NAME_GEN_LANGUAGES);
    return keys[Math.floor(Math.random() * keys.length)];
  }
  if (setting in NAME_GEN_LANGUAGES) return setting;
  // unknown value → random fallback
  const keys = Object.keys(NAME_GEN_LANGUAGES);
  return keys[Math.floor(Math.random() * keys.length)];
}

/** @type {Map<string, any>} */
const dictCache = new Map();

/**
 * Load a dict module for a language with caching.
 * Dynamic import, GM-only memory — cache lives in this module.
 * On failure, tries the other language and warns.
 * @param {string} lang
 * @returns {Promise<any|null>}
 */
export async function loadNameGenDict(lang) {
  if (dictCache.has(lang)) return dictCache.get(lang);
  try {
    const mod = await import(`./dict/${lang}.js`);
    const d = mod.lang ?? mod.default ?? mod;
    if (d) dictCache.set(lang, d);
    return d ?? null;
  } catch (err) {
    console.warn(`[fate-on-the-table] failed to load name dict "${lang}":`, err);
    // fallback to the other language
    const fallback = lang === "english" ? "russian" : "english";
    if (dictCache.has(fallback)) return dictCache.get(fallback);
    try {
      const mod2 = await import(`./dict/${fallback}.js`);
      const d2 = mod2.lang ?? mod2.default ?? mod2;
      if (d2) {
        dictCache.set(fallback, d2);
        // also cache under original to avoid repeated failures
        dictCache.set(lang, d2);
      }
      return d2 ?? null;
    } catch (err2) {
      console.warn(`[fate-on-the-table] fallback dict load failed for "${fallback}":`, err2);
      return null;
    }
  }
}

/**
 * Convenience: resolve setting then load dict (handles "random").
 * @param {string} setting
 * @returns {Promise<any|null>}
 */
export async function loadDictForSetting(setting) {
  const lang = resolveLanguage(setting);
  return loadNameGenDict(lang);
}

export function _clearCacheForTests() {
  dictCache.clear();
}

export function _cacheForTests() {
  return dictCache;
}
