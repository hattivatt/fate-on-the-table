/**
 * Node tests for layoutSchema.js — the pure validator/normalizer.
 *
 * The rules mirror the standalone layout-editor contract
 * (`layout-editor/src/contract/validateLayout.ts` / `normalizeLayout.ts`):
 * both sides must accept the same documents and normalize them identically.
 * Run with `npm test`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { analyzeLayout, FORMAT, VERSION } from "../scripts/layoutSchema.js";

function loadLayout(id) {
  return JSON.parse(
    readFileSync(new URL(`../layouts/${id}.json`, import.meta.url), "utf8"),
  );
}

/** Minimal valid document for mutation-based broken fixtures. */
function validDocument(overrides = {}) {
  return {
    format: FORMAT,
    version: VERSION,
    id: "test-layout",
    name: "Test Layout",
    anchor: { element: "portrait", point: "topLeft" },
    scale: 1,
    canvas: {
      origin: { x: -10, y: -20 },
      size: { width: 200, height: 300 },
    },
    elements: [
      {
        id: "portrait",
        type: "tile",
        rect: { x: 0, y: 0, width: 100, height: 100 },
        content: { resolver: "@portrait", mode: "image" },
      },
      {
        id: "name",
        type: "drawing",
        rect: { x: 0, y: 0, width: 200, height: 28 },
        content: { resolver: "@name", mode: "value" },
        style: { fontFamily: "Montserrat", fontSize: 20, textColor: "#000000" },
      },
    ],
    ...overrides,
  };
}

test("built-in layouts (default, minimal, full) are valid", () => {
  for (const id of ["default", "minimal", "full"]) {
    const result = analyzeLayout(loadLayout(id));
    assert.equal(
      result.ok,
      true,
      `layout "${id}" should be valid: ${JSON.stringify(result.errors)}`,
    );
    assert.ok(result.normalized);
  }
});

test("minimal and full layouts carry the interactive stress box pair", () => {
  for (const id of ["minimal", "full"]) {
    const result = analyzeLayout(loadLayout(id));
    assert.equal(result.ok, true, `layout "${id}" should be valid`);
    const elements = result.normalized.elements;
    const names = elements.find((e) => e.id === "stressTrackNames");
    const boxes = elements.find((e) => e.id === "stressBoxRows");

    assert.ok(names, `layout "${id}" must keep a stressTrackNames element`);
    assert.equal(names.content.resolver, "@stressTrackNames");
    assert.equal(names.content.mode, "rows");

    assert.ok(boxes, `layout "${id}" must contain a stressBoxRows element`);
    assert.equal(boxes.content.resolver, "@stressBoxRows");
    assert.equal(boxes.content.mode, "boxRow");
    assert.equal(boxes.type, "drawing");
    // The boxes rest in their own boxRow below the label: no anchorTo, the
    // box row is a separate absolute row under the stress track names so the
    // box x does not depend on the measured name width.
    assert.equal(boxes.position, undefined);
    assert.equal(boxes.layer.elevation, 20);
    assert.equal(boxes.layer.sort, 2000);
    assert.equal(boxes.repeat.axis, "y");
    assert.equal(boxes.style.stroke.width, 1);
    // Underscore the label-above-box geometry contract: the box row starts
    // strictly below the label rect and shares its x column.
    assert.ok(
      boxes.rect.y > names.rect.y,
      `layout "${id}" stress boxes must sit below the track names`,
    );
    assert.equal(boxes.rect.x, names.rect.x);

    // The combined text stress element must not shadow the interactive boxes.
    assert.ok(
      !elements.some((e) => e.content?.resolver === "@stressTracks"),
      `layout "${id}" should not keep a text-only @stressTracks element`,
    );
  }
});

test("normalizes a valid document with safe defaults", () => {
  const result = analyzeLayout(validDocument());
  assert.equal(result.ok, true);
  const doc = result.normalized;
  assert.equal(doc.format, FORMAT);
  assert.equal(doc.version, VERSION);
  assert.equal(doc.scale, 1);
  assert.deepEqual(doc.canvas.origin, { x: -10, y: -20 });
  assert.deepEqual(doc.canvas.sizePolicy, { mode: "fixed" });
  assert.equal(doc.anchor.point, "topLeft");
  assert.equal(doc.elements.length, 2);
  assert.equal(doc.elements[0].content.mode, "image");
  assert.equal(result.warnings.length, 0);
});

