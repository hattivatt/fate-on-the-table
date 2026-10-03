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
 * Synchronous cache accessor — no side effects, no loading.
 * @param {string} lang
 * @returns {any|undefined}
 */
export function getCachedNameGenDict(lang) {
  return dictCache.has(lang) ? dictCache.get(lang) : undefined;
}

/**
 * Preload a set of language dicts with per-entry isolation.
 * One broken dict does not reject the whole batch.
 * Falls back via loadNameGenDict, but unknown languages are reported as
 * errors even when the fallback succeeds — the requested key itself is broken.
 * @param {string[]} langKeys
 * @returns {Promise<Array<{lang:string, dict:any|null, error:any|null}>>}
 */
export async function preloadNameGenDicts(langKeys) {
  if (!Array.isArray(langKeys) || langKeys.length === 0) return [];
  const results = await Promise.all(
    langKeys.map(async (k) => {
      try {
        // Unknown language keys are considered broken even though
        // loadNameGenDict falls back to english/russian and succeeds.
        const isKnown = k in NAME_GEN_LANGUAGES;
        const dict = await loadNameGenDict(k);
        if (!isKnown) {
          return { lang: k, dict: null, error: new Error(`unknown language "${k}"`) };
        }
        // loadNameGenDict may return null only when both primary and
        // fallback imports fail — treat as error.
        if (!dict) {
          return { lang: k, dict: null, error: new Error(`dict not available for "${k}"`) };
        }
        return { lang: k, dict, error: null };
      } catch (err) {
        return { lang: k, dict: null, error: err };
      }
    }),
  );
  return results;
}

/**
 * Pure helper: resolve settings language option to the list of dict keys
 * that must be preloaded. `random` → all languages, otherwise single resolved.
 * @param {{language?:string}|string} opts
 * @returns {string[]}
 */
export function resolveNameGenLanguageKeys(opts) {
  const language = typeof opts === "string" ? opts : (opts?.language ?? "random");
  if (language === "random") return Object.keys(NAME_GEN_LANGUAGES);
  return [resolveLanguage(language)];
}

/**
 * Pure helper for writing a generated name to a token doc / creation data.
 * Mirrors the preCreateToken apply logic for testability.
 * @param {object|null} tokenDoc
 * @param {object|null} data
 * @param {string} newName
 * @returns {boolean} true if applied
 */
export function applyGeneratedName(tokenDoc, data, newName) {
  if (!newName || typeof newName !== "string") return false;
  try {
    if (typeof tokenDoc?.updateSource === "function") {
      tokenDoc.updateSource({ name: newName });
      return true;
    }
    if (tokenDoc && typeof tokenDoc === "object") {
      tokenDoc.name = newName;
      if (data && typeof data === "object" && data !== tokenDoc) data.name = newName;
      return true;
    }
    if (data && typeof data === "object") {
      data.name = newName;
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

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
