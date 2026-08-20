/**
 * WidgetSync — keeps placed widgets on the active scene in sync with the
 * actor. Triggered by actor updates (debounced) and cleans up on actor delete.
 */

import { build, toDocumentData } from "./WidgetBuilder.js";
import { getLayout, getLayoutRecord } from "./layoutRegistry.js";
import {
  getPlacementOptions,
  selectLayoutIdForActor,
} from "./settings.js";
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

const TILE_FIELDS = [
  "x",
  "y",
  "width",
  "height",
  "texture.src",
  "texture.anchorX",
  "texture.anchorY",
];

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
        console.error("[fate-on-the-table] sync failed:", err),
      );
    }, DEBOUNCE_MS),
  );
}

/**
 * Immediate (non-debounced) sync of every widget of an actor on the active
 * scene. Public API for the FatePointManager so UI actions get an instant
 * response without waiting for the debounced updateActor hook.
 * @param {object} actor
 */
export async function syncActorNow(actor) {
  if (actor.type !== "fate-core-official") return;
  await syncActor(actor);
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
 * Deletes a single widget of an actor: its scene documents and its registry
 * record on the actor.
 * @param {object} actor
 * @param {string} widgetId
 * @returns {Promise<boolean>}  True when a widget record was found and removed.
 */
export async function removeWidgetRecord(actor, widgetId) {
  const widgets = actor.getFlag(FLAG_SCOPE, WIDGETS_FLAG) ?? [];
  const record = widgets.find((w) => w.widgetId === widgetId);
  if (!record) return false;
  const scene = game.scenes.get(record.sceneId);
  if (scene) {
    await deleteWidgetDocs(scene, widgetId);
  }
  await actor.setFlag(
    FLAG_SCOPE,
    WIDGETS_FLAG,
    widgets.filter((w) => w.widgetId !== widgetId),
  );
  return true;
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
      console.warn("[fate-on-the-table] reconcile failed:", err);
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

/**
 * Module-owned stale cleanup for a single actor's widgets on a scene.
 *
 * Consequences have no interactive checkbox Drawing anymore — they are text
 * COST rows edited by double-click. Older module versions could leave a
 * `consequenceBoxRows` box part (or a legacy `consequences` combined
 * `[ ]`/`[X]` text row) behind on an ordinary actor widget. This function
 * removes only such module-owned stale docs, and never a foreign document:
 *   - a doc must carry the `fate-on-the-table` flag with an `actorUuid`
 *     matching `actor` (module identity account);
 *   - its `ownerType` must NOT be a conflict/board/zone/card type (conflict
 *     cards are a separate feature owner and are never touched);
 *   - its `part` must be `consequenceBoxRows` (the interactive checkbox),
 *     or the legacy `consequences` part whose text is the old checkbox/name
 *     marker form (contains a `[` checkbox bracket).
 * Deletion is by flag identity only — never by coordinates or raw text, so
 * a user's own drawings and any unrelated actor/scene documents are safe.
 * No recursion: the delete does not trigger a scene reconcile itself.
 * @param {object} scene  Scene document.
 * @param {object} actor  Actor document being synced.
 * @returns {Promise<void>}
 */
export async function cleanupStaleConsequenceBoxes(scene, actor) {
  const actorUuid = actor?.uuid;
  if (!actorUuid) return;
  const stale = [];
  const isLegacyCheckboxText = (text) =>
    typeof text === "string" && /\[[ X]\]/.test(text);
  for (const doc of [...scene.drawings, ...scene.tiles]) {
    if (doc.getFlag?.(FLAG_SCOPE, "actorUuid") !== actorUuid) continue;
    const ownerType = doc.getFlag?.(FLAG_SCOPE, "ownerType");
    // Only ordinary actor widgets (no ownerType, or a non-conflict scope).
    if (
      ownerType &&
      (ownerType === "conflictCard" ||
        ownerType === "conflictZone" ||
        ownerType === "conflictBoard")
    ) {
      continue;
    }
    const part = doc.getFlag?.(FLAG_SCOPE, "part");
    if (part === "consequenceBoxRows") {
      stale.push(doc);
    } else if (part === "consequences" && isLegacyCheckboxText(doc.text ?? doc.texture?.src)) {
      // The old combined `[ ]`/`[X]` name+checkbox resolver output — no
      // longer built; removing the stale pair as well.
      stale.push(doc);
    }
  }
  if (stale.length) {
    const drawIds = stale
      .filter((d) => d.documentName === "Drawing")
      .map((d) => d.id);
    const tileIds = stale
      .filter((d) => d.documentName === "Tile")
      .map((d) => d.id);
    if (drawIds.length) await scene.deleteEmbeddedDocuments("Drawing", drawIds);
    if (tileIds.length) await scene.deleteEmbeddedDocuments("Tile", tileIds);
  }
}

/**
 * Resolves the layout id of a widget record. Explicit records keep their
 * layout identity; legacy records (placed before layouts existed) fall back
 * to the role-based selection and get the identity written back after a
 * successful sync.
 */
function resolveRecordLayoutId(actor, record) {
  if (record.layoutId && getLayoutRecord(record.layoutId)) return record.layoutId;
  if (record.layoutId) {
    console.warn(
      `[fate-on-the-table] widget layout "${record.layoutId}" is not registered; falling back.`,
    );
  }
  return selectLayoutIdForActor(actor);
}

async function syncActor(actor) {
  if (!canvas?.scene) return;
  // Module-owned stale cleanup: remove any legacy consequence CHECKBOX
  // Drawing/Tile the actor may still have on this scene from an older
  // module version. Consequences are text COST rows now; a leftover
  // `consequenceBoxRows` part (or an old `consequences` checkbox text row)
  // would otherwise keep an interactive-looking box that nothing toggles.
  await cleanupStaleConsequenceBoxes(canvas.scene, actor);
  const opts = getPlacementOptions();
  const widgets = actor.getFlag(FLAG_SCOPE, WIDGETS_FLAG) ?? [];
  const records = widgets.filter(
    (record) => record.sceneId === canvas.scene.id,
  );
  if (!records.length) return;

  const byLayout = new Map();
  for (const record of records) {
    const layoutId = resolveRecordLayoutId(actor, record);
    if (!byLayout.has(layoutId)) byLayout.set(layoutId, []);
    byLayout.get(layoutId).push(record);
  }

  const identityWrites = new Map();
  for (const [layoutId, group] of byLayout) {
    const layout = getLayout(layoutId);
    if (!layout) continue;
    const { docs } = await build(actor, layout, {
      scale: opts.scale,
      fontFamily: opts.fontFamily,
      textColor: opts.textColor,
      fatePointImage: opts.fatePointImage,
      fatePointTileSize: opts.fatePointTileSize,
      fatePointStep: opts.fatePointStep,
      backgroundTexture: opts.backgroundTexture,
    });
    for (const record of group) {
      try {
        await syncWidget(actor, record, docs);
        if (!record.layoutId) {
          identityWrites.set(record.widgetId, {
            layoutId,
            layoutVersion: layout.version,
          });
        }
      } catch (err) {
        console.warn(
          `[fate-on-the-table] widget sync failed (${record.widgetId}):`,
          err,
        );
      }
    }
  }

  // Legacy records get their layout identity written back only after the
  // widget synced successfully with the resolved layout.
  if (identityWrites.size) {
    const next = widgets.map((w) =>
      identityWrites.has(w.widgetId)
        ? { ...w, ...identityWrites.get(w.widgetId) }
        : w,
    );
    await actor.setFlag(FLAG_SCOPE, WIDGETS_FLAG, next);
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
  const syncOptions = { fateOnTheTableSync: true };

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
