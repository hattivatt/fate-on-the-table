/**
 * conflictBoardGeometry — pure geometry engine for the conflict board
 * (feature 5). Produces the rects of the five board areas, lays cards out
 * deterministically, transforms a minimal-layout rect into board coordinates
 * and provides hit-tests for future interactions.
 *
 * This module must stay free of any Foundry runtime dependency (no `game`,
 * `canvas`, `CONFIG`): it is covered by the Node test suite.
 *
 * All coordinates are BOARD-LOCAL: the runtime adds `board.origin` to place
 * the board on the scene. The top-left of the friendly area is the local
 * origin `(0, 0)`; `bounds` extends beyond it by the outer padding.
 *
 * Board layout:
 *
 * ```text
 * ┌────────────┬──────────────────────┬────────────┐
 * │ friendly   │       field          │ hostile    │
 * ├────────────┴──────────┬───────────┴────────────┤
 * │   bottomFriendly      │   bottomHostile        │
 * └───────────────────────┴────────────────────────┘
 * ```
 */

/** Central field size per preset (square side in scene units). */
export const BOARD_SIZE_PRESETS = Object.freeze({
  small: 500,
  medium: 800,
  large: 1200,
});
export const DEFAULT_SIZE_PRESET = "medium";

/** Width of the central round box in the bottom strip per preset (scene units).
 *  ~1.2–2× the round-number font size (48/56/64), rounded to a pleasant number
 *  so a 1–2 digit round fits comfortably. Height is always `bottomH` so the box
 *  spans the full bottom strip vertically.
 */
export const ROUND_BOX_WIDTHS = Object.freeze({
  small: 96,
  medium: 112,
  large: 128,
});
export const DEFAULT_ROUND_BOX_WIDTH = ROUND_BOX_WIDTHS.medium;

/** Size of a participant card (minimal layout proportions), scene units. */
export const DEFAULT_CARD_SIZE = Object.freeze({ width: 220, height: 150 });

/**
 * Legacy fixed side (scene units) of the "Add zone" click-placement.
 * DEPRECATED: the Add-zone flow now uses the preset-dependent rectangular
 * `ZONE_PLACEMENT_SIZES` via `zonePlacementSize`. Kept for backward
 * compatibility with older callers and tests.
 */
export const ZONE_PLACEMENT_SIZE = 120;

/**
 * Zone placement rect per board preset (`width × height`, scene units). The
 * "Add zone" click-placement uses `zonePlacementSize(preset, field)`, so the
 * zone is a rectangle whose size depends on the board preset: medium is
 * 150×120 (larger than the legacy 120×120 square AND not square), small is
 * smaller, large is noticeably bigger. Frozen canonical config — never
 * mutated at runtime.
 */
export const ZONE_PLACEMENT_SIZES = Object.freeze({
  small: Object.freeze({ width: 120, height: 96 }),
  medium: Object.freeze({ width: 150, height: 120 }),
  large: Object.freeze({ width: 225, height: 180 }),
});
/** Fallback used for an unknown preset and as `zoneRectAtAnchor` default. */
export const DEFAULT_ZONE_PLACEMENT_SIZE = ZONE_PLACEMENT_SIZES.medium;

/** Gap between board areas (scene units). */
export const BOARD_GAP = 12;
/** Outer padding around the whole board. */
export const BOARD_PADDING = 12;
/** Inner padding inside an area around its cards. */
export const SIDE_PADDING = 12;
/** Vertical gap between stacked cards in a side area. */
export const CARD_GAP = 10;
/** Vertical overlap of pile cards in the acted/eliminated areas.
 * DEPRECATED: bottom areas now use CARD_GAP stacking; kept for backward
 * compatibility with external callers that import the constant.
 */
export const PILE_OVERLAP = 26;

export const AREA_NAMES = Object.freeze([
  "friendly",
  "hostile",
  "bottomFriendly",
  "bottomHostile",
]);

