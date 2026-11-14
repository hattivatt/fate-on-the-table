/**
 * Scene / setting / user / canvasReady hooks that re-sync the module's scene
 * widgets (actor widgets, GM fate point row, situation aspects, conflict board).
 */

import { getConflictBoardOptions, CONFLICT_BOARD_SETTING_KEYS } from "../settings.js";
import { reconcileScene } from "../WidgetSync.js";
import { initCanvasClickFallback } from "../FatePointManager.js";
import { syncGmFatePointRow } from "../FatePointSync.js";
import { syncSituationAspects } from "../SituationAspectSync.js";
import {
  MODULE_ID,
  FLAG_SCOPE,
  GM_FP_SCOPE,
  GM_FP_KEY,
  SITUATION_ASPECTS_SCOPE,
  SITUATION_ASPECTS_KEY,
  CONFLICT_BOARD_FLAG,
} from "../constants.js";
import {
  syncConflictBoard,
  readConflictBoard,
  writeConflictBoard,
  boardRegistry,
  CONFLICT_BOARD_WIDGET_FLAG,
} from "../ConflictBoardSync.js";
import { scheduleConflictSync, resolveSceneConflictCombat } from "./conflict.js";
import { scheduleSituationAspectSync } from "./situationAspects.js";

const FATE_POINT_SETTINGS = [
  "fatePointImage",
  "fatePointTileSize",
  "fatePointStep",
  "gmFatePointDirection",
];

const LAYOUT_SETTINGS = ["defaultTemplate", "playerLayout", "npcLayout"];

const SITUATION_ASPECT_SETTINGS = [
  "situationAspectsWidth",
  "situationAspectsHeight",
  "situationAspectsFontFamily",
  "situationAspectsFontSize",
  "situationAspectsTextColor",
  "situationAspectsBackgroundTexture",
  "situationAspectsBackgroundColor",
  "situationAspectsBackgroundAlpha",
];

// Scene-level keys that, when changed in the Scene Config, only refresh the
// projection of an existing conflict board (origin is never touched).
const SCENE_GEOMETRY_KEYS = [
  "width",
  "height",
  "padding",
  "grid",
  "gridType",
  "backgroundColor",
  "background",
  "backgroundElevation",
  "backgroundAlpha",
];

const SETTINGS_DEBOUNCE_MS = 400;
// Single global timers: these target the ephemeral `canvas.scene` at fire
// time, so there is no cross-scene queue to lose.
let gmSyncTimer = null;
let actorReconcileTimer = null;
let conflictSettingsTimer = null;

export function onCanvasReady() {
  const scene = canvas.scene;
  if (!scene) return;
  initCanvasClickFallback();
  reconcileScene(scene).catch((err) => console.error("[fate-on-the-table] reconcile failed:", err));
  syncGmFatePointRow(scene).catch((err) =>
    console.error("[fate-on-the-table] GM fate point sync failed:", err),
  );
  syncSituationAspects(scene).catch((err) =>
    console.error("[fate-on-the-table] situation aspects sync failed:", err),
  );
  syncConflictOnCanvasReady(scene).catch((err) =>
    console.error("[fate-on-the-table] conflict board sync failed:", err),
  );
}

/**
 * Reconcile + project the conflict board of the scene. Without a valid
 * `conflictBoard` flag nothing is created. The combat is only passed when it
 * matches the board's `combatId` and is bound to the scene.
 */
async function syncConflictOnCanvasReady(scene) {
  const state = readConflictBoard(scene);
  if (!state) return;
  const combat = resolveSceneConflictCombat(scene, state);
  await syncConflictBoard(scene, combat ? { combat } : {});
}

/** GM fate points changed on some user: re-sync the GM row (debounced). */
export function onUpdateUser(user, changed) {
  if (!user.isGM) return;
  if (!foundry.utils.hasProperty(changed, `flags.${GM_FP_SCOPE}.${GM_FP_KEY}`)) return;
  scheduleGmSync();
}

function scheduleGmSync() {
  if (!canvas.scene) return;
  clearTimeout(gmSyncTimer);
  gmSyncTimer = setTimeout(() => {
    syncGmFatePointRow(canvas.scene).catch((err) =>
      console.error("[fate-on-the-table] GM fate point sync failed:", err),
    );
  }, SETTINGS_DEBOUNCE_MS);
}

