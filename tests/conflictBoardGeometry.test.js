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
  assert.ok(g.roundBox, "roundBox reserved in bottom strip");
  assert.equal(
    g.bottomFriendly.width + g.roundBox.width + g.bottomHostile.width,
    g.bounds.width - 2 * BOARD_PADDING,
  );
  assert.equal(g.bottomFriendly.width, g.bottomHostile.width);
  assert.equal(g.roundBox.y, g.bottomFriendly.y);
  assert.equal(g.roundBox.height, g.bottomFriendly.height);
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

test("side overflow spills into bottomFriendly/bottomHostile horizontally", () => {
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
  assert.equal(positions.d.y, g.bottomFriendly.content.y);
  assert.equal(positions.d.side, "friendly");
  // hostile column still in side
  assert.equal(positions.e.area, "side");
  assert.equal(positions.e.x, g.hostile.content.x);
  assert.equal(positions.f.area, "side");
  // no overflow yet (bottom horizontal row: pile tail keeps within)
  assert.equal(overflow.length, 0);
  // check steps: side vertical, bottom horizontal
  assert.equal(positions.b.y - positions.a.y, g.card.height + CARD_GAP);
  assert.equal(positions.d.y, g.bottomFriendly.content.y); // first in bottom is at top of box
  // second friendly bottom would be placed horizontally next to first (if fits) or pile on last slot
  const state2 = {
    cards: {
      a: { side: "friendly", order: 0 },
      b: { side: "friendly", order: 1 },
      c: { side: "friendly", order: 2 },
      d: { side: "friendly", order: 3 },
      e: { side: "friendly", order: 4 },
    },
  };
  const { positions: p2, overflow: o2 } = layoutConflictCards(g, state2);
  assert.equal(p2.e.side, "friendly");
  assert.equal(p2.e.area, "bottom");
  // horizontal: y equal, x increases (or piles with overlap if width exhausted)
  assert.equal(p2.e.y, g.bottomFriendly.content.y);
  assert.equal(p2.d.y, g.bottomFriendly.content.y);
  // small bottom width 434 holds only 1 card at step 230, so 2 bottom cards pile with overlap
  assert.ok(p2.e.x >= p2.d.x, "second bottom card not before first");
  assert.ok(p2.e.x + g.card.width <= g.bottomFriendly.content.x + g.bottomFriendly.content.width + 1e-6, "within bottom width");
  assert.equal(o2.length, 0, "pile tail not reported as overflow");
});