test("missing format/version/id/name/canvas/anchor/elements are errors", () => {
  const cases = [
    ["format", { format: undefined }],
    ["version", { version: 2 }],
    ["id", { id: "" }],
    ["name", { name: undefined }],
    ["canvas", { canvas: undefined }],
    ["anchor", { anchor: undefined }],
    ["elements", { elements: undefined }],
    ["elements", { elements: "nope" }],
  ];
  for (const [path, overrides] of cases) {
    const result = analyzeLayout(validDocument(overrides));
    assert.equal(result.ok, false, `"${path}" should fail`);
    assert.ok(
      result.errors.some((e) => e.path.startsWith(`$.${path}`)),
      `expected an error at "$.${path}", got ${JSON.stringify(result.errors)}`,
    );
  }
});

test("required canvas fields: size, positive dimensions, origin", () => {
  const cases = [
    ["$.canvas.size", { canvas: { origin: { x: 0, y: 0 } } }],
    ["$.canvas.size.width", { canvas: { origin: { x: 0, y: 0 }, size: { width: 0, height: 100 } } }],
    ["$.canvas.size.width", { canvas: { origin: { x: 0, y: 0 }, size: { width: 30000, height: 100 } } }],
    ["$.canvas.origin", { canvas: { size: { width: 200, height: 300 } } }],
    ["$.canvas.sizePolicy.minimum.width", { canvas: { origin: { x: 0, y: 0 }, size: { width: 200, height: 300 }, sizePolicy: { mode: "content", minimum: { width: -1, height: 100 } } } }],
  ];
  for (const [path, overrides] of cases) {
    const result = analyzeLayout(validDocument(overrides));
    assert.equal(result.ok, false, `"${path}" should fail`);
    assert.ok(
      result.errors.some((e) => e.path.startsWith(path)),
      `expected an error at "${path}", got ${JSON.stringify(result.errors)}`,
    );
  }
});

test("anchor requires element (string) and a known point", () => {
  const doc = validDocument();
  doc.anchor = { element: "portrait" };
  let result = analyzeLayout(doc);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.path === "$.anchor.point"));

  const doc2 = validDocument();
  doc2.anchor.point = "middleEarth";
  result = analyzeLayout(doc2);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.path === "$.anchor.point"));

  const doc3 = validDocument();
  doc3.anchor.element = "missing";
  result = analyzeLayout(doc3);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.path === "$.anchor.element"));
});

test("empty anchor element is a warning and normalized to the first element", () => {
  const doc = validDocument();
  doc.anchor.element = "";
  const result = analyzeLayout(doc);
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some((w) => w.path === "$.anchor.element"));
  assert.equal(result.normalized.anchor.element, "portrait");
});

test("non-positive scale is an error", () => {
  for (const scale of [0, -2]) {
    const result = analyzeLayout(validDocument({ scale }));
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.path === "$.scale"));
  }
});

test("non-string description is an error", () => {
  const result = analyzeLayout(validDocument({ description: 42 }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.path === "$.description"));
});

test("background texture requires source and a fill|none whenEmpty", () => {
  const doc = validDocument();
  doc.background = { enabled: true, texture: { whenEmpty: "fill" } };
  let result = analyzeLayout(doc);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.path === "$.background.texture.source"));

  const doc2 = validDocument();
  doc2.background = { enabled: true, texture: { source: "@setting.x", whenEmpty: "bounce" } };
  result = analyzeLayout(doc2);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.path === "$.background.texture.whenEmpty"));
});

test("duplicate element ids are an error", () => {
  const doc = validDocument();
  doc.elements.push({ ...doc.elements[1] });
  const result = analyzeLayout(doc);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.message.includes("Duplicate")));
});

test("unknown references (anchor.element, position.anchorTo, sizing.growTo) are errors", () => {
  const doc = validDocument();
  doc.anchor.element = "missing";
  doc.elements[1].position = {
    anchorTo: "nope",
    anchorPoint: "leftCenter",
    selfPoint: "leftCenter",
  };
  doc.elements[1].sizing = { growTo: "nope" };
  const result = analyzeLayout(doc);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.path === "$.anchor.element"));
  assert.ok(result.errors.some((e) => e.path === "$.elements[1].position.anchorTo"));
  assert.ok(result.errors.some((e) => e.path === "$.elements[1].sizing.growTo"));
});

