/**
 * Pure name-binding helpers for situation aspects (no Foundry globals —
 * importable from Node tests).
 *
 * Situation aspects can carry a textual binding to a character token or to a
 * conflict-board zone: the choice is appended to the aspect text as a single
 * parenthetical suffix, Fate-Core-style (`"Aspect text (Goblin)"`,
 * `"Aspect text (Room)"`). The format must stay exactly `${base} (${choice})`
 * because ConsequenceInteractions.upsertSituationAspect deduplicates linked
 * aspects by the exact name `${text} (${actor.name})`.
 */

/**
 * Trailing parenthetical group of an aspect name: an optional whitespace
 * gap, a paren-free body and the closing parenthesis anchored at the end
 * of the string. Only a SIMPLE trailing group counts as a binding — a name
 * whose tail nests parentheses (e.g. "Fire (hot (very))") has no parseable
 * binding, keeps `suffix: ''` and is therefore preserved verbatim.
 */
const TRAILING_SUFFIX_RE = /\s*\(([^()]*)\)\s*$/;

/**
 * Appends exactly ONE binding suffix to an aspect base name. When both
 * choices are somehow non-empty the character wins (the UI enforces mutual
 * exclusion; this priority keeps submit-time code honest). An empty base
 * yields '' — callers validate the name before calling.
 * @param {string} base  Aspect text without any binding suffix.
 * @param {{character?: string, zone?: string}} [binding]
 * @returns {string}  `${base} (${choice})`, or the trimmed base when no
 *   choice is present.
 */
export function buildBoundName(base, binding = {}) {
  const text = String(base ?? "").trim();
  if (!text) return "";
  const character = String(binding?.character ?? "").trim();
  const zone = String(binding?.zone ?? "").trim();
  const choice = character || zone;
  return choice ? `${text} (${choice})` : text;
}

/**
 * Splits a trailing `(suffix)` off an aspect name. Used by the edit form to
 * preselect the character/zone binding: the suffix only preselects a select
 * when it matches a known token/zone name (checked by the caller); an
 * unrecognized suffix must survive saving untouched, which the caller
 * achieves by keeping the field verbatim when no binding is chosen.
 * @param {string} name  Full aspect name (may contain no suffix at all).
 * @returns {{base: string, suffix: string}}  Trimmed base text and the
 *   trimmed content of the trailing parenthetical group ('' when absent).
 */
export function parseBinding(name) {
  const raw = String(name ?? "");
  const m = TRAILING_SUFFIX_RE.exec(raw);
  if (!m) return { base: raw.trim(), suffix: "" };
  return {
    base: raw.slice(0, m.index).trim(),
    suffix: String(m[1] ?? "").trim(),
  };
}
