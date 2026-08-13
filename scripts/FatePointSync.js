/**
 * FatePointSync — reads the GM fate points (fate-core-official.gmfatepoints
 * on the active GM user) and keeps a separate GM token row on the scene in
 * sync: creates missing tiles in batch, deletes extras by index, updates
 * geometry/texture when settings change, and cleans up the scene registry
 * when the row is fully deleted manually.
 */

import { buildTileRow, toDocumentData } from "./WidgetBuilder.js";
import { getPlacementOptions } from "./settings.js";
import {
  FLAG_SCOPE,
  GM_FP_SCOPE,
  GM_FP_KEY,
  GM_FP_WIDGET_FLAG,
  GM_FP_PART,
  GM_FP_FRAME_PART,
  GM_OWNER_TYPE,
} from "./constants.js";

const TILE_FIELDS = [
  "x",
  "y",
  "width",
  "height",
  "texture.src",
  "texture.anchorX",
  "texture.anchorY",
];

const FRAME_FIELDS = [
  "x",
  "y",
  "shape.width",
  "shape.height",
  "fillType",
  "strokeWidth",
  "strokeColor",
  "strokeAlpha",
  "elevation",
  "sort",
];

/** Padding between the GM frame and the token row. */
const FRAME_PAD = 7;

/** The first active GM user, exactly like the legacy macro. */
export function activeGm() {
  return game.users.find((u) => u.isGM && u.active) ?? null;
}

/** Current GM fate points value (0 when missing). */
export function gmFatePoints() {
  const gm = activeGm();
  if (!gm) return 0;
  return Number(gm.getFlag(GM_FP_SCOPE, GM_FP_KEY)) || 0;
}

/** Scene registry of the GM fate point row: { widgetId, anchor } or null. */
export function gmFpRegistry(scene = canvas?.scene) {
  return scene?.getFlag(FLAG_SCOPE, GM_FP_WIDGET_FLAG) ?? null;
}

/** All tiles of the GM fate point row on a scene, by registry widgetId. */
export function gmRowTiles(scene, widgetId) {
  return scene.tiles.filter(
    (t) => t.getFlag(FLAG_SCOPE, "widgetId") === widgetId,
  );
}

/** The persistent GM fate point frame drawing on a scene. */
export function gmRowFrame(scene, widgetId) {
  return scene.drawings.filter(
    (d) =>
      d.getFlag(FLAG_SCOPE, "widgetId") === widgetId &&
      d.getFlag(FLAG_SCOPE, "part") === GM_FP_FRAME_PART,
  );
}

/**
 * Bounds of the GM token row relative to the anchor, per the configured
 * direction.
 * @param {number} [count]  Defaults to the current GM fate points.
 * @returns {{x: number, y: number, width: number, height: number}}
 */
export function gmRowBounds(count = gmFatePoints()) {
  const opts = getPlacementOptions();
  const size = opts.fatePointTileSize;
  const step = opts.fatePointStep;
  const n = Math.max(1, Number(count) || 0);
  switch (opts.gmFatePointDirection) {
    case "rtl":
      return { x: -(n - 1) * step, y: 0, width: size + (n - 1) * step, height: size };
    case "ttb":
      return { x: 0, y: 0, width: size, height: size + (n - 1) * step };
    case "btt":
      return { x: 0, y: -(n - 1) * step, width: size, height: size + (n - 1) * step };
    default:
      return { x: 0, y: 0, width: size + (n - 1) * step, height: size };
  }
}

/**
 * Bounds of the persistent GM frame (row bounds + padding), relative to the
 * anchor. The frame exists even when the row is empty (0 fate points).
 * @returns {{x: number, y: number, width: number, height: number}}
 */
export function gmFrameBounds() {
  const b = gmRowBounds();
  return {
    x: b.x - FRAME_PAD,
    y: b.y - FRAME_PAD,
    width: b.width + FRAME_PAD * 2,
    height: b.height + FRAME_PAD * 2,
  };
}