test("position requires anchorTo, anchorPoint and selfPoint", () => {
  const doc = validDocument();
  doc.elements[1].position = { anchorPoint: "centerLeft", selfPoint: "centerLeft" };
  let result = analyzeLayout(doc);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.path === "$.elements[1].position.anchorTo"));

  const doc2 = validDocument();
  doc2.elements[1].position = { anchorTo: "portrait", selfPoint: "centerLeft" };
  result = analyzeLayout(doc2);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.path === "$.elements[1].position.anchorPoint"));
});

test("repeat requires axis and pitch; itemHeight must be positive", () => {
  const doc = validDocument();
  doc.elements[1].content = { resolver: "@skillNames", mode: "rows" };
  doc.elements[1].repeat = { pitch: 40 };
  let result = analyzeLayout(doc);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.path === "$.elements[1].repeat.axis"));

  const doc2 = validDocument();
  doc2.elements[1].content = { resolver: "@skillNames", mode: "rows" };
  doc2.elements[1].repeat = { axis: "y", pitch: undefined };
  result = analyzeLayout(doc2);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.path === "$.elements[1].repeat.pitch"));

  const doc3 = validDocument();
  doc3.elements[1].content = { resolver: "@skillNames", mode: "rows" };
  doc3.elements[1].repeat = { axis: "y", pitch: 40, itemHeight: 0 };
  result = analyzeLayout(doc3);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.path === "$.elements[1].repeat.itemHeight"));
});

test("negative rect/pitch/fontSize values are errors; huge values hit the limits", () => {
  const doc = validDocument();
  doc.elements[1].rect = { x: 0, y: 0, width: -1, height: 28 };
  doc.elements[1].repeat = { axis: "y", pitch: -5, itemHeight: 10 };
  doc.elements[1].style.fontSize = -3;
  let result = analyzeLayout(doc);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.path === "$.elements[1].rect.width"));
  assert.ok(result.errors.some((e) => e.path === "$.elements[1].repeat.pitch"));
  assert.ok(result.errors.some((e) => e.path === "$.elements[1].style.fontSize"));

  const doc2 = validDocument();
  doc2.elements[1].style.fontSize = 5000;
  result = analyzeLayout(doc2);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.path === "$.elements[1].style.fontSize"));

  const doc3 = validDocument();
  const many = [];
  for (let i = 0; i < 501; i++) {
    many.push({ ...doc3.elements[1], id: `el${i}` });
  }
  doc3.elements = many;
  result = analyzeLayout(doc3);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.path === "$.elements"));
});

test("unsupported type / content mode are errors", () => {
  const doc = validDocument();
  doc.elements[0].type = "sprite";
  let result = analyzeLayout(doc);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.path === "$.elements[0].type"));

  const doc2 = validDocument();
  doc2.elements[1].content.mode = "explode";
  result = analyzeLayout(doc2);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.path === "$.elements[1].content.mode"));
});

test("unregistered resolvers and type/mode mismatches are errors", () => {
  const doc = validDocument();
  doc.elements[1].content = { resolver: "@kamehameha", mode: "value" };
  let result = analyzeLayout(doc);
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => e.path === "$.elements[1].content.resolver"),
  );

  const doc2 = validDocument();
  doc2.elements[0].content = { resolver: "@portrait", mode: "count" };
  result = analyzeLayout(doc2);
  assert.equal(result.ok, false);

  const doc3 = validDocument();
  doc3.elements[1].content = { resolver: "@name", mode: "rows" };
  result = analyzeLayout(doc3);
  assert.equal(result.ok, false);

  const doc4 = validDocument();
  doc4.elements[0].content = { resolver: "@name", mode: "image" };
  result = analyzeLayout(doc4);
  assert.equal(result.ok, false);
});

