/**
 * Builds the concrete list of scene documents (drawings + tiles) that form
 * the character widget on the table, from an actor and a layout template.
 *
 * All returned coordinates are RELATIVE to the widget anchor and already
 * scaled. The PlacementManager adds the anchor offset when committing.
 *
 * Element types:
 *   - "tile":     single image (portrait). `content` resolves to a src.
 *   - "tileRow":  horizontal row of images (e.g. fate point tokens).
 *                 `content` resolves to a count; `src` comes from
 *                 options.fatePointImage; `step` is the horizontal pitch.
 *   - "drawing":  text (or a shape frame if `content` resolves to "").
 *                 Either `content` (single drawing) or `rows` (one drawing
 *                 per row, stacked with `lineHeight`).
 */

const warnedFonts = new Set();

const resolvers = {
  "@name": (actor) => actor.name,
  "@portrait": (actor) => actor.img,
  "@empty": () => "",
  "@headerAspects": () => game.i18n.localize("chars-to-table.header.aspects"),
  "@headerFatePoints": () =>
    game.i18n.localize("chars-to-table.header.fatePoints"),
  "@headerSkills": () => game.i18n.localize("chars-to-table.header.skills"),
  "@aspects": (actor) => aspectsText(actor),
  "@skillNames": (actor) => skillRows(actor).map((r) => r.names.join(", ")),
  "@skillValues": (actor) => skillRows(actor).map((r) => "+" + r.rank),
  "@fatePointTokens": (actor) =>
    Number(actor.system?.details?.fatePoints?.current) || 0,
};

function skillRows(actor) {
  const list = Object.values(actor.system?.skills ?? {}).filter(
    (s) => Number(s.rank) > 0,
  );
  const byRank = {};
  for (const s of list) (byRank[s.rank] ??= []).push(s.name);
  return Object.keys(byRank)
    .map(Number)
    .sort((a, b) => b - a)
    .map((rank) => ({ rank, names: byRank[rank] }));
}

function aspectsText(actor) {
  const values = Object.values(actor.system?.aspects ?? {})
    .map((a) => a.value)
    .filter((v) => v && String(v).trim());
  return values.join("\n\n");
}

function resolveValue(key, actor) {
  if (typeof key === "string" && key.startsWith("@")) {
    const fn = resolvers[key];
    return fn ? fn(actor) : key;
  }
  return key;
}

function resolveFont(family) {
  if (CONFIG.fontDefinitions?.[family]) return family;
  if (family && family !== "Montserrat" && !warnedFonts.has(family)) {
    warnedFonts.add(family);
    console.warn(
      `[chars-to-table] font "${family}" is not registered; using Montserrat`,
    );
  }
  return "Montserrat";
}

/**
 * Builds the widget layout for an actor.
 * @param {object} actor
 * @param {object} layout  Layout template object.
 * @param {object} [options]  { scale, fontFamily, textColor, fatePointImage } overrides.
 * @returns {Promise<{docs: object[], bounds: {width: number, height: number}}>}
 */
