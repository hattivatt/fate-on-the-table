/**
 * challengeContest — pure helpers for the "Challenge / Contest" macro that the
 * module ships in the `challenge-contest` Macro compendium pack.
 *
 * Foundry-free: this module never touches top-level `foundry` / `game` /
 * `canvas` / `CONST`, so it imports cleanly in Node tests (the macro command
 * loads it through a dynamic `import()` and supplies all Foundry glue itself).
 *
 * Two text eras coexist:
 *   - LEGACY drawings (no module flags) carry checkbox glyphs and are toggled by
 *     the macro's "single controlled drawing" branch (`buildChallengeText` /
 *     `checkFirstUncheckedTask`). They are intentionally NOT adapted.
 *   - NEW blocks are ONE Drawing each (challenge and contest alike), mirroring
 *     `contestDrawingData`: the block fill/texture is the drawing's own fill
 *     (`fillType: texture ? 2 : addBackground ? 1 : 0`) and the task state lives
 *     in the drawing's module flags (`challengeDrawingData`). The challenge text
 *     is one `"<mark> <text> +<difficulty>"` line per task joined with blank
 *     lines, where the mark is `✅` (success), `❌` (failed) or empty (pending).
 *     Move stays native. Resize is normalised by `drawingFreeResize.js` so our
 *     blocks resize on INDEPENDENT axes (core v14 locks the aspect ratio of a
 *     rectangle drawing); `fontSize` is never rescaled.
 *
 * Legacy multi-drawing challenge blocks (one `taskRow` Drawing per task from the
 * previous layout) still open their context menu and can be deleted as a group,
 * but they no longer receive strike overlays; the user is expected to recreate
 * them in the single-drawing format.
 *
 * The exported builders reproduce the geometry of the legacy standalone macro
 * (`foundry_macro/challenge.js`): the challenge block is one row per task (row
 * pitch `CHALLENGE_TEXT_HEIGHT_PER_TASK`), contest sides share one drawing with
 * a 60-per-side row pitch. Both builders grow the shape by the fixed
 * `CHALLENGE_CONTEST_PAD_X/Y` margins (the centered text never touches the
 * border); the WIDTH is derived dynamically from the widest rendered line
 * (`widthFor`) and the contest height from the REAL rendered line count
 * (`linesFor`), so the blank `"\n\n"` separators fit and a long side name
 * widens the block instead of wrapping.
 */

import {
  FLAG_SCOPE,
  CHALLENGE_OWNER_TYPE,
  CONTEST_OWNER_TYPE,
} from "./constants.js";
import { TEXT_WIDTH_APPROX_FACTOR } from "./layoutGeometry.js";

// Checkbox glyphs used by legacy drawings and by the contest box chart
// (`[   ]` / `[ X ]`).
export const CHECKBOX_UNCHECKED = "[   ]";
export const CHECKBOX_CHECKED = "[ X ]";

// Task status marks rendered as a PREFIX before the task text. Color emoji are
// drawn by PIXI through the canvas 2D `fillText` API in the browser, so they
// render in color (unlike the rich-text pipeline, which Drawing text bypasses).
export const MARK_SUCCESS = "\u2705"; // ✅
export const MARK_FAILED = "\u274C"; // ❌

/** Canonical challenge task statuses. */
export const TASK_STATUS = Object.freeze({
  PENDING: "pending",
  SUCCESS: "success",
  FAILED: "failed",
});

// Legacy nominal geometry. Positions are intentionally NOT configurable: the
// macro anchors every drawing block to the pivot of the current canvas stage
// and the module `scale` setting multiplies the whole block (see `scaled`).
// `CHALLENGE_TEXT_WIDTH` / `CONTEST_TEXT_WIDTH` were the fixed text bases; the
// single-drawing builders now derive the width from the rendered text
// (`widthFor` + `CHALLENGE_CONTEST_MIN_TEXT_WIDTH`) and only keep these as
// legacy fallbacks (also accepted through `options.textWidth` as a floor).
export const CHALLENGE_TEXT_WIDTH = 500;
export const CHALLENGE_TEXT_HEIGHT_PER_TASK = 90;
export const CONTEST_TEXT_WIDTH = 700;
export const CONTEST_TEXT_HEIGHT = 60;
// Legacy per-side gap. The block height is now derived from the real rendered
// line count (the `"\n\n"` separator already occupies one row pitch), so this
// constant is no longer used by `contestDrawingData`; kept for compatibility.
export const CONTEST_TEXT_GAP = 10;

