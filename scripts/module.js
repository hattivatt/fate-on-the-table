/**
 * fate-on-the-table — module entry point.
 *
 * Keeps the top-level canvas patches and the hook registration (order
 * matters); the handlers live by feature under `./hooks/`.
 */

import { registerSettings } from "./settings.js";
import { initialize as initializeLayouts } from "./layoutLoader.js";
import { scheduleActorSync, cleanupActor } from "./WidgetSync.js";
import { initSheetButton } from "./sheetButton.js";
import { initWidgetDrag } from "./widgetDrag.js";
import { initDrawingFreeResize } from "./drawingFreeResize.js";
import { initWidgetInteractions, initCanvasClickFallback } from "./FatePointManager.js";
import { initStressBoxInteractions } from "./StressBoxes.js";
import { MODULE_ID } from "./constants.js";
import {
  syncConflictBoard,
  reconcileConflictBoardProjection,
  readConflictBoard,
  writeConflictBoard,
  boardRegistry,
  removeConflictBoard,
} from "./ConflictBoardSync.js";
import {
  ConflictManager,
  placeBoard,
  openConflictManager,
  returnTurn,
  canPlaceConflictBoard,
  getActiveConflictForScene,
} from "./ConflictManager.js";
import {
  registerConflictInteractions,
  registerConflictManager as injectConflictManager,
  reconcileTokenZoneMembership,
  handleTokenDropOnConflictZone,
} from "./ConflictInteractions.js";
import {
  enterConflictZoneEditMode,
  exitConflictZoneEditMode,
  isConflictEditModeActive,
} from "./ConflictZoneEditor.js";
import { runChallengeContest } from "./challengeContestMacro.js";
import { onPreCreateToken, preloadNameGenerationDicts } from "./hooks/nameGen.js";
import { onPreCreateChatMessage } from "./hooks/chatAlias.js";
import { onActorConsequenceSync, onNewScene } from "./hooks/situationAspects.js";
import { onCanvasReady, onUpdateUser, onUpdateSetting, onUpdateScene } from "./hooks/sync.js";
import {
  onConflictBoardActorUpdate,
  onUpdateCombat,
  onCreateCombatant,
  onUpdateCombatant,
  onDeleteCombatant,
  onUpdateToken,
  onDeleteToken,
  onPreDeleteCombat,
  onDeleteCombat,
} from "./hooks/conflict.js";
import { onRenderCombatTracker, onRenderFateUtilities, registerSceneControl } from "./hooks/ui.js";

// Canvas interaction patches must be applied on every module load (page
// reloads included), so this runs at top level — not inside a one-shot hook.
initWidgetInteractions();
// Challenge / contest blocks are ONE Drawing each; v14's DrawingShapeControls
// corner handle locks the aspect ratio. This wrapper (idempotent) restores an
// independent-axis resize for our drawings only.
initDrawingFreeResize();
initStressBoxInteractions();

console.log("[fate-on-the-table] module loaded");

// Random names for unlinked tokens (sync handler; dicts preloaded on `ready`).
Hooks.on("preCreateToken", onPreCreateToken);
// Token-speaker chat messages use the token's name as alias.
Hooks.on("preCreateChatMessage", onPreCreateChatMessage);

Hooks.once("init", async () => {
  console.log("[fate-on-the-table] init hook");
  try {
    // The built-in layout JSON must be registered BEFORE the settings so
    // their choices already list every layout.
    await initializeLayouts();
    registerSettings();
    console.log("[fate-on-the-table] settings registered");
  } catch (err) {
    console.error("[fate-on-the-table] failed to register settings:", err);
  }
});