/**
 * @param {*} value  sizePreset name.
 * @returns {string} Canonical preset ("small" | "medium" | "large").
 */
export function normalizePreset(value) {
  if (typeof value === "string" && BOARD_SIZE_PRESETS[value] !== undefined) return value;
  return DEFAULT_SIZE_PRESET;
}

/**
 * @param {string} [sizePreset]
 * @returns {{width: number, height: number}} Square from the preset config.
 */
export function resolveBoardSize(sizePreset) {
  const side = BOARD_SIZE_PRESETS[normalizePreset(sizePreset)];
  return { width: side, height: side };
}

/**
 * Normalizes the board size from a preset plus an optionally stored size.
 * A stored valid `{width, height}` wins (boards keep their frozen size even
 * if preset defaults change); otherwise the preset-derived square is used.
 * @param {string} [sizePreset]
 * @param {*} [stored]  Validated `board.boardSize` (may be absent).
 * @returns {{width: number, height: number}}
 */
export function normalizeBoardSize(sizePreset, stored) {
  if (isPositiveNumberPair(stored)) return { width: stored.width, height: stored.height };
  return resolveBoardSize(sizePreset);
}

/**
 * Computes the geometry of the five board areas.
 * @param {object} [options] {
 *   sizePreset: string,        Preset name (default "medium").
 *   boardSize: {width, height}, Stored board size (wins over the preset).
 *   cardWidth, cardHeight: number,   Card size overrides.
 *   minSideWidth, minBottomHeight: number,  Area minimums overrides.
 * }
 * @returns {{
 *   sizePreset: string,
 *   boardSize: {width, height},
 *   fieldSize: number,
 *   card: {width, height},
 *   friendly, hostile, bottomFriendly, bottomHostile: AreaRect,
 *   field: Rect,
 *   bounds: Rect,
 *   acted: AreaRect, eliminated: AreaRect  // deprecated aliases of bottomFriendly/bottomHostile
 * }} where AreaRect = `{ x, y, width, height, content: Rect, cardWidth, cardHeight }`.
 */
export function getConflictBoardGeometry(options = {}) {
  const card = {
    width: positiveNumber(options.cardWidth, DEFAULT_CARD_SIZE.width),
    height: positiveNumber(options.cardHeight, DEFAULT_CARD_SIZE.height),
  };
  const boardSize = normalizeBoardSize(options.sizePreset, options.boardSize);
  const fieldSize = boardSize.width;
  const gap = BOARD_GAP;
  const pad = BOARD_PADDING;

  const sideW = Math.max(card.width + 2 * SIDE_PADDING, positiveNumber(options.minSideWidth, 0));
  const totalW = sideW + gap + fieldSize + gap + sideW;
  const bottomH = Math.max(
    card.height + 2 * SIDE_PADDING,
    positiveNumber(options.minBottomHeight, 0),
  );
  const bottomY = fieldSize + gap;
  const totalH = bottomY + bottomH;

  const area = (x, y, w, h) => ({
    x,
    y,
    width: w,
    height: h,
    content: {
      x: x + SIDE_PADDING,
      y: y + SIDE_PADDING,
      width: w - 2 * SIDE_PADDING,
      height: h - 2 * SIDE_PADDING,
    },
    cardWidth: card.width,
    cardHeight: card.height,
  });

  const friendly = area(0, 0, sideW, fieldSize);
  const field = { x: sideW + gap, y: 0, width: fieldSize, height: fieldSize };
  const hostile = area(sideW + gap + fieldSize + gap, 0, sideW, fieldSize);
  const preset = normalizePreset(options.sizePreset);
  const roundBoxW = ROUND_BOX_WIDTHS[preset] ?? DEFAULT_ROUND_BOX_WIDTH;
  const roundBox = { x: totalW / 2 - roundBoxW / 2, y: bottomY, width: roundBoxW, height: bottomH };
  const bottomFriendlyW = totalW / 2 - roundBoxW / 2;
  const bottomFriendly = area(0, bottomY, bottomFriendlyW, bottomH);
  const bottomHostileW = totalW - (totalW / 2 + roundBoxW / 2);
  const bottomHostile = area(totalW / 2 + roundBoxW / 2, bottomY, bottomHostileW, bottomH);

  return {
    sizePreset: preset,
    boardSize,
    fieldSize,
    card,
    friendly,
    hostile,
    field,
    bottomFriendly,
    bottomHostile,
    roundBox,
    // deprecated aliases for backward compatibility (parallel schema agent / old callers)
    acted: bottomFriendly,
    eliminated: bottomHostile,
    bounds: { x: -pad, y: -pad, width: totalW + 2 * pad, height: totalH + 2 * pad },
  };
}

