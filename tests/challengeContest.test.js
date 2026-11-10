/**
 * Node tests for the pure "Challenge / Contest" helpers used by the module's
 * `challenge-contest` Macro pack (scripts/challengeContest.js).
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  CHECKBOX_UNCHECKED,
  CHECKBOX_CHECKED,
  MARK_SUCCESS,
  MARK_FAILED,
  TASK_STATUS,
  CHALLENGE_SETTING_DEFAULTS,
  CONTEST_SETTING_DEFAULTS,
  CHALLENGE_CONTEST_SETTING_DEFAULTS,
  CHALLENGE_CONTEST_SETTING_KEYS,
  DEFAULT_TASK_DIFFICULTY,
  DEFAULT_SIDE_BOXES,
  DEFAULT_CHALLENGE_TASK_COUNT,
  DEFAULT_CONTEST_SIDE_COUNT,
  DEFAULT_FONT_SIZE,
  CHALLENGE_TEXT_WIDTH,
  CHALLENGE_TEXT_HEIGHT_PER_TASK,
  CONTEST_TEXT_WIDTH,
  CONTEST_TEXT_HEIGHT,
  CHALLENGE_CONTEST_PAD_X,
  CHALLENGE_CONTEST_PAD_Y,
  CHALLENGE_CONTEST_MIN_TEXT_WIDTH,
  CHALLENGE_MARK_RESERVE,
  scaled,
  linesFor,
  widthFor,
  normalizeTasks,
  normalizeTaskState,
  normalizeTaskStatus,
  normalizeSides,
  normalizeSideState,
  buildChallengeText,
  renderChallengeTaskLine,
  renderChallengeText,
  renderContestText,
  renderContestSideText,
  buildContestSideText,
  buildContestText,
  setChallengeTaskStatus,
  advanceSide,
  checkFirstUncheckedTask,
  parseDrawingTasks,
  defaultChallengeTaskRows,
  defaultContestSideRows,
  editorTasksFromRows,
  editorSidesFromRows,
  challengeDrawingData,
  contestDrawingData,
} from "../scripts/challengeContest.js";
import { FLAG_SCOPE, CHALLENGE_OWNER_TYPE, CONTEST_OWNER_TYPE } from "../scripts/constants.js";

test("checkbox glyphs match the legacy macro", () => {
  assert.equal(CHECKBOX_UNCHECKED, "[   ]");
  assert.equal(CHECKBOX_CHECKED, "[ X ]");
});

test("legacy width constants stay exported for compatibility", () => {
  assert.equal(CHALLENGE_TEXT_WIDTH, 500);
  assert.equal(CONTEST_TEXT_WIDTH, 700);
});

test("default editor rows: three tasks and two sides", () => {
  assert.equal(DEFAULT_CHALLENGE_TASK_COUNT, 3);
  assert.equal(DEFAULT_CONTEST_SIDE_COUNT, 2);
  assert.deepEqual(defaultChallengeTaskRows(), [
    { text: "", difficulty: DEFAULT_TASK_DIFFICULTY, status: TASK_STATUS.PENDING },
    { text: "", difficulty: DEFAULT_TASK_DIFFICULTY, status: TASK_STATUS.PENDING },
    { text: "", difficulty: DEFAULT_TASK_DIFFICULTY, status: TASK_STATUS.PENDING },
  ]);
  assert.deepEqual(defaultContestSideRows(), [
    { name: "", boxes: DEFAULT_SIDE_BOXES, done: 0 },
    { name: "", boxes: DEFAULT_SIDE_BOXES, done: 0 },
  ]);
});

test("editorRows: normalize entered values and keep per-row state", () => {
  assert.deepEqual(
    editorTasksFromRows([
      { text: " A ", difficulty: "3", status: TASK_STATUS.SUCCESS },
      { text: "   ", difficulty: 5, status: TASK_STATUS.FAILED },
      { text: "B", difficulty: "bad", status: "unknown" },
    ]),
    [
      { text: " A ", difficulty: 3, status: TASK_STATUS.SUCCESS },
      { text: "B", difficulty: DEFAULT_TASK_DIFFICULTY, status: TASK_STATUS.PENDING },
    ],
  );
  assert.deepEqual(
    editorSidesFromRows(
      [
        { name: " Heroes ", boxes: "4", done: "2" },
        { name: "   ", boxes: "99", done: "99" },
      ],
      (index) => `Side ${index + 1}`,
    ),
    [
      { name: "Heroes", boxes: 4, done: 2 },
      { name: "Side 2", boxes: 20, done: 20 },
    ],
  );
  assert.deepEqual(editorSidesFromRows(null), []);
});

test("status marks are the color emoji check / cross", () => {
  assert.equal(MARK_SUCCESS, "\u2705"); // ✅
  assert.equal(MARK_FAILED, "\u274C"); // ❌
  assert.equal(MARK_SUCCESS, "✅");
  assert.equal(MARK_FAILED, "❌");
  assert.deepEqual(TASK_STATUS, {
    PENDING: "pending",
    SUCCESS: "success",
    FAILED: "failed",
  });
});

test("setting defaults mirror the legacy ChallengeContestManager page", () => {
  assert.equal(CHALLENGE_SETTING_DEFAULTS.challengeFontFamily, "Montserrat");
  assert.equal(CHALLENGE_SETTING_DEFAULTS.challengeAddBackground, false);
  assert.equal(CHALLENGE_SETTING_DEFAULTS.challengeBackgroundColor, "#ffffff");
  assert.equal(CHALLENGE_SETTING_DEFAULTS.challengeTextColor, "#000000");
  assert.equal(CONTEST_SETTING_DEFAULTS.contestFontFamily, "Montserrat");
  assert.equal(CONTEST_SETTING_DEFAULTS.contestAddBackground, false);
  assert.equal(CONTEST_SETTING_DEFAULTS.contestBackgroundColor, "#ffffff");
  // The legacy contest text color default is black (its label was the bug).
  assert.equal(CONTEST_SETTING_DEFAULTS.contestTextColor, "#000000");
  // Font size is no longer a setting: one fixed constant multiplied by scale.
  assert.equal("challengeFontSize" in CHALLENGE_SETTING_DEFAULTS, false);
  assert.equal("contestFontSize" in CONTEST_SETTING_DEFAULTS, false);
  assert.equal(DEFAULT_FONT_SIZE, 40);
  // One shared texture setting drives both challenge and contest drawings.
  assert.equal(
    CHALLENGE_CONTEST_SETTING_DEFAULTS.challengeContestBackgroundTexture,
    "",
  );
  assert.equal(
    "challengeContestBackgroundTexture" in CHALLENGE_SETTING_DEFAULTS,
    false,
  );
  assert.equal(
    "challengeContestBackgroundTexture" in CONTEST_SETTING_DEFAULTS,
    false,
  );
  assert.equal(
    Object.keys(CHALLENGE_CONTEST_SETTING_DEFAULTS).length,
    CHALLENGE_CONTEST_SETTING_KEYS.length,
  );
  assert.deepEqual(CHALLENGE_CONTEST_SETTING_KEYS, [
    "challengeFontFamily",
    "challengeAddBackground",
    "challengeBackgroundColor",
    "challengeTextColor",
    "contestFontFamily",
    "contestAddBackground",
    "contestBackgroundColor",
    "contestTextColor",
    "challengeContestBackgroundTexture",
  ]);
});

test("scaled: multiplies by scale, identity on 1 / invalid scale", () => {
  assert.equal(scaled(40, 1), 40);
  assert.equal(scaled(40, 2), 80);
  assert.equal(scaled(500, 0.5), 250);
  assert.equal(scaled(40), 40);
  assert.equal(scaled(40, "bad"), 40);
  assert.equal(scaled("bad", 2), 0);
});

test("linesFor: counts hard newlines including blank separator lines", () => {
  // A single line that fits stays one line.
  assert.equal(linesFor("hello world", 1000, 10), 1);
  // "\n" -> two lines, "\n\n" -> three (the blank line is counted).
  assert.equal(linesFor("a\nb", 1000, 10), 2);
  assert.equal(linesFor("a\n\nb", 1000, 10), 3);
  assert.equal(linesFor("a\n\n\nb", 1000, 10), 4);
  // Empty text has no lines at all.
  assert.equal(linesFor("", 1000, 10), 0);
  assert.equal(linesFor(null, 1000, 10), 0);
  assert.equal(linesFor(undefined, 1000, 10), 0);
  // A lone newline is two empty lines.
  assert.equal(linesFor("\n", 1000, 10), 2);
});

test("linesFor: word-wraps long lines and handles an unbreakable word", () => {
  // maxWidth 100, fontSize 40 -> approx 24.8 chars per line; each "aaa" is
  // 74.4 wide, so only one word fits per line -> 4 lines.
  assert.equal(linesFor("aaa bbb ccc ddd", 100, 40), 4);
  // No positive width means no wrapping (one line per hard newline).
  assert.equal(linesFor("aaa bbb ccc", 0, 40), 1);
  // An unbreakable word wider than the box still occupies one line.
  assert.equal(linesFor("aaaaaaaaaaaa", 100, 40), 1);
});

test("widthFor: widest hard line, rounded up (no wrap by a fraction)", () => {
  // fontSize 40 -> approx 24.8 per char; "abc" = 74.4 -> ceil 75.
  assert.equal(widthFor("abc", 40), 75);
  // The widest line wins across hard newlines; blank lines are 0.
  assert.equal(widthFor("a\nbb\nccc", 40), 75);
  assert.equal(widthFor("longest\n\nx", 40), Math.ceil(7 * 24.8));
  // Empty / null / undefined -> 0.
  assert.equal(widthFor("", 40), 0);
  assert.equal(widthFor(null, 40), 0);
  assert.equal(widthFor(undefined, 40), 0);
  // Never below 4 units per char (fontSize 0 guard).
  assert.equal(widthFor("abc", 0), 12);
  assert.equal(widthFor("abc", NaN), 12);
});

test("widthFor: scales with fontSize and never wraps a long line", () => {
  assert.equal(widthFor("abc", 80), Math.ceil(3 * 80 * 0.62));
  assert.ok(widthFor("abc", 80) > widthFor("abc", 40), "font size grows width");
  // A single very long line reports its FULL natural width (the dynamic block
  // widens instead of wrapping).
  assert.equal(widthFor("a".repeat(100), 40), Math.ceil(100 * 24.8));
  // widthFor(x) equals the char count metric linesFor uses to fit a line.
  const text = "alpha bravo charlie";
  assert.equal(linesFor(text, widthFor(text, 40), 40), 1);
});

/* ------------------------------------------------------------------ *
 * Legacy checkbox helpers (unchanged)
 * ------------------------------------------------------------------ */

