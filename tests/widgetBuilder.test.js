/**
 * Node tests for the WidgetBuilder resolver catalog (pure data normalizers).
 * Importing WidgetBuilder is safe in Node: the module only touches `game`
 * inside resolver callbacks, never at top level.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { analyzeLayout } from "../scripts/layoutSchema.js";
import {
  build,
  stressTrackRows,
  stressTrackNames,
  stressTrackBoxes,
  stressTrackBoxRows,
  resolveElement,
  stressBoxTarget,
  shortAspectsText,
  resolverCatalog,
  consequenceNames,
  consequenceCostRows,
  consequenceCostTarget,
  consequenceCostDescriptors,
  CONSEQUENCE_COST_ROW_WIDTH,
} from "../scripts/WidgetBuilder.js";

function makeActor(tracks) {
  return { system: { tracks } };
}

/** Minimal game stub: build() only touches i18n and settings resolvers. */
function withGameStub(fn) {
  globalThis.game = {
    i18n: { localize: (key) => key },
    settings: { get: () => "" },
  };
  globalThis.CONFIG = { fontDefinitions: {} };
  try {
    return fn();
  } finally {
    delete globalThis.game;
    delete globalThis.CONFIG;
  }
}

function loadNormalized(id) {
  const raw = JSON.parse(
    readFileSync(new URL(`../layouts/${id}.json`, import.meta.url), "utf8"),
  );
  return analyzeLayout(raw).normalized;
}

function actorWithTracks() {
  return {
    name: "Bob Example",
    img: "img/bob.png",
    system: {
      aspects: {},
      skills: {},
      details: { fatePoints: { current: 0 } },
      tracks: {
        phys: {
          name: "Physical Stress",
          enabled: true,
          boxes: 2,
          box_values: [false, true, false, false],
          aspect: "No",
        },
        ment: {
          name: "Mental Stress",
          enabled: true,
          boxes: 3,
          box_values: [false, false, false],
          aspect: "No",
        },
      },
    },
  };
}

test("resolveElement keeps the value shape for every content mode", () => {
  const actor = {
    name: "Physical Stress",
    img: "img.png",
    system: {
      skills: { ath: { name: "Athletics", rank: 4 } },
      details: { fatePoints: { current: 1 } },
      tracks: {
        phys: {
          name: "Physical Stress",
          enabled: true,
          boxes: 2,
          box_values: [false, true, false, false],
          aspect: "No",
        },
      },
    },
  };
  const cases = [
    [{ resolver: "@name", mode: "value" }, "Physical Stress"],
    [{ resolver: "@empty", mode: "empty" }, ""],
    [{ resolver: "@skillNames", mode: "rows" }, ["Athletics"]],
    [{ resolver: "@fatePointTokens", mode: "count" }, 1],
    [{ resolver: "@portrait", mode: "image" }, "img.png"],
  ];
  for (const [content, expected] of cases) {
    assert.deepEqual(resolveElement({ content }, actor), expected, JSON.stringify(content));
  }
  // boxRow must stay an array of arrays (a string here would break the engine)
  const boxRow = resolveElement(
    { content: { resolver: "@stressBoxRows", mode: "boxRow" } },
    actor,
  );
  assert.ok(Array.isArray(boxRow));
  assert.deepEqual(boxRow, [["", "X", "", ""]]);
});

test("stress names and boxes split into aligned row columns", () => {
  const actor = makeActor({
    phys: {
      name: "Physical Stress",
      enabled: true,
      boxes: 2,
      box_values: [false, true, false, false],
      aspect: "No",
    },
  });
  assert.deepEqual(stressTrackNames(actor), ["Physical Stress"]);
  assert.deepEqual(stressTrackBoxes(actor), [
    "\u2610 \u2612 \u2610 \u2610",
  ]);
});

test("box rows yield per-box marker texts for framed checkbox drawings", () => {
  const actor = makeActor({
    phys: {
      name: "Physical Stress",
      enabled: true,
      boxes: 2,
      box_values: [false, true, false, false],
      aspect: "No",
    },
    ment: {
      name: "Mental Stress",
      enabled: true,
      boxes: 3,
      box_values: [false, false, false],
      aspect: "No",
    },
  });
  assert.deepEqual(stressTrackBoxRows(actor), [
    ["", "X", "", ""],
    ["", "", ""],
  ]);
  assert.deepEqual(stressTrackNames(actor), ["Physical Stress", "Mental Stress"]);
});

test("stress rows count boxes from box_values (linked skill bonuses)", () => {
  const actor = makeActor({
    phys: {
      name: "Physical Stress",
      enabled: true,
      boxes: 2, // base boxes; Physique adds 2 more -> box_values has 4 entries
      box_values: [false, true, false, false],
      aspect: "No",
    },
  });
  assert.deepEqual(stressTrackRows(actor), [
    "Physical Stress: \u2610 \u2612 \u2610 \u2610",
  ]);
});

test("stress rows fall back to the base boxes when box_values is missing", () => {
  const actor = makeActor({
    phys: {
      name: "Physical Stress",
      enabled: true,
      boxes: 3,
      aspect: "No",
    },
  });
  assert.deepEqual(stressTrackRows(actor), [
    "Physical Stress: \u2610 \u2610 \u2610",
  ]);
});

