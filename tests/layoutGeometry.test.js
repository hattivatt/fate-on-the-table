/**
 * Node tests for layoutGeometry.js — geometry of the "default" layout
 * (the version reworked in the standalone layout-editor) in anchor-relative
 * coordinates at scale 1, plus the legacy fallback parity check.
 *
 * The expected values were derived by hand from the layout JSON and the
 * geometry rules of LAYOUT-FORMAT.md.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { analyzeLayout } from "../scripts/layoutSchema.js";
import { computeLayoutDocs } from "../scripts/layoutGeometry.js";
import { legacyToJson } from "../scripts/layoutLoader.js";
import { layouts as legacyLayouts } from "../scripts/layouts.js";

function loadNormalized(id) {
  const raw = JSON.parse(
    readFileSync(new URL(`../layouts/${id}.json`, import.meta.url), "utf8"),
  );
  return analyzeLayout(raw).normalized;
}

const ORIGIN = { x: -150, y: -200 };

/** Translates engine (canvas-local) docs to anchor-relative scene coords. */
function toAnchorRelative(docs, scale = 1) {
  return docs.map((d) => ({
    ...d,
    x: d.x + ORIGIN.x * scale,
    y: d.y + ORIGIN.y * scale,
  }));
}

function resolvedData({ rows = 4, tokens = 3, portrait = "modules/fate-on-the-table/portrait.png" } = {}) {
  const skillName = [];
  const skillValue = [];
  for (let i = 0; i < rows; i++) {
    skillName.push(`Skill ${i}`);
    skillValue.push(`+${rows - i}`);
  }
  return {
    name: "Alice Example",
    portrait,
    aspectsHeader: "Аспекты",
    aspects: "High Concept\n\nTrouble",
    fatePointsLabel: "Жетоны",
    fatePointsFrame: "",
    fatePointTokens: tokens,
    skillsHeader: "Компетенции",
    skillName,
    skillValue,
    stressTrackNames: ["Physical Stress", "Mental Stress"],
    stressBoxRows: [
      ["X", "", "", ""],
      ["", "", ""],
    ],
  };
}

/** Deterministic fast text metric shared by the render helpers below. */
const fastMeasureText = (text, style) =>
  String(text ?? "").length * (Number(style?.size) || 20) * 0.5;
/** Renders the default layout with the given data. */
function renderDefault(data, options = {}) {
  const layout = loadNormalized("default");
  const { docs, canvas } = computeLayoutDocs(layout, data, {
    fatePointImage: "modules/fate-on-the-table/fp.png",
    measureText: fastMeasureText,
    ...options,
  });
  return { docs: toAnchorRelative(docs, options.scale ?? 1), canvas };
}