test("@shortAspects validates only in mode value (mirror of @aspects)", () => {
  // value is the only allowed mode.
  const doc = validDocument();
  doc.elements[1].content = { resolver: "@shortAspects", mode: "value" };
  const result = analyzeLayout(doc);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.normalized.elements[1].content.resolver, "@shortAspects");

  // Every other content mode must be rejected.
  for (const mode of ["rows", "boxRow", "count", "image", "empty"]) {
    const d = validDocument();
    d.elements[1].content = { resolver: "@shortAspects", mode };
    const bad = analyzeLayout(d);
    assert.equal(
      bad.ok,
      false,
      `@shortAspects with mode "${mode}" should be rejected`,
    );
    assert.ok(
      bad.errors.some(
        (e) =>
          e.path === "$.elements[1].content" ||
          e.path === "$.elements[1].content.mode",
      ),
      `expected a content error for mode "${mode}": ${JSON.stringify(bad.errors)}`,
    );
  }
});

test("short-aspects fixture layout is valid and uses @shortAspects", () => {
  const doc = JSON.parse(
    readFileSync(
      new URL("../tests/fixtures/short-aspects.json", import.meta.url),
      "utf8",
    ),
  );
  const result = analyzeLayout(doc);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  const short = result.normalized.elements.find((e) => e.id === "shortAspects");
  assert.ok(short, "fixture must contain the shortAspects element");
  assert.equal(short.content.resolver, "@shortAspects");
  assert.equal(short.content.mode, "value");
});

test("@consequenceNames validates only in mode rows (plain names next to boxes)", () => {
  const doc = validDocument();
  doc.elements[1].content = { resolver: "@consequenceNames", mode: "rows" };
  const result = analyzeLayout(doc);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.normalized.elements[1].content.resolver, "@consequenceNames");
  assert.equal(result.normalized.elements[1].content.mode, "rows");

  for (const mode of ["value", "boxRow", "count", "image", "empty"]) {
    const d = validDocument();
    d.elements[1].content = { resolver: "@consequenceNames", mode };
    const bad = analyzeLayout(d);
    assert.equal(
      bad.ok,
      false,
      `@consequenceNames with mode "${mode}" should be rejected`,
    );
    assert.ok(
      bad.errors.some(
        (e) =>
          e.path === "$.elements[1].content" ||
          e.path === "$.elements[1].content.mode",
      ),
      `expected a content error for mode "${mode}": ${JSON.stringify(bad.errors)}`,
    );
  }
});

test("built-in layouts carry the consequence header + cost rows (no checkbox pair)", () => {
  for (const id of ["minimal", "full"]) {
    const result = analyzeLayout(loadLayout(id));
    assert.equal(result.ok, true, `layout "${id}" should be valid`);
    const elements = result.normalized.elements;
    const header = elements.find((e) => e.id === "consequencesHeader");
    const rows = elements.find((e) => e.id === "consequenceCostRows");

    assert.ok(header, `layout "${id}" must contain a consequencesHeader element`);
    assert.equal(header.content.resolver, "@consequencesHeader");
    assert.equal(header.content.mode, "value");
    assert.equal(header.type, "drawing");
    // The header is a plain text value element on the base canvas layer.
    assert.equal(header.position, undefined);
    assert.equal(header.layer.elevation, 0);
    assert.equal(header.layer.sort, 0);

    assert.ok(rows, `layout "${id}" must contain a consequenceCostRows element`);
    assert.equal(rows.content.resolver, "@consequenceCostRows");
    assert.equal(rows.content.mode, "rows");
    assert.equal(rows.type, "drawing");
    // The cost rows are anchored above the header: repeated vertically and
    // sitting BELOW the header (header is on top).
    assert.equal(rows.position, undefined);
    assert.equal(rows.repeat.axis, "y");
    assert.ok(rows.rect.y >= header.rect.y + header.rect.height, "cost rows sit below the header");
    // Regression: the consequence cost rows are the double-click input target,
    // so they render ABOVE the transparent widgetBounds grab frame
    // (bounds layer elevation 10 / sort 1000) — same elevation/sort as the
    // already-interactive stress box rows.
    assert.equal(rows.layer.elevation, 20);
    assert.equal(rows.layer.sort, 2000);
    assert.ok(
      rows.layer.elevation > result.normalized.bounds.layer.elevation &&
        rows.layer.sort > result.normalized.bounds.layer.sort,
      `layout "${id}" consequence cost rows must sit above widgetBounds`,
    );

    // No checkbox part or plain-name element remains in the built-ins.
    assert.ok(
      !elements.some((e) => e.id === "consequenceBoxRows" || e.content?.resolver === "@consequenceBoxRows"),
      `layout "${id}" must not keep a consequenceBoxRows element`,
    );
    assert.ok(
      !elements.some((e) => e.id === "consequences" || e.content?.resolver === "@consequenceNames"),
      `layout "${id}" must not keep a consequence name element`,
    );
  }
});