// Fixed internal shape padding (NOT a setting). Foundry centers the Drawing
// text horizontally/vertically inside `shape`, so the shape is grown by these
// base (unscaled) margins on every side; the text itself is unchanged and now
// keeps a border of air instead of touching the block edge. Both blocks share
// the same visual frame, so one pair of constants covers challenge and contest.
export const CHALLENGE_CONTEST_PAD_X = 28;
export const CHALLENGE_CONTEST_PAD_Y = 18;

// Dynamic-width guard rails. The block width is derived from the widest
// RENDERED text line (the same `TEXT_WIDTH_APPROX_FACTOR` approximation the
// layout engine uses in `wrapLinesForValue`), not from a fixed 500/700 base:
// a short list yields a narrow block, a long line a wide one. `MIN_TEXT_WIDTH`
// keeps a short (or still empty) block from collapsing to a point, and the
// challenge-only `MARK_RESERVE` leaves room for a future ✅/❌ prefix: a PENDING
// task carries no mark in the rendered text yet, but once the user sets a
// status the line grows by the emoji + a space. At font 40 that prefix is
// ~2 chars * 40 * 0.62 ≈ 50px; 70 base covers it and scales with `scale`.
export const CHALLENGE_CONTEST_MIN_TEXT_WIDTH = 200;
export const CHALLENGE_MARK_RESERVE = 70;

// Legacy per-item defaults (used when a form field is left empty).
export const DEFAULT_TASK_DIFFICULTY = 2;
export const DEFAULT_SIDE_BOXES = 3;
export const DEFAULT_CHALLENGE_TASK_COUNT = 3;
export const DEFAULT_CONTEST_SIDE_COUNT = 2;

// One fixed font size for both drawing types. This is deliberately NOT a
// setting: the module-wide `scale` setting is the only size knob and it
// multiplies this constant (same convention as layout fonts/geometry).
export const DEFAULT_FONT_SIZE = 40;

/**
 * Defaults mirrored from the legacy journal page `ChallengeContestManager`.
 * The old contest page carried a copy/paste label bug on `contestTextColor`,
 * but its stored default was (and stays) `#000000`; the module just exposes it
 * as a proper setting.
 */
export const CHALLENGE_SETTING_DEFAULTS = Object.freeze({
  challengeFontFamily: "Montserrat",
  challengeAddBackground: false,
  challengeBackgroundColor: "#ffffff",
  challengeTextColor: "#000000",
});

export const CONTEST_SETTING_DEFAULTS = Object.freeze({
  contestFontFamily: "Montserrat",
  contestAddBackground: false,
  contestBackgroundColor: "#ffffff",
  contestTextColor: "#000000",
});

/**
 * All macro settings in one frozen object (module defaults + macro fallback).
 * `challengeContestBackgroundTexture` is deliberately shared by BOTH the
 * challenge and the contest drawings (one world setting drives both), so it
 * lives only here and not in the per-kind default objects above.
 */
export const CHALLENGE_CONTEST_SETTING_DEFAULTS = Object.freeze({
  ...CHALLENGE_SETTING_DEFAULTS,
  ...CONTEST_SETTING_DEFAULTS,
  challengeContestBackgroundTexture: "",
});

/** Stable setting-key list (mirrors the registration order in settings.js). */
export const CHALLENGE_CONTEST_SETTING_KEYS = Object.freeze(
  Object.keys(CHALLENGE_CONTEST_SETTING_DEFAULTS),
);

/**
 * Coerces a value to a finite number, else `fallback`.
 * @param {*} value
 * @param {number} fallback
 * @returns {number}
 */
function asNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Multiplies a base (unscaled) value by the module `scale` setting. An invalid
 * or omitted scale is treated as `1`, so the identity is safe to call from
 * pure tests. Mirrors how layout geometry/fonts apply `settings.scale`
 * (`value * scale`, e.g. layoutGeometry.js).
 * @param {*} value  Base (unscaled) value.
 * @param {*} [scale=1]  Multiplier (module `scale` setting).
 * @returns {number}
 */
export function scaled(value, scale = 1) {
  return asNumber(value, 0) * asNumber(scale, 1);
}

/**
 * Estimates how many RENDERED text lines a Drawing text produces inside a
 * `maxWidth`-wide box, using the same character-width approximation as the
 * layout engine (`TEXT_WIDTH_APPROX_FACTOR`, mirroring
 * `layoutGeometry.wrapLinesForValue`).
 *
 * Blank lines are counted, which is what makes the single-drawing heights
 * correct: the `"\n\n"` separator between tasks/sides renders as one EMPTY
 * line, so `n` joined blocks occupy `2n-1` text lines, not `n`.
 *
 * The estimate is a pure approximation for pure Node geometry tests; a real
 * browser font may differ slightly, but the padded shape leaves headroom.
 * @param {*} text  Raw drawing text (may contain `\n`; `"\n\n"` = blank line).
 * @param {*} maxWidth  Available text width (same units as `fontSize`).
 * @param {*} fontSize  Font size (same units as `maxWidth`).
 * @returns {number}  Rendered line count (0 for an empty string).
 */
export function linesFor(text, maxWidth, fontSize) {
  const source = String(text ?? "");
  if (source === "") return 0;
  const width = asNumber(maxWidth, 0);
  const approx = Math.max(asNumber(fontSize, 0) * TEXT_WIDTH_APPROX_FACTOR, 4);
  let count = 0;
  for (const raw of source.split("\n")) {
    if (width <= 0 || raw.length * approx <= width) {
      count += 1;
      continue;
    }
    // Word-wrap approximation: greedy fill, a word that no longer fits starts
    // the next line. A single word wider than the box still takes one line.
    let current = "";
    let wrapped = 0;
    for (const word of raw.split(" ")) {
      const candidate = current ? `${current} ${word}` : word;
      if (candidate.length * approx <= width) {
        current = candidate;
      } else if (current) {
        wrapped += 1;
        current = word;
      } else {
        wrapped += 1;
        current = "";
      }
    }
    if (current) wrapped += 1;
    count += Math.max(1, wrapped);
  }
  return count;
}

/**
 * Estimates the width (same units as `fontSize`) of the WIDEST rendered line
 * of a Drawing text, using the SAME per-character approximation as `linesFor`
 * (`charCount * fontSize * TEXT_WIDTH_APPROX_FACTOR`). This is the horizontal
 * projection of that metric: the block is sized to hold the longest hard line,
 * so no word-wrap happens and `linesFor` then counts the hard lines only.
 *
 * The result is rounded UP to a whole unit so the widest line always fits the
 * computed content width (rounding down could push `linesFor` into a spurious
 * wrap by a fraction of a pixel). Blank lines contribute width 0; an empty /
 * `null` text yields 0.
 * @param {*} text  Raw drawing text (may contain `\n`).
 * @param {*} fontSize  Font size (same units as the returned width).
 * @returns {number}  Approximate widest-line width (>= 0).
 */
export function widthFor(text, fontSize) {
  const source = String(text ?? "");
  if (source === "") return 0;
  const approx = Math.max(asNumber(fontSize, 0) * TEXT_WIDTH_APPROX_FACTOR, 4);
  let widest = 0;
  for (const raw of source.split("\n")) {
    const width = raw.length * approx;
    if (width > widest) widest = width;
  }
  return Math.ceil(widest);
}

/**
 * Normalizes a task status with backward compatibility:
 *   - `"success"` / `true`  -> `"success"`;
 *   - `"failed"`           -> `"failed"`;
 *   - `"pending"` / `false` / anything else -> `"pending"`;
 *   - a bare legacy `done` boolean is honored when `status` is absent.
 * @param {*} status
 * @param {*} [legacyDone]
 * @returns {"pending"|"success"|"failed"}
 */
