/**
 * Node tests for the WidgetBuilder resolver catalog (pure data normalizers).
 * Importing WidgetBuilder is safe in Node: the module only touches `game`
 * inside resolver callbacks, never at top level.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  stressTrackRows,
  stressTrackNames,
  stressTrackBoxes,
  stressTrackBoxRows,
  resolveElement,
} from "../scripts/WidgetBuilder.js";

function makeActor(tracks) {
  return { system: { tracks } };
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
