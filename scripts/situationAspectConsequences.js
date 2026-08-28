/**
 * Pure consequence helpers for situation aspects (no Foundry globals —
 * importable from Node tests). Mirrors situationAspectZones.js but for the
 * consequence binding (`aspect.consequence = {trackKey, cost, actorName}`).
 *
 * - `consequence` is the stable structural binding for a consequence-aspect;
 *   without it a linked aspect is a candidate for "adoption" when it matches a
 *   character's live consequence track text.
 * - The marker is rendered in front of a consequence-bound line in the SA
 *   widget: e.g. "✚ Name (invokes)" (2), "⚠ Name (invokes)" (4),
 *   "☠ Name (invokes)" (6); any other / missing cost falls back to "✚".
 */

import { parseBinding } from "./situationAspectNames.js";

export const CONSEQUENCE_MARKERS = Object.freeze({ 2: "✚", 4: "⚠", 6: "☠" });
export const CONSEQUENCE_MARKER_DEFAULT = "✚";

/**
 * Glyph for a consequence cost. Non-number / ≤0 / NaN / undefined -> default.
 * Known costs 2/4/6 map to their dedicated glyphs; any other positive cost
 * uses the default glyph as well.
 * @param {*} cost
 * @returns {string}
 */
export function consequenceMarker(cost) {
  const n = Number(cost);
  if (!Number.isFinite(n) || n <= 0) return CONSEQUENCE_MARKER_DEFAULT;
  return CONSEQUENCE_MARKERS[n] ?? CONSEQUENCE_MARKER_DEFAULT;
}

/**
 * True when a track is a consequence/condition track (has absorbable harm).
 * `harm_can_absorb` is the field edited on the sheet; a positive value
 * signals a consequence track (traditionally 2/4/6 but fully editable).
 * @param {*} track
 * @returns {boolean}
 */
export function isConsequenceTrack(track) {
  return Number(track?.harm_can_absorb) > 0;
}

/**
 * Consequence tracks of an actor's `system.tracks` map.
 * Only tracks with a positive `harm_can_absorb` and a non-empty
 * `aspect.name` are considered (mirrors the live consequence list the
 * conflict card cost rows iterate). Order follows `Object.entries`.
 * @param {*} tracks  `actor.system.tracks` map
 * @returns {Array<{trackKey: string, cost: number, text: string}>}
 */
export function consequenceTracksOf(tracks) {
  if (!tracks || typeof tracks !== "object" || Array.isArray(tracks)) return [];
  const out = [];
  for (const [trackKey, track] of Object.entries(tracks)) {
    if (!isConsequenceTrack(track)) continue;
    const text = String(track?.aspect?.name ?? "").trim();
    if (!text) continue;
    out.push({ trackKey, cost: Number(track.harm_can_absorb), text });
  }
  return out;
}

/**
 * Structural consequence meta for a situation aspect.
 * @param {string} trackKey
 * @param {*} cost  Raw `harm_can_absorb` (number|string|null/undefined)
 * @param {string} actorName
 * @returns {{trackKey: string, cost: number, actorName: string}}
 */
export function buildConsequenceMeta(trackKey, cost, actorName) {
  return { trackKey: String(trackKey ?? ""), cost: Number(cost), actorName: String(actorName ?? "") };
}

/**
 * Reconciles a situation aspect list against the live actor tracks of the
 * scene. Pure, no Foundry globals.
 *
 * Each aspect with a structural `consequence` binding is resolved:
 * - actor not on scene (by `meta.actorName`) -> delete;
 * - track missing or `track.aspect.name` empty -> delete;
 * - name mismatch (`${trackText} (${actorName})`) -> rename (keep invokes/zoneIds/linked);
 * - `harm_can_absorb` differs from `meta.cost` -> update meta (Number(cost)).
 *
 * A `linked===true` aspect WITHOUT a meta is a candidate for adoption:
 * `parseBinding(name)` -> suffix; when that suffix matches an actor and the
 * base matches one of that actor's `consequenceTracksOf` texts, attach the
 * structural meta.
 *
 * Idempotent: second call with same list and actors -> changed:false, deep-equal list.
 * @param {object[]} list  Situation aspect list (raw flag value)
 * @param {Array<{name: string, tracks: object}>} actors  Scene actors (first occurrence per name)
 * @returns {{list: object[], changed: boolean}}
 */
export function reconcileConsequences(list, actors) {
  if (!Array.isArray(list)) return { list: [], changed: false };
  const actorByName = new Map();
  for (const a of actors ?? []) {
    const name = String(a?.name ?? "").trim();
    if (!name) continue;
    if (actorByName.has(name)) continue;
    actorByName.set(name, a);
  }
  let changed = false;
  const out = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") {
      out.push(raw);
      continue;
    }
    const meta = raw.consequence;
    const hasMeta =
      meta && typeof meta === "object" && typeof meta.actorName === "string" && typeof meta.trackKey === "string";
    if (hasMeta) {
      const actor = actorByName.get(String(meta.actorName).trim());
      if (!actor) {
        changed = true;
        continue;
      }
      const track = actor.tracks?.[meta.trackKey];
      const trackText = String(track?.aspect?.name ?? "").trim();
      if (!track || !trackText) {
        changed = true;
        continue;
      }
      const expectedName = `${trackText} (${meta.actorName})`;
      const currentName = String(raw.name ?? "");
      const normalizedCost = Number(track?.harm_can_absorb);
      const metaCost = Number(meta.cost);
      const needName = currentName !== expectedName;
      const needCost = !Object.is(normalizedCost, metaCost);
      if (!needName && !needCost) {
        out.push(raw);
        continue;
      }
      changed = true;
      const next = { ...raw };
      if (needName) next.name = expectedName;
      if (needCost) next.consequence = { ...meta, cost: normalizedCost };
      out.push(next);
      continue;
    }
    if (raw.linked === true) {
      const { base, suffix } = parseBinding(String(raw.name ?? ""));
      if (!suffix) {
        out.push(raw);
        continue;
      }
      const actor = actorByName.get(suffix);
      if (!actor) {
        out.push(raw);
        continue;
      }
      const tracks = consequenceTracksOf(actor.tracks ?? {});
      const match = tracks.find((t) => t.text === base);
      if (!match) {
        out.push(raw);
        continue;
      }
      changed = true;
      out.push({ ...raw, consequence: buildConsequenceMeta(match.trackKey, match.cost, suffix) });
      continue;
    }
    out.push(raw);
  }
  if (!changed) return { list, changed: false };
  return { list: out, changed: true };
}
