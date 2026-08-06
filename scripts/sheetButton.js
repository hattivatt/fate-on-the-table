/**
 * Adds the "Place on Table" / "Remove from Table" buttons to the Fate Core
 * character sheet WINDOW frame via the supported ApplicationV2
 * `_getFrameButtons` extension point (no modification of system files;
 * patched on the sheet class prototype).
 */

import { PlacementManager } from "./PlacementManager.js";
import { removeActorWidgets } from "./WidgetSync.js";
import { FLAG_SCOPE, WIDGETS_FLAG } from "./constants.js";

export function initSheetButton() {
  const cls = findSheetClass();
  if (!cls) {
    console.warn("[chars-to-table] fcoCharacter sheet class not found");
    return;
  }
  patchFrameButtons(cls);
}

function findSheetClass() {
  const stack = [CONFIG.Actor.sheetClasses];
  while (stack.length) {
    const value = stack.pop();
    if (!value) continue;
    if (value.cls && value.cls.name === "fcoCharacter") return value.cls;
    if (typeof value === "object") {
      for (const v of Object.values(value)) stack.push(v);
    }
  }
  return null;
}

function patchFrameButtons(cls) {
  // Guard against re-patching on module hot-reload.
  if (cls.prototype.__charsToTablePatched) return;
  cls.prototype.__charsToTablePatched = true;

  const originalButtons = cls.prototype._getFrameButtons;
  cls.prototype._getFrameButtons = function (options) {
    const buttons = originalButtons ? originalButtons.call(this, options) : [];
    if (!buttons.some((b) => b.action === "charsToTablePlace")) {
      buttons.push({
        type: "button",
        action: "charsToTablePlace",
        icon: "fas fa-dice-d20",
        label: game.i18n.localize("chars-to-table.placeOnTable.title"),
      });
    }
    if (
      !buttons.some((b) => b.action === "charsToTableRemove") &&
      (this.actor?.getFlag?.(FLAG_SCOPE, WIDGETS_FLAG) ?? []).length > 0
    ) {
      buttons.push({
        type: "button",
        action: "charsToTableRemove",
        icon: "fas fa-user-minus",
        label: game.i18n.localize("chars-to-table.remove.title"),
      });
    }
    return buttons;
  };

  const originalClick = cls.prototype._onClickAction;
  cls.prototype._onClickAction = function (event, target) {
    const action = target?.dataset?.action;
    if (action === "charsToTablePlace") {
      PlacementManager.place(this.actor ?? this.object);
      return;
    }
    if (action === "charsToTableRemove") {
      removeWithConfirmation(this.actor ?? this.object);
      return;
    }
    return originalClick ? originalClick.call(this, event, target) : undefined;
  };
}

async function removeWithConfirmation(actor) {
  const widgets = actor.getFlag(FLAG_SCOPE, WIDGETS_FLAG) ?? [];
  if (!widgets.length) {
    ui.notifications.info(game.i18n.localize("chars-to-table.remove.none"));
    return;
  }
  const confirmed = await Dialog.confirm({
    title: game.i18n.localize("chars-to-table.remove.confirmTitle"),
    content: game.i18n.format("chars-to-table.remove.confirm", {
      name: actor.name,
    }),
    yes: () => true,
    no: () => false,
    defaultYes: false,
  });
  if (!confirmed) return;
  const count = await removeActorWidgets(actor);
  ui.notifications.info(
    game.i18n.format("chars-to-table.remove.done", { count }),
  );
}
