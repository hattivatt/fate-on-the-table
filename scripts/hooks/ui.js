/**
 * UI integration hooks: Combat Tracker / Fate Utilities buttons and the GM
 * scene control tools.
 */

import { FatePointManager } from "../FatePointManager.js";
import { SituationAspectManager } from "../SituationAspectManager.js";
import { LayoutImportExport } from "../LayoutImportExport.js";
import { MODULE_ID } from "../constants.js";
import { placeBoard, openConflictManager, canPlaceConflictBoard } from "../ConflictManager.js";
import {
  enterConflictZoneEditMode,
  exitConflictZoneEditMode,
  isConflictEditModeActive,
} from "../ConflictZoneEditor.js";
import {
  createCombatTrackerPlaceButton,
  createFateUtilsPlaceButton,
  insertCombatTrackerBoardPlacement,
  insertFateUtilsBoardPlacement,
  attachPlaceBoardClick,
} from "../conflictUi.js";

let sceneControlsRegistered = false;

/** Resolves the DOM root of an ApplicationV2 render hook payload (v14 HTMLElement). */
function resolveHtmlRoot(html) {
  if (!html || typeof html.querySelector !== "function") return null;
  return html;
}

/**
 * GM-only "Place conflict board" control in the Combat Tracker. Added only
 * when placement is currently possible; it calls `placeBoard()` unchanged.
 * The control is inserted as its OWN row directly ABOVE the standard
 * `.combat-controls` (previous/next/end combat) — never inside that flex row
 * — via the pure `conflictUi` helper.
 */
export function onRenderCombatTracker(app, html) {
  if (!game.user.isGM) return;
  const scene = canvas.scene;
  if (!scene) return;
  if (!canPlaceConflictBoard(scene, game.combat)) return;
  const root = resolveHtmlRoot(html);
  if (!root) return;
  const button = createCombatTrackerPlaceButton(
    game.i18n.localize(`${MODULE_ID}.conflict.placement.fromCombatTracker`),
  );
  if (!insertCombatTrackerBoardPlacement(root, button)) return;
  attachPlaceBoardClick(button, placeBoard);
}

/** GM-only scene control tools opening the manager dialogs. */
export function registerSceneControl() {
  if (sceneControlsRegistered) return;
  sceneControlsRegistered = true;
  Hooks.on("getSceneControlButtons", (controls) => {
    const group = controls.find((c) => c.name === "token");
    if (!group) return;
    group.tools.push({
      name: "fateOnTheTableFatePoints",
      title: game.i18n.localize(`${MODULE_ID}.manager.tool`),
      icon: "fas fa-star",
      visible: game.user.isGM,
      onClick: () => FatePointManager.open(),
      button: true,
    });
    group.tools.push({
      name: "fateOnTheTableSituationAspects",
      title: game.i18n.localize(`${MODULE_ID}.situationAspects.tool`),
      icon: "fas fa-fire",
      visible: game.user.isGM,
      onClick: () => SituationAspectManager.open(),
      button: true,
    });
    group.tools.push({
      name: "fateOnTheTableLayouts",
      title: game.i18n.localize(`${MODULE_ID}.layouts.tool`),
      icon: "fas fa-table-columns",
      visible: game.user.isGM,
      onClick: () => LayoutImportExport.open(),
      button: true,
    });
    group.tools.push({
      name: "fateOnTheTableConflictManager",
      title: game.i18n.localize(`${MODULE_ID}.conflict.tool`),
      icon: "fas fa-crosshairs",
      visible: game.user.isGM,
      onClick: () => openConflictManager(),
      button: true,
    });
    // GM toggle for the conflict zone editor. Outside the mode the zone
    // drawings never intercept token clicks/drags (the editor only attaches
    // its own listeners while it is active).
    group.tools.push({
      name: "fateOnTheTableConflictZoneEditor",
      title: game.i18n.localize(`${MODULE_ID}.conflict.zone.editor`),
      icon: "fas fa-draw-polygon",
      visible: game.user.isGM,
      toggle: true,
      active: isConflictEditModeActive(),
      onClick: () => {
        if (isConflictEditModeActive()) {
          exitConflictZoneEditMode();
          return false;
        }
        return enterConflictZoneEditMode();
      },
    });
  });
}

/**
 * Adds buttons to the system's Fate Utilities app (no modification of
 * system files): a "Place GM fate points" button next to the Scene Fate
 * Points control of the current GM, and a "Place situation aspects" button
 * in the situation aspects row of the scene tab.
 */
export function onRenderFateUtilities(app, html) {
  if (!game.user.isGM) return;
  const root = resolveHtmlRoot(html);
  if (!root) return;
  const input = root.querySelector(`input[name="gmfp"][data-gmid="${game.user.id}"]`);
  const cell = input?.closest("td");
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
  const saRow = root.querySelector("#fu_scene_sit_aspects_container > div");
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

  // Feature 5 — "Place conflict board" icon button in the conflict pane of
  // the scene tab (GM-only action row). Icon-only `fu_button` inserted via the
  // pure `conflictUi` helper EXACTLY between the "Timed event"
  // (`#fco_timed_event`) and the "Cycle to next available conflict"
  // (`#fco_next_conflict`) controls (the latter lives in a neighbouring
  // table cell, so the button goes into the timed event's own flex row). Same
  // shared `placeBoard()` handler as the Combat Tracker; no second board
  // variant. Hidden when no combat is pinned to the scene, and panes without
  // the conflict controls never break the rest of the utilities.
  if (canPlaceConflictBoard(canvas.scene, game.combat)) {
    const button = createFateUtilsPlaceButton(
      game.i18n.localize(`${MODULE_ID}.conflict.placement.fromFateUtils`),
    );
    if (!insertFateUtilsBoardPlacement(root, button)) return;
    attachPlaceBoardClick(button, placeBoard);
  }
}