test("buildChallengeText: rows joined with blank lines", () => {
  const text = buildChallengeText([
    { text: "Climb the wall", difficulty: 2 },
    { text: "Find the key", difficulty: 4 },
    { text: "Open the door", difficulty: 1 },
  ]);
  assert.equal(
    text,
    "[   ] Climb the wall +2\n\n[   ] Find the key +4\n\n[   ] Open the door +1",
  );
});

test("buildChallengeText: single task has no separator", () => {
  assert.equal(
    buildChallengeText([{ text: "Only", difficulty: 3 }]),
    "[   ] Only +3",
  );
});

test("buildChallengeText: empty input -> empty string", () => {
  assert.equal(buildChallengeText([]), "");
  assert.equal(buildChallengeText(null), "");
  assert.equal(buildChallengeText(undefined), "");
});

test("buildChallengeText: drops blank/whitespace-only tasks", () => {
  assert.equal(
    buildChallengeText([
      { text: "Keep", difficulty: 1 },
      { text: "   ", difficulty: 5 },
      { text: "", difficulty: 5 },
      null,
    ]),
    "[   ] Keep +1",
  );
});

test("buildChallengeText: missing/NaN difficulty falls back, 0 is preserved", () => {
  const text = buildChallengeText([
    { text: "A" },
    { text: "B", difficulty: "nope" },
    { text: "C", difficulty: 0 },
  ]);
  assert.equal(
    text,
    `[   ] A +${DEFAULT_TASK_DIFFICULTY}\n\n[   ] B +${DEFAULT_TASK_DIFFICULTY}\n\n[   ] C +0`,
  );
});

