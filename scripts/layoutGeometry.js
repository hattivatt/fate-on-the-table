/**
 * layoutGeometry — pure geometry engine for layout documents.
 *
 * Converts a NORMALIZED layout (see layoutSchema.js) plus resolved element
 * content into the concrete document descriptors consumed by the runtime
 * builder (WidgetBuilder) and later by `toDocumentData`.
 *
 * This module must stay free of any Foundry runtime dependency (no `game`,
 * `canvas`, `CONFIG`): it is covered by the Node test suite and its output is
 * compared against the legacy `layouts.js` geometry for parity.
 *
 * Coordinates produced by `computeLayoutDocs` are CANVAS-LOCAL (relative to
 * the layout's virtual canvas). The runtime builder adds
 * `canvas.origin * scale` to convert them to anchor-relative scene
 * coordinates, preserving the legacy builder contract.
 *
 * Geometry rules implemented (per LAYOUT-FORMAT.md):
 *   - `drawing` with mode `value`/`empty`  → one Drawing;
 *   - `drawing` with mode `rows`           → one Drawing per row, pitch apart;
 *   - `tile`                               → one Tile (skipped without a src);
 *   - `tileRow` with mode `count`          → N Tiles along `repeat.axis`;
 *   - `position.anchorTo`                  → aligns selfPoint with the source
 *     element's LAYOUT rect anchorPoint (+ offset);
 *   - `sizing.growTo`                      → frame grows right/down to the
 *     source element's instance bounds + padding, never below its own rect;
 *   - `sizing.width: "canvas"`             → element spans the computed canvas;
 *   - `canvas.sizePolicy`                  → fixed or content (with minimum);
 *   - `background` / `bounds`              → canvas-spanning service drawings.
 */

/**
 * Box rows (content mode "boxRow"): one row per track, one DRAWING per box.
 * The resolved value is an array of rows; each row is an array of per-box
 * texts (e.g. "X" for a checked box, "" for an empty one). Boxes are laid
 * out horizontally at `rect.width` + BOX_GAP pitch; rows stack vertically at
 * `repeat.pitch`. The element's style (stroke, font, alignment) applies to
 * every box drawing — a framed rectangle with the marker text, like the
 * legacy macro stress boxes.
 */
const BOX_GAP = 6;

/** Point offsets (fractions of width/height) for the 9 anchor points. */
const POINT_FRACTIONS = {
  topLeft: [0, 0],
  topCenter: [0.5, 0],
  topRight: [1, 0],
  centerLeft: [0, 0.5],
  center: [0.5, 0.5],
  centerRight: [1, 0.5],
  bottomLeft: [0, 1],
  bottomCenter: [0.5, 1],
  bottomRight: [1, 1],
};

// CONST.DRAWING_FILL_TYPES values (kept as literals to stay runtime-free).
const FILL_NONE = 0;
const FILL_SOLID = 1;
const FILL_PATTERN = 2;

function pointOnRect(rect, point) {
  const [fx, fy] = POINT_FRACTIONS[point] ?? POINT_FRACTIONS.topLeft;
  return { x: rect.x + rect.width * fx, y: rect.y + rect.height * fy };
}

/** Fallback text width for pure Node geometry tests without a browser font. */
function defaultMeasureText(text, style) {
  return String(text ?? "").length * (Number(style?.size) || 20) * 0.55;
}

/**
 * Computes the concrete document descriptors of a layout.
 * @param {object} layout   Normalized layout document.
 * @param {object} resolved Content per element id: { [id]: string|number|string[] }.
 * @param {object} [options]  {
 *   scale: number,            Runtime scale (multiplied with layout.scale).
 *   fontFamily: string,       Runtime font override ("" = use layout style).
 *   textColor: string|null,   Runtime text color override.
 *   fatePointImage: string,   src of fate point tokens.
 *   fatePointTileSize/Step: number,  Runtime token overrides.
 *   backgroundTexture: string, Resolved texture source for the background.
 *   resolveFont: (family: string) => string,  Font validation hook.
 *   measureText: (text: string, style: object) => number,  Text width hook
 *     used to attach boxRow drawings after variable-width row labels.
 * }
 * @returns {{docs: object[], canvas: {x: number, y: number, width: number, height: number}}}
 */
