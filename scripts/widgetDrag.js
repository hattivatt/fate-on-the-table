/**
 * widgetDrag — moves all parts of a widget together when any single part is
 * dragged on the canvas (drawings and tiles live in different layers and
 * cannot be grouped natively). Also updates the widget anchor (the actor
 * flag for actor widgets, the scene flag for the GM fate point row) so the
 * next sync does not snap the widget back.
 */

import { FLAG_SCOPE, WIDGETS_FLAG, GM_FP_WIDGET_FLAG, GM_OWNER_TYPE } from "./constants.js";
import { allWidgetDocs } from "./widgetDocs.js";

export function initWidgetDrag() {
  Hooks.on("preUpdateDrawing", onPartPreUpdate);
  Hooks.on("preUpdateTile", onPartPreUpdate);
}

function onPartPreUpdate(document, change, options, userId) {
  if (options?.charsToTableSync) return;
  if (change.x === undefined && change.y === undefined) return;
  const widgetId = document.getFlag(FLAG_SCOPE, "widgetId");
  if (!widgetId) return;
  const dx = (change.x ?? document.x) - document.x;
  const dy = (change.y ?? document.y) - document.y;
  if (!dx && !dy) return;
  propagate(document, widgetId, dx, dy);
}

async function propagate(sourceDoc, widgetId, dx, dy) {
  const scene = canvas?.scene;
  if (!scene) return;
  const siblings = allWidgetDocs(scene, widgetId).filter(
    (d) => d.id !== sourceDoc.id,
  );

  if (siblings.length) {
    const drawUpdates = [];
    const tileUpdates = [];
    for (const s of siblings) {
      const update = {
        _id: s.id,
        x: Math.round(s.x + dx),
        y: Math.round(s.y + dy),
      };
      (s.documentName === "Tile" ? tileUpdates : drawUpdates).push(update);
    }

    const syncOptions = { charsToTableSync: true };
    if (drawUpdates.length) {
      await scene.updateEmbeddedDocuments("Drawing", drawUpdates, syncOptions);
    }
    if (tileUpdates.length) {
      await scene.updateEmbeddedDocuments("Tile", tileUpdates, syncOptions);
    }
  }

  // The anchor must be shifted even for a single-document widget (e.g. a GM
  // fate point row with one token).
  const ownerType = sourceDoc.getFlag(FLAG_SCOPE, "ownerType");
  if (ownerType === GM_OWNER_TYPE) {
    await shiftSceneAnchor(scene, widgetId, dx, dy);
    return;
  }
  const actorUuid = sourceDoc.getFlag(FLAG_SCOPE, "actorUuid");
  if (actorUuid) {
    try {
      const actor = await fromUuid(actorUuid);
      if (actor) await shiftAnchor(actor, scene.id, widgetId, dx, dy);
    } catch (err) {
      console.warn("[chars-to-table] anchor update failed:", err);
    }
  }
}

/** Updates the GM row anchor stored in the scene flag. */
async function shiftSceneAnchor(scene, widgetId, dx, dy) {
  const registry = scene.getFlag(FLAG_SCOPE, GM_FP_WIDGET_FLAG);
  if (!registry || registry.widgetId !== widgetId) return;
  await scene.setFlag(FLAG_SCOPE, GM_FP_WIDGET_FLAG, {
    ...registry,
    anchor: {
      x: (registry.anchor?.x ?? 0) + dx,
      y: (registry.anchor?.y ?? 0) + dy,
    },
  });
}

async function shiftAnchor(actor, sceneId, widgetId, dx, dy) {
  const widgets = (actor.getFlag(FLAG_SCOPE, WIDGETS_FLAG) ?? []).map((w) =>
    w.sceneId === sceneId && w.widgetId === widgetId
      ? {
          ...w,
          anchor: {
            x: (w.anchor?.x ?? 0) + dx,
            y: (w.anchor?.y ?? 0) + dy,
          },
        }
      : w,
  );
  await actor.setFlag(FLAG_SCOPE, WIDGETS_FLAG, widgets);
}