export function normalizeTaskStatus(status, legacyDone) {
  if (status === "success" || status === true) return TASK_STATUS.SUCCESS;
  if (status === "failed") return TASK_STATUS.FAILED;
  if (status === "pending" || status === false) return TASK_STATUS.PENDING;
  return legacyDone === true ? TASK_STATUS.SUCCESS : TASK_STATUS.PENDING;
}

/**
 * Normalizes challenge tasks WITH their status: drops entries without a
 * non-whitespace text, fills a missing/NaN difficulty with the legacy default
 * (a provided `0` is preserved) and coerces the status with
 * `normalizeTaskStatus` (so old `done: true` flags map to `"success"`).
 * @param {Array<{text?: *, difficulty?: *, status?: *, done?: *}>} tasks
 * @returns {Array<{text: string, difficulty: number, status: string}>}
 */
export function normalizeTaskState(tasks) {
  if (!Array.isArray(tasks)) return [];
  return tasks
    .filter((task) => task && String(task.text ?? "").trim() !== "")
    .map((task) => ({
      text: String(task.text),
      difficulty: asNumber(task.difficulty, DEFAULT_TASK_DIFFICULTY),
      status: normalizeTaskStatus(task.status, task.done),
    }));
}

/**
 * Normalizes challenge tasks to the LEGACY shape (state stripped). Kept for
 * the checkbox-era helpers and their tests.
 * @param {Array<{text?: *, difficulty?: *}>} tasks
 * @returns {Array<{text: string, difficulty: number}>}
 */
export function normalizeTasks(tasks) {
  return normalizeTaskState(tasks).map(({ text, difficulty }) => ({
    text,
    difficulty,
  }));
}

/**
 * Builds the full text of a LEGACY challenge drawing (checkbox glyphs).
 * @param {Array<{text: string, difficulty: number}>} tasks
 * @returns {string} `"[   ] text +N"` rows joined with blank lines.
 */
export function buildChallengeText(tasks) {
  return normalizeTasks(tasks)
    .map((task) => `${CHECKBOX_UNCHECKED} ${task.text} +${task.difficulty}`)
    .join("\n\n");
}

/**
 * Renders ONE state-backed challenge task line: an optional status mark as a
 * PREFIX, then the plain task text + difficulty. The mark is `✅` for success,
 * `❌` for failed and absent for pending (no extra leading space).
 * @param {{text?: *, difficulty?: *, status?: *, done?: *}} task
 * @returns {string} `"<mark> <text> +<difficulty>"` or `""` for a blank task.
 */
export function renderChallengeTaskLine(task) {
  const normalized = normalizeTaskState([task])[0];
  if (!normalized) return "";
  const mark =
    normalized.status === TASK_STATUS.SUCCESS
      ? MARK_SUCCESS
      : normalized.status === TASK_STATUS.FAILED
        ? MARK_FAILED
        : "";
  const prefix = mark ? `${mark} ` : "";
  return `${prefix}${normalized.text} +${normalized.difficulty}`;
}

/**
 * Builds the full text of the SINGLE state-backed challenge drawing: one
 * `"<mark> <text> +<difficulty>"` line per task, joined with blank lines.
 * @param {Array<{text?: *, difficulty?: *, status?: *, done?: *}>} tasks
 * @returns {string}
 */
export function renderChallengeText(tasks) {
  return normalizeTaskState(tasks)
    .map((task) => renderChallengeTaskLine(task))
    .join("\n\n");
}

/**
 * Normalizes contest sides WITH their done counter: name to string, box count
 * clamped to [1, 20], `done` clamped to [0, boxes].
 * @param {Array<{name?: *, boxes?: *, done?: *}>} sides
 * @returns {Array<{name: string, boxes: number, done: number}>}
 */