/**
 * Lays the cards of a conflict board state out deterministically.
 *
 * Cards are grouped ONLY by `side` (friendly|hostile), ignoring the stored
 * `area` (compat with schema v2 where area is always "side" and acted state
 * lives in flags).
 *
 * - Each side fills its column top-down (stack with `CARD_GAP` = 10, step
 *   `cardHeight + CARD_GAP` = 160). Threshold is inclusive:
 *   `sideY + cardH <= content.y + content.height`. Capacity per preset:
 *   small 500→476/160→3 cards, medium 800→776/160→4 cards, large
 *   1200→1176/160→7 cards. No off-by-one: remaining gap after last card
 *   is < cardHeight.
 * - Overflow spills into its bottom box (`bottomFriendly`/`bottomHostile`)
 *   as a **horizontal row** with `y = bottomContent.y` and
 *   `x = bottomContent.x + i*(cardWidth+CARD_GAP)` (card 220×150, step 230).
 *   Bottom content height = bottomH-24 = 150 == cardHeight, so exactly one row.
 *   Bottom content widths per preset: small 434 (capacity 1), medium 576
 *   (capacity 2), large 768 (capacity 3).
 * - **Horizontal overflow (pile tail)**: when `x+cardWidth > content.x+content.width`
 *   (`n > capacity`) remaining cards are stacked on the last fitting slot
 *   with a reduced overlap step. Desired pile step is `PILE_OVERLAP` (26px)
 *   to show a dense stack; if that would exceed the right edge the step is
 *   shrunk to `availableTail / tailCount` (minimum 0 — all tail cards collapse
 *   onto the last slot). All bottom cards therefore stay inside
 *   `bottomContent` (`x+width <= right`, `y+height <= bottom`). No overflow
 *   entry is reported for this horizontal pile (cards remain visible, only
 *   overlapped). Width-degenerate case (`cardWidth > contentWidth`) still
 *   reports `reason:"width"`.
 * Cards are never silently clipped: every card receives a position. The
 * overflow list now only reports genuine degenerate cases; the horizontal pile
 * is intentional and not considered an error.
 *
 * @param {object} geometry  Output of `getConflictBoardGeometry`.
 * @param {object} state     Conflict board state (`state.cards`).
 * @returns {{
 *   positions: { [combatantId]: { x, y, width, height, area: "side"|"bottom", side, order } },
 *   overflow: Array<{ combatantId, area: "side"|"bottom", side, order, index, reason: "height"|"width" }>,
 *   hasOverflow: boolean
 * }}
 */
