/**
 * Pure situation-aspect normalization (no Foundry globals at import time).
 * Shared by SituationAspectSync and ConflictBoardSync to avoid duplication and
 * the import cycle via settings/LayoutImportExport.
 */

import { normalizeZoneIds } from "./situationAspectZones.js";

/**
 * Deep-clones and normalizes a raw situation aspects list:
 * `free_invokes` becomes a non-negative integer, names are trimmed, empty
 * names are dropped. Unknown extra fields are preserved.
 * @param {*} list
 * @returns {object[]}
 */
export function normalizeAspects(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const raw of list) {
    const name = String(raw?.name ?? "").trim();
    if (!name) continue;
    const invokes = Math.max(0, Math.trunc(Number(raw.free_invokes) || 0));
    const zoneIds = normalizeZoneIds(raw?.zoneIds);
    out.push({ ...raw, name, free_invokes: invokes, zoneIds });
  }
  return out;
}