test("a track with base boxes 0 but skill-granted boxes is rendered", () => {
  const actor = makeActor({
    extra: {
      name: "Extra Stress",
      enabled: true,
      boxes: 0, // only granted by a linked skill
      box_values: [false, false],
      aspect: "No",
    },
  });
  assert.deepEqual(stressTrackRows(actor), ["Extra Stress: \u2610 \u2610"]);
});

test("disabled tracks and aspect tracks (consequences) are excluded", () => {
  const actor = makeActor({
    phys: {
      name: "Physical Stress",
      enabled: false,
      boxes: 4,
      box_values: [false, false, false, false],
      aspect: "No",
    },
    mild: {
      name: "Mild Consequence",
      enabled: true,
      boxes: 0,
      box_values: [],
      aspect: { when_marked: true, name: "My leg" },
    },
    cond: {
      name: "Condition",
      enabled: true,
      boxes: 0,
      box_values: [false],
      aspect: { as_name: true, name: "" },
    },
  });
  assert.deepEqual(stressTrackRows(actor), []);
});

test("all boxes render checked once box_values are marked", () => {
  const actor = makeActor({
    phys: {
      name: "Physical Stress",
      enabled: true,
      boxes: 1,
      box_values: [true],
      aspect: "No",
    },
  });
  assert.deepEqual(stressTrackRows(actor), ["Physical Stress: \u2612"]);
});

test("stressBoxTarget maps a flat box index to its track and box", () => {
  const actor = makeActor({
    phys: {
      name: "Physical Stress",
      enabled: true,
      boxes: 4,
      box_values: [false, false, false, false],
      aspect: "No",
    },
    ment: {
      name: "Mental Stress",
      enabled: true,
      boxes: 3,
      box_values: [false, false, false],
      aspect: "No",
    },
  });
  // first track: boxes 0..3, second track: boxes 0..2
  assert.deepEqual(stressBoxTarget(actor, 0), { trackKey: "phys", boxIndex: 0 });
  assert.deepEqual(stressBoxTarget(actor, 3), { trackKey: "phys", boxIndex: 3 });
  assert.deepEqual(stressBoxTarget(actor, 4), { trackKey: "ment", boxIndex: 0 });
  assert.deepEqual(stressBoxTarget(actor, 6), { trackKey: "ment", boxIndex: 2 });
  assert.equal(stressBoxTarget(actor, 7), null);
  assert.equal(stressBoxTarget(actor, -1), null);
});

test("stressBoxTarget skips disabled and aspect tracks, counts skill-granted boxes", () => {
  const actor = makeActor({
    off: {
      name: "Disabled Stress",
      enabled: false,
      boxes: 4,
      box_values: [false, false, false, false],
      aspect: "No",
    },
    mild: {
      name: "Mild Consequence",
      enabled: true,
      boxes: 0,
      box_values: [],
      aspect: { when_marked: true, name: "" },
    },
    extra: {
      name: "Extra Stress",
      enabled: true,
      boxes: 0, // only granted by a linked skill
      box_values: [false, false],
      aspect: "No",
    },
  });
  assert.deepEqual(stressBoxTarget(actor, 0), { trackKey: "extra", boxIndex: 0 });
  assert.deepEqual(stressBoxTarget(actor, 1), { trackKey: "extra", boxIndex: 1 });
  assert.equal(stressBoxTarget(actor, 2), null);
});

