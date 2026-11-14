/**
 * Adds "Place on Table" / "Remove from Table" entries to the Fate Core
 * character sheet WINDOW header menu (the "⋮" menu) via the supported
 * ApplicationV2 `_headerControlContextEntries` extension point (no
 * modification of system files; wrapped on the sheet class prototype through
 * `wrapMethod` — libWrapper "WRAPPER" when available, direct patch otherwise).
 */

import { PlacementManager } from "./PlacementManager.js";
import { removeActorWidgets, syncActorNow } from "./WidgetSync.js";
import { getLayoutIds, getLayoutRecord } from "./layoutRegistry.js";
import { layoutDisplayName } from "./settings.js";
import { FLAG_SCOPE, WIDGETS_FLAG } from "./constants.js";
import { dialogField } from "./utils.js";
import { wrapMethod, pathKey } from "./patchMethod.js";

export function initSheetButton() {
  const found = findSheetClass();
  if (!found) {
    console.warn("[fate-on-the-table] fcoCharacter sheet class not found");
    return;
  }
  patchSheetMenu(found);
}

/**
 * Finds the fcoCharacter sheet class in `CONFIG.Actor.sheetClasses` together
 * with its global path (libWrapper target prefix), e.g.
 * `CONFIG.Actor.sheetClasses["fate-core-official"]["fate-core-official.fcoCharacter"].cls`.
 * @returns {{cls: Function, path: string}|null}
 */
function findSheetClass() {
  const stack = [{ value: CONFIG.Actor.sheetClasses, path: "CONFIG.Actor.sheetClasses" }];
  while (stack.length) {
    const { value, path } = stack.pop();
    if (!value) continue;
    if (value.cls && value.cls.name === "fcoCharacter") {
      return { cls: value.cls, path: `${path}.cls` };
    }
    if (typeof value === "object") {
      for (const [k, v] of Object.entries(value)) {
        stack.push({ value: v, path: `${path}${pathKey(k)}` });
      }
    }
  }
  return null;
}

function patchSheetMenu({ cls, path }) {
  // Idempotent (module hot-reload): wrapMethod guards re-registration.
  wrapMethod(
    cls.prototype,
    {
      cls: "fcoCharacter",
      path: `${path}.prototype`,
      method: "_headerControlContextEntries",
    },
    // WRAPPER: the native entries are always produced first. The wrapper calls
    // `wrapped` eagerly (libWrapper requires the call during the wrapper) and
    // returns a generator that yields the native entries, then ours.
    function (wrapped, ...args) {
      return moduleHeaderEntries.call(this, wrapped(...args));
    },
    { type: "WRAPPER" },
  );
}

/** Yields the native header entries followed by the module's own entries. */
function* moduleHeaderEntries(nativeEntries) {
  if (nativeEntries) yield* nativeEntries;
  const actor = this.actor ?? this.object;
  const widgets = actor?.getFlag?.(FLAG_SCOPE, WIDGETS_FLAG) ?? [];
  // Widget placement is restricted to the GM and Assistant GM roles.
  // Plain players cannot create tiles on the scene, and in v14 there is
  // no TILE_CREATE permission to check for a finer-grained rule.
  const canCreate = game.user.isGM;
  if (canCreate) {
    yield {
      label: game.i18n.localize("fate-on-the-table.placeOnTable.title"),
      icon: "fas fa-level-down-alt",
      onClick: () => PlacementManager.place(actor),
    };
  }
  // Removing widgets is a GM-only operation.
  if (game.user.isGM && widgets.length > 0) {
    yield {
      label: game.i18n.localize("fate-on-the-table.remove.title"),
      icon: "fas fa-level-up-alt",
      onClick: () => removeWithConfirmation(actor),
    };
    // Explicit layout change for already placed widgets: the stored layout
    // identity wins over the role-based default settings.
    yield {
      label: game.i18n.localize("fate-on-the-table.layouts.change.title"),
      icon: "fas fa-table-columns",
      onClick: () => changeWidgetLayout(actor),
    };
  }
}

/** Explicitly re-layouts every placed widget of the actor. */
export async function changeWidgetLayout(actor) {
  const layouts = getLayoutIds();
  if (layouts.length <= 1) {
    ui.notifications.info(
      game.i18n.localize("fate-on-the-table.layouts.change.none"),
    );
    return;
  }
  const options = layouts
    .map(
      (id) =>
        `<option value="${id}">${layoutDisplayName(id)}</option>`,
    )
    .join("");
  const result = await foundry.applications.api.DialogV2.input({
    window: {
      title: game.i18n.localize("fate-on-the-table.layouts.change.title"),
    },
    content: `<p>${game.i18n.format(
      "fate-on-the-table.layouts.change.prompt",
      { name: actor.name },
    )}</p><select name="layout">${options}</select>`,
    ok: {
      label: game.i18n.localize("fate-on-the-table.layouts.change.confirm"),
    },
    rejectClose: false,
  });
  const layoutId = String(dialogField(result, "layout") ?? "").trim();
  const record = getLayoutRecord(layoutId);
  if (!layoutId || !record) return;

  const widgets = (actor.getFlag(FLAG_SCOPE, WIDGETS_FLAG) ?? []).map((w) => ({
    ...w,
    layoutId,
    layoutVersion: record.version,
  }));
  await actor.setFlag(FLAG_SCOPE, WIDGETS_FLAG, widgets);
  await syncActorNow(actor);
  ui.notifications.info(
    game.i18n.format("fate-on-the-table.layouts.change.done", {
      name: layoutDisplayName(layoutId),
    }),
  );
}

async function removeWithConfirmation(actor) {
  const widgets = actor.getFlag(FLAG_SCOPE, WIDGETS_FLAG) ?? [];
  if (!widgets.length) {
    ui.notifications.info(game.i18n.localize("fate-on-the-table.remove.none"));
    return;
  }
  const confirmed = await foundry.applications.api.DialogV2.confirm({
    window: {
      title: game.i18n.localize("fate-on-the-table.remove.confirmTitle"),
    },
    content: game.i18n.format("fate-on-the-table.remove.confirm", {
      name: actor.name,
    }),
    rejectClose: false,
  });
  if (!confirmed) return;
  const count = await removeActorWidgets(actor);
  ui.notifications.info(
    game.i18n.format("fate-on-the-table.remove.done", { count }),
  );
}