test("normalizeTasks: non-array -> []", () => {
  assert.deepEqual(normalizeTasks("nope"), []);
  assert.deepEqual(normalizeTasks({}), []);
});

test("buildContestText: one string per side with a checkbox run", () => {
  assert.deepEqual(
    buildContestText([
      { name: "Heroes", boxes: 3 },
      { name: "Villains", boxes: 2 },
    ]),
    ["Heroes: [   ][   ][   ]", "Villains: [   ][   ]"],
  );
});

test("buildContestText: single side and empty input", () => {
  assert.deepEqual(buildContestText([{ name: "Solo", boxes: 1 }]), [
    "Solo: [   ]",
  ]);
  assert.deepEqual(buildContestText([]), []);
  assert.deepEqual(buildContestText(null), []);
});

test("buildContestText: boxes clamp to [1, 20] and default to 3", () => {
  assert.deepEqual(
    buildContestText([
      { name: "Low", boxes: 0 },
      { name: "High", boxes: 99 },
      { name: "Missing" },
    ]),
    [
      "Low: [   ]",
      `High: ${CHECKBOX_UNCHECKED.repeat(20)}`,
      `Missing: ${CHECKBOX_UNCHECKED.repeat(DEFAULT_SIDE_BOXES)}`,
    ],
  );
});

test("buildContestText: empty name still yields a row", () => {
  assert.deepEqual(buildContestText([{ name: "", boxes: 2 }]), [
    ": [   ][   ]",
  ]);
});

test("buildContestSideText: matches the array builder and handles garbage", () => {
  assert.equal(
    buildContestSideText({ name: "Tie", boxes: 4 }),
    "Tie: [   ][   ][   ][   ]",
  );
  assert.equal(buildContestSideText(null), ": [   ][   ][   ]");
});

test("normalizeSides: non-array -> []", () => {
  assert.deepEqual(normalizeSides(undefined), []);
  assert.deepEqual(normalizeSides("x"), []);
});

test("checkFirstUncheckedTask: checks only the FIRST unchecked box", () => {
  const text = "[   ] A\n\n[   ] B";
  const result = checkFirstUncheckedTask(text);
  assert.equal(result.changed, true);
  assert.equal(result.text, "[ X ] A\n\n[   ] B");
});

test("checkFirstUncheckedTask: no unchecked box is a no-op", () => {
  const text = "[ X ] A\n\n[ X ] B";
  assert.deepEqual(checkFirstUncheckedTask(text), { text, changed: false });
  assert.deepEqual(checkFirstUncheckedTask(""), { text: "", changed: false });
  assert.deepEqual(checkFirstUncheckedTask(null), { text: "", changed: false });
});

test("parseDrawingTasks: reads checkbox/text/difficulty", () => {
  const parsed = parseDrawingTasks("[   ] A +2\n\n[ X ] B +0");
  assert.deepEqual(parsed, [
    { checked: false, checkbox: "[   ]", text: "A", difficulty: 2 },
    { checked: true, checkbox: "[ X ]", text: "B", difficulty: 0 },
  ]);
});