test("build resolves actor tracks into separate interactive box drawings (minimal)", async () => {
  const layout = loadNormalized("minimal");
  const actor = actorWithTracks();
  const { docs } = await withGameStub(() =>
    build(actor, layout, { fatePointImage: "", backgroundTexture: "" }),
  );

  const boxes = docs.filter((d) => d.part === "stressBoxRows");
  assert.equal(boxes.length, 7);
  assert.deepEqual(boxes.map((d) => d.index), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(boxes.map((d) => d.rowIndex), [0, 0, 0, 0, 1, 1, 1]);
  assert.deepEqual(boxes.map((d) => d.columnIndex), [0, 1, 2, 3, 0, 1, 2]);
  boxes.forEach((d) => {
    assert.equal(d.kind, "drawing");
    assert.equal(d.elevation, 20); // above the grab frame -> clickable
    assert.equal(d.sort, 2000);
  });
  assert.equal(boxes[0].text, ""); // empty box marker (box_values[0] = false)
  assert.equal(boxes[1].text, "X"); // checked box marker (box_values[1] = true)

  // No leftover combined text element replaces the interactive boxes.
  assert.equal(docs.some((d) => d.part === "stressTracks"), false);
  const names = docs.filter((d) => d.part === "stressTrackNames");
  assert.equal(names.length, 2);
});

test("build with an empty stress track name skips the invalid name but keeps boxes and bounds", async () => {
  const layout = loadNormalized("minimal");
  // All stress tracks have an EMPTY name -> the rows-mode name element must
  // not emit an invalid empty Drawing, but the box cells and the bounds
  // (widgetBounds) group must survive.
  const actor = {
    name: "Bob",
    img: "img/bob.png",
    system: {
      aspects: {},
      details: { fatePoints: { current: 0 } },
      tracks: {
        phys: {
          name: "",
          enabled: true,
          boxes: 1,
          box_values: [true],
          aspect: "No",
        },
        ment: {
          name: "",
          enabled: true,
          boxes: 1,
          box_values: [false],
          aspect: "No",
        },
      },
    },
  };
  const { docs } = await withGameStub(() =>
    build(actor, layout, { fatePointImage: "", backgroundTexture: "" }),
  );

  // No fully-invisible empty Drawing (empty text, no stroke, no fill).
  const invalid = docs.filter(
    (d) => d.kind === "drawing" && !d.text && !d.stroke && d.fillType === 0,
  );
  assert.deepEqual(
    invalid.map((d) => `${d.part}#${d.index}`),
    [],
    "empty-named stress tracks must not emit invalid Drawings",
  );

  // The empty names were skipped entirely.
  assert.equal(
    docs.some((d) => d.part === "stressTrackNames"),
    false,
  );

  // The checkbox row cells (framed, visible) are still generated for each
  // track — the regression that hid them is gone.
  const boxes = docs.filter((d) => d.part === "stressBoxRows");
  assert.equal(boxes.length, 2);
  assert.deepEqual(boxes.map((d) => d.text), ["X", ""]);
  boxes.forEach((d) => {
    assert.equal(d.stroke, 1);
    assert.equal(d.elevation, 20);
    assert.equal(d.sort, 2000);
  });

  // The top grouping widgetBounds Drawing survives the batch.
  const bounds = docs.find((d) => d.part === "widgetBounds");
  assert.ok(bounds, "widgetBounds must be present");
  assert.equal(bounds.kind, "drawing");
  assert.equal(bounds.elevation, 10);
  assert.equal(bounds.sort, 1000);
});

test("name normalization: whitespace-only values become empty, internal spaces survive", () => {
  const base = {
    img: "",
    system: { aspects: {}, skills: {}, details: { fatePoints: {} }, tracks: {} },
  };
  // Whitespace-only actor name -> empty string (geometry then filters it).
  assert.equal(
    resolveElement(
      { content: { resolver: "@name", mode: "value" } },
      { name: "   ", ...base },
    ),
    "",
  );
  // Surrounding whitespace is trimmed, internal spaces are preserved.
  assert.equal(
    resolveElement(
      { content: { resolver: "@name", mode: "value" } },
      { name: "  Alice Smith  ", ...base },
    ),
    "Alice Smith",
  );
  // Whitespace-only stress track name -> empty string.
  const wsStress = makeActor({
    phys: { name: "  ", enabled: true, boxes: 1, box_values: [false], aspect: "No" },
  });
  assert.deepEqual(stressTrackNames(wsStress), [""]);
  // Whitespace-only aspect name falls back to the trimmed slot name; a
  // whitespace-only slot name collapses to "".
  const cons = makeActor({
    mild: {
      name: "  Mild Slot  ",
      enabled: true,
      boxes: 0,
      box_values: [false],
      aspect: { when_marked: true, name: "   " },
    },
  });
  assert.deepEqual(consequenceNames(cons), ["Mild Slot"]);
  const wsCons = makeActor({
    mild: {
      name: "   ",
      enabled: true,
      boxes: 0,
      box_values: [false],
      aspect: { when_marked: true, name: "   " },
    },
  });
  assert.deepEqual(consequenceNames(wsCons), [""]);
});

test("build with whitespace-only names creates no invalid Drawings but keeps every box cell and bounds", async () => {
  const layout = loadNormalized("minimal");
  const actor = {
    name: "   ",
    img: "img/ghost.png",
    system: {
      aspects: {},
      details: { fatePoints: { current: 0 } },
      tracks: {
        phys: {
          name: "   ",
          enabled: true,
          boxes: 2,
          box_values: [false, true],
          aspect: "No",
        },
        ment: {
          name: "   ",
          enabled: true,
          boxes: 1,
          box_values: [false],
          aspect: "No",
        },
        mild: {
          name: "   ",
          enabled: true,
          boxes: 0,
          box_values: [true],
          aspect: { when_marked: true, name: "   " },
        },
        moderate: {
          name: "   ",
          enabled: true,
          boxes: 0,
          box_values: [false],
          aspect: { when_marked: true, name: "   " },
        },
      },
    },
  };
  const { docs } = await withGameStub(() =>
    build(actor, layout, { fatePointImage: "", backgroundTexture: "" }),
  );

  // No whitespace-only invisible Drawing reaches the creation batch.
  const invalid = docs.filter(
    (d) =>
      d.kind === "drawing" &&
      !String(d.text ?? "").trim() &&
      (d.stroke ?? 0) <= 0 &&
      ((d.fillType ?? 0) === 0 || (d.fillAlpha ?? 0) <= 0),
  );
  assert.deepEqual(invalid.map((d) => `${d.part}#${d.index}`), []);

  // Whitespace-only values produce no rows-mode/value-mode Drawing at all.
  assert.equal(docs.some((d) => d.part === "name"), false, "whitespace-only actor name must be skipped");
  assert.equal(docs.some((d) => d.part === "stressTrackNames"), false, "whitespace-only stress names must be skipped");

  // The actor still has 2 enabled consequence slots, so the LOCALIZED header
  // renders (it is not whitespace) — but the whitespace consequence slot name
  // produces an empty cost row (skipped) and the free slot produces the
  // underscore run (kept). Only the underscore line survives as a cost row.
  const headers = docs.filter((d) => d.part === "consequencesHeader");
  assert.equal(headers.length, 1, "a consequence header Drawing is present when slots exist");
  const costRows = docs.filter((d) => d.part === "consequenceCostRows");
  assert.equal(costRows.length, 1, "only the non-whitespace underscore cost row survives");
  assert.ok(costRows[0].text.includes("_"), "the kept cost row is the underscore line");

  // Every framed checkbox cell is still created — including empty cells and
  // cells of whitespace-named tracks.
  const boxes = docs.filter((d) => d.part === "stressBoxRows");
  assert.equal(boxes.length, 3, "all stress cells (2+1) must stay");
  assert.deepEqual(boxes.map((d) => d.stroke), [1, 1, 1]);
  assert.deepEqual(boxes.map((d) => d.elevation), [20, 20, 20]);
  assert.deepEqual(boxes.map((d) => d.sort), [2000, 2000, 2000]);

  // The top widgetBounds grab frame survives the batch.
  const bounds = docs.find((d) => d.part === "widgetBounds");
  assert.ok(bounds, "widgetBounds must be present");
  assert.equal(bounds.kind, "drawing");
  assert.equal(bounds.stroke, 1);
  assert.equal(bounds.strokeAlpha, 0.2);
  assert.equal(bounds.elevation, 10);
  assert.equal(bounds.sort, 1000);
});

test("minimal widget path: ordinary actor keeps name text and the full box/bounds set", async () => {
  const layout = loadNormalized("minimal");
  const actor = {
    name: "Bob Example",
    img: "img/bob.png",
    system: {
      aspects: {},
      details: { fatePoints: { current: 0 } },
      tracks: {
        phys: {
          name: "Physical Stress",
          enabled: true,
          boxes: 2,
          box_values: [false, true],
          aspect: "No",
        },
        mild: {
          name: "Mild Consequence",
          enabled: true,
          boxes: 0,
          box_values: [true],
          aspect: { when_marked: true, name: "Broken leg" },
        },
      },
    },
  };
  const { docs } = await withGameStub(() =>
    build(actor, layout, { fatePointImage: "", backgroundTexture: "" }),
  );

  const name = docs.find((d) => d.part === "name");
  assert.ok(name, "name drawing must be present");
  assert.equal(name.kind, "drawing");
  assert.equal(name.text, "Bob Example");
  assert.equal(name.elevation, 0);
  assert.equal(name.sort, 0);

  const boxes = docs.filter((d) => d.part === "stressBoxRows");
  assert.equal(boxes.length, 2);
  assert.deepEqual(boxes.map((d) => d.index), [0, 1]);
  assert.deepEqual(boxes.map((d) => d.stroke), [1, 1]);

  // Ordinary actor build: stress boxes sit BELOW the corresponding labels;
  // the consequence header renders above its cost rows (no checkboxes).
  const stressLabels = docs.filter((d) => d.part === "stressTrackNames");
  const consHeaders = docs.filter((d) => d.part === "consequencesHeader");
  const costRows = docs.filter((d) => d.part === "consequenceCostRows");
  assert.equal(stressLabels.length, 1);
  assert.equal(consHeaders.length, 1, "a consequence header renders for this actor");
  assert.equal(costRows.length, 1);
  assert.equal(costRows[0].text, "Broken leg");
  stressLabels.forEach((label, i) => {
    const rowBoxes = boxes.filter((d) => d.rowIndex === i);
    assert.ok(
      rowBoxes.every((d) => d.y > label.y),
      "stress box row must be below its track label",
    );
  });
  // The cost row sits strictly below its header (header on top).
  costRows.forEach((row) =>
    assert.ok(row.y >= consHeaders[0].y + consHeaders[0].h, "cost row must be below the header"),
  );
  // No consequence checkbox part is produced.
  assert.equal(docs.some((d) => d.part === "consequenceBoxRows"), false);

  const bounds = docs.find((d) => d.part === "widgetBounds");
  assert.ok(bounds, "widgetBounds must be present");
  assert.deepEqual(
    { part: bounds.part, elevation: bounds.elevation, sort: bounds.sort },
    { part: "widgetBounds", elevation: 10, sort: 1000 },
  );
});

test("build emits no stress drawings when the actor has no tracks", async () => {
  for (const id of ["minimal", "full"]) {
    const layout = loadNormalized(id);
    const actor = {
      name: "Empty",
      img: "",
      system: { aspects: {}, skills: {}, details: { fatePoints: { current: 0 } }, tracks: {} },
    };
    const { docs } = await withGameStub(() =>
      build(actor, layout, { fatePointImage: "", backgroundTexture: "" }),
    );
    assert.equal(docs.some((d) => d.part === "stressTrackNames"), false, id);
    assert.equal(docs.some((d) => d.part === "stressBoxRows"), false, id);
    assert.equal(docs.some((d) => d.part === "stressTracks"), false, id);
  }
});

/* ------------------------------------------------------------------ *
 * Short aspects (@shortAspects)
 * ------------------------------------------------------------------ */

test("shortAspectsText returns the first two non-empty aspects in order", () => {
  const actor = {
    system: {
      aspects: {
        highconcept: { value: "Scion of the Storm" },
        trouble: { value: "Too curious to live" },
        aspect3: { value: "" },
        aspect4: { value: "Aspect Four" },
      },
    },
  };
  // Empty slots are skipped; the first two non-empty values are kept in
  // collection (sheet) order, no sorting, no slot-name hardcoding.
  assert.equal(
    shortAspectsText(actor),
    "Scion of the Storm\n\nToo curious to live",
  );
});

test("shortAspectsText handles 0/1/2/3 aspects, empty values and missing actors", () => {
  // 0 aspects -> empty string
  assert.equal(shortAspectsText({ system: { aspects: {} } }), "");
  // 1 aspect
  assert.equal(
    shortAspectsText({ system: { aspects: { hc: { value: "Only One" } } } }),
    "Only One",
  );
  // 2 aspects -> joined with "\n\n"
  assert.equal(
    shortAspectsText({
      system: { aspects: { a: { value: "First" }, b: { value: "Second" } } },
    }),
    "First\n\nSecond",
  );
  // 3 aspects -> only the first two
  assert.equal(
    shortAspectsText({
      system: {
        aspects: {
          a: { value: "First" },
          b: { value: "Second" },
          c: { value: "Third" },
        },
      },
    }),
    "First\n\nSecond",
  );
  // Empty/whitespace values are skipped and never produce extra separators.
  assert.equal(
    shortAspectsText({
      system: {
        aspects: {
          a: { value: "" },
          b: { value: "B" },
          c: { value: "   " },
          d: { value: "D" },
        },
      },
    }),
    "B\n\nD",
  );
  // Missing actor / missing aspects / null entries -> empty string.
  assert.equal(shortAspectsText(undefined), "");
  assert.equal(shortAspectsText(null), "");
  assert.equal(shortAspectsText({}), "");
  assert.equal(shortAspectsText({ system: {} }), "");
  assert.equal(shortAspectsText({ system: { aspects: { a: null } } }), "");
});

test("@shortAspects resolver metadata and resolved output", () => {
  const entry = resolverCatalog["@shortAspects"];
  assert.ok(entry, "@shortAspects must be registered in the resolver catalog");
  assert.equal(entry.mode, "value"); // same content mode as @aspects
  const actor = {
    system: {
      aspects: {
        highconcept: { value: "HC" },
        trouble: { value: "Tr" },
        aspect3: { value: "A3" },
      },
    },
  };
  assert.equal(
    resolveElement({ content: { resolver: "@shortAspects", mode: "value" } }, actor),
    "HC\n\nTr",
  );
  // Empty actor stays an empty string (no drawing text, no placeholder).
  assert.equal(
    resolveElement({ content: { resolver: "@shortAspects", mode: "value" } }, {}),
    "",
  );
});

test("@aspects regression: full list result is unchanged", () => {
  const actor = {
    system: {
      aspects: {
        highconcept: { value: "HC" },
        trouble: { value: "Tr" },
        aspect3: { value: "A3" },
      },
    },
  };
  assert.equal(
    resolveElement({ content: { resolver: "@aspects", mode: "value" } }, actor),
    "HC\n\nTr\n\nA3",
  );
});

test("compact short-aspects fixture builds a drawing with the first two aspects", async () => {
  const raw = JSON.parse(
    readFileSync(
      new URL("../tests/fixtures/short-aspects.json", import.meta.url),
      "utf8",
    ),
  );
  const layout = analyzeLayout(raw).normalized;
  const actor = {
    name: "Zeph",
    img: "img/zeph.png",
    system: {
      aspects: {
        highconcept: { value: "Storm Rider" },
        trouble: { value: "Debt to the Wyrm" },
        aspect3: { value: "Unshakeable" },
      },
    },
  };
  const { docs } = await withGameStub(() =>
    build(actor, layout, { fatePointImage: "", backgroundTexture: "" }),
  );
  const short = docs.find((d) => d.part === "shortAspects");
  assert.ok(short, "fixture must emit the shortAspects drawing");
  assert.equal(short.text, "Storm Rider\n\nDebt to the Wyrm");
});

/* ------------------------------------------------------------------ *
 * Consequences (@consequenceNames)
 * ------------------------------------------------------------------ */

function consequenceActor(overrides = {}) {
  return makeActor({
    phys: {
      name: "Physical Stress",
      enabled: true,
      boxes: 2,
      box_values: [false, false],
      aspect: "No",
    },
    mild: {
      name: "Mild Consequence",
      enabled: true,
      boxes: 0,
      box_values: [true],
      aspect: { when_marked: true, name: "Broken leg" },
    },
    moderate: {
      name: "Moderate Consequence",
      enabled: true,
      boxes: 0,
      box_values: [false],
      aspect: { when_marked: true, name: "" },
    },
    cond: {
      name: "Condition",
      enabled: true,
      boxes: 0,
      box_values: [true],
      aspect: { as_name: true, name: "On fire" },
    },
    ...overrides,
  });
}

test("consequenceNames emits one name per enabled aspect track in sheet order", () => {
  const actor = consequenceActor();
  // mild (name) and cond (box_values[0]) are occupied -> aspect name; moderate
  // is free but still keeps its slot name; phys is a plain stress track and
  // excluded. There is no checkbox row: consequences are text only.
  assert.deepEqual(consequenceNames(actor), [
    "Broken leg",
    "Moderate Consequence",
    "On fire",
  ]);
});

test("consequence names: an aspect name without a checked box still shows the name", () => {
  const actor = makeActor({
    mild: {
      name: "Mild",
      enabled: true,
      boxes: 0,
      box_values: [false],
      aspect: { when_marked: true, name: "Twisted ankle" },
    },
  });
  assert.deepEqual(consequenceNames(actor), ["Twisted ankle"]);
});

test("consequence names: free tracks keep their slot name; actors without aspect tracks produce none", () => {
  const free = makeActor({
    mild: {
      name: "Mild",
      enabled: true,
      boxes: 0,
      box_values: [false],
      aspect: { when_marked: true, name: "" },
    },
  });
  assert.deepEqual(consequenceNames(free), ["Mild"]);
  // No tracks at all -> nothing.
  assert.deepEqual(consequenceNames(makeActor({})), []);
  // Disabled aspect track -> excluded even when marked.
  const disabled = makeActor({
    mild: {
      name: "Mild",
      enabled: false,
      boxes: 0,
      box_values: [true],
      aspect: { when_marked: true, name: "Broken leg" },
    },
  });
  assert.deepEqual(consequenceNames(disabled), []);
});

test("@consequenceNames resolves to the documented shape; @consequenceBoxRows is removed", () => {
  assert.equal(resolverCatalog["@consequenceNames"].mode, "rows");
  assert.equal(resolverCatalog["@consequenceBoxRows"], undefined, "checkbox resolver must be removed");
  const actor = consequenceActor();
  assert.deepEqual(
    resolveElement(
      { content: { resolver: "@consequenceNames", mode: "rows" } },
      actor,
    ),
    ["Broken leg", "Moderate Consequence", "On fire"],
  );
  // Actor without aspect tracks -> empty array (no rows).
  assert.deepEqual(
    resolveElement(
      { content: { resolver: "@consequenceNames", mode: "rows" } },
      makeActor({}),
    ),
    [],
  );
});

test("@consequences legacy regression: combined [X]/[ ] rows are unchanged", () => {
  const actor = consequenceActor();
  assert.deepEqual(
    resolveElement({ content: { resolver: "@consequences", mode: "rows" } }, actor),
    ["[X] Broken leg", "[ ] Moderate Consequence", "[X] On fire"],
  );
});

test("minimal layout renders the consequence header above its cost rows (free + occupied)", async () => {
  const layout = loadNormalized("minimal");
  const actor = {
    name: "Bob",
    img: "img/bob.png",
    system: {
      aspects: {},
      details: { fatePoints: { current: 0 } },
      tracks: {
        phys: {
          name: "Physical Stress",
          enabled: true,
          boxes: 2,
          box_values: [false, true, false, false],
          aspect: "No",
        },
        mild: {
          name: "Mild Consequence",
          enabled: true,
          boxes: 0,
          box_values: [true],
          aspect: { when_marked: true, name: "Broken leg" },
        },
      },
    },
  };
  const { docs } = await withGameStub(() =>
    build(actor, layout, { fatePointImage: "", backgroundTexture: "" }),
  );
  const headers = docs.filter((d) => d.part === "consequencesHeader");
  assert.equal(headers.length, 1, "a header renders when the actor has consequence slots");
  assert.equal(headers[0].elevation, 0);
  assert.equal(headers[0].sort, 0);
  // Occupied slot shows the actual consequence name (the visible input result).
  const costRows = docs.filter((d) => d.part === "consequenceCostRows");
  assert.equal(costRows.length, 1);
  assert.equal(costRows[0].text, "Broken leg");
  // Cost rows are the double-click input target: they sit above the
  // widgetBounds grab frame (10/1000), same as the stress boxes (20/2000).
  assert.equal(costRows[0].elevation, 20);
  assert.equal(costRows[0].sort, 2000);
  assert.ok(costRows[0].y >= headers[0].y + headers[0].h, "cost row sits below the header");
  // No consequence checkbox part is produced.
  assert.equal(docs.some((d) => d.part === "consequenceBoxRows"), false);

  // A free consequence slot keeps its cost row (the underscore run) with its
  // own sequential flat index; the header still renders.
  const freeActor = {
    ...actor,
    system: {
      ...actor.system,
      tracks: {
        ...actor.system.tracks,
        moderate: {
          name: "Moderate Consequence",
          enabled: true,
          boxes: 0,
          box_values: [false],
          aspect: { when_marked: true, name: "" },
        },
      },
    },
  };
  const { docs: docs2 } = await withGameStub(() =>
    build(freeActor, layout, { fatePointImage: "", backgroundTexture: "" }),
  );
  const headers2 = docs2.filter((d) => d.part === "consequencesHeader");
  const costRows2 = docs2.filter((d) => d.part === "consequenceCostRows");
  assert.equal(headers2.length, 1);
  assert.equal(costRows2.length, 2);
  assert.deepEqual(costRows2.map((d) => d.index), [0, 1]);
  assert.equal(costRows2[0].text, "Broken leg");
  assert.equal(costRows2[1].text, "_".repeat(CONSEQUENCE_COST_ROW_WIDTH));
  // Minimal geometry (root reference): header at y 290, cost rows at y 330
  // with a 40px pitch, translated by the canvas origin (-150,-200).
  assert.equal(headers2[0].y, 90); // 290 - 200
  assert.deepEqual(costRows2.map((d) => d.y), [130, 170]); // 330, 370 pitch 40
  assert.ok(costRows2.every((d) => d.y >= headers2[0].y + headers2[0].h));
});

/* ------------------------------------------------------------------ *
 * Consequence cost rows (@consequencesHeader / @consequenceCostRows)
 * ------------------------------------------------------------------ */

function costActor(costs = {}, overrides = {}) {
  const base = {
    phys: {
      name: "Physical Stress",
      enabled: true,
      boxes: 2,
      box_values: [false, false],
      aspect: "No",
      harm_can_absorb: 0,
    },
    mild: {
      name: "Mild Consequence",
      enabled: true,
      boxes: 0,
      box_values: [false],
      aspect: { when_marked: true, name: "" },
      harm_can_absorb: 2,
    },
    moderate: {
      name: "Moderate Consequence",
      enabled: true,
      boxes: 0,
      box_values: [false],
      aspect: { when_marked: true, name: "" },
      harm_can_absorb: 4,
    },
    severe: {
      name: "Severe Consequence",
      enabled: true,
      boxes: 0,
      box_values: [false],
      aspect: { when_marked: true, name: "" },
      harm_can_absorb: 6,
    },
  };
  for (const [key, cost] of Object.entries(costs)) {
    if (cost === undefined) delete base[key].harm_can_absorb;
    else base[key].harm_can_absorb = cost;
  }
  base.mild.aspect = {
    ...base.mild.aspect,
    ...(overrides.mildAspect || {}),
  };
  base.moderate.aspect = {
    ...base.moderate.aspect,
    ...(overrides.moderateAspect || {}),
  };
  return makeActor({ ...base, ...(overrides.tracks || {}) });
}

function costRow(price) {
  return String(price ?? "") + "_".repeat(Math.max(0, CONSEQUENCE_COST_ROW_WIDTH - String(price ?? "").length));
}

test("@consequenceCostRows takes each slot cost from harm_can_absorb (custom 3/7/11)", () => {
  const actor = costActor({ mild: 3, moderate: 7, severe: 11 });
  assert.deepEqual(consequenceCostRows(actor), [
    costRow(3),
    costRow(7),
    costRow(11),
  ]);
  // No hardcoded 2/4/6 fallback.
  assert.equal(consequenceCostRows(actor).join(",").includes("2"), false);
  assert.equal(consequenceCostRows(actor).join(",").includes("4"), false);
  assert.equal(consequenceCostRows(actor).join(",").includes("6"), false);
});

test("@consequenceCostRows skips stress tracks and disabled tracks", () => {
  const actor = costActor(
    {},
    {
      tracks: {
        off: {
          name: "Disabled Consequence",
          enabled: false,
          boxes: 0,
          box_values: [false],
          aspect: { when_marked: true, name: "" },
          harm_can_absorb: 2,
        },
        notAspect: {
          name: "Plain",
          enabled: true,
          boxes: 1,
          box_values: [false],
          aspect: "No",
          harm_can_absorb: 2,
        },
      },
    },
  );
  // Only mild/moderate/severe (2/4/6) — the disabled and non-aspect tracks are excluded.
  const rows = consequenceCostRows(actor);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows, [costRow(2), costRow(4), costRow(6)]);
});