test("default layout: full actor (4 skill rows, 3 FP tokens, 2 stress rows)", () => {
  const { docs } = renderDefault(resolvedData());

  const find = (part, index = -1) =>
    docs.find((d) => d.part === part && d.index === index);
  const partDocs = (part) => docs.filter((d) => d.part === part);

  assert.equal(docs.length, 29, JSON.stringify(docs.map((d) => `${d.part}#${d.index}`)));

  // name spans the full canvas width, 1px below the canvas top
  const name = find("name");
  assert.deepEqual(
    { x: name.x, y: name.y, w: name.w, h: name.h },
    { x: -150, y: -199, w: 659, h: 28 },
  );
  assert.equal(name.text, "Alice Example");
  assert.equal(name.font, "Montserrat");
  assert.equal(name.size, 26);
  assert.equal(name.weight, 800);
  assert.equal(name.align, "center");

  const portrait = find("portrait");
  assert.deepEqual(
    { x: portrait.x, y: portrait.y, w: portrait.w, h: portrait.h },
    { x: -1, y: -23, w: 270, h: 270 },
  );
  assert.equal(portrait.kind, "tile");
  assert.equal(portrait.src, "modules/fate-on-the-table/portrait.png");

  const aspectsHeader = find("aspectsHeader");
  assert.deepEqual(
    { x: aspectsHeader.x, y: aspectsHeader.y, w: aspectsHeader.w, h: aspectsHeader.h },
    { x: 175, y: -150, w: 300, h: 68 },
  );
  const aspects = find("aspects");
  assert.deepEqual(
    { x: aspects.x, y: aspects.y, w: aspects.w, h: aspects.h },
    { x: 165, y: -82, w: 333, h: 450 },
  );
  assert.equal(aspects.text, "High Concept\n\nTrouble");

  const label = find("fatePointsLabel");
  assert.deepEqual(
    { x: label.x, y: label.y, w: label.w, h: label.h },
    { x: -102, y: 119, w: 200, h: 17 },
  );

  // frame: 3 tokens do not overflow the layout-defined 307 width
  const frame = find("fatePointsFrame");
  assert.deepEqual(
    { x: frame.x, y: frame.y, w: frame.w, h: frame.h },
    { x: -146, y: 142, w: 307, h: 97 },
  );
  assert.equal(frame.stroke, 2);
  assert.equal(frame.fillType, 0);

  // token row: anchored to the frame's leftCenter, vertically centered
  const tokens = partDocs("fatePointTokens");
  assert.equal(tokens.length, 3);
  tokens.forEach((t, i) => {
    assert.deepEqual(
      { x: t.x, y: t.y, w: t.w, h: t.h },
      { x: -146 + i * 20, y: 155.5, w: 70, h: 70 },
    );
    assert.equal(t.kind, "tile");
    assert.equal(t.index, i);
    assert.deepEqual(t.textureAnchor, { x: 0, y: 0 });
  });

  const skillsHeader = find("skillsHeader");
  assert.deepEqual(
    { x: skillsHeader.x, y: skillsHeader.y, w: skillsHeader.w, h: skillsHeader.h },
    { x: -16, y: 338, w: 300, h: 17 },
  );

  const names = partDocs("skillName");
  assert.equal(names.length, 4);
  const values = partDocs("skillValue");
  assert.equal(values.length, 4);
  names.forEach((d, i) => {
    assert.deepEqual(
      { x: d.x, y: d.y, w: d.w, h: d.h },
      { x: -146, y: 375 + i * 68, w: 583, h: 68 },
    );
    assert.equal(d.text, `Skill ${i}`);
    assert.equal(d.stroke, 2);
    assert.equal(d.font, "Montserrat");
    assert.equal(d.size, 16);
  });
  values.forEach((d, i) => {
    assert.deepEqual(
      { x: d.x, y: d.y, w: d.w, h: d.h },
      { x: 436, y: 375 + i * 68, w: 68, h: 68 },
    );
    assert.equal(d.text, `+${4 - i}`);
    assert.equal(d.font, "Bruno Ace");
    assert.equal(d.size, 30);
  });

  // stress: left-aligned names (20px) with the box row directly below each
  // name in the same x column (no anchorTo; boxes no longer depend on the
  // measured name width).
  const stressNames = partDocs("stressTrackNames");
  assert.equal(stressNames.length, 2);
  stressNames.forEach((d, i) => {
    assert.deepEqual(
      { x: d.x, y: d.y, w: d.w, h: d.h },
      { x: -137, y: 240 + i * 64, w: 182, h: 24 },
    );
    assert.equal(d.align, "left");
    assert.equal(d.font, "Montserrat");
    assert.equal(d.size, 20);
  });
  assert.equal(stressNames[0].text, "Physical Stress");

  const stressBoxes = partDocs("stressBoxRows");
  assert.equal(stressBoxes.length, 7);
  stressBoxes.forEach((d, i) => {
    const row = Math.floor(i / 4);
    const col = i % 4;
    // Box row is a separate absolute row below its label (pitch 64).
    assert.deepEqual(
      { x: d.x, y: d.y, w: d.w, h: d.h },
      { x: -137 + col * 26, y: 268 + row * 64, w: 20, h: 20 },
    );
    assert.equal(d.align, "center");
    assert.equal(d.font, "Montserrat");
    assert.equal(d.size, 14);
    assert.equal(d.stroke, 1);
    assert.equal(d.fillType, 0);
  });
  assert.equal(stressBoxes[0].text, "X"); // checked box marker
  assert.equal(stressBoxes[1].text, ""); // empty box marker

  // The boxes must be the ONLY documents above the transparent grab frame
  // (bounds elevation 10 / sort 1000), so clicks land on them.
  stressBoxes.forEach((d) => {
    assert.equal(d.elevation, 20);
    assert.equal(d.sort, 2000);
  });
  const aboveFrame = docs.filter(
    (d) => (d.elevation ?? 0) > 10 || (d.sort ?? 0) > 1000,
  );
  assert.deepEqual(
    [...new Set(aboveFrame.map((d) => d.part))],
    ["stressBoxRows"],
  );

  // background and bounds span the full canvas
  const bg = find("widgetBackground");
  assert.deepEqual(
    { x: bg.x, y: bg.y, w: bg.w, h: bg.h },
    { x: -150, y: -199, w: 659, h: 846 },
  );
  assert.equal(bg.fillType, 1); // SOLID without a texture
  assert.equal(bg.fillColor, "#ffffff");
  assert.equal(bg.elevation, -10);
  assert.equal(bg.sort, -1000);
  const bounds = find("widgetBounds");
  assert.deepEqual(
    { x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h },
    { x: -150, y: -199, w: 659, h: 846 },
  );
  assert.equal(bounds.stroke, 1);
  assert.equal(bounds.strokeAlpha, 0.2);
  assert.equal(bounds.elevation, 10);
  assert.equal(bounds.sort, 1000);
});

test("default layout: background uses a pattern when a texture is set", () => {
  const { docs } = renderDefault(resolvedData(), {
    backgroundTexture: "modules/fate-on-the-table/bg.png",
  });
  const bg = docs.find((d) => d.part === "widgetBackground");
  assert.equal(bg.fillType, 2); // PATTERN
  assert.equal(bg.texture, "modules/fate-on-the-table/bg.png");
});

test("default layout: no skills and no tokens keeps the canvas minimum 659x568", () => {
  const { docs, canvas } = renderDefault(resolvedData({ rows: 0, tokens: 0 }));
  assert.equal(canvas.width, 659);
  assert.equal(canvas.height, 568);
  // No skill rows, no token tiles and no hidden empty drawings (the empty
  // aspects text WOULD be skipped too, but here aspects are non-empty).
  assert.equal(docs.filter((d) => d.part === "skillName").length, 0);
  assert.equal(docs.filter((d) => d.part === "skillValue").length, 0);
  assert.equal(docs.filter((d) => d.part === "fatePointTokens").length, 0);
  const bg = docs.find((d) => d.part === "widgetBackground");
  assert.deepEqual({ w: bg.w, h: bg.h }, { w: 659, h: 568 });
  const name = docs.find((d) => d.part === "name");
  assert.equal(name.w, 659);
});

test("default layout: 15 FP tokens grow the frame to the right only", () => {
  const { docs } = renderDefault(resolvedData({ tokens: 15 }));
  const frame = docs.find((d) => d.part === "fatePointsFrame");
  assert.deepEqual({ w: frame.w, h: frame.h }, { w: 357, h: 97 });
  const tokens = docs.filter((d) => d.part === "fatePointTokens");
  assert.equal(tokens.length, 15);
  assert.equal(tokens[14].x, -146 + 14 * 20);
  const bg = docs.find((d) => d.part === "widgetBackground");
  assert.equal(bg.w, 659); // canvas width is driven by the skills column
});