test("parseDrawingTasks: empty -> [] and unparseable blocks are kept", () => {
  assert.deepEqual(parseDrawingTasks(""), []);
  assert.deepEqual(parseDrawingTasks(null), []);
  assert.deepEqual(parseDrawingTasks("just text"), [
    { checked: false, checkbox: "", text: "just text", difficulty: null },
  ]);
});

/* ------------------------------------------------------------------ *
 * Task status model (status | legacy done)
 * ------------------------------------------------------------------ */

test("normalizeTaskStatus: status wins, legacy done boolean maps", () => {
  assert.equal(normalizeTaskStatus("success"), "success");
  assert.equal(normalizeTaskStatus("failed"), "failed");
  assert.equal(normalizeTaskStatus("pending"), "pending");
  assert.equal(normalizeTaskStatus(true), "success");
  assert.equal(normalizeTaskStatus(false), "pending");
  assert.equal(normalizeTaskStatus(undefined, true), "success");
  assert.equal(normalizeTaskStatus(undefined, false), "pending");
  assert.equal(normalizeTaskStatus("garbage"), "pending");
  assert.equal(normalizeTaskStatus(undefined, 1), "pending");
});

test("normalizeTaskState: status model with legacy done fallback", () => {
  assert.deepEqual(
    normalizeTaskState([
      { text: "A", difficulty: 1, done: true },
      { text: "B", status: "failed" },
      { text: "C", status: "pending" },
      { text: "D", status: "success" },
      { text: "   " },
      null,
    ]),
    [
      { text: "A", difficulty: 1, status: "success" },
      { text: "B", difficulty: 2, status: "failed" },
      { text: "C", difficulty: 2, status: "pending" },
      { text: "D", difficulty: 2, status: "success" },
    ],
  );
  assert.deepEqual(normalizeTaskState("nope"), []);
});

test("renderChallengeTaskLine: pending has no mark, success/failed get a prefix", () => {
  assert.equal(renderChallengeTaskLine({ text: "A", difficulty: 2 }), "A +2");
  assert.equal(
    renderChallengeTaskLine({ text: "A", difficulty: 2, status: "pending" }),
    "A +2",
  );
  assert.equal(
    renderChallengeTaskLine({ text: "A", difficulty: 2, status: "success" }),
    "✅ A +2",
  );
  assert.equal(
    renderChallengeTaskLine({ text: "A", difficulty: 2, status: "failed" }),
    "❌ A +2",
  );
  // Legacy `done` boolean maps to success.
  assert.equal(
    renderChallengeTaskLine({ text: "D", difficulty: 3, done: true }),
    "✅ D +3",
  );
  assert.equal(renderChallengeTaskLine({ text: "A" }), `A +${DEFAULT_TASK_DIFFICULTY}`);
  assert.equal(renderChallengeTaskLine({ text: "B", difficulty: 0 }), "B +0");
  assert.equal(renderChallengeTaskLine({ text: "  " }), "");
  assert.equal(renderChallengeTaskLine(null), "");
});

test("renderChallengeText: one marked line per task, joined with blank lines", () => {
  assert.equal(
    renderChallengeText([
      { text: "A", difficulty: 1 },
      { text: "B", difficulty: 2, status: "success" },
      { text: "C", difficulty: 3, status: "failed" },
    ]),
    "A +1\n\n✅ B +2\n\n❌ C +3",
  );
  assert.equal(renderChallengeText([{ text: "Only", difficulty: 3 }]), "Only +3");
  assert.equal(renderChallengeText([]), "");
  assert.equal(renderChallengeText(null), "");
});

test("renderChallengeText: marks never break the line join (single-code-unit BMP emoji)", () => {
  // Regression guard for the PIXI TextMetrics concern: ✅/❌ are single BMP
  // code units, so they must not act as line separators or split a task line.
  assert.equal(MARK_SUCCESS.length, 1);
  assert.equal(MARK_FAILED.length, 1);
  assert.equal(MARK_SUCCESS.codePointAt(0), 0x2705);
  assert.equal(MARK_FAILED.codePointAt(0), 0x274c);

  const text = renderChallengeText([
    { text: "A", difficulty: 1, status: "success" },
    { text: "B", difficulty: 2, status: "failed" },
    { text: "C", difficulty: 3, status: "pending" },
  ]);
  assert.equal(text, "✅ A +1\n\n❌ B +2\n\nC +3");
  assert.equal(text.split("\n\n").length, 3, "exactly one line per task");
  assert.equal(/\n\n\n/.test(text), false, "no extra blank line from a mark");
});