test("@consequenceCostRows returns [] and @consequencesHeader returns '' when no aspect slots", () => {
  const noSlots = makeActor({
    phys: { name: "Physical", enabled: true, boxes: 1, box_values: [false], aspect: "No" },
  });
  assert.deepEqual(consequenceCostRows(noSlots), []);
  assert.deepEqual(consequenceCostDescriptors(noSlots), []);
  assert.equal(
    resolveElement({ content: { resolver: "@consequencesHeader", mode: "value" } }, noSlots),
    "",
  );
  assert.deepEqual(
    resolveElement({ content: { resolver: "@consequenceCostRows", mode: "rows" } }, noSlots),
    [],
  );

  // No tracks at all.
  assert.deepEqual(consequenceCostRows(makeActor({})), []);
});

test("empty slot shows cost + underscores; a missing cost shows an empty cost + underscores", () => {
  // Mild has a real cost 2 -> "2" + underscores (no 2/4/6 hardcoding, but the 2 coexists with 3/7 below).
  const actor = costActor({ mild: 2, moderate: 3, severe: 7 });
  assert.deepEqual(consequenceCostRows(actor), [
    costRow(2),
    costRow(3),
    costRow(7),
  ]);

  // A slot with NO harm_can_absorb shows the underscore line with an empty cost.
  const missing = costActor({ mild: 2, moderate: undefined, severe: 7 });
  assert.deepEqual(consequenceCostRows(missing), [
    costRow(2),
    costRow(""),
    costRow(7),
  ]);
  assert.equal(consequenceCostRows(missing)[1], "_".repeat(CONSEQUENCE_COST_ROW_WIDTH));
});