test("empty text drawings without stroke/fill are skipped; frames stay", () => {
  const data = resolvedData({ rows: 0, tokens: 0 });
  data.aspects = ""; // no aspects: the text drawing must not be created
  const { docs } = renderDefault(data);
  assert.equal(docs.some((d) => d.part === "aspects"), false);
  // The FP frame has a stroke: it stays even with empty text.
  assert.equal(docs.some((d) => d.part === "fatePointsFrame"), true);
  // A missing portrait image means no tile at all.
  data.portrait = "";
  const { docs: docs2 } = renderDefault(data);
  assert.equal(docs2.some((d) => d.part === "portrait"), false);
});

test("runtime overrides (scale, font, color, token size/step) are applied", () => {
  const { docs, canvas } = renderDefault(resolvedData({ rows: 2, tokens: 2 }), {
    scale: 2,
    fontFamily: "BadScript",
    textColor: "#112233",
    fatePointTileSize: 50,
    fatePointStep: 30,
  });
  const name = docs.find((d) => d.part === "name");
  assert.equal(name.font, "BadScript");
  assert.equal(name.size, 52);
  assert.equal(name.color, "#112233");
  assert.equal(name.x, -300);
  assert.equal(name.w, 1318); // 659 * 2
  const token = docs.find((d) => d.part === "fatePointTokens" && d.index === 0);
  assert.equal(token.w, 100);
  assert.equal(token.h, 100);
  assert.equal(token.x, -292); // frame x 4 * scale 2, origin -300
  const token1 = docs.find((d) => d.part === "fatePointTokens" && d.index === 1);
  assert.equal(token1.x, token.x + 60); // step 30 * scale 2
  assert.equal(canvas.width, 1318);
  // canvas-local maxY = (575 + 2 * 68) * 2 = 1422; minY = name y 1 * 2 = 2.
  assert.equal(canvas.height, 1420);
});

test("legacy fallback conversion reproduces the legacy default.json geometry", () => {
  // The legacy JS template is the pre-editor default; it must still render
  // exactly like the snapshot of the old layout JSON.
  const legacyFixture = JSON.parse(
    readFileSync(new URL("./fixtures/default-legacy.json", import.meta.url), "utf8"),
  );
  const legacyLayout = legacyToJson(legacyLayouts.default);
  assert.ok(legacyLayout);
  const data = resolvedData({ rows: 4, tokens: 3 });

  const fromLegacy = computeLayoutDocs(legacyLayout, data, {});
  const fromJson = computeLayoutDocs(
    analyzeLayout(legacyFixture).normalized,
    data,
    {},
  );

  const strip = ({ docs, canvas }) => ({
    canvas,
    docs: docs.map(({ x, y, w, h, part, index, kind, text }) => ({
      part,
      index,
      kind,
      x: Math.round(x),
      y: Math.round(y),
      w: Math.round(w),
      h: Math.round(h),
      text,
    })),
  });

  assert.deepEqual(strip(fromJson), strip(fromLegacy));
});

test("legacy fallback conversion handles rows/FP changes like the legacy default", () => {
  const legacyFixture = JSON.parse(
    readFileSync(new URL("./fixtures/default-legacy.json", import.meta.url), "utf8"),
  );
  const legacyLayout = legacyToJson(legacyLayouts.default);
  const data = resolvedData({ rows: 0, tokens: 0 });
  const fromLegacy = computeLayoutDocs(legacyLayout, data, {});
  const fromJson = computeLayoutDocs(
    analyzeLayout(legacyFixture).normalized,
    data,
    {},
  );
  assert.equal(fromLegacy.docs.length, fromJson.docs.length);
  assert.deepEqual(fromLegacy.canvas, fromJson.canvas);
});

test("minimal layout creates no empty sections for a bare actor", () => {
  const layout = loadNormalized("minimal");
  const data = {
    name: "Bob",
    portrait: "img/bob.png",
    aspectsHeader: "Аспекты",
    aspects: "",
  };
  const { docs, canvas } = computeLayoutDocs(layout, data, {});
  const parts = new Set(docs.map((d) => d.part));
  // Only name, portrait, header and the background/bounds card; the empty
  // aspects text and missing stress/consequences rows create no documents.
  assert.deepEqual([...parts].sort(), [
    "aspectsHeader",
    "name",
    "portrait",
    "widgetBackground",
    "widgetBounds",
  ]);
  assert.equal(canvas.width, 659);
  assert.equal(canvas.height, 445); // portrait bottom (175 + 270)
});

/** Renders the minimal layout with the given resolved data (canvas-local). */
function renderMinimal(data, options = {}) {
  const layout = loadNormalized("minimal");
  const { docs, canvas } = computeLayoutDocs(layout, data, {
    measureText: fastMeasureText,
    ...options,
  });
  return { docs, canvas };
}

/** Renders the full layout with the given resolved data (canvas-local). */
function renderFull(data, options = {}) {
  const layout = loadNormalized("full");
  const { docs, canvas } = computeLayoutDocs(layout, data, {
    measureText: fastMeasureText,
    ...options,
  });
  return { docs, canvas };
}

const STRESS_DATA = {
  stressTrackNames: ["Physical Stress", "Mental Stress"],
  stressBoxRows: [
    ["X", "", "", ""],
    ["", "", ""],
  ],
};