export function normalizeSideState(sides) {
  if (!Array.isArray(sides)) return [];
  return sides.map((side) => {
    const source = side && typeof side === "object" ? side : {};
    const boxes = Math.min(
      Math.max(Math.floor(asNumber(source.boxes, DEFAULT_SIDE_BOXES)), 1),
      20,
    );
    const done = Math.min(
      Math.max(Math.floor(asNumber(source.done, 0)), 0),
      boxes,
    );
    return { name: String(source.name ?? ""), boxes, done };
  });
}

/**
 * Normalizes contest sides to the LEGACY shape (state stripped).
 * @param {Array<{name?: *, boxes?: *}>} sides
 * @returns {Array<{name: string, boxes: number}>}
 */
export function normalizeSides(sides) {
  return normalizeSideState(sides).map(({ name, boxes }) => ({ name, boxes }));
}

export function defaultChallengeTaskRows() {
  return Array.from({ length: DEFAULT_CHALLENGE_TASK_COUNT }, () => ({
    text: "",
    difficulty: DEFAULT_TASK_DIFFICULTY,
    status: TASK_STATUS.PENDING,
  }));
}

export function defaultContestSideRows() {
  return Array.from({ length: DEFAULT_CONTEST_SIDE_COUNT }, () => ({
    name: "",
    boxes: DEFAULT_SIDE_BOXES,
    done: 0,
  }));
}

export function editorTasksFromRows(rows) {
  return normalizeTaskState(rows);
}

export function editorSidesFromRows(rows, fallbackName = () => "") {
  if (!Array.isArray(rows)) return [];
  return normalizeSideState(
    rows.map((row, index) => {
      const source = row && typeof row === "object" ? row : {};
      const name = String(source.name ?? "").trim();
      return {
        name: name || String(fallbackName(index) ?? ""),
        boxes: source.boxes,
        done: source.done,
      };
    }),
  );
}

/**
 * Builds one contest side line from its done counter: the first `done` boxes
 * are `[ X ]`, the rest `[   ]`.
 * @param {{name?: *, boxes?: *, done?: *}} side
 * @returns {string} `"<name>: [X][ ][ ]"`.
 */
export function renderContestSideText(side) {
  const normalized = normalizeSideState([side])[0];
  if (!normalized) return "";
  const chart = Array.from({ length: normalized.boxes }, (_, index) =>
    index < normalized.done ? CHECKBOX_CHECKED : CHECKBOX_UNCHECKED,
  ).join("");
  return `${normalized.name}: ${chart}`;
}

/**
 * Builds the text of one LEGACY contest side drawing (all boxes unchecked).
 * @param {{name?: *, boxes?: *}} side
 * @returns {string} `"<name>: [   ][   ]..."`.
 */
export function buildContestSideText(side) {
  const normalized = normalizeSides([side])[0];
  if (!normalized) return "";
  return `${normalized.name}: ${CHECKBOX_UNCHECKED.repeat(normalized.boxes)}`;
}

/**
 * Builds one text per LEGACY contest side (one Drawing per side).
 * @param {Array<{name?: *, boxes?: *}>} sides
 * @returns {string[]}
 */
export function buildContestText(sides) {
  return normalizeSides(sides).map((side) => buildContestSideText(side));
}

/**
 * Builds the full text of the single state-backed contest drawing: one
 * `"<name>: [X][ ][ ]"` line per side, joined with blank lines.
 * @param {Array<{name?: *, boxes?: *, done?: *}>} sides
 * @returns {string}
 */
export function renderContestText(sides) {
  return normalizeSideState(sides).map((side) => renderContestSideText(side)).join("\n\n");
}

/**
 * Marks the FIRST unchecked box of a LEGACY drawing text as checked. Returns
 * the (possibly unchanged) text plus whether a toggle happened, so the macro
 * can report "already checked" without re-deriving the state.
 * @param {*} text
 * @returns {{text: string, changed: boolean}}
 */
export function checkFirstUncheckedTask(text) {
  const source = String(text ?? "");
  const index = source.indexOf(CHECKBOX_UNCHECKED);
  if (index === -1) return { text: source, changed: false };
  return {
    text:
      source.slice(0, index) +
      CHECKBOX_CHECKED +
      source.slice(index + CHECKBOX_UNCHECKED.length),
    changed: true,
  };
}

