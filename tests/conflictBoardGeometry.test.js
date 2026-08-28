/**
 * Node tests for conflictBoardGeometry.js — the pure geometry of the five
 * board areas, card layout, pile/overflow, hit-tests and rect transform.
 * Run with `npm test`; no Foundry dependency.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getConflictBoardGeometry,
  layoutConflictCards,
  transformCardRect,
  hitTestConflictZone,
  hitTestZone,
  pointInRect,
  clampZoneRectToField,
  zoneRectAtAnchor,
  zonePlacementSize,
  normalizeBoardSize,
  resolveBoardSize,
  normalizePreset,
  BOARD_SIZE_PRESETS,
  DEFAULT_CARD_SIZE,
  ZONE_PLACEMENT_SIZE,
  ZONE_PLACEMENT_SIZES,
  DEFAULT_ZONE_PLACEMENT_SIZE,
  BOARD_GAP,
  BOARD_PADDING,
  SIDE_PADDING,
  CARD_GAP,
  PILE_OVERLAP,
  AREA_NAMES,
} from "../scripts/conflictBoardGeometry.js";

test("three presets produce square fields of the configured size", () => {
  assert.deepEqual(resolveBoardSize("small"), { width: 500, height: 500 });
  assert.deepEqual(resolveBoardSize("medium"), { width: 800, height: 800 });
  assert.deepEqual(resolveBoardSize("large"), { width: 1200, height: 1200 });
  assert.deepEqual(BOARD_SIZE_PRESETS, { small: 500, medium: 800, large: 1200 });
});

test("normalizeBoardSize prefers the stored size, falls back to the preset", () => {
  assert.deepEqual(normalizeBoardSize("medium", { width: 900, height: 900 }), {
    width: 900,
    height: 900,
  });
  assert.deepEqual(normalizeBoardSize("large", undefined), { width: 1200, height: 1200 });
  assert.deepEqual(normalizeBoardSize("small", { width: -1, height: 5 }), {
    width: 500,
    height: 500,
  });
  assert.deepEqual(normalizeBoardSize("bogus", undefined), { width: 800, height: 800 });
  assert.equal(normalizePreset("bogus"), "medium");
  assert.equal(normalizePreset("large"), "large");
});

test("geometry contains the five areas; friendly/hostile flank a square field", () => {
  const g = getConflictBoardGeometry({ sizePreset: "medium" });
  for (const name of [...AREA_NAMES, "field"]) assert.ok(g[name], `missing ${name}`);
  assert.equal(g.fieldSize, 800);
  assert.equal(g.field.width, g.field.height);
  assert.ok(g.friendly.x + g.friendly.width < g.field.x);
  assert.equal(g.field.x + g.field.width, g.hostile.x - BOARD_GAP);
  assert.ok(g.field.y + g.field.height < g.bottomFriendly.y);
  assert.equal(g.bottomFriendly.y, g.bottomHostile.y);
  assert.equal(g.bottomFriendly.width + g.bottomHostile.width, g.bounds.width - 2 * BOARD_PADDING);
  // deprecated aliases still point to bottom boxes
  assert.deepEqual(g.acted, g.bottomFriendly);
  assert.deepEqual(g.eliminated, g.bottomHostile);
  assert.deepEqual(g.card, DEFAULT_CARD_SIZE);
});

test("side areas are tall as the field and at least card width + padding", () => {
  const g = getConflictBoardGeometry({ sizePreset: "small" });
  assert.equal(g.friendly.height, g.field.height);
  assert.equal(g.hostile.height, g.field.height);
  assert.equal(g.friendly.width, g.hostile.width);
  assert.ok(g.friendly.width >= g.card.width + 2 * SIDE_PADDING);
  assert.equal(g.friendly.content.width, g.friendly.width - 2 * SIDE_PADDING);
  assert.equal(g.friendly.content.height, g.friendly.height - 2 * SIDE_PADDING);
});

test("bounds wrap all five areas with outer padding", () => {
  const g = getConflictBoardGeometry({ sizePreset: "large" });
  const b = g.bounds;
  assert.equal(b.x, -BOARD_PADDING);
  assert.equal(b.y, -BOARD_PADDING);
  assert.ok(b.x <= g.friendly.x);
  assert.ok(b.y <= g.friendly.y);
  assert.ok(b.x + b.width >= g.hostile.x + g.hostile.width);
  assert.ok(b.y + b.height >= g.bottomHostile.y + g.bottomHostile.height);
  assert.ok(b.x + b.width >= g.field.x + g.field.width);
  // the full board (not just the field) is inside the bounds
  assert.ok(g.hostile.x + g.hostile.width + BOARD_PADDING === b.x + b.width);
});

test("side-area cards stack vertically with a fixed gap", () => {
  const g = getConflictBoardGeometry({ sizePreset: "medium" });
  const state = {
    cards: {
      a: { side: "friendly", area: "side", order: 0 },
      b: { side: "friendly", area: "side", order: 1 },
      c: { side: "hostile", area: "side", order: 0 },
      d: { side: "friendly", area: "side", order: 2 },
    },
  };
  const { positions } = layoutConflictCards(g, state);
  const a = positions.a;
  const b = positions.b;
  const d = positions.d;
  assert.equal(a.x, g.friendly.content.x);
  assert.equal(a.y, g.friendly.content.y);
  assert.equal(b.x, a.x);
  assert.equal(b.y - a.y, g.card.height + CARD_GAP);
  assert.equal(d.y - b.y, g.card.height + CARD_GAP);
  assert.deepEqual({ w: a.width, h: a.height }, { w: g.card.width, h: g.card.height });
  assert.equal(a.area, "side");
  assert.equal(a.side, "friendly");
  const c = positions.c;
  assert.equal(c.area, "side");
  assert.equal(c.x, g.hostile.content.x);
  assert.equal(c.side, "hostile");
  assert.equal(Object.keys(positions).length, 4);
});

test("side cards are ordered by the record order, not insertion", () => {
  const g = getConflictBoardGeometry({ sizePreset: "medium" });
  const state = {
    cards: {
      z: { side: "friendly", area: "side", order: 3 },
      a: { side: "friendly", area: "side", order: 1 },
      m: { side: "friendly", area: "side", order: 2 },
    },
  };
  const { positions } = layoutConflictCards(g, state);
  assert.equal(positions.a.y, g.friendly.content.y);
  assert.ok(positions.a.y < positions.m.y);
  assert.ok(positions.m.y < positions.z.y);
});

test("side overflow spills into bottomFriendly/bottomHostile with same gap", () => {
  const g = getConflictBoardGeometry({ sizePreset: "small" });
  // small preset: friendly content height 476, card 150+10 step => 3 cards fit in column (0,160,320), 4th overflows to bottom
  const state = {
    cards: {
      a: { side: "friendly", order: 0 },
      b: { side: "friendly", order: 1 },
      c: { side: "friendly", order: 2 },
      d: { side: "friendly", order: 3 }, // should go to bottomFriendly
      e: { side: "hostile", order: 0 },
      f: { side: "hostile", order: 1 },
    },
  };
  const { positions, overflow } = layoutConflictCards(g, state);
  // friendly column: a,b,c in side; d in bottom
  assert.equal(positions.a.area, "side");
  assert.equal(positions.b.area, "side");
  assert.equal(positions.c.area, "side");
  assert.equal(positions.d.area, "bottom");
  assert.equal(positions.d.x, g.bottomFriendly.content.x);
  assert.equal(positions.d.side, "friendly");
  // hostile column still in side
  assert.equal(positions.e.area, "side");
  assert.equal(positions.e.x, g.hostile.content.x);
  assert.equal(positions.f.area, "side");
  // no overflow yet (bottom can hold at least 1)
  assert.equal(overflow.length, 0);
  // check steps
  assert.equal(positions.b.y - positions.a.y, g.card.height + CARD_GAP);
  assert.equal(positions.d.y, g.bottomFriendly.content.y); // first in bottom
  // second friendly bottom would stack with CARD_GAP as well
  const state2 = {
    cards: {
      a: { side: "friendly", order: 0 },
      b: { side: "friendly", order: 1 },
      c: { side: "friendly", order: 2 },
      d: { side: "friendly", order: 3 },
      e: { side: "friendly", order: 4 },
    },
  };
  const { positions: p2 } = layoutConflictCards(g, state2);
  assert.equal(p2.e.y - p2.d.y, g.card.height + CARD_GAP);
  assert.equal(p2.e.side, "friendly");
  assert.equal(p2.e.area, "bottom");
});

test("bottom overflow is reported explicitly; cards are never silently clipped", () => {
  const g = getConflictBoardGeometry({ sizePreset: "small" });
  const cards = {};
  // small: friendly column holds 3, bottom holds 1 => 4 total before overflow; 40 will overflow bottom
  for (let i = 0; i < 40; i++) cards[`c${i}`] = { side: "friendly", order: i };
  const { positions, overflow, hasOverflow } = layoutConflictCards(g, { cards });
  assert.equal(Object.keys(positions).length, 40);
  assert.equal(hasOverflow, true);
  assert.ok(overflow.length > 0);
  assert.ok(overflow.every((o) => o.reason === "height" && o.area === "bottom"));
  // the position of the overflowing card is still computed (no clipping)
  const last = positions.c39;
  assert.ok(last.y + last.height > g.bottomFriendly.content.y + g.bottomFriendly.content.height);
  assert.ok(overflow.some((o) => o.combatantId === "c39"));
  // first cards are in side, later in bottom
  assert.equal(positions.c0.area, "side");
  assert.equal(positions.c3.area, "bottom");
  assert.equal(positions.c0.side, "friendly");
});

test("side+bottom overflow is per side — hostile side independent", () => {
  const g = getConflictBoardGeometry({ sizePreset: "small" });
  const cards = {};
  for (let i = 0; i < 10; i++) cards[`f${i}`] = { side: "friendly", order: i };
  for (let i = 0; i < 10; i++) cards[`h${i}`] = { side: "hostile", order: i };
  const { positions, overflow, hasOverflow } = layoutConflictCards(g, { cards });
  assert.equal(hasOverflow, true);
  assert.equal(Object.keys(positions).length, 20);
  assert.ok(overflow.every((o) => o.reason === "height" && o.area === "bottom"));
  assert.ok(overflow.some((o) => o.side === "friendly"));
  assert.ok(overflow.some((o) => o.side === "hostile"));
  // both sides spill to their own bottom boxes
  assert.equal(positions.f3.area, "bottom");
  assert.equal(positions.f3.x, g.bottomFriendly.content.x);
  assert.equal(positions.h3.area, "bottom");
  assert.equal(positions.h3.x, g.bottomHostile.content.x);
});

test("layout groups only by side, ignoring stored area (compat with schema v2)", () => {
  const g = getConflictBoardGeometry({ sizePreset: "medium" });
  const state = {
    cards: {
      a: { side: "friendly", area: "acted", order: 0 }, // old acted area should be ignored
      b: { side: "hostile", area: "eliminated", order: 0 },
      c: { side: "friendly", area: "side", order: 1 },
    },
  };
  const { positions } = layoutConflictCards(g, state);
  // a and c both friendly side — they stay in friendly column ordered by order
  assert.equal(positions.a.area, "side");
  assert.equal(positions.c.area, "side");
  assert.ok(positions.a.y < positions.c.y);
  assert.equal(positions.b.area, "side");
  assert.equal(positions.b.x, g.hostile.content.x);
});

test("side overflow is reported when the area height is exhausted", () => {
  const g = getConflictBoardGeometry({ sizePreset: "small" });
  const cards = {};
  for (let i = 0; i < 10; i++) cards[`s${i}`] = { side: "friendly", order: i };
  const { positions, overflow, hasOverflow } = layoutConflictCards(g, { cards });
  assert.equal(hasOverflow, true);
  assert.equal(Object.keys(positions).length, 10);
  assert.ok(overflow.every((o) => o.reason === "height"));
});

test("hitTestZone returns the first matching zone or null", () => {
  const zones = [
    { id: "z1", rect: { x: 0, y: 0, width: 10, height: 10 } },
    { id: "z2", rect: { x: 5, y: 5, width: 20, height: 20 } },
  ];
  assert.equal(hitTestZone(zones, { x: 3, y: 3 }).id, "z1");
  assert.equal(hitTestZone(zones, { x: 12, y: 12 }).id, "z2");
  assert.equal(hitTestZone(zones, { x: 100, y: 100 }), null);
  assert.equal(hitTestZone([], { x: 0, y: 0 }), null);
});

test("hitTestConflictZone distinguishes zones, field, areas and misses", () => {
  const g = getConflictBoardGeometry({ sizePreset: "medium" });
  const zones = [
    { id: "z1", rect: { x: g.field.x + 10, y: g.field.y + 10, width: 50, height: 50 } },
  ];

  const zoneHit = hitTestConflictZone(g, zones, { x: g.field.x + 20, y: g.field.y + 20 });
  assert.equal(zoneHit.type, "zone");
  assert.equal(zoneHit.zoneId, "z1");
  assert.equal(zoneHit.area, "central");
  assert.deepEqual(zoneHit.zone, zones[0]);

  const fieldHit = hitTestConflictZone(g, zones, { x: g.field.x + 200, y: g.field.y + 200 });
  assert.equal(fieldHit.type, "field");
  assert.equal(fieldHit.area, "central");

  const friendlyHit = hitTestConflictZone(g, zones, { x: g.friendly.x + 5, y: g.friendly.y + 5 });
  assert.equal(friendlyHit.type, "area");
  assert.equal(friendlyHit.area, "friendly");

  const bottomFriendlyHit = hitTestConflictZone(g, zones, { x: g.bottomFriendly.x + 5, y: g.bottomFriendly.y + 5 });
  assert.equal(bottomFriendlyHit.type, "area");
  assert.equal(bottomFriendlyHit.area, "bottomFriendly");

  const bottomHostileHit = hitTestConflictZone(g, zones, { x: g.bottomHostile.x + 5, y: g.bottomHostile.y + 5 });
  assert.equal(bottomHostileHit.type, "area");
  assert.equal(bottomHostileHit.area, "bottomHostile");

  const miss = hitTestConflictZone(g, zones, {
    x: g.bounds.x + g.bounds.width + 50,
    y: 0,
  });
  assert.equal(miss.type, null);
  assert.equal(miss.zoneId, null);

  const noPoint = hitTestConflictZone(g, zones, null);
  assert.equal(noPoint.type, null);
});

test("transformCardRect fits a minimal layout rect into a slot preserving aspect", () => {
  const layoutRect = { x: 0, y: 0, width: 659, height: 445 };
  const slot = { x: 100, y: 200, width: 220, height: 150 };
  const t = transformCardRect(layoutRect, slot);
  assert.equal(t.scale, 220 / 659); // width-limited fit (min of the two ratios)
  assert.equal(t.height, 445 * (220 / 659));
  assert.ok(Math.abs(t.x + t.width / 2 - (slot.x + slot.width / 2)) < 1e-9);
  assert.ok(Math.abs(t.y + t.height / 2 - (slot.y + slot.height / 2)) < 1e-9);
  assert.ok(t.dx !== undefined && t.dy !== undefined);
});

test("transformCardRect mapping is usable for arbitrary layout sub-rects", () => {
  const layoutRect = { x: 0, y: 0, width: 659, height: 445 };
  const slot = { x: 0, y: 0, width: 220, height: 150 };
  const t = transformCardRect(layoutRect, slot);
  const sub = { x: 10, y: 20, width: 100, height: 50 };
  const mapped = {
    x: sub.x * t.scale + t.dx,
    y: sub.y * t.scale + t.dy,
    width: sub.width * t.scale,
    height: sub.height * t.scale,
  };
  assert.ok(mapped.width > 0 && mapped.height > 0);
});

test("transformCardRect honours an explicit scale override", () => {
  const t = transformCardRect({ x: 0, y: 0, width: 100, height: 100 }, { x: 0, y: 0, width: 200, height: 300 }, { scale: 2 });
  assert.equal(t.scale, 2);
  assert.deepEqual({ w: t.width, h: t.height }, { w: 200, h: 200 });
});

test("pointInRect uses inclusive bounds", () => {
  const rect = { x: 0, y: 0, width: 10, height: 10 };
  assert.equal(pointInRect(rect, { x: 0, y: 0 }), true);
  assert.equal(pointInRect(rect, { x: 10, y: 10 }), true);
  assert.equal(pointInRect(rect, { x: 11, y: 0 }), false);
  assert.equal(pointInRect(rect, { x: 5, y: 5 }), true);
  assert.equal(pointInRect(rect, null), false);
  assert.equal(pointInRect(null, { x: 0, y: 0 }), false);
});

test("zone placement sizes are rectangular, preset-dependent and immutable", () => {
  // medium is exactly the requested 150×120 (larger area, not a square)
  assert.deepEqual(ZONE_PLACEMENT_SIZES.medium, { width: 150, height: 120 });
  assert.ok(ZONE_PLACEMENT_SIZES.medium.width > ZONE_PLACEMENT_SIZES.medium.height);
  // small is smaller, large is noticeably bigger, both keep the aspect ratio
  assert.deepEqual(ZONE_PLACEMENT_SIZES.small, { width: 120, height: 96 });
  assert.deepEqual(ZONE_PLACEMENT_SIZES.large, { width: 225, height: 180 });
  assert.ok(ZONE_PLACEMENT_SIZES.large.width > ZONE_PLACEMENT_SIZES.medium.width * 1.4);
  assert.ok(ZONE_PLACEMENT_SIZES.small.width < ZONE_PLACEMENT_SIZES.medium.width);
  assert.equal(ZONE_PLACEMENT_SIZES.small.width / ZONE_PLACEMENT_SIZES.small.height, 1.25);
  // the frozen config cannot be mutated
  assert.throws(() => {
    ZONE_PLACEMENT_SIZES.medium.width = 999;
  }, TypeError);
  // legacy constant is kept for backward compatibility only
  assert.equal(ZONE_PLACEMENT_SIZE, 120);
});

test("zonePlacementSize returns the preset rect; unknown presets fall back to medium", () => {
  const field = { x: 0, y: 0, width: 800, height: 800 };
  assert.deepEqual(zonePlacementSize("small", field), { width: 120, height: 96 });
  assert.deepEqual(zonePlacementSize("medium", field), { width: 150, height: 120 });
  assert.deepEqual(zonePlacementSize("large", field), { width: 225, height: 180 });
  assert.deepEqual(zonePlacementSize("bogus", field), { width: 150, height: 120 });
  assert.deepEqual(zonePlacementSize(undefined, field), { width: 150, height: 120 });
  // without a field the preset sizes are returned unchanged
  assert.deepEqual(zonePlacementSize("medium"), { width: 150, height: 120 });
});

test("zonePlacementSize clamps each dimension independently to the field", () => {
  // wider than tall: the width is clamped, the height is not
  const wide = { x: 0, y: 0, width: 100, height: 500 };
  assert.deepEqual(zonePlacementSize("medium", wide), { width: 100, height: 120 });
  // tall field: the height is clamped, the width is not
  const tall = { x: 0, y: 0, width: 500, height: 100 };
  assert.deepEqual(zonePlacementSize("medium", tall), { width: 150, height: 100 });
  // field smaller than the preset in both dimensions: fill it
  const tiny = { x: 0, y: 0, width: 40, height: 30 };
  assert.deepEqual(zonePlacementSize("large", tiny), { width: 40, height: 30 });
});

test("clampZoneRectToField keeps a fully-inside rect unchanged", () => {
  const field = { x: 100, y: 50, width: 200, height: 150 };
  const inside = { x: 120, y: 60, width: 80, height: 40 };
  assert.deepEqual(clampZoneRectToField(inside, field), inside);
  // input is never mutated
  assert.deepEqual(inside, { x: 120, y: 60, width: 80, height: 40 });
});

test("clampZoneRectToField clamps the position at every edge", () => {
  const field = { x: 100, y: 50, width: 200, height: 150 };
  const size = { width: 80, height: 40 };
  // left edge
  assert.deepEqual(clampZoneRectToField({ x: 0, y: 60, ...size }, field), {
    x: 100,
    y: 60,
    width: 80,
    height: 40,
  });
  // top edge
  assert.deepEqual(clampZoneRectToField({ x: 120, y: -5, ...size }, field), {
    x: 120,
    y: 50,
    width: 80,
    height: 40,
  });
  // right edge: field.x + field.width - width = 220
  assert.deepEqual(clampZoneRectToField({ x: 300, y: 60, ...size }, field), {
    x: 220,
    y: 60,
    width: 80,
    height: 40,
  });
  // bottom edge: field.y + field.height - height = 160
  assert.deepEqual(clampZoneRectToField({ x: 120, y: 200, ...size }, field), {
    x: 120,
    y: 160,
    width: 80,
    height: 40,
  });
});

test("clampZoneRectToField shrinks a rect larger than the field to fill it", () => {
  const field = { x: 0, y: 0, width: 100, height: 60 };
  assert.deepEqual(
    clampZoneRectToField({ x: -10, y: -10, width: 300, height: 200 }, field),
    { x: 0, y: 0, width: 100, height: 60 },
  );
  // wider only
  assert.deepEqual(
    clampZoneRectToField({ x: 40, y: 5, width: 300, height: 20 }, field),
    { x: 0, y: 5, width: 100, height: 20 },
  );
});

test("zoneRectAtAnchor centers the rectangular rect on the anchor inside the field", () => {
  const field = { x: 100, y: 50, width: 200, height: 150 };
  const size = { width: 150, height: 120 };
  // centered rect {x:105,y:40} hits the top edge and is clamped to y:50
  const r = zoneRectAtAnchor(field, { x: 180, y: 100 }, size);
  assert.deepEqual(r, { x: 105, y: 50, width: 150, height: 120 });
  // centered rect near the right/bottom edges clamps accordingly
  const rb = zoneRectAtAnchor(field, { x: 260, y: 180 }, size);
  assert.deepEqual(rb, { x: 150, y: 80, width: 150, height: 120 });
  // the rect is rectangular (width !== height)
  assert.ok(r.width > r.height);
  // input field is never mutated
  assert.deepEqual(field, { x: 100, y: 50, width: 200, height: 150 });
});

test("zoneRectAtAnchor uses the medium 150×120 rect by default and keeps numeric compat", () => {
  const field = { x: 0, y: 0, width: 800, height: 800 };
  // default = DEFAULT_ZONE_PLACEMENT_SIZE (medium 150×120)
  assert.deepEqual(zoneRectAtAnchor(field, { x: 500, y: 400 }), {
    x: 425,
    y: 340,
    width: 150,
    height: 120,
  });
  // legacy numeric argument is still accepted as a square side
  assert.deepEqual(zoneRectAtAnchor(field, { x: 500, y: 400 }, 120), {
    x: 440,
    y: 340,
    width: 120,
    height: 120,
  });
});

test("zoneRectAtAnchor shrinks each dimension when the field is smaller than the zone", () => {
  const field = { x: 0, y: 0, width: 80, height: 60 };
  assert.deepEqual(zoneRectAtAnchor(field, { x: 40, y: 30 }, { width: 150, height: 120 }), {
    x: 0,
    y: 0,
    width: 80,
    height: 60,
  });
  // a field that is smaller only vertically keeps the full width
  const narrow = { x: 0, y: 0, width: 400, height: 60 };
  assert.deepEqual(zoneRectAtAnchor(narrow, { x: 200, y: 30 }, { width: 150, height: 120 }), {
    x: 125,
    y: 0,
    width: 150,
    height: 60,
  });
});

test("clampZoneRectToField preserves rectangular proportions (independent clamp)", () => {
  const field = { x: 0, y: 0, width: 200, height: 100 };
  // only the width is shrunk, the height keeps its smaller size
  assert.deepEqual(
    clampZoneRectToField({ x: 10, y: 5, width: 300, height: 60 }, field),
    { x: 0, y: 5, width: 200, height: 60 },
  );
  // only the height is shrunk
  assert.deepEqual(
    clampZoneRectToField({ x: 10, y: 5, width: 100, height: 200 }, field),
    { x: 10, y: 0, width: 100, height: 100 },
  );
});

test("zoneRectAtAnchor + zonePlacementSize stay consistent (preview = committed rect)", () => {
  const g = getConflictBoardGeometry({ sizePreset: "medium" });
  const field = g.field;
  const anchor = {
    x: field.x + field.width / 2,
    y: field.y + field.height / 2,
  };
  for (const preset of ["small", "medium", "large"]) {
    const size = zonePlacementSize(preset, field);
    const rect = zoneRectAtAnchor(field, anchor, size);
    // the committed rect always matches the placement preview size
    assert.deepEqual(
      { width: rect.width, height: rect.height },
      size,
      `preset ${preset}: preview and committed rect must agree`,
    );
    // and is centered on the anchor
    assert.equal(rect.x + rect.width / 2, anchor.x);
    assert.equal(rect.y + rect.height / 2, anchor.y);
  }
});

test("layoutConflictCards handles an empty board", () => {
  const g = getConflictBoardGeometry({ sizePreset: "small" });
  const { positions, overflow, hasOverflow } = layoutConflictCards(g, {});
  assert.deepEqual(positions, {});
  assert.deepEqual(overflow, []);
  assert.equal(hasOverflow, false);
});

test("custom card size and area minimums are honoured", () => {
  const g = getConflictBoardGeometry({
    sizePreset: "small",
    cardWidth: 300,
    cardHeight: 200,
    minSideWidth: 400,
    minBottomHeight: 260,
  });
  assert.deepEqual(g.card, { width: 300, height: 200 });
  assert.ok(g.friendly.width >= 400);
  assert.ok(g.acted.height >= 260);
  const { positions } = layoutConflictCards(g, {
    cards: { a: { side: "friendly", area: "side", order: 0 } },
  });
  assert.deepEqual({ w: positions.a.width, h: positions.a.height }, { w: 300, h: 200 });
});