function scheduleActorReconcile() {
  if (!canvas.scene) return;
  clearTimeout(actorReconcileTimer);
  actorReconcileTimer = setTimeout(() => {
    reconcileScene(canvas.scene).catch((err) =>
      console.error("[fate-on-the-table] reconcile failed:", err),
    );
  }, SETTINGS_DEBOUNCE_MS);
}

/** Module settings changed: re-sync whatever depends on that setting. */
export function onUpdateSetting(setting) {
  if (!setting.key?.startsWith(`${MODULE_ID}.`)) return;
  const key = setting.key.split(".")[1];
  if (FATE_POINT_SETTINGS.includes(key)) {
    scheduleGmSync();
    scheduleActorReconcile();
    return;
  }
  if (LAYOUT_SETTINGS.includes(key)) {
    // Role-based layout changes affect legacy widgets (records without an
    // explicit layout identity) and new placements only.
    scheduleActorReconcile();
    return;
  }
  if (SITUATION_ASPECT_SETTINGS.includes(key)) {
    scheduleSituationAspectSync();
    return;
  }
  if (CONFLICT_BOARD_SETTING_KEYS.includes(key)) {
    // Background/size settings: refresh an already placed board's projection
    // without moving its origin.
    scheduleConflictBoardSettingsSync();
  }
}

function scheduleConflictBoardSettingsSync() {
  if (!canvas.scene) return;
  clearTimeout(conflictSettingsTimer);
  conflictSettingsTimer = setTimeout(() => {
    syncConflictBoardSettings(canvas.scene).catch((err) =>
      console.error("[fate-on-the-table] conflict board settings sync failed:", err),
    );
  }, SETTINGS_DEBOUNCE_MS);
}

async function syncConflictBoardSettings(scene) {
  const state = readConflictBoard(scene);
  if (!state || !boardRegistry(scene)?.widgetId) return;
  const opts = getConflictBoardOptions();
  const origin = state.board?.origin ?? { x: 0, y: 0 };
  await writeConflictBoard(scene, {
    ...state,
    board: {
      ...(state.board ?? {}),
      origin,
      background: {
        color: opts.background.color,
        texture: opts.background.texture,
        alpha: opts.background.alpha,
      },
    },
  });
  await syncConflictBoard(scene);
}

/** Scene flags/settings changed: re-sync scene widgets + the conflict board. */
export function onUpdateScene(scene, changed, options) {
  const { hasProperty } = foundry.utils;
  if (hasProperty(changed, `flags.${SITUATION_ASPECTS_SCOPE}.${SITUATION_ASPECTS_KEY}`)) {
    scheduleSituationAspectSync(scene);
    // Zone-bound situation aspects changed: refresh the conflict zone overlays
    // of a live board. Our writes are marked `fateOnTheTableSync`, so the
    // conflict-flag branch below bails on them and no hook loop is possible.
    if (readConflictBoard(scene) && boardRegistry(scene)?.widgetId) {
      scheduleConflictSync(scene);
    }
  }

  // Conflict board flag changed: sync ONLY the current board. Our own writes
  // (writeConflictBoard/registry) are marked and ignored to prevent recursion.
  const conflictFlagChanged =
    hasProperty(changed, `flags.${FLAG_SCOPE}.${CONFLICT_BOARD_FLAG}`) ||
    hasProperty(changed, `flags.${FLAG_SCOPE}.${CONFLICT_BOARD_WIDGET_FLAG}`);
  if (conflictFlagChanged) {
    if (options?.fateOnTheTableSync) return;
    if (scene.id !== canvas.scene?.id) return;
    scheduleConflictSync(scene);
    return;
  }

  // Scene background/size changed in the Scene Config: refresh the projection
  // of an existing board without moving its origin.
  if (SCENE_GEOMETRY_KEYS.some((k) => hasProperty(changed, k))) {
    if (options?.fateOnTheTableSync) return;
    if (scene.id !== canvas.scene?.id) return;
    if (!readConflictBoard(scene) || !boardRegistry(scene)?.widgetId) return;
    scheduleConflictSync(scene);
  }
}