/**
 * Parses a challenge drawing text back into task descriptors (utility used to
 * inspect a drawing, e.g. when reasoning about checkbox state).
 * @param {*} text
 * @returns {Array<{checked: boolean, checkbox: string, text: string, difficulty: number|null}>}
 */
export function parseDrawingTasks(text) {
  const source = String(text ?? "").trim();
  if (!source) return [];
  return source.split(/\n{2,}/).map((block) => {
    const trimmed = block.trim();
    const match =
      /^(\[ {3}\]|\[ X \])\s+([\s\S]*?)\s*\+(-?\d+)\s*$/.exec(trimmed);
    if (!match) {
      return {
        checked: false,
        checkbox: "",
        text: trimmed,
        difficulty: null,
      };
    }
    return {
      checked: match[1] === CHECKBOX_CHECKED,
      checkbox: match[1],
      text: match[2],
      difficulty: Number(match[3]),
    };
  });
}

/**
 * Pure immutable set of one challenge task's status. The whole list is
 * normalized to the canonical `{text, difficulty, status}` shape first, so a
 * legacy `done` task carries over as `"success"`.
 * @param {Array<{status?: *, done?: *}>} tasks
 * @param {number} index
 * @param {"pending"|"success"|"failed"} status
 * @returns {Array<{text: string, difficulty: number, status: string}>|null}
 *   New array (one item mutated), or null when the list/index is invalid.
 */
export function setChallengeTaskStatus(tasks, index, status) {
  if (!Array.isArray(tasks)) return null;
  if (!Number.isInteger(index) || index < 0 || index >= tasks.length) return null;
  const next = normalizeTaskStatus(status, undefined);
  return normalizeTaskState(tasks).map((task, i) =>
    i === index ? { ...task, status: next } : { ...task },
  );
}

/**
 * Pure immutable advance of one contest side by `delta`, clamped to
 * [0, boxes]. Boxes are normalized with the same [1, 20] clamp as the
 * creation path.
 * @param {Array<{boxes?: *, done?: *}>} sides
 * @param {number} index
 * @param {number} delta  Signed step (+1 forward, −1 back).
 * @returns {Array<object>|null}  New array, or null when invalid.
 */
export function advanceSide(sides, index, delta) {
  if (!Array.isArray(sides)) return null;
  if (!Number.isInteger(index) || index < 0 || index >= sides.length) return null;
  const step = Math.trunc(Number(delta) || 0);
  // Normalize the WHOLE list up front so every returned side (including the
  // untouched ones) is persisted in the same canonical shape; then only the
  // selected side's `done` is advanced. Untouched sides are returned as the
  // normalized copies, never as the raw input objects.
  const base = normalizeSideState(sides);
  return base.map((side, i) => {
    if (i !== index) return side;
    const done = Math.min(Math.max(side.done + step, 0), side.boxes);
    return { ...side, done };
  });
}

/** Legacy Advanced Drawing Tools flags (drop shadows off). @returns {object} */
function legacyDrawingFlags() {
  return {
    adt: { dropShadow: false },
    "advanced-drawing-tools": { textStyle: { dropShadow: false } },
  };
}

/** Module-owned flag payload of the SINGLE state-backed challenge drawing. */
function challengeFlags(tasks, widgetId) {
  return {
    [FLAG_SCOPE]: {
      widgetId: widgetId ?? null,
      ownerType: CHALLENGE_OWNER_TYPE,
      tasks: normalizeTaskState(tasks),
    },
  };
}

/** Module-owned flag payload for a state-backed contest drawing. */
function contestFlags(sides, widgetId) {
  return {
    [FLAG_SCOPE]: {
      widgetId: widgetId ?? null,
      ownerType: CONTEST_OWNER_TYPE,
      sides: normalizeSideState(sides),
    },
  };
}