export function computeLayoutDocs(layout, resolved, options = {}) {
  const scale = (layout.scale ?? 1) * (options.scale ?? 1);
  const fontOverride = options.fontFamily ?? "";
  const colorOverride = options.textColor ?? null;
  const resolveFont = options.resolveFont ?? ((f) => f);
  const elements = layout.elements ?? [];

  const byElement = new Map();
  const instances = [];

  for (const el of elements) {
    const rect = el.rect ?? { x: 0, y: 0, width: 0, height: 0 };
    const mode = el.content?.mode;
    const value = resolved?.[el.id];
    const list = [];

    if (el.type === "tile") {
      const src = String(value ?? "");
      if (src) {
        list.push({
          kind: "tile",
          part: el.id,
          index: -1,
          x: rect.x * scale,
          y: rect.y * scale,
          w: rect.width * scale,
          h: rect.height * scale,
          src,
        });
      }
    } else if (el.type === "tileRow") {
      const count = Math.max(0, Number(value) || 0);
      const src = options.fatePointImage || "";
      if (src && count > 0) {
        const tileSize = (options.fatePointTileSize ?? rect.width) * scale;
        // The layout normalizer always supplies `repeat.pitch` for tileRow
        // elements (same default as the layout-editor: the tile width); this
        // fallback only guards against non-normalized layouts.
        const pitch =
          (options.fatePointStep ?? el.repeat?.pitch ?? rect.width) * scale;
        const axis = el.repeat?.axis ?? "x";
        const dir = el.repeat?.direction === "backward" ? -1 : 1;
        for (let i = 0; i < count; i++) {
          list.push({
            kind: "tile",
            part: el.id,
            index: i,
            x: rect.x * scale + (axis === "x" ? dir * i * pitch : 0),
            y: rect.y * scale + (axis === "y" ? dir * i * pitch : 0),
            w: tileSize,
            h: tileSize,
            src,
            // Row coordinates are visible top-left coordinates. Keep the
            // texture anchor at the top-left as well; Foundry otherwise
            // centers the image.
            textureAnchor: { x: 0, y: 0 },
          });
        }
      }
    } else {
      // drawing
      const style = el.style ?? {};
      const fill = style.fill ?? {};
      const strokeWidth = style.stroke?.width ?? 0;
      const base = {
        kind: "drawing",
        part: el.id,
        font: fontOverride || resolveFont(style.fontFamily || "Montserrat"),
        size: Math.round((style.fontSize ?? 20) * scale),
        color: colorOverride || style.textColor || "#000000",
        align: style.textAlign || "left",
        weight: style.fontWeight ?? null,
        stroke: strokeWidth,
        strokeColor: colorOverride || style.stroke?.color || style.textColor || "#000000",
        strokeAlpha: strokeWidth ? (style.stroke?.alpha ?? 1) : 0,
        fillType:
          fill.type === "solid" ? FILL_SOLID : fill.type === "pattern" ? FILL_PATTERN : FILL_NONE,
        fillColor: fill.color || "#ffffff",
        fillAlpha: fill.type === "none" ? 0 : (fill.alpha ?? 1),
        elevation: el.layer?.elevation ?? 0,
        sort: el.layer?.sort ?? 0,
      };
      if (mode === "rows") {
        const rows = Array.isArray(value) ? value : [];
        const pitch = (el.repeat?.pitch ?? rect.height) * scale;
        const itemH = (el.repeat?.itemHeight ?? rect.height) * scale;
        rows.forEach((text, i) => {
          list.push({
            ...base,
            index: i,
            x: rect.x * scale,
            y: rect.y * scale + i * pitch,
            w: rect.width * scale,
            h: itemH,
            text: String(text ?? ""),
          });
        });
      } else if (mode === "boxRow") {
        const rows = Array.isArray(value) ? value : [];
        const rowPitch = (el.repeat?.pitch ?? rect.height) * scale;
        const boxW = rect.width * scale;
        const boxH = rect.height * scale;
        const boxPitch = boxW + BOX_GAP * scale;
        let idx = 0;
        rows.forEach((row, i) => {
          const boxes = Array.isArray(row) ? row : [];
          boxes.forEach((text, j) => {
            list.push({
              ...base,
              index: idx++,
              rowIndex: i,
              columnIndex: j,
              x: rect.x * scale + j * boxPitch,
              y: rect.y * scale + i * rowPitch,
              w: boxW,
              h: boxH,
              text: String(text ?? ""),
            });
          });
        });
      } else {
        const text = String(value ?? "");
        // Skip invisible clutter: an empty text drawing without a stroke or
        // fill would create a hidden empty document.
        const invisible = !text && !strokeWidth && fill.type !== "solid";
        if (!invisible) {
          list.push({
            ...base,
            index: -1,
            x: rect.x * scale,
            y: rect.y * scale,
            w: rect.width * scale,
            h: rect.height * scale,
            text,
          });
        }
      }
    }

    byElement.set(el.id, list);
    instances.push(...list);
  }

  // ---- position.anchorTo ----------------------------------------------
  // Uses the source element's LAYOUT rect (scaled): the frame it anchors to
  // is not grown yet (matches the legacy frameAnchor behaviour).
  for (const el of elements) {
    const pos = el.position;
    if (!pos?.anchorTo) continue;
    const source = byElement.get(pos.anchorTo);
    const target = byElement.get(el.id);
    if (!source?.length || !target?.length) continue;
    const sourceEl = elements.find((e) => e.id === pos.anchorTo);

    // A boxRow anchored to a rows element is a two-dimensional relationship:
    // align each row of boxes after that row's actual text width, rather than
    // after the fixed width of the label column. This keeps the gap constant
    // for labels of different lengths while preserving left-aligned labels.
    if (
      el.content?.mode === "boxRow" &&
      sourceEl?.content?.mode === "rows"
    ) {
      const measureText = options.measureText ?? defaultMeasureText;
      const gap = (pos.offset?.x ?? BOX_GAP) * scale;
      const offsetY = (pos.offset?.y ?? 0) * scale;
      for (const d of target) {
        const sourceRow = source.find((s) => s.index === d.rowIndex);
        if (!sourceRow) continue;
        const textWidth = measureText(sourceRow.text, sourceRow);
        d.x =
          sourceRow.x +
          textWidth +
          gap +
          d.columnIndex * (d.w + BOX_GAP * scale);
        d.y = sourceRow.y + (sourceRow.h - d.h) / 2 + offsetY;
      }
      continue;
    }

    const srcRect = sourceEl?.rect
      ? {
          x: sourceEl.rect.x * scale,
          y: sourceEl.rect.y * scale,
          width: sourceEl.rect.width * scale,
          height: sourceEl.rect.height * scale,
        }
      : null;
    if (!srcRect) continue;
    const srcPoint = pointOnRect(srcRect, pos.anchorPoint ?? "leftCenter");
    const first = target[0];
    const selfPoint = pointOnRect(
      { x: first.x, y: first.y, width: first.w, height: first.h },
      pos.selfPoint ?? "leftCenter",
    );
    const dx = srcPoint.x + (pos.offset?.x ?? 0) * scale - selfPoint.x;
    const dy = srcPoint.y + (pos.offset?.y ?? 0) * scale - selfPoint.y;
    for (const d of target) {
      d.x += dx;
      d.y += dy;
    }
  }

  // ---- sizing.growTo ----------------------------------------------------
  // Grows right/down to the source element's instance bounds + padding;
  // never shrinks below the element's own rect.
  for (const el of elements) {
    const sizing = el.sizing;
    if (!sizing?.growTo) continue;
    const source = byElement.get(sizing.growTo);
    const target = byElement.get(el.id);
    if (!source?.length || !target?.length) continue;
    const pad = (sizing.padding ?? 7) * scale;
    const maxX = Math.max(...source.map((d) => d.x + d.w)) + pad;
    const maxY = Math.max(...source.map((d) => d.y + d.h)) + pad;
    for (const d of target) {
      if (maxX > d.x + d.w) d.w = maxX - d.x;
      if (maxY > d.y + d.h) d.h = maxY - d.y;
    }
  }

  // ---- canvas bounds ----------------------------------------------------
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const d of instances) {
    minX = Math.min(minX, d.x);
    minY = Math.min(minY, d.y);
    maxX = Math.max(maxX, d.x + d.w);
    maxY = Math.max(maxY, d.y + d.h);
  }
  const hasDocs = instances.length > 0;
  const unionW = hasDocs ? maxX - minX : 0;
  const unionH = hasDocs ? maxY - minY : 0;

  let canvas;
  if (!hasDocs) {
    canvas = { x: 0, y: 0, width: 0, height: 0 };
  } else {
    const policy = layout.canvas?.sizePolicy ?? { mode: "fixed" };
    const size = layout.canvas?.size ?? {};
    if (policy.mode !== "content") {
      canvas = {
        x: minX,
        y: minY,
        width: (size.width ?? unionW) * scale,
        height: (size.height ?? unionH) * scale,
      };
    } else {
      const minW = (policy.minimum?.width ?? 0) * scale;
      const minH = (policy.minimum?.height ?? 0) * scale;
      canvas = {
        x: minX,
        y: minY,
        width: Math.max(unionW, minW),
        height: Math.max(unionH, minH),
      };
    }
  }

  // ---- sizing.width: "canvas" ------------------------------------------
  for (const el of elements) {
    if (el.sizing?.width !== "canvas") continue;
    for (const d of byElement.get(el.id) ?? []) {
      d.x = canvas.x;
      d.w = canvas.width;
    }
  }

  // ---- background / bounds (service drawings) ---------------------------
  if (hasDocs && canvas.width > 0 && canvas.height > 0) {
    const bg = layout.background;
    if (bg?.enabled !== false) {
      const fill = bg?.fill ?? {};
      const texture =
        bg?.texture?.source != null ? options.backgroundTexture ?? "" : "";
      instances.push({
        kind: "drawing",
        part: "widgetBackground",
        index: -1,
        x: canvas.x,
        y: canvas.y,
        w: canvas.width,
        h: canvas.height,
        font: "Montserrat",
        size: 8,
        color: fill.color ?? "#ffffff",
        align: "left",
        weight: null,
        stroke: 0,
        strokeColor: "#000000",
        strokeAlpha: 0,
        fillType: texture ? FILL_PATTERN : FILL_SOLID,
        fillColor: fill.color ?? "#ffffff",
        fillAlpha: fill.alpha ?? 1,
        texture: texture || null,
        elevation: bg?.layer?.elevation ?? -10,
        sort: bg?.layer?.sort ?? -1000,
        text: "",
      });
    }
    const bounds = layout.bounds;
    if (bounds?.enabled !== false) {
      const stroke = bounds?.stroke ?? {};
      instances.push({
        kind: "drawing",
        part: "widgetBounds",
        index: -1,
        x: canvas.x,
        y: canvas.y,
        w: canvas.width,
        h: canvas.height,
        font: "Montserrat",
        size: 8,
        color: stroke.color ?? "#000000",
        align: "left",
        weight: null,
        stroke: stroke.width ?? 1,
        strokeColor: stroke.color ?? "#000000",
        strokeAlpha: stroke.alpha ?? 0.2,
        fillType: FILL_NONE,
        fillColor: "#ffffff",
        fillAlpha: 0,
        texture: null,
        elevation: bounds?.layer?.elevation ?? 10,
        sort: bounds?.layer?.sort ?? 1000,
        text: "",
      });
    }
  }

  return { docs: instances, canvas };
}