test("setChallengeTaskStatus: sets one task, never mutates the input", () => {
  const tasks = [
    { text: "A", difficulty: 1, status: "pending" },
    { text: "B", difficulty: 2, status: "pending" },
  ];
  const next = setChallengeTaskStatus(tasks, 0, "success");
  assert.deepEqual(next, [
    { text: "A", difficulty: 1, status: "success" },
    { text: "B", difficulty: 2, status: "pending" },
  ]);
  assert.equal(tasks[0].status, "pending", "input untouched");
  assert.notEqual(next, tasks, "new array");
  assert.deepEqual(setChallengeTaskStatus(tasks, 1, "failed")[1], {
    text: "B",
    difficulty: 2,
    status: "failed",
  });
  assert.equal(setChallengeTaskStatus(tasks, 0, "pending")[0].status, "pending");
  // A legacy done task is canonicalized before the status is written.
  assert.deepEqual(setChallengeTaskStatus([{ text: "A", done: true }], 0, "failed"), [
    { text: "A", difficulty: DEFAULT_TASK_DIFFICULTY, status: "failed" },
  ]);
});

test("setChallengeTaskStatus: invalid list/index -> null", () => {
  assert.equal(setChallengeTaskStatus(null, 0, "success"), null);
  assert.equal(setChallengeTaskStatus([], 0, "success"), null);
  assert.equal(setChallengeTaskStatus([{ text: "A" }], 2, "success"), null);
  assert.equal(setChallengeTaskStatus([{ text: "A" }], -1, "success"), null);
  assert.equal(setChallengeTaskStatus([{ text: "A" }], 0.5, "success"), null);
});

/* ------------------------------------------------------------------ *
 * advanceSide (contest, pure immutable)
 * ------------------------------------------------------------------ */

test("advanceSide: clamps to [0, boxes] and never mutates the input", () => {
  const sides = [{ name: "A", boxes: 2, done: 1 }];
  assert.equal(advanceSide(sides, 0, +1)[0].done, 2);
  assert.equal(advanceSide(sides, 0, -1)[0].done, 0);
  assert.equal(advanceSide(sides, 0, +99)[0].done, 2, "clamped to boxes");
  assert.equal(advanceSide(sides, 0, -99)[0].done, 0, "clamped to zero");
  assert.equal(sides[0].done, 1, "input untouched");
});

test("advanceSide: invalid list/index -> null; boxes normalized", () => {
  assert.equal(advanceSide(null, 0, 1), null);
  assert.equal(advanceSide([], 0, 1), null);
  assert.equal(advanceSide([{ boxes: 2 }], 5, 1), null);
  assert.equal(advanceSide([{ name: "A", done: 0 }], 0, 1)[0].boxes, DEFAULT_SIDE_BOXES);
});

test("advanceSide: untouched sides are normalized too (homogeneous flags)", () => {
  const sides = [
    { name: "A", boxes: 2, done: 0 },
    { name: "B", boxes: "garbage", done: "nope" },
  ];
  const next = advanceSide(sides, 0, +1);
  assert.deepEqual(next[1], { name: "B", boxes: DEFAULT_SIDE_BOXES, done: 0 });
  assert.equal(typeof next[1].boxes, "number");
  assert.equal(typeof next[1].done, "number");
  assert.deepEqual(next[0], { name: "A", boxes: 2, done: 1 });
  assert.equal(sides[1].boxes, "garbage");
});

test("normalizeSideState: done coerced and clamped", () => {
  assert.deepEqual(normalizeSideState([{ name: "A", boxes: 2, done: -5 }]), [
    { name: "A", boxes: 2, done: 0 },
  ]);
});

/* ------------------------------------------------------------------ *
 * renderContestText / renderContestSideText
 * ------------------------------------------------------------------ */

test("renderContestText: filled boxes chart follows the done counter", () => {
  assert.deepEqual(
    [
      renderContestSideText({ name: "A", boxes: 3, done: 0 }),
      renderContestSideText({ name: "B", boxes: 3, done: 1 }),
      renderContestSideText({ name: "C", boxes: 3, done: 3 }),
    ],
    ["A: [   ][   ][   ]", "B: [ X ][   ][   ]", "C: [ X ][ X ][ X ]"],
  );
});

test("renderContestText: sides joined with blank lines, done clamped", () => {
  assert.equal(
    renderContestText([
      { name: "A", boxes: 2, done: 1 },
      { name: "B", boxes: 2, done: 99 },
    ]),
    "A: [ X ][   ]\n\nB: [ X ][ X ]",
  );
});

/* ------------------------------------------------------------------ *
 * challengeDrawingData (ONE drawing with marks)
 * ------------------------------------------------------------------ */