/**
 * Resolves the top-left anchor of a drawing block. When a `center` pivot is
 * given the block is centered on it; otherwise the explicit top-left position
 * is used (legacy contract). Keeps the block visually centered when `scale`
 * changes because the caller passes the already-scaled block size.
 * @param {{x?: number, y?: number}} [position]  Explicit top-left.
 * @param {{x?: number, y?: number}} [center]    Pivot to center the block on.
 * @param {number} width
 * @param {number} height
 * @returns {{x: number, y: number}}
 */
function resolveAnchor(position, center, width, height) {
  const cx = Number(center?.x);
  const cy = Number(center?.y);
  if (Number.isFinite(cx) && Number.isFinite(cy)) {
    return { x: cx - width / 2, y: cy - height / 2 };
  }
  return { x: asNumber(position?.x, 0), y: asNumber(position?.y, 0) };
}

/**
 * Builds the create payload of the SINGLE state-backed challenge Drawing: one
 * `"<mark> <text> +<difficulty>"` line per task joined with blank lines (marks
 * are `✅`/`❌` prefixes; pending rows carry no mark). Mirrors
 * `contestDrawingData`: the block fill/texture is the drawing's own fill
 * (`fillType: texture ? 2 : addBackground ? 1 : 0`). The text is centered by
 * Foundry inside the shape, so the shape is grown by the fixed
 * `CHALLENGE_CONTEST_PAD_X/Y` margins. The width is DYNAMIC: the widest
 * rendered line (`widthFor`) plus the challenge-only `CHALLENGE_MARK_RESERVE`
 * (room for a future `✅`/`❌` prefix), floored by
 * `CHALLENGE_CONTEST_MIN_TEXT_WIDTH` and any explicit `textWidth` request, then
 * +2*padX. The height stays `count * scaled(90) + 2*padY` (the 90/row pitch
 * already covers the blank `"\n\n"` separator line). The `tasks` state lives in
 * the module flags; the text is always DERIVED from it. When `options.center`
 * is given the (scaled, padded) block is centered on that pivot and `position`
 * is ignored.
 * @param {Array<{text: string, difficulty: number, status?: string, done?: boolean}>} tasks
 * @param {{x?: number, y?: number}} [position]  Top-left of the drawing.
 * @param {object} [options]  `{ scale, center, type, widgetId, fontFamily,
 *   textColor, addBackground, backgroundColor, backgroundTexture, textWidth,
 *   textHeightPerTask }`.
 * @returns {object}
 */
export function challengeDrawingData(tasks, position, options = {}) {
  const list = normalizeTaskState(tasks);
  const scale = asNumber(options.scale, 1);
  const texture = options.backgroundTexture ?? "";
  const padX = scaled(CHALLENGE_CONTEST_PAD_X, scale);
  const padY = scaled(CHALLENGE_CONTEST_PAD_Y, scale);
  const fontSize = scaled(DEFAULT_FONT_SIZE, scale);
  const text = renderChallengeText(list);
  // Dynamic width: widest rendered line + a reserve for a status mark that a
  // PENDING task does not carry yet (so marking it later cannot overflow),
  // floored by the absolute minimum and an optional explicit `textWidth`.
  const contentWidth = Math.max(
    scaled(CHALLENGE_CONTEST_MIN_TEXT_WIDTH, scale),
    widthFor(text, fontSize) + scaled(CHALLENGE_MARK_RESERVE, scale),
    scaled(asNumber(options.textWidth, 0), scale),
  );
  const width = contentWidth + 2 * padX;
  const rowHeight = scaled(
    asNumber(options.textHeightPerTask, CHALLENGE_TEXT_HEIGHT_PER_TASK),
    scale,
  );
  const totalHeight = list.length === 0 ? 0 : list.length * rowHeight + 2 * padY;
  const anchor = resolveAnchor(position, options.center, width, totalHeight);
  return {
    type: options.type ?? "r",
    x: anchor.x,
    y: anchor.y,
    text,
    fontSize,
    fontFamily: String(
      options.fontFamily ?? CHALLENGE_SETTING_DEFAULTS.challengeFontFamily,
    ),
    textColor: String(
      options.textColor ?? CHALLENGE_SETTING_DEFAULTS.challengeTextColor,
    ),
    fillType: texture ? 2 : options.addBackground ? 1 : 0,
    fillColor: String(
      options.backgroundColor ??
        CHALLENGE_SETTING_DEFAULTS.challengeBackgroundColor,
    ),
    fillAlpha: 1,
    texture: texture || null,
    strokeWidth: 0,
    shape: { width, height: totalHeight },
    flags: { ...legacyDrawingFlags(), ...challengeFlags(list, options.widgetId) },
  };
}