/**
 * Builds the persistent GM frame document descriptor: transparent box with a
 * visible border, drawn above the tokens so the whole box is draggable.
 * @returns {object}  Drawing descriptor (relative coords).
 */
export function buildGmFrameDoc() {
  const b = gmFrameBounds();
  return {
    kind: "drawing",
    part: GM_FP_FRAME_PART,
    index: -1,
    x: b.x,
    y: b.y,
    w: b.width,
    h: b.height,
    font: "Montserrat",
    size: 8,
    color: "#000000",
    align: "left",
    stroke: 2,
    text: "",
    fillType: CONST.DRAWING_FILL_TYPES.NONE,
    fillColor: "#ffffff",
    fillAlpha: 0,
    elevation: 10,
    sort: 1000,
  };
}

/**
 * Builds the GM fate point row document descriptors (relative coords,
 * no offset): count tiles of `w`x`h` with horizontal pitch `step`.
 * @returns {object[]}  Tile descriptors or [] when src/count is missing.
 */
export function buildGmRowDocs() {
  const opts = getPlacementOptions();
  return buildTileRow({
    part: GM_FP_PART,
    count: gmFatePoints(),
    src: opts.fatePointImage || "",
    x: 0,
    y: 0,
    w: opts.fatePointTileSize,
    h: opts.fatePointTileSize,
    step: opts.fatePointStep,
    direction: opts.gmFatePointDirection,
  });
}

/**
 * Re-syncs the GM fate point box on the active scene against the current
 * GM fate points value and the module settings.
 *
 * - The frame (transparent draggable box) always exists: it is created when
 *   missing and updated to the current geometry. The box persists even at 0
 *   fate points (empty box).
 * - value 0: keep the registry and anchor, remove all tiles.
 * - value > 0 with NO documents at all (frame + tiles): the box was deleted
 *   manually — treat it as removed and clear the registry (never auto-recreate
 *   without explicit placement).
 * - value > 0: restore/create/update tiles by index in one batch, delete
 *   extras by index (stable order).
 * @param {object} [scene]
 * @returns {Promise<boolean>}  True when the scene has a live box.
 */
