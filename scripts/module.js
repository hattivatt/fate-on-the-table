/**
 * chars-to-table — module entry point.
 */

import { registerSettings } from "./settings.js";
import { initialize as initializeLayouts } from "./layoutLoader.js";
import {
  scheduleActorSync,
  cleanupActor,
  reconcileScene,
} from "./WidgetSync.js";
import { initSheetButton } from "./sheetButton.js";
import { initWidgetDrag } from "./widgetDrag.js";
import {
  FatePointManager,
  initWidgetInteractions,
  initCanvasClickFallback,
} from "./FatePointManager.js";
import { syncGmFatePointRow } from "./FatePointSync.js";
import { SituationAspectManager } from "./SituationAspectManager.js";
import { syncSituationAspects } from "./SituationAspectSync.js";
import { LayoutImportExport } from "./LayoutImportExport.js";
import {
  MODULE_ID,
  GM_FP_SCOPE,
  GM_FP_KEY,
  SITUATION_ASPECTS_SCOPE,
  SITUATION_ASPECTS_KEY,
} from "./constants.js";

// Canvas interaction patches must be applied on every module load (page
// reloads included), so this runs at top level — not inside a one-shot hook.
initWidgetInteractions();

console.log("[chars-to-table] module loaded");

const FATE_POINT_SETTINGS = [
  "fatePointImage",
  "fatePointTileWidth",
  "fatePointTileHeight",
  "fatePointStep",
  "gmFatePointDirection",
];

const LAYOUT_SETTINGS = [
  "defaultTemplate",
  "playerLayout",
  "npcLayout",
];

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

let gmSyncTimer = null;
let actorReconcileTimer = null;
let saSyncTimer = null;
let sceneControlsRegistered = false;

Hooks.once("init", async () => {
  console.log("[chars-to-table] init hook");
  try {
    // The built-in layout JSON must be registered BEFORE the settings so
    // their choices already list every layout.
    await initializeLayouts();
    registerSettings();
    console.log("[chars-to-table] settings registered");
  } catch (err) {
    console.error("[chars-to-table] failed to register settings:", err);
  }
});

Hooks.once("ready", () => {
  console.log("[chars-to-table] ready hook");
  try {
    initSheetButton();
  } catch (err) {
    console.error("[chars-to-table] failed to init sheet button:", err);
  }
  initWidgetDrag();
  Hooks.on("updateActor", scheduleActorSync);
  Hooks.on("deleteActor", cleanupActor);
  Hooks.on("updateUser", onUpdateUser);
  Hooks.on("updateSetting", onUpdateSetting);
  Hooks.on("updateScene", onUpdateScene);
  Hooks.on("canvasReady", onCanvasReady);
  Hooks.on("renderFateUtilities", onRenderFateUtilities);
  Hooks.on(`${MODULE_ID}.newScene`, onNewScene);
  registerSceneControl();
  console.log("[chars-to-table] hooks wired");
});

function onCanvasReady() {
  if (!canvas?.scene) return;
  initCanvasClickFallback();
  reconcileScene(canvas.scene).catch((err) =>
    console.error("[chars-to-table] reconcile failed:", err),
  );
  syncGmFatePointRow(canvas.scene).catch((err) =>
    console.error("[chars-to-table] GM fate point sync failed:", err),
  );
  syncSituationAspects(canvas.scene).catch((err) =>
    console.error("[chars-to-table] situation aspects sync failed:", err),
  );
}

/** GM fate points changed on some user: re-sync the GM row (debounced). */
function onUpdateUser(user, changed) {
  if (!user.isGM) return;
  const hasFlag = foundry.utils.hasProperty(
    changed,
    `flags.${GM_FP_SCOPE}.${GM_FP_KEY}`,
  );
  if (!hasFlag) return;
  scheduleGmSync();
}

/** Fate point settings changed: re-sync GM row and actor widgets. */
function onUpdateSetting(setting) {
  if (!setting.key?.startsWith(`${MODULE_ID}.`)) return;
  const key = setting.key.split(".")[1];
  if (FATE_POINT_SETTINGS.includes(key)) {
    scheduleGmSync();
    if (canvas?.scene) {
      clearTimeout(actorReconcileTimer);
      actorReconcileTimer = setTimeout(() => {
        reconcileScene(canvas.scene).catch((err) =>
          console.error("[chars-to-table] reconcile failed:", err),
        );
      }, 400);
    }
    return;
  }
  if (LAYOUT_SETTINGS.includes(key)) {
    // Role-based layout changes affect legacy widgets (records without an
    // explicit layout identity) and new placements only; widgets with an
    // explicit identity keep their layout.
    if (canvas?.scene) {
      clearTimeout(actorReconcileTimer);
      actorReconcileTimer = setTimeout(() => {
        reconcileScene(canvas.scene).catch((err) =>
          console.error("[chars-to-table] reconcile failed:", err),
        );
      }, 400);
    }
    return;
  }
  if (SITUATION_ASPECT_SETTINGS.includes(key)) {
    scheduleSituationAspectSync();
  }
}