Hooks.once("ready", () => {
  console.log("[fate-on-the-table] ready hook");
  try {
    initSheetButton();
  } catch (err) {
    console.error("[fate-on-the-table] failed to init sheet button:", err);
  }
  preloadNameGenerationDicts();
  initWidgetDrag();
  // Retry: idempotent, and the canvas classes are guaranteed present by `ready`.
  initDrawingFreeResize();
  Hooks.on("updateActor", scheduleActorSync);
  // Distinct purpose: actor data changes that drive CONFLICT cards (stress,
  // consequences, aspects, skills, items) re-project the active board through
  // the same serialized sync queue. Kept separate from scheduleActorSync so
  // ordinary actor-widget sync and the fateOnTheTableSync recursion guard are
  // never touched.
  Hooks.on("updateActor", onConflictBoardActorUpdate);
  // Consequence → situation-aspect reconciliation: any actor track edit may
  // have renamed/cleared a consequence; if the actor has a token on the
  // active scene its linked aspect (suffix " (ActorName)") must be reconciled.
  Hooks.on("updateActor", onActorConsequenceSync);
  Hooks.on("deleteActor", cleanupActor);
  Hooks.on("updateUser", onUpdateUser);
  Hooks.on("updateSetting", onUpdateSetting);
  Hooks.on("updateScene", onUpdateScene);
  Hooks.on("canvasReady", onCanvasReady);
  Hooks.on("renderFateUtilities", onRenderFateUtilities);
  Hooks.on(`${MODULE_ID}.newScene`, onNewScene);
  registerSceneControl();
  try {
    // Feature 5 — conflict board integration (idempotent, guarded inside
    // ConflictInteractions/ConflictZoneEditor). Players get the read-only
    // interactions (sheets, no GM menus); GM-only paths are gated internally.
    registerConflictInteractions();
    // First-scene DOM click fallback: Foundry fires the very first
    // `canvasReady` BEFORE `ready`, so the hook subscription in `onCanvasReady`
    // misses it and the widget listeners would only attach after a scene
    // switch. Mirror ConflictInteractions' eager attach here on the already
    // present view; the idempotent `dataset.cttClickFallback` guard keeps the
    // later `canvasReady` subscription safe (needed for every next scene).
    if (canvas.app?.view) initCanvasClickFallback();
    injectConflictManager(ConflictManager);
    Hooks.on("renderCombatTracker", onRenderCombatTracker);
    Hooks.on("updateCombat", onUpdateCombat);
    Hooks.on("createCombatant", onCreateCombatant);
    Hooks.on("updateCombatant", onUpdateCombatant);
    Hooks.on("deleteCombatant", onDeleteCombatant);
    Hooks.on("updateToken", onUpdateToken);
    Hooks.on("deleteToken", onDeleteToken);
    // Close-combat guard: while a Combat document is being deleted its board
    // projection stays untouched (no automatic cleanup on combat end).
    Hooks.on("preDeleteCombat", onPreDeleteCombat);
    Hooks.on("deleteCombat", onDeleteCombat);
    registerPublicApi();
  } catch (err) {
    console.error("[fate-on-the-table] failed to wire conflict integration:", err);
  }
  console.log("[fate-on-the-table] hooks wired");
});

/** Extends the module public API with the conflict integration (in `ready`). */
function registerPublicApi() {
  const moduleData = game.modules.get(MODULE_ID);
  if (!moduleData) return;
  moduleData.api = {
    ...(moduleData.api ?? {}),
    conflict: {
      ConflictManager,
      placeBoard,
      openConflictManager,
      returnTurn,
      getActiveConflictForScene,
      canPlaceConflictBoard,
      syncConflictBoard,
      removeConflictBoard,
      reconcileConflictBoardProjection,
      readConflictBoard,
      writeConflictBoard,
      boardRegistry,
      registerConflictInteractions,
      registerConflictManager: injectConflictManager,
      reconcileTokenZoneMembership,
      handleTokenDropOnConflictZone,
      enterConflictZoneEditMode,
      exitConflictZoneEditMode,
      isConflictEditModeActive,
    },
    challengeContest: {
      run() {
        return runChallengeContest();
      },
    },
  };
}