export function layoutConflictCards(geometry, state = {}) {
  const positions = {};
  const overflow = [];
  const groups = { friendly: [], hostile: [] };

  for (const [combatantId, record] of Object.entries(state.cards ?? {})) {
    if (!isObject(record)) continue;
    const sideName = record.side === "hostile" ? "hostile" : "friendly";
    if (!groups[sideName]) continue;
    groups[sideName].push({ combatantId, record, side: sideName });
  }

  const sides = ["friendly", "hostile"];
  for (const sideName of sides) {
    const sideArea = geometry?.[sideName];
    const bottomName = sideName === "friendly" ? "bottomFriendly" : "bottomHostile";
    // fallback to legacy aliases for robustness if caller still has old geometry
    const bottomArea = geometry?.[bottomName] ?? (sideName === "friendly" ? geometry?.acted : geometry?.eliminated);
    if (!sideArea?.content || !bottomArea?.content) continue;
    const list = groups[sideName].sort(
      (a, b) => (a.record.order ?? 0) - (b.record.order ?? 0),
    );
    const step = Math.max(sideArea.cardHeight + CARD_GAP, 2);
    let sideCount = 0;
    const bottomItems = [];
    for (const item of list) {
      const homeSide = sideName;
      const width = sideArea.cardWidth;
      const height = sideArea.cardHeight;
      const order = item.record.order ?? 0;
      // try to fit into side column (inclusive threshold — no off-by-one)
      const sideY = sideArea.content.y + sideCount * step;
      const fitsSideHeight = sideY + height <= sideArea.content.y + sideArea.content.height;
      const fitsSideWidth = width <= sideArea.content.width;
      if (fitsSideHeight && fitsSideWidth) {
        const x = sideArea.content.x;
        const y = sideY;
        positions[item.combatantId] = { x, y, width, height, area: "side", side: homeSide, order };
        sideCount++;
      } else {
        bottomItems.push(item);
      }
    }

    // Horizontal bottom row with pile tail for overflow
    if (bottomItems.length > 0) {
      const wc = sideArea.cardWidth;
      const hc = sideArea.cardHeight;
      const contentX = bottomArea.content.x;
      const contentY = bottomArea.content.y;
      const W = bottomArea.content.width;
      const stepX = wc + CARD_GAP;
      const n = bottomItems.length;

      let capacity = 0;
      if (wc <= W) capacity = Math.floor((W - wc) / stepX) + 1;
      else capacity = 0;

      if (capacity <= 0) {
        for (let i = 0; i < n; i++) {
          const item = bottomItems[i];
          const order = item.record.order ?? 0;
          positions[item.combatantId] = { x: contentX, y: contentY, width: wc, height: hc, area: "bottom", side: sideName, order };
          overflow.push({ combatantId: item.combatantId, area: "bottom", side: sideName, order, index: i, reason: "width" });
        }
      } else if (n <= capacity) {
        for (let i = 0; i < n; i++) {
          const item = bottomItems[i];
          const x = contentX + i * stepX;
          const y = contentY;
          positions[item.combatantId] = { x, y, width: wc, height: hc, area: "bottom", side: sideName, order: item.record.order ?? 0 };
        }
      } else {
        const lastNormalIdx = capacity - 1;
        const lastNormalX = contentX + lastNormalIdx * stepX;
        const tailCount = n - capacity;
        const available = W - wc - lastNormalIdx * stepX;
        const maxStep = tailCount > 0 ? available / tailCount : 0;
        const desired = PILE_OVERLAP;
        const pileStep = Math.max(0, Math.min(desired, maxStep));
        for (let i = 0; i < n; i++) {
          const item = bottomItems[i];
          let x;
          if (i < lastNormalIdx) x = contentX + i * stepX;
          else if (i === lastNormalIdx) x = lastNormalX;
          else x = lastNormalX + (i - lastNormalIdx) * pileStep;
          const y = contentY;
          positions[item.combatantId] = { x, y, width: wc, height: hc, area: "bottom", side: sideName, order: item.record.order ?? 0 };
        }
        // intentional pile — no overflow report (all cards stay within bottomContent)
      }
    }
  }

  return { positions, overflow, hasOverflow: overflow.length > 0 };
}

/**
 * Transforms a rect from minimal-layout coordinates into a board area slot,
 * fitting it preserving the aspect ratio and centering it in the slot.
 * The returned `scale`/`dx`/`dy` allow mapping any sub-rect of the layout
 * (`boardRect = { x: u*scale + dx, y: v*scale + dy, width: w*scale, height: h*scale }`).
 *
 * @param {Rect} layoutRect    Rect in minimal-layout coordinates (e.g. its bounds).
 * @param {Rect} targetSlot    Target slot in board-local coordinates.
 * @param {object} [options]   `{ scale }` explicit scale override.
 * @returns {{x, y, width, height, scale, dx, dy}}
 */
