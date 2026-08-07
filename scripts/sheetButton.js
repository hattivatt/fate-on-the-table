/**
 * Adds "Place on Table" / "Remove from Table" entries to the Fate Core
 * character sheet WINDOW header menu (the "⋮" menu) via the supported
 * ApplicationV2 `_headerControlContextEntries` extension point (no
 * modification of system files; patched on the sheet class prototype).
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
  patchSheetMenu(cls);
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

function patchSheetMenu(cls) {
  // Guard against re-patching on module hot-reload.
  if (cls.prototype.__charsToTablePatched) return;
  cls.prototype.__charsToTablePatched = true;

  const original = cls.prototype._headerControlContextEntries;
  cls.prototype._headerControlContextEntries = function* () {
    if (original) yield* original.call(this);
    const actor = this.actor ?? this.object;
    yield {
      name: game.i18n.localize("chars-to-table.placeOnTable.title"),
      icon: "fas fa-level-down-alt",
      callback: () => PlacementManager.place(actor),
    };
    if ((actor?.getFlag?.(FLAG_SCOPE, WIDGETS_FLAG) ?? []).length > 0) {
      yield {
        name: game.i18n.localize("chars-to-table.remove.title"),
        icon: "fas fa-level-up-alt",
        callback: () => removeWithConfirmation(actor),
      };
    }
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