test("@consequenceBoxRows remains unregistered and unbuildable (consequences are text only)", () => {
  // The consequence checkbox resolver has been removed from the catalog: a
  // layout element that still references it must be rejected as an unknown
  // resolver, so no new layout can create a consequence checkbox Drawing.
  for (const mode of ["boxRow", "rows", "value"]) {
    const doc = validDocument();
    doc.elements[1].content = { resolver: "@consequenceBoxRows", mode };
    doc.elements[1].type = "drawing";
    const result = analyzeLayout(doc);
    assert.equal(
      result.ok,
      false,
      `@consequenceBoxRows mode "${mode}" should be rejected as an unknown resolver`,
    );
    assert.ok(
      result.errors.some((e) => e.path === "$.elements[1].content.resolver"),
      `expected unknown-resolver error for mode "${mode}": ${JSON.stringify(result.errors)}`,
    );
  }
});

test("default layout has no consequence elements of any kind", () => {
  const result = analyzeLayout(loadLayout("default"));
  assert.equal(result.ok, true, "default layout should be valid");
  const elements = result.normalized.elements;
  for (const resolver of [
    "@consequenceNames",
    "@consequenceBoxRows",
    "@consequencesHeader",
    "@consequenceCostRows",
    "@consequences",
  ]) {
    assert.ok(
      !elements.some((e) => e.content?.resolver === resolver),
      `default layout must not keep a ${resolver} element`,
    );
  }
  assert.ok(
    !elements.some((e) => e.id === "consequenceBoxRows" || e.id === "consequencesHeader" || e.id === "consequenceCostRows"),
    "default layout must not keep consequence parts",
  );
});

test("tile with mode value / drawing with mode image or count are errors", () => {
  const doc = validDocument();
  doc.elements[0].content = { resolver: "@portrait", mode: "value" };
  assert.equal(analyzeLayout(doc).ok, false);

  const doc2 = validDocument();
  doc2.elements[1].content = { resolver: "@name", mode: "image" };
  assert.equal(analyzeLayout(doc2).ok, false);

  const doc3 = validDocument();
  doc3.elements[1].content = { resolver: "@fatePointTokens", mode: "count" };
  assert.equal(analyzeLayout(doc3).ok, false);
});

test("rows/tileRow without repeat produce a warning", () => {
  const doc = validDocument();
  doc.elements[1].content = { resolver: "@skillNames", mode: "rows" };
  const result = analyzeLayout(doc);
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some((w) => w.path === "$.elements[1].repeat"));

  // boxRow behaves like rows: repeat is expected (warning) but optional.
  const doc2 = validDocument();
  doc2.elements[1].content = { resolver: "@stressBoxRows", mode: "boxRow" };
  const result2 = analyzeLayout(doc2);
  assert.equal(result2.ok, true);
  assert.ok(result2.warnings.some((w) => w.path === "$.elements[1].repeat"));
});

test("boxRow mode requires a drawing element", () => {
  const doc = validDocument();
  doc.elements[0].type = "tile";
  doc.elements[0].content = { resolver: "@stressBoxRows", mode: "boxRow" };
  const result = analyzeLayout(doc);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.path === "$.elements[0].content.mode"));
});

test("unknown optional fields are warnings and preserved in the normalized document", () => {
  const doc = validDocument();
  doc.someFutureField = { nested: [1, 2] };
  doc.elements[1].futureField = "survives";
  const result = analyzeLayout(doc);
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some((w) => w.path === "$.someFutureField"));
  assert.ok(result.warnings.some((w) => w.path === "$.elements[1].futureField"));
  assert.deepEqual(result.normalized.someFutureField, { nested: [1, 2] });
  assert.equal(result.normalized.elements[1].futureField, "survives");
});