test("challengeDrawingData: one payload, marked lines, flags, no fill", () => {
  const data = challengeDrawingData(
    [
      { text: "A", difficulty: 1, status: "pending" },
      { text: "B", difficulty: 2, status: "success" },
      { text: "C", difficulty: 3, status: "failed" },
    ],
    { x: 10, y: 20 },
  );
  assert.equal(data.text, "A +1\n\n✅ B +2\n\n❌ C +3");
  const widest = widthFor(data.text, DEFAULT_FONT_SIZE);
  assert.deepEqual(data.shape, {
    width:
      Math.max(CHALLENGE_CONTEST_MIN_TEXT_WIDTH, widest + CHALLENGE_MARK_RESERVE) +
      2 * CHALLENGE_CONTEST_PAD_X,
    height: 3 * CHALLENGE_TEXT_HEIGHT_PER_TASK + 2 * CHALLENGE_CONTEST_PAD_Y,
  });
  // Widest line "✅ B +2" (6 chars) -> ceil(6*24.8)=149; + reserve 70 = 219
  // (> min 200) -> + 2*28 padding.
  assert.deepEqual(data.shape, { width: 275, height: 306 });
  assert.equal(data.x, 10);
  assert.equal(data.y, 20);
  assert.equal(data.type, "r");
  assert.equal(data.fontFamily, "Montserrat");
  assert.equal(data.fontSize, DEFAULT_FONT_SIZE);
  assert.equal(data.textColor, "#000000");
  assert.equal(data.fillType, 0);
  assert.equal(data.texture, null);
  assert.deepEqual(data.flags.adt, { dropShadow: false });
  assert.equal(data.flags[FLAG_SCOPE].ownerType, CHALLENGE_OWNER_TYPE);
  assert.equal(data.flags[FLAG_SCOPE].widgetId, null);
  assert.deepEqual(data.flags[FLAG_SCOPE].tasks, [
    { text: "A", difficulty: 1, status: "pending" },
    { text: "B", difficulty: 2, status: "success" },
    { text: "C", difficulty: 3, status: "failed" },
  ]);
});

test("challengeDrawingData: legacy done + widgetId in flags", () => {
  const data = challengeDrawingData(
    [{ text: "Done", difficulty: 3, done: true }],
    { x: 0, y: 0 },
    { widgetId: "w-9" },
  );
  assert.equal(data.text, "✅ Done +3");
  assert.equal(data.flags[FLAG_SCOPE].widgetId, "w-9");
  assert.deepEqual(data.flags[FLAG_SCOPE].tasks, [
    { text: "Done", difficulty: 3, status: "success" },
  ]);
});

test("challengeDrawingData: scale multiplies font and total height; min scales", () => {
  const data = challengeDrawingData(
    [
      { text: "A", difficulty: 1 },
      { text: "B", difficulty: 2 },
    ],
    { x: 0, y: 0 },
    { scale: 2 },
  );
  assert.equal(data.fontSize, DEFAULT_FONT_SIZE * 2);
  // At scale 2 the widest line (199) + reserve (140) = 339 is below the
  // scaled minimum (400), so the min floor wins: 400 + 2*56 = 512. Height:
  // 2 * (90*2) + 2 * (18*2) = 432.
  assert.deepEqual(data.shape, { width: 512, height: 432 });
});

test("challengeDrawingData: center anchors the scaled block on the pivot", () => {
  const data = challengeDrawingData(
    [
      { text: "A", difficulty: 1 },
      { text: "B", difficulty: 2 },
    ],
    undefined,
    { center: { x: 1000, y: 500 }, scale: 2 },
  );
  // Block is 512x432 at scale 2 -> top-left = center - half.
  assert.equal(data.x, 744);
  assert.equal(data.y, 284);
});

test("challengeDrawingData: texture / background fill rule (contest parity)", () => {
  const textured = challengeDrawingData(
    [{ text: "A", difficulty: 1 }],
    { x: 0, y: 0 },
    { addBackground: true, backgroundTexture: "modules/x/bg.webp" },
  );
  assert.equal(textured.fillType, 2);
  assert.equal(textured.texture, "modules/x/bg.webp");
  const solid = challengeDrawingData(
    [{ text: "A", difficulty: 1 }],
    { x: 0, y: 0 },
    { addBackground: true, backgroundColor: "#123456" },
  );
  assert.equal(solid.fillType, 1);
  assert.equal(solid.texture, null);
  assert.equal(solid.fillColor, "#123456");
  const plain = challengeDrawingData(
    [{ text: "A", difficulty: 1 }],
    { x: 0, y: 0 },
    { addBackground: false, backgroundTexture: "" },
  );
  assert.equal(plain.fillType, 0);
  assert.equal(plain.texture, null);
});

test("challengeDrawingData: style override and empty tasks", () => {
  const data = challengeDrawingData([{ text: "A", difficulty: 1 }], { x: 0, y: 0 }, {
    type: "rectangle",
    textColor: "#abcdef",
    fontFamily: "Custom",
  });
  assert.equal(data.type, "rectangle");
  assert.equal(data.textColor, "#abcdef");
  assert.equal(data.fontFamily, "Custom");
  assert.equal(challengeDrawingData([], { x: 0, y: 0 }).text, "");
  // Empty input: width is pinned to the absolute min content width, height 0.
  assert.deepEqual(challengeDrawingData([], { x: 0, y: 0 }).shape, {
    width: CHALLENGE_CONTEST_MIN_TEXT_WIDTH + 2 * CHALLENGE_CONTEST_PAD_X,
    height: 0,
  });
  assert.deepEqual(challengeDrawingData(null, null).text, "");
});