export async function build(actor, layout, options = {}) {
  const scale = (layout.scale ?? 1) * (options.scale ?? 1);
  const fontOverride = options.fontFamily || "";
  const colorOverride = options.textColor || null;
  const dx = layout.drawingOffset?.x ?? 0;
  const dy = layout.drawingOffset?.y ?? 0;
  const docs = [];
  const matchWidthParts = [];

  for (const el of layout.elements ?? []) {
    // The portrait is the anchor and does not take the drawing offset.
    const ox = el.id === "portrait" ? 0 : dx;
    const oy = el.id === "portrait" ? 0 : dy;
    if (el.matchBoundsWidth) matchWidthParts.push(el.id);

    if (el.type === "tile") {
      const src = resolveValue(el.content, actor);
      docs.push({
        kind: "tile",
        part: el.id,
        index: -1,
        x: (el.x + ox) * scale,
        y: (el.y + oy) * scale,
        w: el.w * scale,
        h: el.h * scale,
        src: String(src ?? ""),
      });
      continue;
    }

    if (el.type === "tileRow") {
      const count = Math.max(0, Number(resolveValue(el.content, actor)) || 0);
      const src = options.fatePointImage || "";
      if (src && count > 0) {
        const step = (el.step ?? el.w + 20) * scale;
        for (let i = 0; i < count; i++) {
          docs.push({
            kind: "tile",
            part: el.id,
            index: i,
            x: (el.x + ox + i * step) * scale,
            y: (el.y + oy) * scale,
            w: el.w * scale,
            h: el.h * scale,
            src,
          });
        }
      }
      continue;
    }

    const font = fontOverride || resolveFont(el.font || "Montserrat");
    const color = colorOverride || el.color || "#000000";
    const size = Math.round((el.size ?? 20) * scale);
    const lineHeight =
      (el.lineHeight ?? Math.round((el.size ?? 20) * 1.2)) * scale;
    const stroke = el.stroke ?? 0;
    const base = {
      kind: "drawing",
      part: el.id,
      x: (el.x + ox) * scale,
      y: (el.y + oy) * scale,
      w: el.w * scale,
      h: el.h * scale,
      font,
      size,
      color,
      align: el.align || "left",
      stroke,
      weight: el.weight ?? null,
    };

    if (el.rows) {
      const rows = resolveValue(el.rows, actor) ?? [];
      rows.forEach((text, i) => {
        docs.push({
          ...base,
          index: i,
          text: String(text ?? ""),
          y: base.y + i * lineHeight,
          h: lineHeight,
        });
      });
    } else {
      const text = resolveValue(el.content, actor);
      docs.push({ ...base, index: -1, text: String(text ?? "") });
    }
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const d of docs) {
    minX = Math.min(minX, d.x);
    minY = Math.min(minY, d.y);
    maxX = Math.max(maxX, d.x + d.w);
    maxY = Math.max(maxY, d.y + d.h);
  }

  // Elements marked matchBoundsWidth span the full widget width.
  for (const d of docs) {
    if (matchWidthParts.includes(d.part)) {
      d.x = minX;
      d.w = maxX - minX;
    }
  }

  const boundsConfig = layout.bounds;
  if (docs.length > 0 && boundsConfig?.enabled !== false) {
    // "Grab" box covering the whole widget: transparent, thin outline, drawn
    // on top (high elevation/sort + last in the batch). Dragging it moves the
    // whole widget via the widgetDrag hooks.
    docs.push({
      kind: "drawing",
      part: "widgetBounds",
      index: -1,
      x: minX,
      y: minY,
      w: maxX - minX,
      h: maxY - minY,
      font: "Montserrat",
      size: 8,
      color: boundsConfig?.color || "#000000",
      align: "left",
      stroke: boundsConfig?.stroke ?? 1,
      strokeAlpha: boundsConfig?.alpha ?? 0.2,
      text: "",
      elevation: boundsConfig?.elevation ?? 10,
      sort: boundsConfig?.sort ?? 1000,
    });
  }

  if (!docs.length) {
    return { docs, bounds: { x: 0, y: 0, width: 0, height: 0 } };
  }
  return {
    docs,
    bounds: { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
  };
}

/**
 * Converts a built document descriptor into a Drawing/Tile create payload
 * with the widget identity flags.
 * @param {object} doc
 * @param {object} flags  { widgetId, part, index, actorUuid }
 * @returns {object}
 */
function getRectangleType() {
  return (
    CONST.DRAWING_TYPES?.RECTANGLE ?? foundry.data.ShapeData.TYPES.RECTANGLE
  );
}

export function toDocumentData(doc, flags) {
  if (doc.kind === "tile") {
    return {
      texture: { src: doc.src },
      x: Math.round(doc.x),
      y: Math.round(doc.y),
      width: Math.round(doc.w),
      height: Math.round(doc.h),
      flags: { "chars-to-table": flags },
    };
  }
  const strokeWidth = doc.stroke ?? 0;
  const widgetFlags = { "chars-to-table": flags };
  // Advanced Drawing Tools: without these flags ADT overrides the core text
  // styling (in particular alignment) with its own defaults.
  const textStyle = {
    dropShadow: false,
    strokeThickness: 0,
    align: doc.align || "left",
  };
  if (doc.weight) textStyle.fontWeight = doc.weight;
  widgetFlags["advanced-drawing-tools"] = { textStyle };
  widgetFlags.adt = { dropShadow: false };
  if (doc.weight) widgetFlags.adt.fontWeight = doc.weight;
  return {
    type: getRectangleType(),
    author: game.user.id,
    x: Math.round(doc.x),
    y: Math.round(doc.y),
    shape: { width: Math.round(doc.w), height: Math.round(doc.h) },
    fillType: CONST.DRAWING_FILL_TYPES.NONE,
    fillColor: "#ffffff",
    fillAlpha: 0,
    strokeWidth,
    strokeColor: strokeWidth ? doc.color : "#000000",
    strokeAlpha: doc.strokeAlpha ?? (strokeWidth ? 1 : 0),
    text: doc.text ?? "",
    fontFamily: doc.font,
    fontSize: Math.max(8, doc.size),
    textColor: doc.color,
    textAlign: doc.align,
    elevation: doc.elevation ?? 0,
    sort: doc.sort ?? 0,
    points: [],
    flags: widgetFlags,
  };
}