test("occupied slot keeps its cost next to the aspect.name (custom cost preserved)", () => {
  const actor = costActor(
    { mild: 2, moderate: 4, severe: 6 },
    { mildAspect: { name: "Broken leg" } },
  );
  assert.deepEqual(consequenceCostRows(actor), [
    "2 Broken leg",
    costRow(4),
    costRow(6),
  ]);
});

test("filled custom-cost rows: named+cost -> \"<cost> <name>\", named-only -> name, checked-only -> cost", () => {
  const actor = makeActor({
    // occupied by name AND has a cost -> "3 Ankle twist"
    mild: {
      name: "Mild Consequence",
      enabled: true,
      boxes: 0,
      box_values: [false],
      aspect: { when_marked: true, name: "Ankle twist" },
      harm_can_absorb: 3,
    },
    // occupied by name only (no cost) -> just the name
    moderate: {
      name: "Moderate Consequence",
      enabled: true,
      boxes: 0,
      box_values: [false],
      aspect: { when_marked: true, name: "Broken leg" },
    },
    // occupied by the checked box only (no name) -> just the cost
    severe: {
      name: "Severe Consequence",
      enabled: true,
      boxes: 0,
      box_values: [true],
      aspect: { when_marked: true, name: "" },
      harm_can_absorb: 7,
    },
    // free slot -> cost + underscores
    extreme: {
      name: "Extreme Consequence",
      enabled: true,
      boxes: 0,
      box_values: [false],
      aspect: { when_marked: true, name: "" },
      harm_can_absorb: 9,
    },
  });
  assert.deepEqual(consequenceCostRows(actor), [
    "3 Ankle twist",
    "Broken leg",
    "7",
    costRow(9),
  ]);
});