test("bottom horizontal pile keeps all cards within bounds (no overflow beyond board)", () => {
  const g = getConflictBoardGeometry({ sizePreset: "small" });
  const cards = {};
  // small: friendly column holds 3, bottom capacity 1 => 4+ total overflow to bottom pile; 40 cards must pile without exceeding bounds
  for (let i = 0; i < 40; i++) cards[`c${i}`] = { side: "friendly", order: i };
  const { positions, overflow, hasOverflow } = layoutConflictCards(g, { cards });
  assert.equal(Object.keys(positions).length, 40);
  // horizontal pile keeps all cards visible inside bottomContent — no overflow reported
  assert.equal(hasOverflow, false);
  assert.equal(overflow.length, 0);
  // every bottom card stays within bottomFriendly content rect by X and Y
  for (let i = 3; i < 40; i++) {
    const pos = positions[`c${i}`];
    assert.equal(pos.area, "bottom");
    assert.equal(pos.y, g.bottomFriendly.content.y, `c${i} y at top of box`);
    assert.ok(pos.x >= g.bottomFriendly.content.x - 1e-6, `c${i} left within`);
    assert.ok(pos.x + pos.width <= g.bottomFriendly.content.x + g.bottomFriendly.content.width + 1e-6, `c${i} right within ${pos.x + pos.width}`);
    assert.ok(pos.y + pos.height <= g.bottomFriendly.content.y + g.bottomFriendly.content.height + 1e-6, `c${i} bottom within`);
  }
  // still computed positions for all, first cards in side, later in bottom
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
  assert.equal(hasOverflow, false, "horizontal pile not considered overflow");
  assert.equal(Object.keys(positions).length, 20);
  assert.equal(overflow.length, 0);
  // both sides spill to their own bottom boxes
  assert.equal(positions.f3.area, "bottom");
  assert.equal(positions.f3.x, g.bottomFriendly.content.x);
  assert.equal(positions.h3.area, "bottom");
  assert.equal(positions.h3.x, g.bottomHostile.content.x);
  // y equal (horizontal row)
  assert.equal(positions.f3.y, g.bottomFriendly.content.y);
  assert.equal(positions.h3.y, g.bottomHostile.content.y);
  // friendly not in bottomHostile and vice versa
  assert.ok(positions.f3.x + g.card.width <= g.bottomFriendly.content.x + g.bottomFriendly.content.width + 1e-6);
  assert.ok(positions.h3.x + g.card.width <= g.bottomHostile.content.x + g.bottomHostile.content.width + 1e-6);
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

test("side overflow is not an error — bottom pile keeps within bounds", () => {
  const g = getConflictBoardGeometry({ sizePreset: "small" });
  const cards = {};
  for (let i = 0; i < 10; i++) cards[`s${i}`] = { side: "friendly", order: i };
  const { positions, overflow, hasOverflow } = layoutConflictCards(g, { cards });
  assert.equal(hasOverflow, false, "horizontal bottom pile not overflow");
  assert.equal(Object.keys(positions).length, 10);
  assert.equal(overflow.length, 0);
  // all bottom cards stay within
  for (let i = 3; i < 10; i++) {
    const pos = positions[`s${i}`];
    assert.equal(pos.area, "bottom");
    assert.ok(pos.x + pos.width <= g.bottomFriendly.content.x + g.bottomFriendly.content.width + 1e-6);
    assert.equal(pos.y, g.bottomFriendly.content.y);
  }
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

test("roundBox is reserved per preset and does not intersect bottom boxes", () => {
  const expected = { small: 96, medium: 112, large: 128 };
  for (const preset of ["small", "medium", "large"]) {
    const g = getConflictBoardGeometry({ sizePreset: preset });
    assert.equal(g.roundBox.width, expected[preset], `roundBox width for ${preset}`);
    assert.equal(g.roundBox.height, g.bottomFriendly.height);
    assert.equal(g.roundBox.y, g.bottomFriendly.y);
    assert.equal(g.bottomFriendly.x + g.bottomFriendly.width, g.roundBox.x);
    assert.equal(g.roundBox.x + g.roundBox.width, g.bottomHostile.x);
    // no intersection
    const intersect = (a, b) =>
      !(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y);
    assert.equal(intersect(g.bottomFriendly, g.roundBox), false, `${preset} bottomFriendly vs roundBox`);
    assert.equal(intersect(g.bottomHostile, g.roundBox), false, `${preset} bottomHostile vs roundBox`);
    // bottom boxes keep enough width for a standard card
    assert.ok(
      g.bottomFriendly.content.width >= DEFAULT_CARD_SIZE.width,
      `${preset} bottomFriendly fits card width ${g.bottomFriendly.content.width}`,
    );
    assert.ok(
      g.bottomHostile.content.width >= DEFAULT_CARD_SIZE.width,
      `${preset} bottomHostile fits card width ${g.bottomHostile.content.width}`,
    );
  }
});

test("bottom cards never overlap roundBox (layout positions)", () => {
  for (const preset of ["small", "medium", "large"]) {
    const g = getConflictBoardGeometry({ sizePreset: preset });
    // force overflow into bottom boxes with 6 cards per side
    const cards = {};
    for (let i = 0; i < 6; i++) cards[`f${i}`] = { side: "friendly", order: i };
    for (let i = 0; i < 6; i++) cards[`h${i}`] = { side: "hostile", order: i };
    const { positions } = layoutConflictCards(g, { cards });
    const roundBox = g.roundBox;
    for (const [id, pos] of Object.entries(positions)) {
      if (pos.area !== "bottom") continue;
      const cardRect = { x: pos.x, y: pos.y, width: pos.width, height: pos.height };
      const intersect =
        !(cardRect.x + cardRect.width <= roundBox.x ||
          roundBox.x + roundBox.width <= cardRect.x ||
          cardRect.y + cardRect.height <= roundBox.y ||
          roundBox.y + roundBox.height <= cardRect.y);
      assert.equal(intersect, false, `${preset} card ${id} must not intersect roundBox`);
      // also inside its bottom area
      const bottomArea = pos.side === "friendly" ? g.bottomFriendly : g.bottomHostile;
      assert.ok(
        pos.x >= bottomArea.content.x - 1e-6 && pos.x + pos.width <= bottomArea.x + bottomArea.width + 1e-6,
        `${preset} card ${id} inside its bottom box`,
      );
    }
  }
});

test("column capacity is exact per preset (no off-by-one): small 3, medium 4, large 7", () => {
  const expectations = { small: 3, medium: 4, large: 7 };
  for (const [preset, expected] of Object.entries(expectations)) {
    const g = getConflictBoardGeometry({ sizePreset: preset });
    // build exactly expected cards in side: they must all stay in column
    const cardsExact = {};
    for (let i = 0; i < expected; i++) cardsExact[`c${i}`] = { side: "friendly", order: i };
    const { positions: pExact } = layoutConflictCards(g, { cards: cardsExact });
    for (let i = 0; i < expected; i++) assert.equal(pExact[`c${i}`].area, "side", `${preset} card ${i} stays in side`);
    // one more must spill to bottom
    const cardsPlus = { ...cardsExact, [`c${expected}`]: { side: "friendly", order: expected } };
    const { positions: pPlus } = layoutConflictCards(g, { cards: cardsPlus });
    assert.equal(pPlus[`c${expected}`].area, "bottom", `${preset} card ${expected} spills to bottom`);
    // verify inclusive fitsSide: last side card's bottom edge <= content bottom
    const lastSide = pExact[`c${expected - 1}`];
    assert.ok(lastSide.y + g.card.height <= g.friendly.content.y + g.friendly.content.height + 1e-6, `${preset} last side fits inclusive`);
    // remaining gap < cardHeight confirms no off-by-one
    const remaining = g.friendly.content.y + g.friendly.content.height - (lastSide.y + g.card.height);
    assert.ok(remaining < g.card.height && remaining >= 0, `${preset} remaining gap ${remaining} < cardHeight`);
    // card N-1 not switched early: if we request N=expected, none spilled prematurely
    assert.equal(Object.values(pExact).filter((p) => p.area === "bottom").length, 0, `${preset} no early spill`);
  }
});

test("bottom boxes lay cards horizontally with fixed step (y equal, x += cardW+GAP)", () => {
  // medium bottom capacity 2 → 2 cards fit without overlap; large capacity 3 → 3 cards fit
  for (const preset of ["medium", "large"]) {
    const g = getConflictBoardGeometry({ sizePreset: preset });
    const capacity = preset === "medium" ? 2 : 3;
    const sideCap = preset === "medium" ? 4 : 7;
    // fill side fully then add capacity cards to bottom
    const cards = {};
    for (let i = 0; i < sideCap; i++) cards[`s${i}`] = { side: "friendly", order: i };
    for (let i = 0; i < capacity; i++) cards[`b${i}`] = { side: "friendly", order: sideCap + i };
    const { positions } = layoutConflictCards(g, { cards });
    const bottoms = Array.from({ length: capacity }, (_, i) => positions[`b${i}`]);
    // all bottom: same y, x step = cardW+GAP
    for (const b of bottoms) assert.equal(b.y, g.bottomFriendly.content.y, `${preset} bottom y at top`);
    for (let i = 1; i < bottoms.length; i++) {
      assert.equal(bottoms[i].x - bottoms[i - 1].x, g.card.width + CARD_GAP, `${preset} bottom x step ${i}`);
      assert.equal(bottoms[i].y, bottoms[0].y, `${preset} bottom y equal`);
    }
    // also hostile side independent: friendly bottom cards stay in bottomFriendly
    for (const b of bottoms) assert.ok(b.x + b.width <= g.bottomFriendly.content.x + g.bottomFriendly.content.width + 1e-6);
  }
  // small: capacity 1 → single bottom card at content.x
  const gSmall = getConflictBoardGeometry({ sizePreset: "small" });
  const cardsSmall = {};
  for (let i = 0; i < 3; i++) cardsSmall[`s${i}`] = { side: "friendly", order: i };
  cardsSmall.b0 = { side: "friendly", order: 3 };
  const { positions: pS } = layoutConflictCards(gSmall, { cards: cardsSmall });
  assert.equal(pS.b0.x, gSmall.bottomFriendly.content.x);
  assert.equal(pS.b0.y, gSmall.bottomFriendly.content.y);
});

test("overflow beyond bottom width piles with overlap and stays within bottom content rect", () => {
  for (const preset of ["small", "medium", "large"]) {
    const g = getConflictBoardGeometry({ sizePreset: preset });
    const sideCap = preset === "small" ? 3 : preset === "medium" ? 4 : 7;
    const capacity = preset === "small" ? 1 : preset === "medium" ? 2 : 3;
    // create more bottom cards than capacity to trigger pile tail
    const extra = 6;
    const nBottom = capacity + extra;
    const cards = {};
    for (let i = 0; i < sideCap; i++) cards[`s${i}`] = { side: "friendly", order: i };
    for (let i = 0; i < nBottom; i++) cards[`b${i}`] = { side: "friendly", order: sideCap + i };
    const { positions, overflow } = layoutConflictCards(g, { cards });
    assert.equal(overflow.length, 0, `${preset} pile not reported as overflow`);
    const bottoms = Array.from({ length: nBottom }, (_, i) => positions[`b${i}`]);
    // all within bottom content rect by X and Y
    for (let i = 0; i < nBottom; i++) {
      const pos = bottoms[i];
      assert.equal(pos.area, "bottom", `${preset} b${i} bottom`);
      assert.equal(pos.y, g.bottomFriendly.content.y, `${preset} b${i} y`);
      assert.ok(pos.x >= g.bottomFriendly.content.x - 1e-6, `${preset} b${i} left`);
      assert.ok(pos.x + pos.width <= g.bottomFriendly.content.x + g.bottomFriendly.content.width + 1e-6, `${preset} b${i} right within ${pos.x + pos.width} <= ${g.bottomFriendly.content.x + g.bottomFriendly.content.width}`);
      assert.ok(pos.y + pos.height <= g.bottomFriendly.content.y + g.bottomFriendly.content.height + 1e-6, `${preset} b${i} bottom within`);
    }
    // monotonic x non-decreasing
    for (let i = 1; i < nBottom; i++) assert.ok(bottoms[i].x >= bottoms[i - 1].x - 1e-6, `${preset} monotonic ${i}`);
    // beyond capacity, step is compressed (overlap): tail step <= CARD_GAP+cardW and <= PILE_OVERLAP unless shrunk further
    if (nBottom > capacity) {
      const lastNormalIdx = capacity - 1;
      const tailStep = bottoms[lastNormalIdx + 1].x - bottoms[lastNormalIdx].x;
      assert.ok(tailStep <= PILE_OVERLAP + 1e-6 || tailStep < g.card.width + CARD_GAP, `${preset} tail overlaps (step ${tailStep} <= ${PILE_OVERLAP} or < normal)`);
      assert.ok(tailStep >= 0, `${preset} pile step non-negative`);
    }
  }
});

test("friendly and hostile bottom piles are independent (no cross-area leakage)", () => {
  for (const preset of ["small", "medium", "large"]) {
    const g = getConflictBoardGeometry({ sizePreset: preset });
    const sideCap = preset === "small" ? 3 : preset === "medium" ? 4 : 7;
    const cards = {};
    for (let i = 0; i < sideCap + 5; i++) cards[`f${i}`] = { side: "friendly", order: i };
    for (let i = 0; i < sideCap + 5; i++) cards[`h${i}`] = { side: "hostile", order: i };
    const { positions } = layoutConflictCards(g, { cards });
    for (let i = sideCap; i < sideCap + 5; i++) {
      const pf = positions[`f${i}`];
      const ph = positions[`h${i}`];
      assert.equal(pf.side, "friendly");
      assert.equal(ph.side, "hostile");
      assert.equal(pf.area, "bottom");
      assert.equal(ph.area, "bottom");
      // friendly bottom inside bottomFriendly content, hostile inside bottomHostile content
      assert.ok(pf.x >= g.bottomFriendly.content.x - 1e-6 && pf.x + pf.width <= g.bottomFriendly.content.x + g.bottomFriendly.content.width + 1e-6, `${preset} friendly ${i} in its box`);
      assert.ok(ph.x >= g.bottomHostile.content.x - 1e-6 && ph.x + ph.width <= g.bottomHostile.content.x + g.bottomHostile.content.width + 1e-6, `${preset} hostile ${i} in its box`);
      // no cross leakage: friendly not inside hostile box
      assert.ok(pf.x + pf.width <= g.roundBox.x + 1e-6 || pf.x >= g.bottomFriendly.content.x, `${preset} friendly not leaking`);
    }
  }
});

test("hitTestConflictZone distinguishes bottomFriendly, bottomHostile and roundBox", () => {
  const g = getConflictBoardGeometry({ sizePreset: "medium" });
  const bf = hitTestConflictZone(g, [], { x: g.bottomFriendly.x + 5, y: g.bottomFriendly.y + 5 });
  assert.equal(bf.type, "area");
  assert.equal(bf.area, "bottomFriendly");
  const bh = hitTestConflictZone(g, [], { x: g.bottomHostile.x + 5, y: g.bottomHostile.y + 5 });
  assert.equal(bh.type, "area");
  assert.equal(bh.area, "bottomHostile");
  const rb = hitTestConflictZone(g, [], {
    x: g.roundBox.x + g.roundBox.width / 2,
    y: g.roundBox.y + g.roundBox.height / 2,
  });
  assert.equal(rb.type, "area");
  assert.equal(rb.area, "roundBox");
});
