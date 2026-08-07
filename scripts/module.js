/**
 * chars-to-table — module entry point.
 */

import { registerSettings } from "./settings.js";
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
import {
  MODULE_ID,
  GM_FP_SCOPE,
  GM_FP_KEY,
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

let gmSyncTimer = null;
let actorReconcileTimer = null;
let sceneControlsRegistered = false;

Hooks.once("init", () => {
  console.log("[chars-to-table] init hook");
  try {
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
  Hooks.on("canvasReady", onCanvasReady);
  Hooks.on("renderFateUtilities", onRenderFateUtilities);
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
  if (!FATE_POINT_SETTINGS.includes(key)) return;
  scheduleGmSync();
  if (canvas?.scene) {
    clearTimeout(actorReconcileTimer);
    actorReconcileTimer = setTimeout(() => {
      reconcileScene(canvas.scene).catch((err) =>
        console.error("[chars-to-table] reconcile failed:", err),
      );
    }, 400);
  }
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

/** GM-only scene control tool opening the Fate Point Manager dialog. */
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
  });
}

/**
 * Adds a "Place GM fate points" button next to the Scene Fate Points
 * control of the current GM inside the system's Fate Utilities app
 * (no modification of system files).
 */
function onRenderFateUtilities(app, html) {
  if (!game.user.isGM) return;
  const input = html.querySelector?.(
    `input[name="gmfp"][data-gmid="${game.user.id}"]`,
  );
  const cell = input?.closest?.("td");
  if (!cell || cell.querySelector("[data-ctt-gm-place]")) return;

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
