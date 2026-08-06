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

console.log("[chars-to-table] module loaded");

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
  Hooks.on("canvasReady", () => {
    if (canvas?.scene) reconcileScene(canvas.scene);
  });
  console.log("[chars-to-table] hooks wired");
});