test("normalization mirrors the layout-editor defaults", () => {
  const doc = validDocument();
  doc.canvas.sizePolicy = { mode: "content", overflow: "expand" };
  doc.anchor.point = "leftCenter"; // legacy alias -> canonical
  const result = analyzeLayout(doc);
  const normalized = result.normalized;

  // content mode without minimum -> minimum = canvas.size
  assert.deepEqual(normalized.canvas.sizePolicy, {
    mode: "content",
    overflow: "expand",
    minimum: { width: 200, height: 300 },
  });
  assert.equal(normalized.anchor.point, "centerLeft");

  const portrait = normalized.elements[0];
  const name = normalized.elements[1];
  // style fill/stroke defaults + layer default
  assert.deepEqual(portrait.style.fill, { type: "none", color: "#ffffff", alpha: 0 });
  assert.deepEqual(portrait.style.stroke, { width: 0, color: "#000000", alpha: 0 });
  assert.deepEqual(portrait.layer, { elevation: 0, sort: 0 });
  assert.deepEqual(name.style.fill, { type: "none", color: "#ffffff", alpha: 0 });

  // zero rect dimensions are replaced (editor normalizeRect)
  const doc2 = validDocument();
  doc2.elements[1].rect = { x: 0, y: 0, width: 0, height: 0 };
  const normalized2 = analyzeLayout(doc2).normalized;
  assert.deepEqual(normalized2.elements[1].rect, { x: 0, y: 0, width: 100, height: 40 });
});

test("normalization synthesizes repeat for rows/tileRow and position defaults", () => {
  const doc = validDocument();
  doc.elements[1].content = { resolver: "@skillNames", mode: "rows" };
  doc.elements[1].rect = { x: 0, y: 0, width: 200, height: 30 };
  doc.elements[0].type = "tileRow";
  doc.elements[0].content = { resolver: "@fatePointTokens", mode: "count" };
  doc.elements[0].rect = { x: 0, y: 0, width: 50, height: 50 };
  doc.elements[0].position = {
    anchorTo: "name",
    anchorPoint: "leftCenter",
    selfPoint: "leftCenter",
  };
  const normalized = analyzeLayout(doc).normalized;

  const rows = normalized.elements[1];
  assert.deepEqual(rows.repeat, {
    axis: "y",
    direction: "forward",
    pitch: 30,
    itemHeight: 30,
  });
  const tileRow = normalized.elements[0];
  // The editor's synthesized repeat carries an explicit (undefined) itemHeight
  // for tileRow elements; JSON output drops it, the in-memory model keeps it.
  assert.deepEqual(tileRow.repeat, {
    axis: "x",
    direction: "forward",
    pitch: 50,
    itemHeight: undefined,
  });
  // legacy point aliases normalized, offset default added
  assert.equal(tileRow.position.anchorPoint, "centerLeft");
  assert.equal(tileRow.position.selfPoint, "centerLeft");
  assert.deepEqual(tileRow.position.offset, { x: 0, y: 0 });
});

test("bad sizePolicy / anchor point are errors", () => {
  const doc = validDocument();
  doc.canvas.sizePolicy = { mode: "elastic", overflow: "bounce" };
  doc.anchor.point = "middleEarth";
  const result = analyzeLayout(doc);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.path === "$.canvas.sizePolicy.mode"));
  assert.ok(result.errors.some((e) => e.path === "$.canvas.sizePolicy.overflow"));
  assert.ok(result.errors.some((e) => e.path === "$.anchor.point"));
});

test("@setting.* resolvers are allowed in any mode", () => {
  const doc = validDocument();
  doc.elements[1].content = { resolver: "@setting.textColor", mode: "value" };
  const result = analyzeLayout(doc);
  assert.equal(result.ok, true);
});

test("@setting. with an empty key is rejected (editor parity)", () => {
  const doc = validDocument();
  doc.elements[1].content = { resolver: "@setting.", mode: "value" };
  const result = analyzeLayout(doc);
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => e.path === "$.elements[1].content.resolver"),
  );
});