/** Situation aspects flag changed on a scene: re-sync its widget (debounced). */
function onUpdateScene(scene, changed) {
  if (
    !foundry.utils.hasProperty(
      changed,
      `flags.${SITUATION_ASPECTS_SCOPE}.${SITUATION_ASPECTS_KEY}`,
    )
  ) {
    return;
  }
  scheduleSituationAspectSync(scene);
}

/** "New Scene" from the FatePointManager: update an already placed widget. */
function onNewScene({ scene } = {}) {
  scheduleSituationAspectSync(scene);
}

function scheduleGmSync() {
  if (!canvas?.scene) return;
  clearTimeout(gmSyncTimer);
  gmSyncTimer = setTimeout(() => {
    syncGmFatePointRow(canvas.scene).catch((err) =>
      console.error("[chars-to-table] GM fate point sync failed:", err),
    );
  }, 400);
}

function scheduleSituationAspectSync(scene = canvas?.scene) {
  if (!scene) return;
  clearTimeout(saSyncTimer);
  saSyncTimer = setTimeout(() => {
    syncSituationAspects(scene).catch((err) =>
      console.error("[chars-to-table] situation aspects sync failed:", err),
    );
  }, 400);
}

/** GM-only scene control tools opening the manager dialogs. */
function registerSceneControl() {
  if (sceneControlsRegistered) return;
  sceneControlsRegistered = true;
  Hooks.on("getSceneControlButtons", (controls) => {
    const group = controls.find((c) => c.name === "token");
    if (!group) return;
    group.tools.push({
      name: "charsToTableFatePoints",
      title: game.i18n.localize(`${MODULE_ID}.manager.tool`),
      icon: "fas fa-star",
      visible: game.user.isGM,
      onClick: () => FatePointManager.open(),
      button: true,
    });
    group.tools.push({
      name: "charsToTableSituationAspects",
      title: game.i18n.localize(`${MODULE_ID}.situationAspects.tool`),
      icon: "fas fa-fire",
      visible: game.user.isGM,
      onClick: () => SituationAspectManager.open(),
      button: true,
    });
    group.tools.push({
      name: "charsToTableLayouts",
      title: game.i18n.localize(`${MODULE_ID}.layouts.tool`),
      icon: "fas fa-table-columns",
      visible: game.user.isGM,
      onClick: () => LayoutImportExport.open(),
      button: true,
    });
  });
}

/**
 * Adds buttons to the system's Fate Utilities app (no modification of
 * system files): a "Place GM fate points" button next to the Scene Fate
 * Points control of the current GM, and a "Place situation aspects" button
 * in the situation aspects row of the scene tab.
 */
function onRenderFateUtilities(app, html) {
  if (!game.user.isGM) return;
  const input = html.querySelector?.(
    `input[name="gmfp"][data-gmid="${game.user.id}"]`,
  );
  const cell = input?.closest?.("td");
  if (cell && !cell.querySelector("[data-ctt-gm-place]")) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.cttGmPlace = "";
    button.className = "fu_button";
    button.innerHTML = `<i class="fas fa-level-down-alt"></i> ${game.i18n.localize(
      `${MODULE_ID}.manager.placeGmRow`,
    )}`;
    button.style.cssText =
      "border:2px groove var(--fco-foundry-interactable-color); " +
      "margin-left:8px; background-color:var(--fco-sheet-input-colour); " +
      "color:var(--fco-sheet-text-colour); font-size:inherit;";
    button.addEventListener("click", () => {
      button.disabled = true;
      FatePointManager.placeGmFatePointRow().finally(() => {
        button.disabled = false;
      });
    });
    cell.append(button);
  }

  // The situation aspects section of the scene tab: the first child div is
  // the GM-only action row (Add New Aspect, label settings, countdowns).
  const saRow = html.querySelector?.("#fu_scene_sit_aspects_container > div");
  if (saRow && !saRow.querySelector("[data-ctt-sa-place]")) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.cttSaPlace = "";
    button.className = "fu_button";
    button.innerHTML = `<i class="fas fa-fire"></i> ${game.i18n.localize(
      `${MODULE_ID}.situationAspects.placeFromFateUtils`,
    )}`;
    button.style.cssText =
      "border:2px groove var(--fco-foundry-interactable-color); " +
      "margin-left:8px; background-color:var(--fco-sheet-input-colour); " +
      "color:var(--fco-sheet-text-colour); font-size:inherit;";
    button.addEventListener("click", () => {
      button.disabled = true;
      SituationAspectManager.placeWidget().finally(() => {
        button.disabled = false;
      });
    });
    saRow.append(button);
  }
}
