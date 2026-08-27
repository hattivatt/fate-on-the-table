/**
 * Pure zone-binding helpers for situation aspects (no Foundry globals —
 * importable from Node tests). Mirrors situationAspectNames.js but for the
 * STRUCTURAL zone binding (`zoneIds: string[]`) introduced alongside the
 * conflict board.
 *
 * - `zoneIds` is the stable structural binding to conflict-board zones;
 *   a text suffix like "Aspect (Zone)" is the LEGACY textual form and is
 *   migrated to `zoneIds` inside SituationAspectSync.
 * - The marker `SA_ZONE_MARKER` is rendered in front of a zone-bound line
 *   in the SA widget (`◈ Name (invokes)`).
 */

import { buildBoundName, parseBinding } from "./situationAspectNames.js";

export const SA_ZONE_MARKER = "◈";

/**
 * Normalizes a zoneIds value to a de-duplicated array of existing zone ids.
 * When `validIds` is supplied only ids present there survive; otherwise every
 * string id survives. Order of the first occurrence is preserved.
 * Non-arrays / undefined -> [].
 * @param {*} value
 * @param {Iterable<string>|null|undefined} validIds
 * @returns {string[]}
 */
export function normalizeZoneIds(value, validIds) {
  if (!Array.isArray(value)) return [];
  const validSet = validIds != null ? new Set(validIds) : null;
  const seen = new Set();
  const out = [];
  for (const raw of value) {
    if (typeof raw !== "string") continue;
    const id = raw;
    if (!id) continue;
    if (seen.has(id)) continue;
    if (validSet && !validSet.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Safe read of an aspect's zoneIds: [] when missing / not an array.
 * Returns a shallow copy filtered to strings (no mutation of the source).
 * @param {*} aspect
 * @returns {string[]}
 */
export function aspectZoneIds(aspect) {
  if (!aspect || typeof aspect !== "object") return [];
  const v = aspect.zoneIds;
  if (!Array.isArray(v)) return [];
  // Keep only string ids; preserve order (no dedup here — caller decides).
  return v.filter((id) => typeof id === "string" && id.length > 0);
}

/**
 * Aspects bound to a concrete zone id.
 * @param {object[]} aspects
 * @param {string} zoneId
 * @returns {object[]}
 */
export function aspectsForZone(aspects, zoneId) {
  if (!Array.isArray(aspects) || typeof zoneId !== "string" || !zoneId) return [];
  return aspects.filter((a) => aspectZoneIds(a).includes(zoneId));
}

/**
 * Strips a trailing zone suffix from a name when it matches a known zone.
 * Pure helper for the migration path; character priority is NOT checked here
 * (the caller `migrateZoneSuffixes` does it).
 * @param {string} name
 * @param {Record<string,string>|Map<string,string>} zoneNameToId
 * @returns {{name: string, zoneId: string|null, matched: boolean}}
 */
export function stripZoneSuffix(name, zoneNameToId) {
  const raw = String(name ?? "");
  const { base, suffix } = parseBinding(raw);
  if (!suffix) return { name: raw.trim(), zoneId: null, matched: false };
  let zoneId = null;
  if (zoneNameToId instanceof Map) zoneId = zoneNameToId.get(suffix) ?? null;
  else if (zoneNameToId && typeof zoneNameToId === "object") zoneId = zoneNameToId[suffix] ?? null;
  if (zoneId) return { name: base, zoneId, matched: true };
  return { name: raw.trim(), zoneId: null, matched: false };
}

/**
 * Migrates legacy textual zone suffixes ("Aspect (Zone)") to structural
 * `zoneIds: [zoneId]` / `name: base`.
 *
 * For every aspect that has NO existing zoneIds, the trailing suffix is
 * parsed via `parseBinding`; when it matches a zone name in `zoneNameToId`
 * AND does NOT match a character name (Set `characterNames` — character
 * priority) the aspect is converted. All other aspects are left untouched.
 * Idempotent: a second call yields `changed === false`.
 * @param {object[]} list
 * @param {Record<string,string>|Map<string,string>} zoneNameToId
 * @param {Set<string>|Iterable<string>} characterNames
 * @returns {{list: object[], changed: boolean}}
 */
export function migrateZoneSuffixes(list, zoneNameToId, characterNames) {
  if (!Array.isArray(list)) return { list: [], changed: false };
  const charSet = characterNames instanceof Set ? characterNames : new Set(characterNames ?? []);
  const getZoneId = (suffix) => {
    if (zoneNameToId instanceof Map) return zoneNameToId.get(suffix) ?? null;
    if (zoneNameToId && typeof zoneNameToId === "object") return zoneNameToId[suffix] ?? null;
    return null;
  };
  let changed = false;
  const newList = list.map((aspect) => {
    if (!aspect || typeof aspect !== "object") return aspect;
    const existing = aspectZoneIds(aspect);
    if (existing.length > 0) return aspect;
    const rawName = String(aspect.name ?? "");
    const { base, suffix } = parseBinding(rawName);
    if (!suffix) return aspect;
    if (charSet.has(suffix)) return aspect;
    const zoneId = getZoneId(suffix);
    if (!zoneId) return aspect;
    changed = true;
    return { ...aspect, name: base, zoneIds: [zoneId] };
  });
  return { list: changed ? newList : list, changed };
}

/**
 * Pure helper for the MANAGER submit paths: builds the next `{name, zoneIds}`
 * from a raw text field plus the chosen bindings.
 *
 * - `character` has priority over `zoneIds` (mutual exclusion, same as the
 *   UI and `buildBoundName`);
 * - when a zone binding is chosen the trailing textual suffix of `rawName`
 *   is stripped via `parseBinding(rawName).base` so the name is stored bare
 *   and the structural `zoneIds` carry the binding;
 * - `zoneIds` are normalized through `normalizeZoneIds(value, validIds)` so
 *   dangling ids or duplicates are never persisted;
 * - with NEITHER binding the name handling follows the edit-form contract:
 *   when `hadKnownBinding` is true (the edited aspect carried a known binding)
 *   the suffix is stripped, otherwise the verbatim trimmed name is kept so an
 *   unknown suffix like "(custom note)" survives untouched.
 *
 * Idempotent with respect to ordering/dedup and validIds filtering.
 * @param {string} rawName  Trimmed text of the name field.
 * @param {{character?: string, zoneIds?: string[], hadKnownBinding?: boolean}} [binding]
 * @param {Iterable<string>|null|undefined} validIds  Existing zone ids of the live board.
 * @returns {{name: string, zoneIds: string[]}}
 */
export function applyAspectBinding(rawName, binding = {}, validIds) {
  const raw = String(rawName ?? "").trim();
  const character = String(binding?.character ?? "").trim();
  const hadKnownBinding = !!binding?.hadKnownBinding;
  const zones = normalizeZoneIds(binding?.zoneIds, validIds);
  if (character) {
    const base = parseBinding(raw).base || raw;
    return { name: buildBoundName(base, { character }), zoneIds: [] };
  }
  if (zones.length) {
    const base = parseBinding(raw).base || raw;
    return { name: base || raw, zoneIds: zones };
  }
  if (hadKnownBinding) {
    const base = parseBinding(raw).base;
    return { name: base || raw, zoneIds: [] };
  }
  return { name: raw, zoneIds: [] };
}
