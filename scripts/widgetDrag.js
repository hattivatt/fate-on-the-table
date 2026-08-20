/**
 * widgetDrag — moves all parts of a widget together when any single part is
 * dragged on the canvas (drawings and tiles live in different layers and
 * cannot be grouped natively). Also updates the widget anchor (the actor
 * flag for actor widgets, the scene flag for the GM fate point row and the
 * situation aspects widget) so the next sync does not snap the widget back.
 */

import {
  FLAG_SCOPE,
  WIDGETS_FLAG,
  GM_FP_WIDGET_FLAG,
  GM_OWNER_TYPE,
  SITUATION_ASPECTS_WIDGET_FLAG,
  SA_OWNER_TYPE,
  CONFLICT_ZONE_OWNER_TYPE,
  CONFLICT_CARD_OWNER_TYPE,
} from "./constants.js";
import { allWidgetDocs } from "./widgetDocs.js";
import {
  readConflictBoard,
  writeConflictBoard,
  syncConflictBoard,
  boardRegistry,
  CONFLICT_BOARD_OWNER_TYPE,
} from "./ConflictBoardSync.js";

export function initWidgetDrag() {
  Hooks.on("preUpdateDrawing", onPartPreUpdate);
  Hooks.on("preUpdateTile", onPartPreUpdate);
}

function onPartPreUpdate(document, change, options, userId) {
  if (options?.fateOnTheTableSync) return;
  if (change.x === undefined && change.y === undefined) return;
  const widgetId = document.getFlag(FLAG_SCOPE, "widgetId");
  if (!widgetId) return;
  const ownerType = document.getFlag(FLAG_SCOPE, "ownerType");
  // Conflict cards are positioned deterministically by the board layout
  // (layoutConflictCards); a free card drag would desync the projection and
  // must never move TokenDocument.x/y. Card-area assignment is a future
  // extension, so the move is rejected outright.
  if (ownerType === CONFLICT_CARD_OWNER_TYPE) return false;
  // Board-level parts (background, area frames, labels, turn marker) are
  // projected from `state.board.origin`, which is fixed at placement and
  // never updated by a drag: moving only the drawings would desync the whole
  // board (zones/cards stay behind and the next sync snaps everything back).
  // The board has no reposition flow in this version, so the move is
  // rejected outright for everyone.
  if (ownerType === CONFLICT_BOARD_OWNER_TYPE) return false;
  // Players never move conflict projections: zones shift the board state, so
  // the move is rejected for non-GM users.
  if (
    ownerType === CONFLICT_ZONE_OWNER_TYPE &&
    typeof game !== "undefined" &&
    game?.user &&
    !game.user.isGM
  ) {
    return false;
  }
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

    const syncOptions = { fateOnTheTableSync: true };
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
  if (ownerType === CONFLICT_BOARD_OWNER_TYPE) {
    // Unreachable (rejected in onPartPreUpdate); kept as a defensive guard.
    return;
  }
  if (ownerType === CONFLICT_ZONE_OWNER_TYPE) {
    await shiftConflictZone(scene, widgetId, dx, dy);
    return;
  }
  if (ownerType === CONFLICT_CARD_OWNER_TYPE) {
    // Unreachable (rejected in onPartPreUpdate); kept as a defensive guard.
    return;
  }
  if (ownerType === GM_OWNER_TYPE) {
    await shiftSceneAnchor(scene, widgetId, dx, dy, GM_FP_WIDGET_FLAG);
    return;
  }
  if (ownerType === SA_OWNER_TYPE) {
    await shiftSceneAnchor(
      scene,
      widgetId,
      dx,
      dy,
      SITUATION_ASPECTS_WIDGET_FLAG,
    );
    return;
  }
  const actorUuid = sourceDoc.getFlag(FLAG_SCOPE, "actorUuid");
  if (actorUuid) {
    try {
      const actor = await fromUuid(actorUuid);
      if (actor) await shiftAnchor(actor, scene.id, widgetId, dx, dy);
    } catch (err) {
      console.warn("[fate-on-the-table] anchor update failed:", err);
    }
  }
}

/**
 * Moves a conflict zone: shifts only the dragged zone's `zones[].rect` by the
 * drag delta and re-projects through `writeConflictBoard` + a safe sync. The
 * board origin, other zones, cards and tokenZones are never touched. The
 * registry maps a zone widget id to its stable zone id, so no foreign
 * document is ever located by coordinates or text.
 */
async function shiftConflictZone(scene, widgetId, dx, dy) {
  const registry = boardRegistry(scene);
  const zoneId = Object.entries(registry?.zoneWidgetIds ?? {}).find(
    ([, widget]) => widget === widgetId,
  )?.[0];
  if (!zoneId) return;
  const state = readConflictBoard(scene);
  const zone = state?.zones?.find((z) => z?.id === zoneId);
  if (!state || !zone?.rect) return;
  const rect = {
    x: Math.round(zone.rect.x + dx),
    y: Math.round(zone.rect.y + dy),
    width: zone.rect.width,
    height: zone.rect.height,
  };
  await writeConflictBoard(scene, {
    ...state,
    zones: state.zones.map((z) => (z?.id === zoneId ? { ...z, rect } : z)),
  });
  await syncConflictBoard(scene);
}

/** Updates a scene-owned widget anchor stored in a scene flag registry. */
async function shiftSceneAnchor(scene, widgetId, dx, dy, flagKey) {
  const registry = scene.getFlag(FLAG_SCOPE, flagKey);
  if (!registry || registry.widgetId !== widgetId) return;
  await scene.setFlag(FLAG_SCOPE, flagKey, {
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