export async function syncGmFatePointRow(scene = canvas?.scene) {
  if (!scene) return false;
  const gm = activeGm();
  if (!gm) {
    console.warn("[fate-on-the-table] no active GM; GM fate points not synced");
    return false;
  }
  const count = Number(gm.getFlag(GM_FP_SCOPE, GM_FP_KEY)) || 0;
  const registry = gmFpRegistry(scene);
  if (!registry?.widgetId) return false;

  const anchor = registry.anchor ?? { x: 0, y: 0 };
  const existingTiles = gmRowTiles(scene, registry.widgetId);
  const existingFrames = gmRowFrame(scene, registry.widgetId);

  // Positive value but the whole box (frame + tiles) is gone: it was deleted
  // manually — never auto-recreate it without explicit placement.
  if (count > 0 && existingTiles.length === 0 && existingFrames.length === 0) {
    await scene.unsetFlag(FLAG_SCOPE, GM_FP_WIDGET_FLAG);
    console.warn(
      "[fate-on-the-table] GM fate point box deleted manually; registry cleared",
    );
    return false;
  }

  const opts = getPlacementOptions();
  const src = opts.fatePointImage || "";

  // 1. The frame always exists (empty box included), so the box can be
  //    dragged and double-clicked at any time.
  const frameDoc = buildGmFrameDoc();
  const framePayload = toDocumentData(
    {
      ...frameDoc,
      x: frameDoc.x + anchor.x,
      y: frameDoc.y + anchor.y,
    },
    {
      widgetId: registry.widgetId,
      part: frameDoc.part,
      index: frameDoc.index,
      ownerType: GM_OWNER_TYPE,
    },
  );
  if (existingFrames.length) {
    const delta = {};
    for (const field of FRAME_FIELDS) {
      const cur = foundry.utils.getProperty(existingFrames[0], field);
      const next = foundry.utils.getProperty(framePayload, field);
      if (cur !== next && next !== undefined) delta[field] = next;
    }
    if (Object.keys(delta).length) {
      await scene.updateEmbeddedDocuments(
        "Drawing",
        [{ _id: existingFrames[0].id, ...delta }],
        { fateOnTheTableSync: true },
      );
    }
  } else {
    await scene.createEmbeddedDocuments("Drawing", [framePayload]);
  }

  // 2. No image configured: never leave empty Tile documents. The frame
  //    stays, the box remains visible.
  if (!src) {
    if (existingTiles.length) {
      await scene.deleteEmbeddedDocuments(
        "Tile",
        existingTiles.map((t) => t.id),
      );
    }
    return true;
  }

  // 3. Zero is a normal state: keep registry + anchor + frame, no tiles.
  if (count === 0) {
    if (existingTiles.length) {
      await scene.deleteEmbeddedDocuments(
        "Tile",
        existingTiles.map((t) => t.id),
      );
    }
    return true;
  }

  // 4. Sync the tiles themselves by index.
  const docs = buildGmRowDocs();
  const target = new Map();
  for (const doc of docs) target.set(doc.index, doc);

  const byIndex = new Map();
  for (const tile of existingTiles) {
    byIndex.set(tile.getFlag(FLAG_SCOPE, "index") ?? tile.x, tile);
  }

  const updates = [];
  const creations = [];
  for (const [index, doc] of target) {
    const abs = { ...doc, x: doc.x + anchor.x, y: doc.y + anchor.y };
    const payload = toDocumentData(abs, {
      widgetId: registry.widgetId,
      part: doc.part,
      index: doc.index,
      ownerType: GM_OWNER_TYPE,
    });
    const tile = byIndex.get(index);
    if (tile) {
      const delta = {};
      for (const field of TILE_FIELDS) {
        const cur = foundry.utils.getProperty(tile, field);
        const next = foundry.utils.getProperty(payload, field);
        if (cur !== next && next !== undefined) delta[field] = next;
      }
      if (Object.keys(delta).length) updates.push({ _id: tile.id, ...delta });
      byIndex.delete(index);
    } else {
      creations.push(payload);
    }
  }

  // Extra tiles (index beyond the current count) — delete by index order.
  const extras = [...byIndex.values()].sort(
    (a, b) =>
      (a.getFlag(FLAG_SCOPE, "index") ?? a.x) -
      (b.getFlag(FLAG_SCOPE, "index") ?? b.x),
  );

  const syncOptions = { fateOnTheTableSync: true };
  if (updates.length) {
    await scene.updateEmbeddedDocuments("Tile", updates, syncOptions);
  }
  if (extras.length) {
    await scene.deleteEmbeddedDocuments(
      "Tile",
      extras.map((t) => t.id),
    );
  }
  if (creations.length) {
    await scene.createEmbeddedDocuments("Tile", creations);
  }
  return true;
}

/**
 * Removes the GM fate point box (frame + tiles + scene registry) after
 * confirmation has been given by the caller.
 * @param {object} [scene]
 * @returns {Promise<boolean>}  True when something was removed.
 */
export async function removeGmFatePointRow(scene = canvas?.scene) {
  if (!scene) return false;
  const registry = gmFpRegistry(scene);
  let removed = 0;
  if (registry?.widgetId) {
    const drawIds = gmRowFrame(scene, registry.widgetId).map((d) => d.id);
    const tileIds = gmRowTiles(scene, registry.widgetId).map((t) => t.id);
    if (drawIds.length) {
      await scene.deleteEmbeddedDocuments("Drawing", drawIds);
      removed += drawIds.length;
    }
    if (tileIds.length) {
      await scene.deleteEmbeddedDocuments("Tile", tileIds);
      removed += tileIds.length;
    }
    await scene.unsetFlag(FLAG_SCOPE, GM_FP_WIDGET_FLAG);
  }
  return removed > 0;
}
