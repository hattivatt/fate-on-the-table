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

/** Renders the default layout with the given data. */
function renderDefault(data, options = {}) {
  const layout = loadNormalized("default");
  const { docs, canvas } = computeLayoutDocs(layout, data, {
    fatePointImage: "modules/fate-on-the-table/fp.png",
    measureText: (text, style) =>
      String(text ?? "").length * (Number(style?.size) || 20) * 0.5,
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

  // stress: left-aligned names (20px) + one framed drawing per checkbox
  const stressNames = partDocs("stressTrackNames");
  assert.equal(stressNames.length, 2);
  stressNames.forEach((d, i) => {
    assert.deepEqual(
      { x: d.x, y: d.y, w: d.w, h: d.h },
      { x: -137, y: 240 + i * 44, w: 182, h: 44 },
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
    assert.deepEqual(
      { x: d.x, y: d.y, w: d.w, h: d.h },
      { x: (row === 0 ? 19 : -1) + col * 26, y: 252 + row * 44, w: 20, h: 20 },
    );
    assert.equal(d.align, "center");
    assert.equal(d.font, "Montserrat");
    assert.equal(d.size, 14);
    assert.equal(d.stroke, 2);
    assert.equal(d.fillType, 0);
  });
  assert.equal(stressBoxes[0].text, "X"); // checked box marker
  assert.equal(stressBoxes[1].text, ""); // empty box marker
  assert.equal(stressBoxes[4].x, -1); // second row starts after its own name

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