test("occupied slot without a price keeps only the name; checked-but-unnamed without a price is empty", () => {
  // mild: filled with a name but no harm_can_absorb -> just the name
  // moderate: checked box, no name, no cost -> empty (the geometry skips it)
  const actor = makeActor({
    mild: {
      name: "Mild Consequence",
      enabled: true,
      boxes: 0,
      box_values: [false],
      aspect: { when_marked: true, name: "Broken leg" },
    },
    moderate: {
      name: "Moderate Consequence",
      enabled: true,
      boxes: 0,
      box_values: [true],
      aspect: { when_marked: true, name: "" },
    },
  });
  assert.deepEqual(consequenceCostRows(actor), ["Broken leg", ""]);
});

test("consequenceCostTarget maps a flat row index to a track key (stable order)", () => {
  const actor = costActor({ mild: 3, moderate: 7, severe: 11 });
  assert.deepEqual(consequenceCostTarget(actor, 0), { trackKey: "mild", boxIndex: 0 });
  assert.deepEqual(consequenceCostTarget(actor, 1), { trackKey: "moderate", boxIndex: 0 });
  assert.deepEqual(consequenceCostTarget(actor, 2), { trackKey: "severe", boxIndex: 0 });
  assert.equal(consequenceCostTarget(actor, 3), null);
  assert.equal(consequenceCostTarget(actor, -1), null);
  // Stress/disabled tracks do not consume a flat index.
  const withJunk = costActor(
    {},
    {
      tracks: {
        off: { name: "Off", enabled: false, boxes: 0, box_values: [false], aspect: { when_marked: true, name: "" }, harm_can_absorb: 2 },
        plain: { name: "Plain", enabled: true, boxes: 1, box_values: [false], aspect: "No", harm_can_absorb: 2 },
      },
    },
  );
  assert.deepEqual(consequenceCostTarget(withJunk, 0), { trackKey: "mild", boxIndex: 0 });
});

