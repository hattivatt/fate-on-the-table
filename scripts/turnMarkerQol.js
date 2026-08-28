/**
 * turnMarkerQol — pure helpers for the token turn-marker QoL.
 * No Foundry globals at import time.
 */

/** Setting key shared with settings.js / constants.js. */
export const TURN_MARKER_SETTING = "autoTurnMarker";

/**
 * Returns a TokenDocument turnMarker patch that enables the ring, or null
 * when the token should not be touched (already on / not an object / missing).
 *
 *   mode 0 -> disabled (needs patch -> mode 1, keeping animation/src/disposition)
 *   mode 1/2/... -> already enabled / other -> null
 *   non-object / null / undefined / array -> null (never invent the structure)
 *
 * @param {*} turnMarker  The current TokenDocument.turnMarker value.
 * @returns {{mode:number, animation?:*, src?:*, disposition?:*}|null}
 */
export function turnMarkerPatchFor(turnMarker) {
  if (!turnMarker || typeof turnMarker !== "object" || Array.isArray(turnMarker)) return null;
  if (Number(turnMarker.mode) !== 0) return null;
  return { ...turnMarker, mode: 1 };
}

/**
 * Collects token patches for a batch update.
 * Pure helper extracted so it is unit-testable without the scene.
 *
 * @param {Array} tokenDocs  Array of TokenDocuments (or plain {id,_id,turnMarker} shapes).
 * @returns {Array<{id:string,patch:object,_id:string,turnMarker:object}>}
 *   Array of entries for tokens that actually need enabling. Each entry carries
 *   both the `{id,patch}` shape requested by the spec and the
 *   `{_id,turnMarker}` shape consumed by `updateEmbeddedDocuments`.
 */
export function collectTurnMarkerPatches(tokenDocs) {
  if (!Array.isArray(tokenDocs)) return [];
  const out = [];
  for (const tok of tokenDocs) {
    if (!tok || typeof tok !== "object") continue;
    const id = tok.id ?? tok._id ?? tok.document?.id ?? null;
    if (!id) continue;
    const tm =
      tok.turnMarker ??
      tok.document?.turnMarker ??
      null;
    // Array turnMarker is treated as no-op by turnMarkerPatchFor but handle
    // the case where tok itself wraps the document differently.
    const patch = turnMarkerPatchFor(tm);
    if (!patch) continue;
    out.push({ id, patch, _id: id, turnMarker: patch });
  }
  return out;
}