export function transformCardRect(layoutRect, targetSlot, options = {}) {
  const lr = rectOf(layoutRect);
  const slot = rectOf(targetSlot);
  let scale = options.scale;
  if (!(isFiniteNumber(scale) && scale > 0)) {
    scale =
      lr.width > 0 && lr.height > 0 && slot.width > 0 && slot.height > 0
        ? Math.min(slot.width / lr.width, slot.height / lr.height)
        : 1;
  }
  const w = lr.width * scale;
  const h = lr.height * scale;
  const dx = slot.x + (slot.width - w) / 2 - lr.x * scale;
  const dy = slot.y + (slot.height - h) / 2 - lr.y * scale;
  return { x: lr.x * scale + dx, y: lr.y * scale + dy, width: w, height: h, scale, dx, dy };
}

/**
 * @param {Rect} rect
 * @param {{x: number, y: number}} point
 * @returns {boolean}
 */
export function pointInRect(rect, point) {
  if (!isRect(rect) || !isPoint(point)) return false;
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}

/**
 * Clamps a rect so it lies fully inside `field`, shrinking its size when it
 * is larger than the field (a rect bigger than the field always fills the
 * field). Width and height are clamped independently, so the rect may be a
 * non-square rectangle. Board-local coordinates; never mutates the input.
 * @param {Rect} rect   Rect to clamp.
 * @param {Rect} field  Constraining rect (e.g. the central field).
 * @returns {Rect}
 */
export function clampZoneRectToField(rect, field) {
  const width = Math.max(0, Math.min(rect.width, field.width));
  const height = Math.max(0, Math.min(rect.height, field.height));
  const maxX = field.x + field.width - width;
  const maxY = field.y + field.height - height;
  return {
    x: Math.min(Math.max(rect.x, field.x), maxX),
    y: Math.min(Math.max(rect.y, field.y), maxY),
    width,
    height,
  };
}

/**
 * The `{width, height}` of the "Add zone" click-placement rect for a board
 * preset, clamped to the actual central `field` (a field smaller than the
 * preset shrinks the zone to fill it; a field larger keeps the preset). The
 * rect is a rectangle — never a square — and scales with the board preset:
 * medium is 150×120, large is noticeably bigger, small is smaller. Unknown
 * presets fall back to medium. Never mutates the input.
 * @param {string} [sizePreset]  Board size preset name.
 * @param {Rect} [field]  Central field rect (board-local), optional.
 * @returns {{width: number, height: number}}
 */
export function zonePlacementSize(sizePreset, field) {
  const preset =
    ZONE_PLACEMENT_SIZES[normalizePreset(sizePreset)] ?? DEFAULT_ZONE_PLACEMENT_SIZE;
  return {
    width: clampDimension(preset.width, field?.width),
    height: clampDimension(preset.height, field?.height),
  };
}

/**
 * The zone rect of the "Add zone" click-placement: a rectangle of
 * `{width, height}` scene units (default `DEFAULT_ZONE_PLACEMENT_SIZE`, or a
 * legacy numeric `size` side for backward compatibility) centered on the
 * anchor and clamped into the central `field` (each dimension is shrunk when
 * the field is smaller than the zone). Board-local coordinates; never mutates
 * the input. For a preset-driven placement pass
 * `zonePlacementSize(sizePreset, field)` as the size — the rect then always
 * matches the `PlacementManager` preview bounds.
 * @param {Rect} field  Central field rect (board-local).
 * @param {{x: number, y: number}} anchor  Board-local anchor point.
 * @param {number|{width: number, height: number}} [size]  Zone size: a
 *   `{width, height}` rect (preferred) or a legacy square side.
 * @returns {Rect}
 */