test("consequenceCostDescriptors exposes the same track mapping the double-click handler needs", () => {
  const actor = costActor(
    { mild: 3, moderate: 7, severe: 11 },
    { moderateAspect: { name: "Twisted ankle" } },
  );
  assert.deepEqual(consequenceCostDescriptors(actor), [
    { trackKey: "mild", cost: 3, occupied: false },
    { trackKey: "moderate", cost: 7, occupied: true },
    { trackKey: "severe", cost: 11, occupied: false },
  ]);
  // Stress and disabled tracks are omitted from the descriptor list.
  assert.equal(consequenceCostDescriptors(makeActor({
    phys: { name: "Physical", enabled: true, boxes: 1, box_values: [false], aspect: "No" },
  })).length, 0);
});

test("@consequencesHeader / @consequenceCostRows resolve via the catalog", () => {
  assert.equal(resolverCatalog["@consequencesHeader"].mode, "value");
  assert.equal(resolverCatalog["@consequenceCostRows"].mode, "rows");
  const actor = costActor({ mild: 3, moderate: 7, severe: 11 });

  const header = withGameStub(() =>
    resolveElement({ content: { resolver: "@consequencesHeader", mode: "value" } }, actor),
  );
  // The game stub localizes to the raw key; the real module resolves it via
  // languages/*.json ("Последствия" in ru). The header only appears when the
  // actor has consequence slots.
  assert.equal(header, "fate-on-the-table.header.consequences");

  assert.deepEqual(
    resolveElement({ content: { resolver: "@consequenceCostRows", mode: "rows" } }, actor),
    consequenceCostRows(actor),
  );
});