test("kitchen-sink layout (rows, tileRow, anchorTo, growTo, width canvas, layers) is valid", () => {
  const doc = {
    format: FORMAT,
    version: VERSION,
    id: "kitchen",
    name: "Kitchen Sink",
    anchor: { element: "portrait", point: "topLeft" },
    scale: 2,
    canvas: {
      origin: { x: 0, y: 0 },
      size: { width: 800, height: 600 },
      sizePolicy: {
        mode: "content",
        minimum: { width: 400, height: 300 },
        overflow: "expand",
      },
    },
    background: {
      enabled: true,
      fill: { color: "#ffeecc", alpha: 0.8 },
      texture: { source: "@setting.backgroundTexture", whenEmpty: "fill" },
      layer: { elevation: -5, sort: -100 },
    },
    bounds: {
      enabled: true,
      rect: "canvas",
      stroke: { width: 2, color: "#333333", alpha: 0.5 },
      layer: { elevation: 5, sort: 100 },
    },
    elements: [
      {
        id: "portrait",
        type: "tile",
        rect: { x: 0, y: 0, width: 100, height: 100 },
        content: { resolver: "@portrait", mode: "image" },
      },
      {
        id: "header",
        type: "drawing",
        rect: { x: 0, y: 120, width: 800, height: 40 },
        content: { resolver: "@headerAspects", mode: "value" },
        style: { fontFamily: "Montserrat", fontSize: 24, fontWeight: 700, textAlign: "center" },
        sizing: { width: "canvas" },
      },
      {
        id: "rows",
        type: "drawing",
        rect: { x: 10, y: 180, width: 400, height: 40 },
        content: { resolver: "@skillNames", mode: "rows" },
        repeat: { axis: "y", pitch: 50, itemHeight: 40 },
        style: { fill: { type: "solid", color: "#ffffff", alpha: 1 }, stroke: { width: 1, color: "#000000", alpha: 1 } },
      },
      {
        id: "frame",
        type: "drawing",
        rect: { x: 10, y: 400, width: 200, height: 100 },
        content: { resolver: "@empty", mode: "empty" },
        style: { stroke: { width: 2, color: "#000000", alpha: 1 } },
        sizing: { growTo: "tokens", padding: 10, minimum: true },
      },
      {
        id: "tokens",
        type: "tileRow",
        rect: { x: 0, y: 0, width: 40, height: 40 },
        content: { resolver: "@fatePointTokens", mode: "count" },
        position: { anchorTo: "frame", anchorPoint: "leftCenter", selfPoint: "leftCenter", offset: { x: 6, y: 0 } },
        repeat: { axis: "x", direction: "backward", pitch: 10 },
      },
      {
        id: "value",
        type: "drawing",
        rect: { x: 500, y: 180, width: 60, height: 40 },
        content: { resolver: "@skillValues", mode: "rows" },
        repeat: { axis: "y", pitch: 50, itemHeight: 40 },
      },
    ],
  };
  const result = analyzeLayout(doc);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.normalized.scale, 2);
  assert.equal(result.normalized.elements.length, 6);
});

test("@consequencesHeader validates only in mode value", () => {
  const doc = validDocument();
  doc.elements[1].content = { resolver: "@consequencesHeader", mode: "value" };
  const result = analyzeLayout(doc);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.normalized.elements[1].content.resolver, "@consequencesHeader");

  for (const mode of ["rows", "boxRow", "count", "image", "empty"]) {
    const d = validDocument();
    d.elements[1].content = { resolver: "@consequencesHeader", mode };
    const bad = analyzeLayout(d);
    assert.equal(
      bad.ok,
      false,
      `@consequencesHeader with mode "${mode}" should be rejected`,
    );
    assert.ok(
      bad.errors.some(
        (e) =>
          e.path === "$.elements[1].content" ||
          e.path === "$.elements[1].content.mode",
      ),
      `expected a content error for mode "${mode}": ${JSON.stringify(bad.errors)}`,
    );
  }
});

test("@consequenceCostRows validates only in mode rows", () => {
  const doc = validDocument();
  doc.elements[1].content = { resolver: "@consequenceCostRows", mode: "rows" };
  const result = analyzeLayout(doc);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.normalized.elements[1].content.resolver, "@consequenceCostRows");

  for (const mode of ["value", "boxRow", "count", "image", "empty"]) {
    const d = validDocument();
    d.elements[1].content = { resolver: "@consequenceCostRows", mode };
    const bad = analyzeLayout(d);
    assert.equal(
      bad.ok,
      false,
      `@consequenceCostRows with mode "${mode}" should be rejected`,
    );
    assert.ok(
      bad.errors.some(
        (e) =>
          e.path === "$.elements[1].content" ||
          e.path === "$.elements[1].content.mode",
      ),
      `expected a content error for mode "${mode}": ${JSON.stringify(bad.errors)}`,
    );
  }
});