test("challengeDrawingData: width is dynamic — short narrow, long wide", () => {
  const shortBlock = challengeDrawingData(
    [{ text: "A", difficulty: 1 }],
    { x: 0, y: 0 },
  );
  const longBlock = challengeDrawingData(
    [{ text: "A very long task description", difficulty: 9 }],
    { x: 0, y: 0 },
  );
  assert.ok(
    shortBlock.shape.width < longBlock.shape.width,
    "a long line widens the block",
  );
  // A short line + reserve (170) is under the min -> the min floor wins.
  assert.deepEqual(shortBlock.shape, {
    width: CHALLENGE_CONTEST_MIN_TEXT_WIDTH + 2 * CHALLENGE_CONTEST_PAD_X,
    height: 1 * CHALLENGE_TEXT_HEIGHT_PER_TASK + 2 * CHALLENGE_CONTEST_PAD_Y,
  });
  // A long line drives the width: widest line + mark reserve + padding.
  assert.deepEqual(longBlock.shape, {
    width:
      widthFor(longBlock.text, DEFAULT_FONT_SIZE) +
      CHALLENGE_MARK_RESERVE +
      2 * CHALLENGE_CONTEST_PAD_X,
    height: 1 * CHALLENGE_TEXT_HEIGHT_PER_TASK + 2 * CHALLENGE_CONTEST_PAD_Y,
  });
});

test("challengeDrawingData: mark reserve leaves room for a future ✅/❌ prefix", () => {
  const pending = challengeDrawingData(
    [{ text: "Task", difficulty: 2, status: "pending" }],
    { x: 0, y: 0 },
  );
  // The mark the user may set later grows the rendered line...
  const markedText = renderChallengeText([
    { text: "Task", difficulty: 2, status: "success" },
  ]);
  assert.ok(
    widthFor(markedText, DEFAULT_FONT_SIZE) >
      widthFor(pending.text, DEFAULT_FONT_SIZE),
    "a marked line is wider than its pending form",
  );
  // ...but the reserve already budgeted for it, so it never overflows the
  // block created while the task was still pending.
  const contentWidth = pending.shape.width - 2 * CHALLENGE_CONTEST_PAD_X;
  assert.ok(
    widthFor(markedText, DEFAULT_FONT_SIZE) <= contentWidth,
    "the marked line fits the reserved content width",
  );
  // The failed cross renders at the same reserved width.
  const failedText = renderChallengeText([
    { text: "Task", difficulty: 2, status: "failed" },
  ]);
  assert.ok(widthFor(failedText, DEFAULT_FONT_SIZE) <= contentWidth);
});

test("challengeDrawingData: explicit textWidth is a floor, not a fixed width", () => {
  const floored = challengeDrawingData([{ text: "A", difficulty: 1 }], { x: 0, y: 0 }, {
    textWidth: 900,
  });
  assert.equal(floored.shape.width, 900 + 2 * CHALLENGE_CONTEST_PAD_X);
  // A request below the min never shrinks the block past the min.
  const tiny = challengeDrawingData([{ text: "A", difficulty: 1 }], { x: 0, y: 0 }, {
    textWidth: 10,
  });
  assert.equal(
    tiny.shape.width,
    CHALLENGE_CONTEST_MIN_TEXT_WIDTH + 2 * CHALLENGE_CONTEST_PAD_X,
  );
});

/* ------------------------------------------------------------------ *
 * contestDrawingData (ONE drawing for all sides)
 * ------------------------------------------------------------------ */

test("contestDrawingData: one payload, all side lines, full block height", () => {
  const data = contestDrawingData(
    [
      { name: "A", boxes: 1, done: 0 },
      { name: "B", boxes: 2, done: 1 },
    ],
    { x: 10, y: 20 },
  );
  assert.equal(data.text, "A: [   ]\n\nB: [ X ][   ]");
  // n=2 sides joined by "\n\n" render 3 text lines (2 sides + 1 blank) and the
  // widest side line drives the width.
  assert.deepEqual(data.shape, {
    width: widthFor(data.text, DEFAULT_FONT_SIZE) + 2 * CHALLENGE_CONTEST_PAD_X,
    height: 3 * CONTEST_TEXT_HEIGHT + 2 * CHALLENGE_CONTEST_PAD_Y,
  });
  // Widest "B: [ X ][   ]" (13 chars) -> ceil(13*24.8)=323 -> + 56 padding.
  assert.deepEqual(data.shape, { width: 379, height: 216 });
  assert.equal(data.x, 10);
  assert.equal(data.y, 20);
  assert.equal(data.fontFamily, "Montserrat");
  assert.equal(data.fontSize, DEFAULT_FONT_SIZE);
  assert.equal(data.flags[FLAG_SCOPE].ownerType, CONTEST_OWNER_TYPE);
  assert.deepEqual(data.flags[FLAG_SCOPE].sides, [
    { name: "A", boxes: 1, done: 0 },
    { name: "B", boxes: 2, done: 1 },
  ]);
});

test("contestDrawingData: widgetId + done state in flags", () => {
  const data = contestDrawingData(
    [{ name: "Solo", boxes: 3, done: 2 }],
    { x: 0, y: 0 },
    { widgetId: "w-9" },
  );
  assert.equal(data.flags[FLAG_SCOPE].widgetId, "w-9");
  assert.equal(data.text, "Solo: [ X ][ X ][   ]");
});

