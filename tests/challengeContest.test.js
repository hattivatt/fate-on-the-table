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
  DEFAULT_FONT_SIZE,
  scaled,
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
  challengeDrawingData,
  contestDrawingData,
} from "../scripts/challengeContest.js";
import { FLAG_SCOPE, CHALLENGE_OWNER_TYPE, CONTEST_OWNER_TYPE } from "../scripts/constants.js";

test("checkbox glyphs match the legacy macro", () => {
  assert.equal(CHECKBOX_UNCHECKED, "[   ]");
  assert.equal(CHECKBOX_CHECKED, "[ X ]");
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
  assert.deepEqual(data.shape, { width: 500, height: 270 });
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

test("challengeDrawingData: scale multiplies font, width and total height", () => {
  const data = challengeDrawingData(
    [
      { text: "A", difficulty: 1 },
      { text: "B", difficulty: 2 },
    ],
    { x: 0, y: 0 },
    { scale: 2 },
  );
  assert.equal(data.fontSize, DEFAULT_FONT_SIZE * 2);
  assert.deepEqual(data.shape, { width: 1000, height: 360 });
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
  // Block is 1000x360 at scale 2 -> top-left = center - half.
  assert.equal(data.x, 500);
  assert.equal(data.y, 320);
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
  assert.deepEqual(challengeDrawingData([], { x: 0, y: 0 }).shape, {
    width: 500,
    height: 0,
  });
  assert.deepEqual(challengeDrawingData(null, null).text, "");
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
  assert.deepEqual(data.shape, { width: 700, height: 130 });
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
  // 2 rows * 120 + 1 gap * 20 = 260.
  assert.deepEqual(data.shape, { width: 1400, height: 260 });
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
  assert.equal(data.x, 300);
  assert.equal(data.y, 370);
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
  assert.deepEqual(data.shape, { width: 700, height: 0 });
  assert.deepEqual(contestDrawingData(null, null).text, "");
});
