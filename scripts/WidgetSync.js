/**
 * WidgetSync — keeps placed widgets on the active scene in sync with the
 * actor. Triggered by actor updates (debounced) and cleans up on actor delete.
 */

import { build, toDocumentData } from "./WidgetBuilder.js";
import { getLayout } from "./layouts.js";
import { getPlacementOptions } from "./settings.js";
import { FLAG_SCOPE, WIDGETS_FLAG } from "./constants.js";
import { allWidgetDocs } from "./widgetDocs.js";

const DEBOUNCE_MS = 400;

const DRAWING_FIELDS = [
  "x",
  "y",
  "text",
  "fontSize",
  "fontFamily",
  "textColor",
  "textAlign",
  "fillType",
  "fillColor",
  "fillAlpha",
  "texture",
  "strokeWidth",
  "strokeColor",
  "strokeAlpha",
  "elevation",
  "sort",
  "shape.width",
  "shape.height",
  "flags.advanced-drawing-tools.textStyle.align",
  "flags.advanced-drawing-tools.textStyle.fontWeight",
];

const TILE_FIELDS = ["x", "y", "width", "height", "texture.src"];

const pending = new Map();

/** Debounced hook entry: schedules a sync for a modified actor. */
export function scheduleActorSync(actor) {
  if (actor.type !== "fate-core-official") return;
  const t = pending.get(actor.id);
  if (t) clearTimeout(t);
  pending.set(
    actor.id,
    setTimeout(() => {
      pending.delete(actor.id);
      syncActor(actor).catch((err) =>
        console.error("[chars-to-table] sync failed:", err),
      );
    }, DEBOUNCE_MS),
  );
}

/** Removes all widget documents when an actor is deleted. */
export async function cleanupActor(actor) {
  await removeActorWidgets(actor);
}

/**
 * Deletes all widget documents (drawings + tiles) of an actor from their
 * scenes and clears the widget registry on the actor.
 * @param {object} actor
 * @returns {Promise<number>}  Number of removed widget records.
 */
export async function removeActorWidgets(actor) {
  const widgets = actor.getFlag(FLAG_SCOPE, WIDGETS_FLAG) ?? [];
  for (const record of widgets) {
    const scene = game.scenes.get(record.sceneId);
    if (!scene) continue;
    await deleteWidgetDocs(scene, record.widgetId);
  }
  await actor.unsetFlag(FLAG_SCOPE, WIDGETS_FLAG);
  return widgets.length;
}

/**
 * Re-syncs every widget present on a scene (used on scene load, so widgets
 * placed with an older module version get current layout/settings/ADT flags).
 * @param {object} scene
 */
export async function reconcileScene(scene) {
  const actorUuids = new Set();
  for (const doc of [...scene.drawings, ...scene.tiles]) {
    const actorUuid = doc.getFlag(FLAG_SCOPE, "actorUuid");
    if (actorUuid) actorUuids.add(actorUuid);
  }
  for (const actorUuid of actorUuids) {
    try {
      const actor = await fromUuid(actorUuid);
      if (actor) await syncActor(actor);
    } catch (err) {
      console.warn("[chars-to-table] reconcile failed:", err);
    }
  }
}

async function deleteWidgetDocs(scene, widgetId) {
  const docs = allWidgetDocs(scene, widgetId);
  const drawIds = docs
    .filter((d) => d.documentName === "Drawing")
    .map((d) => d.id);
  const tileIds = docs
    .filter((d) => d.documentName === "Tile")
    .map((d) => d.id);
  if (drawIds.length) await scene.deleteEmbeddedDocuments("Drawing", drawIds);
  if (tileIds.length) await scene.deleteEmbeddedDocuments("Tile", tileIds);
}

async function syncActor(actor) {
  if (!canvas?.scene) return;
  const opts = getPlacementOptions();
  const layout = getLayout(opts.templateId);
  const { docs } = await build(actor, layout, {
    scale: opts.scale,
    fontFamily: opts.fontFamily,
    textColor: opts.textColor,
    fatePointImage: opts.fatePointImage,
    backgroundTexture: opts.backgroundTexture,
  });

  const widgets = actor.getFlag(FLAG_SCOPE, WIDGETS_FLAG) ?? [];
  for (const record of widgets) {
    if (record.sceneId !== canvas.scene.id) continue;
    await syncWidget(actor, record, docs);
  }
}

async function syncWidget(actor, record, docs) {
  const existing = allWidgetDocs(canvas.scene, record.widgetId);
  if (existing.length === 0) {
    // The widget was fully deleted from the scene; drop its record so it is
    // never re-created by a later sync.
    const widgets = (actor.getFlag(FLAG_SCOPE, WIDGETS_FLAG) ?? []).filter(
      (w) => w.widgetId !== record.widgetId,
    );
    await actor.setFlag(FLAG_SCOPE, WIDGETS_FLAG, widgets);
    return;
  }

  const target = new Map();
  for (const doc of docs) target.set(`${doc.part}#${doc.index}`, doc);

  const byKey = new Map();
  for (const doc of existing) {
    const part = doc.getFlag(FLAG_SCOPE, "part");
    const index = doc.getFlag(FLAG_SCOPE, "index") ?? -1;
    byKey.set(`${part}#${index}`, doc);
  }

  const updates = { Drawing: [], Tile: [] };
  const creations = { Drawing: [], Tile: [] };
  const deletions = { Drawing: [], Tile: [] };
  const syncOptions = { charsToTableSync: true };

  for (const [key, doc] of target) {
    const abs = { ...doc, x: doc.x + record.anchor.x, y: doc.y + record.anchor.y };
    const payload = toDocumentData(abs, {
      widgetId: record.widgetId,
      part: doc.part,
      index: doc.index,
      actorUuid: actor.uuid,
    });
    const existingDoc = byKey.get(key);
    if (existingDoc) {
      const kind = existingDoc.documentName === "Tile" ? "Tile" : "Drawing";
      const fields = kind === "Tile" ? TILE_FIELDS : DRAWING_FIELDS;
      const delta = diff(existingDoc, payload, fields);
      if (Object.keys(delta).length) {
        updates[kind].push({ _id: existingDoc.id, ...delta });
      }
      byKey.delete(key);
    } else {
      creations[payload.texture ? "Tile" : "Drawing"].push(payload);
    }
  }

  for (const doc of byKey.values()) {
    deletions[doc.documentName === "Tile" ? "Tile" : "Drawing"].push(doc.id);
  }

  if (updates.Drawing.length) {
    await canvas.scene.updateEmbeddedDocuments("Drawing", updates.Drawing, syncOptions);
  }
  if (updates.Tile.length) {
    await canvas.scene.updateEmbeddedDocuments("Tile", updates.Tile, syncOptions);
  }
  if (deletions.Drawing.length) {
    await canvas.scene.deleteEmbeddedDocuments("Drawing", deletions.Drawing);
  }
  if (deletions.Tile.length) {
    await canvas.scene.deleteEmbeddedDocuments("Tile", deletions.Tile);
  }
  if (creations.Drawing.length) {
    await canvas.scene.createEmbeddedDocuments("Drawing", creations.Drawing);
  }
  if (creations.Tile.length) {
    await canvas.scene.createEmbeddedDocuments("Tile", creations.Tile);
  }
}

function diff(existing, payload, fields) {
  const delta = {};
  for (const field of fields) {
    const cur = foundry.utils.getProperty(existing, field);
    const next = foundry.utils.getProperty(payload, field);
    if (cur !== next && next !== undefined) delta[field] = next;
  }
  return delta;
}