test("minimal layout: stress tracks render as one interactive Drawing per box", () => {
  const { docs, canvas } = renderMinimal({
    name: "Bob Example",
    portrait: "img/bob.png",
    aspectsHeader: "Аспекты",
    aspects: "High Concept",
    ...STRESS_DATA,
  });
  const partDocs = (part) => docs.filter((d) => d.part === part);

  // Track names are a compact label row (y=320, h=24), pitch 64 apart.
  const stressNames = partDocs("stressTrackNames");
  assert.equal(stressNames.length, 2);
  stressNames.forEach((d, i) => {
    assert.deepEqual(
      { x: d.x, y: d.y, w: d.w, h: d.h },
      { x: 20, y: 320 + i * 64, w: 280, h: 24 },
    );
    assert.equal(d.text, ["Physical Stress", "Mental Stress"][i]);
    assert.equal(d.size, 16);
    assert.equal(d.align, "left");
  });

  // Every checkbox is its own 16x16 Drawing with a flat index and the
  // row/column coordinates. The box row is a SEPARATE absolute row below the
  // label (its own rect y=348, pitch 64 aligned with the labels), so the box
  // x is constant and never depends on the measured name width.
  const stressBoxes = partDocs("stressBoxRows");
  assert.equal(stressBoxes.length, 7);
  assert.deepEqual(stressBoxes.map((d) => d.index), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(stressBoxes.map((d) => d.rowIndex), [0, 0, 0, 0, 1, 1, 1]);
  assert.deepEqual(stressBoxes.map((d) => d.columnIndex), [0, 1, 2, 3, 0, 1, 2]);
  const expectedX = [20, 42, 64, 86, 20, 42, 64];
  const expectedY = [348, 348, 348, 348, 412, 412, 412];
  stressBoxes.forEach((d, i) => {
    assert.deepEqual(
      { x: d.x, y: d.y, w: d.w, h: d.h },
      { x: expectedX[i], y: expectedY[i], w: 16, h: 16 },
    );
    assert.equal(d.align, "center");
    assert.equal(d.size, 12);
    assert.equal(d.stroke, 1);
    // Interactive flags: boxes are the only docs above the grab frame.
    assert.equal(d.elevation, 20);
    assert.equal(d.sort, 2000);
  });
  assert.equal(stressBoxes[0].text, "X");
  assert.equal(stressBoxes[1].text, "");

  const aboveFrame = docs.filter(
    (d) => (d.elevation ?? 0) > 10 || (d.sort ?? 0) > 1000,
  );
  assert.deepEqual([...new Set(aboveFrame.map((d) => d.part))], ["stressBoxRows"]);

  // The minimal canvas height stays portrait-driven (bottom 445); the label
  // rows and box rows fit inside it.
  assert.equal(canvas.width, 659);
  assert.equal(canvas.height, 445);
});

test("full layout: stress tracks render as one interactive Drawing per box", () => {
  const { docs } = renderFull({
    name: "Carol Example",
    portrait: "img/carol.png",
    fatePointsLabel: "Жетоны",
    fatePointsFrame: "",
    fatePointTokens: 0,
    skillsHeader: "Компетенции",
    skillName: [],
    skillValue: [],
    aspectsHeader: "Аспекты",
    aspects: "High Concept",
    consequencesHeader: "Последствия",
    consequences: [],
    stuntsHeader: "Трюки",
    stunts: [],
    ...STRESS_DATA,
  });
  const partDocs = (part) => docs.filter((d) => d.part === part);

  const stressNames = partDocs("stressTrackNames");
  assert.equal(stressNames.length, 2);
  stressNames.forEach((d, i) => {
    assert.deepEqual(
      { x: d.x, y: d.y, w: d.w, h: d.h },
      { x: 20, y: 480 + i * 64, w: 300, h: 24 },
    );
    assert.equal(d.size, 18);
    assert.equal(d.align, "left");
  });

  const stressBoxes = partDocs("stressBoxRows");
  assert.equal(stressBoxes.length, 7);
  assert.deepEqual(stressBoxes.map((d) => d.index), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(stressBoxes.map((d) => d.rowIndex), [0, 0, 0, 0, 1, 1, 1]);
  assert.deepEqual(stressBoxes.map((d) => d.columnIndex), [0, 1, 2, 3, 0, 1, 2]);
  // Box row is a separate absolute row below the label (pitch 64): x is
  // constant 20, boxes never depend on the measured name width.
  const expectedX = [20, 46, 72, 98, 20, 46, 72];
  const expectedY = [508, 508, 508, 508, 572, 572, 572];
  stressBoxes.forEach((d, i) => {
    assert.deepEqual(
      { x: d.x, y: d.y, w: d.w, h: d.h },
      { x: expectedX[i], y: expectedY[i], w: 20, h: 20 },
    );
    assert.equal(d.align, "center");
    assert.equal(d.size, 14);
    assert.equal(d.stroke, 1);
    assert.equal(d.elevation, 20);
    assert.equal(d.sort, 2000);
  });
  assert.equal(stressBoxes[0].text, "X");

  const aboveFrame = docs.filter(
    (d) => (d.elevation ?? 0) > 10 || (d.sort ?? 0) > 1000,
  );
  assert.deepEqual([...new Set(aboveFrame.map((d) => d.part))], ["stressBoxRows"]);
});

test("minimal layout: an empty stress track name is skipped, boxes and bounds stay", () => {
  // Regression: an empty rows-mode row (text="", strokeWidth=0, fillType
  // NONE) used to emit an invalid empty Drawing that broke the Foundry v14
  // batch — hiding the checkbox rows and the widgetBounds service drawing.
  const { docs, canvas } = renderMinimal({
    name: "Bob Example",
    portrait: "img/bob.png",
    aspectsHeader: "Аспекты",
    aspects: "High Concept",
    // Second track has an EMPTY name (the rows-mode element must not emit it).
    stressTrackNames: ["Physical Stress", ""],
    stressBoxRows: [
      ["X", ""],
      [""],
    ],
    consequencesHeader: "",
    consequenceCostRows: [],
  });

  // No Drawings that are fully invisible (empty text, no stroke, no fill).
  const invalid = docs.filter(
    (d) =>
      d.kind === "drawing" &&
      !d.text &&
      !d.stroke &&
      d.fillType === 0,
  );
  assert.deepEqual(
    invalid.map((d) => `${d.part}#${d.index}`),
    [],
    "no fully-invisible empty Drawings may be emitted",
  );

  // The empty name row is skipped but the filled one remains.
  const names = docs.filter((d) => d.part === "stressTrackNames");
  assert.equal(names.length, 1);
  assert.equal(names[0].text, "Physical Stress");
  assert.equal(names[0].index, 0);

  // Every box cell is still generated (framed -> visible), including the
  // cell for the empty-named track, whose source row was skipped.
  const boxes = docs.filter((d) => d.part === "stressBoxRows");
  assert.equal(boxes.length, 3);
  assert.deepEqual(boxes.map((d) => d.rowIndex), [0, 0, 1]);
  assert.deepEqual(boxes.map((d) => d.columnIndex), [0, 1, 0]);
  boxes.forEach((d) => assert.equal(d.stroke, 1));

  // The widgetBounds group Drawing survives and has expected geometry.
  const bounds = docs.find((d) => d.part === "widgetBounds");
  assert.ok(bounds, "widgetBounds must be present");
  assert.deepEqual(
    { x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h },
    { x: 0, y: 0, w: 659, h: 445 },
  );
  assert.equal(bounds.kind, "drawing");
  assert.equal(bounds.stroke, 1);
  assert.equal(bounds.fillType, 0);
  assert.equal(bounds.elevation, 10);
  assert.equal(bounds.sort, 1000);
  const bg = docs.find((d) => d.part === "widgetBackground");
  assert.ok(bg, "widgetBackground must be present");
  assert.equal(bg.elevation, -10);
  assert.equal(bg.sort, -1000);
  assert.equal(canvas.width, 659);
  assert.equal(canvas.height, 445);
});

test("whitespace-only rows/value text is invisible for Foundry v14; framed boxes stay", () => {
  // Regression: Foundry v14 compares `text.trim()`, so an all-whitespace
  // value must NOT reach the creation batch as an empty Drawing (the old
  // `!String(text ?? "")` guard let it through and the whole card batch was
  // rejected, hiding the stress boxes and the widgetBounds frame).
  const { docs, canvas } = renderMinimal({
    name: "   ",
    portrait: "img/bob.png",
    aspectsHeader: "Аспекты",
    aspects: "   ",
    el_3i03bm: "   ",
    // Whitespace-only stress track name and consequence slot name.
    stressTrackNames: ["Physical Stress", "   "],
    stressBoxRows: [
      ["X", ""],
      ["   ", ""],
    ],
    consequencesHeader: "   ",
    consequenceCostRows: ["   "],
  });

  // No Drawing may be fully invisible: empty/whitespace text with zero stroke
  // and no visible fill — the exact shape Foundry v14 rejects.
  const invalid = docs.filter(
    (d) =>
      d.kind === "drawing" &&
      !String(d.text ?? "").trim() &&
      (d.stroke ?? 0) <= 0 &&
      ((d.fillType ?? 0) === 0 || (d.fillAlpha ?? 0) <= 0),
  );
  assert.deepEqual(
    invalid.map((d) => `${d.part}#${d.index}`),
    [],
    "no whitespace-only invisible Drawings may be emitted",
  );

  // Whitespace-only value-mode text produces no Drawings.
  assert.equal(docs.some((d) => d.part === "name"), false, "whitespace-only name must be skipped");
  assert.equal(docs.some((d) => d.part === "el_3i03bm"), false, "whitespace-only aspects must be skipped");

  // Only the non-whitespace name row remains; the whitespace name row and the
  // whitespace consequence header/cost row are invisible and skipped.
  const names = docs.filter((d) => d.part === "stressTrackNames");
  assert.deepEqual(names.map((d) => d.text), ["Physical Stress"]);
  assert.equal(docs.some((d) => d.part === "consequencesHeader"), false);
  assert.equal(docs.some((d) => d.part === "consequenceCostRows"), false);

  // Every framed checkbox cell stays — including the cell of the
  // whitespace-named track and the whitespace marker text of a checked box.
  const boxes = docs.filter((d) => d.part === "stressBoxRows");
  assert.equal(boxes.length, 4);
  assert.deepEqual(boxes.map((d) => d.rowIndex), [0, 0, 1, 1]);
  assert.deepEqual(boxes.map((d) => d.columnIndex), [0, 1, 0, 1]);
  boxes.forEach((d) => {
    assert.equal(d.stroke, 1);
    assert.equal(d.elevation, 20);
    assert.equal(d.sort, 2000);
  });

  // The top widgetBounds grab frame survives the batch with its faint stroke.
  const bounds = docs.find((d) => d.part === "widgetBounds");
  assert.ok(bounds, "widgetBounds must be present");
  assert.equal(bounds.kind, "drawing");
  assert.equal(bounds.stroke, 1);
  assert.equal(bounds.strokeAlpha, 0.2);
  assert.equal(bounds.elevation, 10);
  assert.equal(bounds.sort, 1000);
  const bg = docs.find((d) => d.part === "widgetBackground");
  assert.ok(bg, "widgetBackground must be present");
  assert.equal(bg.elevation, -10);
  assert.equal(bg.sort, -1000);
  assert.equal(canvas.width, 659);
  assert.equal(canvas.height, 443);
});

test("boxRow cells without a frame or fill are skipped; whitespace value text with a stroke stays", () => {
  const layout = {
    scale: 1,
    canvas: { sizePolicy: { mode: "fixed" }, size: { width: 200, height: 200 } },
    background: { enabled: false },
    bounds: { enabled: false },
    elements: [
      {
        id: "framedBoxes",
        type: "drawing",
        rect: { x: 10, y: 10, width: 16, height: 16 },
        content: { resolver: "@fb", mode: "boxRow" },
        repeat: { axis: "y", pitch: 20, itemHeight: 20, direction: "forward" },
        style: {
          fontFamily: "Montserrat", fontSize: 12, textColor: "#000000", textAlign: "center",
          fill: { type: "none", color: "#ffffff", alpha: 0 },
          stroke: { width: 1, color: "#000000", alpha: 1 },
        },
        layer: { elevation: 0, sort: 0 },
      },
      {
        id: "framelessBoxes",
        type: "drawing",
        rect: { x: 10, y: 60, width: 16, height: 16 },
        content: { resolver: "@lb", mode: "boxRow" },
        repeat: { axis: "y", pitch: 20, itemHeight: 20, direction: "forward" },
        style: {
          fontFamily: "Montserrat", fontSize: 12, textColor: "#000000", textAlign: "center",
          fill: { type: "none", color: "#ffffff", alpha: 0 },
          stroke: { width: 0, color: "#000000", alpha: 0 },
        },
        layer: { elevation: 0, sort: 0 },
      },
      {
        id: "banner",
        type: "drawing",
        rect: { x: 0, y: 100, width: 200, height: 40 },
        content: { resolver: "@banner", mode: "value" },
        style: {
          fontFamily: "Montserrat", fontSize: 12, textColor: "#000000", textAlign: "left",
          fill: { type: "none", color: "#ffffff", alpha: 0 },
          stroke: { width: 2, color: "#000000", alpha: 0.5 },
        },
        layer: { elevation: 0, sort: 0 },
      },
    ],
  };
  const { docs } = computeLayoutDocs(
    layout,
    {
      framedBoxes: [["   ", ""]], // whitespace marker text, framed -> stays
      framelessBoxes: [["", ""]], // empty markers, no frame, no fill -> skipped
      banner: "   ", // whitespace text but a visible stroke -> stays
    },
    {},
  );

  const framed = docs.filter((d) => d.part === "framedBoxes");
  assert.equal(framed.length, 2, "framed boxes with whitespace marker text must stay");
  framed.forEach((d) => assert.equal(d.stroke, 1));

  assert.equal(
    docs.some((d) => d.part === "framelessBoxes"),
    false,
    "fully-invisible frameless empty boxes must be skipped",
  );

  // Whitespace-only text is still a valid Drawing when it has a stroke.
  const banner = docs.filter((d) => d.part === "banner");
  assert.equal(banner.length, 1, "whitespace-only value text with a visible stroke stays");
  assert.equal(banner[0].stroke, 2);
  assert.equal(banner[0].strokeAlpha, 0.5);
});

test("service background/bounds are skipped when they would be fully invisible", () => {
  const layout = {
    scale: 1,
    canvas: { sizePolicy: { mode: "fixed" }, size: { width: 100, height: 100 } },
    background: { enabled: true, fill: { color: "#ffffff", alpha: 0 } },
    bounds: { enabled: true, stroke: { width: 0, color: "#000000", alpha: 0.2 } },
    elements: [
      {
        id: "title",
        type: "drawing",
        rect: { x: 0, y: 0, width: 100, height: 20 },
        content: { resolver: "@title", mode: "value" },
        style: {
          fontFamily: "Montserrat", fontSize: 12, textColor: "#000000", textAlign: "left",
          fill: { type: "none", color: "#ffffff", alpha: 0 },
          stroke: { width: 0, color: "#000000", alpha: 0 },
        },
        layer: { elevation: 0, sort: 0 },
      },
    ],
  };
  const { docs } = computeLayoutDocs(layout, { title: "Hello" }, {});
  assert.equal(
    docs.some((d) => d.part === "widgetBackground"),
    false,
    "alpha-0 background is invisible and must not be shipped",
  );
  assert.equal(
    docs.some((d) => d.part === "widgetBounds"),
    false,
    "zero-stroke bounds are invisible and must not be shipped",
  );
  assert.equal(docs.filter((d) => d.part === "title").length, 1);

  // A bounds frame with any positive alpha is validly visible and survives.
  layout.bounds.stroke.width = 1;
  const { docs: docs2 } = computeLayoutDocs(layout, { title: "Hello" }, {});
  assert.equal(docs2.some((d) => d.part === "widgetBounds"), true);
});

test("rows-mode element with solid fill and empty text is still emitted", () => {
  // A fully-invisible skip must NOT drop an empty-text row that is visible
  // through a solid fill: it is a valid background Drawing, not clutter.
  const layout = {
    scale: 1,
    canvas: { sizePolicy: { mode: "fixed" }, size: { width: 100, height: 100 } },
    background: { enabled: false },
    bounds: { enabled: false },
    elements: [
      {
        id: "filler",
        type: "drawing",
        rect: { x: 0, y: 0, width: 100, height: 20 },
        content: { resolver: "@filler", mode: "rows" },
        repeat: { axis: "y", pitch: 20, itemHeight: 20, direction: "forward" },
        style: {
          fontFamily: "Montserrat",
          fontSize: 12,
          textColor: "#000000",
          textAlign: "left",
          fill: { type: "solid", color: "#ff0000", alpha: 1 },
          stroke: { width: 0, color: "#000000", alpha: 0 },
        },
        layer: { elevation: 0, sort: 0 },
      },
    ],
  };
  const { docs } = computeLayoutDocs(layout, { filler: ["", ""] }, {});
  // Both solid-filled rows stay, even though their text is empty.
  const names = docs.filter((d) => d.part === "filler");
  assert.equal(names.length, 2);
  names.forEach((d) => {
    assert.equal(d.text, "");
    assert.equal(d.fillType, 1); // SOLID
  });
});

test("minimal and full layouts create no stress documents without tracks", () => {
  for (const id of ["minimal", "full"]) {
    const layout = loadNormalized(id);
    const data = {
      name: "Empty",
      portrait: "img/e.png",
      stressTrackNames: [],
      stressBoxRows: [],
    };
    const { docs } = computeLayoutDocs(layout, data, {});
    assert.equal(docs.some((d) => d.part === "stressTrackNames"), false, id);
    assert.equal(docs.some((d) => d.part === "stressBoxRows"), false, id);
    // The replaced combined text element must not leave a hidden document.
    assert.equal(docs.some((d) => d.part === "stressTracks"), false, id);
  }
});

/* ------------------------------------------------------------------ *
 * Consequence header + cost rows geometry + stroke scaling
 * ------------------------------------------------------------------ */

test("minimal layout: consequence header renders above the cost rows (free + occupied)", () => {
  const { docs, canvas } = renderMinimal({
    name: "Bob Example",
    portrait: "img/bob.png",
    aspectsHeader: "Аспекты",
    aspects: "High Concept",
    stressTrackNames: ["Physical Stress"],
    stressBoxRows: [["X", ""]],
    consequencesHeader: "Последствия",
    consequenceCostRows: ["Broken leg", "2__________"],
  });
  const partDocs = (part) => docs.filter((d) => d.part === part);

  // The header is a single value-mode Drawing at its provided rect, above the
  // cost rows, on the base canvas layer (no above-bounds elevation).
  const header = partDocs("consequencesHeader");
  assert.equal(header.length, 1);
  assert.deepEqual(
    { x: header[0].x, y: header[0].y, w: header[0].w, h: header[0].h },
    { x: 418, y: 290, w: 210, h: 20 },
  );
  assert.equal(header[0].text, "Последствия");
  assert.equal(header[0].size, 16);
  assert.equal(header[0].align, "left");
  assert.equal(header[0].elevation, 0);
  assert.equal(header[0].sort, 0);

  // One rows-mode Drawing per consequence slot, BELOW the header (y 330 >
  // header bottom 310), pitch 40 apart. Occupied slot shows the aspect name,
  // free slot shows cost + underscores.
  const rows = partDocs("consequenceCostRows");
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((d) => d.index), [0, 1]);
  assert.deepEqual(
    { x: rows[0].x, y: rows[0].y, w: rows[0].w, h: rows[0].h },
    { x: 377, y: 330, w: 260, h: 20 },
  );
  assert.deepEqual(
    { x: rows[1].x, y: rows[1].y },
    { x: 377, y: 370 },
  );
  // Rows are 20px tall on a 40px pitch: a 20px gap between consecutive rows.
  assert.equal(rows[1].y - rows[0].y, 40);
  assert.equal(rows[0].text, "Broken leg");
  assert.equal(rows[0].size, 12);
  assert.equal(rows[0].align, "left");
  assert.equal(rows[1].text, "2__________");
  // Regression: the cost rows are the double-click input target, so they sit
  // ABOVE the transparent widgetBounds grab frame (bounds 10/1000) — exactly
  // like the stress boxes — and win the native PIXI/DOM hit test.
  rows.forEach((d) => {
    assert.equal(d.elevation, 20);
    assert.equal(d.sort, 2000);
  });

  // No consequence checkbox part remains; only the stress boxes and the
  // consequence cost rows (the two interactive parts) sit above the grab frame.
  const aboveFrame = docs.filter(
    (d) => (d.elevation ?? 0) > 10 || (d.sort ?? 0) > 1000,
  );
  assert.deepEqual(
    [...new Set(aboveFrame.map((d) => d.part))].sort(),
    ["consequenceCostRows", "stressBoxRows"],
  );
  assert.equal(canvas.width, 659);
  assert.equal(canvas.height, 445);
});

test("consequence elements create no header/cost documents when there are no aspect tracks", () => {
  for (const id of ["minimal", "full", "default"]) {
    const layout = loadNormalized(id);
    const data = {
      name: "Empty",
      portrait: "img/e.png",
      stressTrackNames: [],
      stressBoxRows: [],
      consequencesHeader: "",
      consequenceCostRows: [],
    };
    const { docs } = computeLayoutDocs(layout, data, {});
    assert.equal(docs.some((d) => d.part === "consequencesHeader"), false, id);
    assert.equal(docs.some((d) => d.part === "consequenceCostRows"), false, id);
  }
});

test("stroke width scales with the layout scale like rect/font (thin boxes stay thin)", () => {
  const { docs } = renderMinimal(
    {
      name: "Bob Example",
      portrait: "img/bob.png",
      aspectsHeader: "Аспекты",
      aspects: "High Concept",
      stressTrackNames: ["Physical Stress"],
      stressBoxRows: [["X", ""]],
      consequencesHeader: "Последствия",
      consequenceCostRows: ["Broken leg"],
    },
    { scale: 2 },
  );
  // Layout stroke 1 * runtime scale 2 -> 2; layout stroke 0 stays 0.
  docs.filter((d) => d.part === "stressBoxRows").forEach((d) => {
    assert.equal(d.stroke, 2);
    assert.equal(d.w, 32);
    assert.equal(d.h, 32);
  });
  // Cost rows are text-only (stroke 0) — their geometry/font scale but the
  // stroke never scales up.
  docs.filter((d) => d.part === "consequenceCostRows").forEach((d) => {
    assert.equal(d.stroke, 0);
    assert.equal(d.x, 754); // 377 * 2
    assert.equal(d.size, 24); // 12 * 2
  });
  const name = docs.find((d) => d.part === "name");
  assert.equal(name.stroke, 0); // zero-width strokes are never scaled up
  // Rect/font scaling parity: box size and text size double too.
  assert.equal(name.size, 52);
  const bounds = docs.find((d) => d.part === "widgetBounds");
  assert.equal(bounds.stroke, 2); // layout bounds stroke 1 * 2
});

/* ------------------------------------------------------------------ *
 * Minimal layout snapshot (provided layout-minimal.json geometry)
 * ------------------------------------------------------------------ */

test("minimal layout snapshot matches the provided layout-minimal.json geometry", () => {
  const raw = JSON.parse(
    readFileSync(new URL("../layouts/minimal.json", import.meta.url), "utf8"),
  );
  const result = analyzeLayout(raw);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  const layout = result.normalized;

  // Canvas / background / bounds from the provided file.
  assert.deepEqual(layout.canvas.origin, { x: -150, y: -200 });
  assert.deepEqual(layout.canvas.size, { width: 659, height: 450 });
  assert.deepEqual(layout.canvas.sizePolicy.minimum, { width: 659, height: 443 });
  assert.equal(layout.background.layer.elevation, -10);
  assert.equal(layout.background.layer.sort, -1000);
  assert.deepEqual(layout.bounds.stroke, { width: 1, color: "#000000", alpha: 0.2 });
  assert.equal(layout.bounds.layer.elevation, 10);
  assert.equal(layout.bounds.layer.sort, 1000);

  const el = (id) => layout.elements.find((e) => e.id === id);
  const assertRect = (id, rect) =>
    assert.deepEqual(el(id).rect, rect, `rect of "${id}"`);

  assertRect("name", { x: 0, y: 0, width: 659, height: 28 });
  assertRect("portrait", { x: 150, y: 175, width: 270, height: 270 });
  assertRect("aspectsHeader", { x: 325, y: 33, width: 300, height: 68 });

  // stressTrackNames y=320 h=24 pitch 64, with the box row below it.
  const stressNames = el("stressTrackNames");
  assertRect("stressTrackNames", { x: 20, y: 320, width: 280, height: 24 });
  assert.equal(stressNames.repeat.axis, "y");
  assert.equal(stressNames.repeat.pitch, 64);
  assert.equal(stressNames.repeat.itemHeight, 24);
  assert.equal(stressNames.repeat.direction, "forward");

  // consequencesHeader x=418 y=290 width=210 height=20, above the cost rows.
  const consHeader = el("consequencesHeader");
  assertRect("consequencesHeader", { x: 418, y: 290, width: 210, height: 20 });
  assert.equal(consHeader.content.resolver, "@consequencesHeader");
  assert.equal(consHeader.content.mode, "value");
  assert.equal(consHeader.style.fontSize, 16);
  assert.equal(consHeader.position, undefined);
  assert.equal(consHeader.layer.elevation, 0);

  // consequenceCostRows x=377 y=330 width=260 height=20, pitch 40 below the
  // header, no anchorTo. The wider 260px block (right edge 637, inside the
  // 659px canvas) keeps the consequence text from wrapping on the reduced
  // font size (12).
  const costRows = el("consequenceCostRows");
  assertRect("consequenceCostRows", { x: 377, y: 330, width: 260, height: 20 });
  assert.equal(costRows.content.resolver, "@consequenceCostRows");
  assert.equal(costRows.content.mode, "rows");
  assert.equal(costRows.repeat.axis, "y");
  assert.equal(costRows.repeat.pitch, 40);
  assert.equal(costRows.repeat.itemHeight, 20);
  assert.equal(costRows.repeat.direction, "forward");
  assert.equal(costRows.style.fontSize, 12);
  assert.equal(costRows.position, undefined);
  // The cost rows must cover the widgetBounds grab frame (bounds layer
  // 10/1000) so double-click routes to the consequence input, not the sheet.
  assert.equal(costRows.layer.elevation, 20);
  assert.equal(costRows.layer.sort, 2000);
  assert.ok(costRows.layer.elevation > layout.bounds.layer.elevation);
  assert.ok(costRows.layer.sort > layout.bounds.layer.sort);

  // The built-in minimal carries NO consequence checkbox part.
  assert.equal(el("consequenceBoxRows"), undefined, "minimal must not contain consequenceBoxRows");

  // @shortAspects element replaces the full @aspects block.
  const short = el("el_3i03bm");
  assert.ok(short, "minimal must contain the @shortAspects element el_3i03bm");
  assert.equal(short.content.resolver, "@shortAspects");
  assert.equal(short.content.mode, "value");
  assertRect("el_3i03bm", { x: 320, y: 100, width: 320, height: 120 });
  assert.ok(
    !layout.elements.some((e) => e.content?.resolver === "@aspects"),
    "minimal must not keep a full @aspects element",
  );

  // The stress box row is also anchor-free and sits below the label column.
  const stressBox = el("stressBoxRows");
  assert.equal(stressBox.position, undefined);
  assert.equal(stressBox.rect.x, stressNames.rect.x);
  assert.ok(stressBox.rect.y > stressNames.rect.y);

  // Thin stress box borders in the snapshot too.
  assert.equal(el("stressBoxRows").style.stroke.width, 1);
});