export function zoneRectAtAnchor(field, anchor, size = DEFAULT_ZONE_PLACEMENT_SIZE) {
  const dims = isFiniteNumber(size)
    ? { width: size, height: size }
    : {
        width: isFiniteNumber(size?.width) ? size.width : DEFAULT_ZONE_PLACEMENT_SIZE.width,
        height: isFiniteNumber(size?.height) ? size.height : DEFAULT_ZONE_PLACEMENT_SIZE.height,
      };
  const width = Math.max(0, clampDimension(dims.width, field?.width));
  const height = Math.max(0, clampDimension(dims.height, field?.height));
  return clampZoneRectToField(
    { x: anchor.x - width / 2, y: anchor.y - height / 2, width, height },
    field,
  );
}

/**
 * Returns the first zone whose rect contains the point, or null.
 * @param {Array<{id: string, rect: Rect}>} zones
 * @param {{x: number, y: number}} point
 * @returns {object|null}
 */
export function hitTestZone(zones = [], point) {
  return (
    zones.find((z) => isRect(z?.rect) && pointInRect(z.rect, point)) ?? null
  );
}

/**
 * Hit-tests a point against the board: custom zones first (they live inside
 * the central field), then the central field, then the board areas.
 * @param {object} geometry  Output of `getConflictBoardGeometry`.
 * @param {Array<{id: string, rect: Rect}>} zones
 * @param {{x: number, y: number}} point
 * @returns {{
 *   type: "zone"|"field"|"area"|null,
 *   area: "friendly"|"hostile"|"central"|"bottomFriendly"|"bottomHostile"|null,
 *   zone: object|null,
 *   zoneId: string|null
 * }}
 */
export function hitTestConflictZone(geometry, zones = [], point) {
  if (!isPoint(point)) {
    return { type: null, area: null, zone: null, zoneId: null };
  }
  for (const zone of zones) {
    if (isRect(zone?.rect) && pointInRect(zone.rect, point)) {
      return { type: "zone", area: "central", zone, zoneId: zone.id ?? null };
    }
  }
  if (geometry?.field && pointInRect(geometry.field, point)) {
    return { type: "field", area: "central", zone: null, zoneId: null };
  }
  if (geometry?.roundBox && pointInRect(geometry.roundBox, point)) {
    return { type: "area", area: "roundBox", zone: null, zoneId: null };
  }
  for (const areaName of AREA_NAMES) {
    if (geometry?.[areaName] && pointInRect(geometry[areaName], point)) {
      return { type: "area", area: areaName, zone: null, zoneId: null };
    }
  }
  return { type: null, area: null, zone: null, zoneId: null };
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function positiveNumber(value, fallback) {
  return isFiniteNumber(value) && value > 0 ? value : fallback;
}

/** Clamps a dimension to a positive finite limit (no limit when absent). */
function clampDimension(value, limit) {
  return isFiniteNumber(limit) && limit > 0 ? Math.min(value, limit) : value;
}

function isPoint(point) {
  return isObject(point) && isFiniteNumber(point.x) && isFiniteNumber(point.y);
}

function isRect(rect) {
  return (
    isObject(rect) &&
    isFiniteNumber(rect.x) &&
    isFiniteNumber(rect.y) &&
    isFiniteNumber(rect.width) &&
    isFiniteNumber(rect.height) &&
    rect.width >= 0 &&
    rect.height >= 0
  );
}

function isPositiveNumberPair(value) {
  return (
    isObject(value) &&
    positiveNumber(value.width, 0) > 0 &&
    positiveNumber(value.height, 0) > 0
  );
}

function rectOf(value) {
  const x = isFiniteNumber(value?.x) ? value.x : 0;
  const y = isFiniteNumber(value?.y) ? value.y : 0;
  const width = positiveNumber(value?.width, 0);
  const height = positiveNumber(value?.height, 0);
  return { x, y, width, height };
}