/**
 * Builds the create payload of the SINGLE state-backed contest Drawing (all
 * sides in one text, one `"<name>: [X][ ][ ]"` line per side joined with blank
 * lines; the `sides[].done` state lives in the module flags).
 *
 * The shape is sized from the REAL rendered line count, not from the side
 * count: a `"\n\n"` separator renders as one EMPTY line, so `n` sides occupy
 * `2n-1` text lines. The width is DYNAMIC — the widest rendered line
 * (`widthFor`), floored by `CHALLENGE_CONTEST_MIN_TEXT_WIDTH` and any explicit
 * `textWidth` — so a side name/box chart that would overflow the legacy 700
 * simply widens the block instead of wrapping; the height stays
 * `lines * scaled(60) + 2*padY` (the `linesFor` call kept as the lines-aware
 * contract, which now counts hard lines because no line wraps). The fixed
 * `CHALLENGE_CONTEST_PAD_X/Y` margins keep the centered text off the block
 * border. Centering mirrors `challengeDrawingData`.
 * @param {Array<{name: string, boxes: number, done?: number}>} sides
 * @param {{x?: number, y?: number}} [position]  Top-left of the drawing.
 * @param {object} [options]  `{ scale, center, type, widgetId, fontFamily,
 *   textColor, addBackground, backgroundColor, backgroundTexture, textWidth,
 *   textHeight }`.
 * @returns {object}
 */
export function contestDrawingData(sides, position, options = {}) {
  const list = normalizeSideState(sides);
  const scale = asNumber(options.scale, 1);
  const texture = options.backgroundTexture ?? "";
  const padX = scaled(CHALLENGE_CONTEST_PAD_X, scale);
  const padY = scaled(CHALLENGE_CONTEST_PAD_Y, scale);
  const fontSize = scaled(DEFAULT_FONT_SIZE, scale);
  const text = renderContestText(list);
  // Dynamic width: the widest rendered side line, floored by the absolute
  // minimum and an optional explicit `textWidth`.
  const textWidth = Math.max(
    scaled(CHALLENGE_CONTEST_MIN_TEXT_WIDTH, scale),
    widthFor(text, fontSize),
    scaled(asNumber(options.textWidth, 0), scale),
  );
  const width = textWidth + 2 * padX;
  const rowHeight = scaled(
    asNumber(options.textHeight, CONTEST_TEXT_HEIGHT),
    scale,
  );
  const lineCount = list.length === 0
    ? 0
    : linesFor(text, textWidth, fontSize);
  const totalHeight = lineCount === 0 ? 0 : lineCount * rowHeight + 2 * padY;
  const anchor = resolveAnchor(position, options.center, width, totalHeight);
  return {
    type: options.type ?? "r",
    x: anchor.x,
    y: anchor.y,
    text,
    fontSize,
    fontFamily: String(
      options.fontFamily ?? CONTEST_SETTING_DEFAULTS.contestFontFamily,
    ),
    textColor: String(
      options.textColor ?? CONTEST_SETTING_DEFAULTS.contestTextColor,
    ),
    fillType: texture ? 2 : options.addBackground ? 1 : 0,
    fillColor: String(
      options.backgroundColor ??
        CONTEST_SETTING_DEFAULTS.contestBackgroundColor,
    ),
    fillAlpha: 1,
    texture: texture || null,
    strokeWidth: 0,
    shape: { width, height: totalHeight },
    flags: { ...legacyDrawingFlags(), ...contestFlags(list, options.widgetId) },
  };
}