test("contestDrawingData: scale multiplies font and total height", () => {
  const data = contestDrawingData(
    [
      { name: "A", boxes: 1 },
      { name: "B", boxes: 2 },
    ],
    { x: 0, y: 0 },
    { scale: 2 },
  );
  assert.equal(data.fontSize, DEFAULT_FONT_SIZE * 2);
  // Widest side (13 chars) at font 80 -> ceil(13*80*0.62)=645 + 2*56 padding.
  // 3 text lines * 120 + 2 * scaled padding (36) = 432.
  assert.deepEqual(data.shape, { width: 757, height: 432 });
});

test("contestDrawingData: center anchors the scaled block on the pivot", () => {
  const data = contestDrawingData(
    [
      { name: "A", boxes: 1 },
      { name: "B", boxes: 2 },
    ],
    undefined,
    { center: { x: 1000, y: 500 }, scale: 2 },
  );
  // Block is 757x432 at scale 2 -> top-left = center - half.
  assert.equal(data.x, 621.5);
  assert.equal(data.y, 284);
});

test("contestDrawingData: texture / background fill rule", () => {
  const textured = contestDrawingData(
    [{ name: "A", boxes: 1 }],
    { x: 0, y: 0 },
    { addBackground: true, backgroundTexture: "modules/x/bg.webp" },
  );
  assert.equal(textured.fillType, 2);
  assert.equal(textured.texture, "modules/x/bg.webp");
  const solid = contestDrawingData(
    [{ name: "A", boxes: 1 }],
    { x: 0, y: 0 },
    { addBackground: true },
  );
  assert.equal(solid.fillType, 1);
  assert.equal(solid.texture, null);
  const plain = contestDrawingData(
    [{ name: "A", boxes: 1 }],
    { x: 0, y: 0 },
    { addBackground: false, backgroundTexture: "" },
  );
  assert.equal(plain.fillType, 0);
  assert.equal(plain.texture, null);
});

test("contestDrawingData: empty sides -> empty text and zero height", () => {
  const data = contestDrawingData([], { x: 0, y: 0 });
  assert.equal(data.text, "");
  // Width is pinned to the absolute min content width, height 0.
  assert.deepEqual(data.shape, {
    width: CHALLENGE_CONTEST_MIN_TEXT_WIDTH + 2 * CHALLENGE_CONTEST_PAD_X,
    height: 0,
  });
  assert.deepEqual(contestDrawingData(null, null).text, "");
});

test("contestDrawingData: width is dynamic and a long side widens (no wrap)", () => {
  // "alpha bravo charlie delta echo: [   ]" would overflow the old fixed 700;
  // the dynamic width widens the block instead of wrapping it.
  const long = contestDrawingData(
    [{ name: "alpha bravo charlie delta echo", boxes: 3 }],
    { x: 0, y: 0 },
  );
  const contentWidth = long.shape.width - 2 * CHALLENGE_CONTEST_PAD_X;
  assert.equal(contentWidth, widthFor(long.text, DEFAULT_FONT_SIZE));
  assert.equal(linesFor(long.text, contentWidth, DEFAULT_FONT_SIZE), 1, "no wrap");
  assert.deepEqual(long.shape, {
    width: widthFor(long.text, DEFAULT_FONT_SIZE) + 2 * CHALLENGE_CONTEST_PAD_X,
    height: 1 * CONTEST_TEXT_HEIGHT + 2 * CHALLENGE_CONTEST_PAD_Y,
  });

  // A one-box side stays at the min-width floor.
  const short = contestDrawingData([{ name: "A", boxes: 1 }], { x: 0, y: 0 });
  assert.deepEqual(short.shape, {
    width: CHALLENGE_CONTEST_MIN_TEXT_WIDTH + 2 * CHALLENGE_CONTEST_PAD_X,
    height: 1 * CONTEST_TEXT_HEIGHT + 2 * CHALLENGE_CONTEST_PAD_Y,
  });
  assert.ok(long.shape.width > short.shape.width, "long side is wider");

  // Two long sides: their hard lines plus the blank separator -> 3 rows, and
  // the width is shared by the widest line.
  const mixed = contestDrawingData(
    [
      { name: "alpha bravo charlie delta echo", boxes: 3 },
      { name: "alpha bravo charlie delta echo", boxes: 3 },
    ],
    { x: 0, y: 0 },
  );
  assert.deepEqual(mixed.shape, {
    width: widthFor(mixed.text, DEFAULT_FONT_SIZE) + 2 * CHALLENGE_CONTEST_PAD_X,
    height: 3 * CONTEST_TEXT_HEIGHT + 2 * CHALLENGE_CONTEST_PAD_Y,
  });
});

test("contestDrawingData: explicit textWidth is a floor, not a fixed width", () => {
  const floored = contestDrawingData([{ name: "A", boxes: 1 }], { x: 0, y: 0 }, {
    textWidth: 900,
  });
  assert.equal(floored.shape.width, 900 + 2 * CHALLENGE_CONTEST_PAD_X);
  const tiny = contestDrawingData([{ name: "A", boxes: 1 }], { x: 0, y: 0 }, {
    textWidth: 10,
  });
  assert.equal(
    tiny.shape.width,
    CHALLENGE_CONTEST_MIN_TEXT_WIDTH + 2 * CHALLENGE_CONTEST_PAD_X,
  );
});
