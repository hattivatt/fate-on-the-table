/**
 * Module settings and the settings application (ApplicationV2).
 */

import { getLayout, getLayoutIds } from "./layouts.js";

export const MODULE_ID = "chars-to-table";

export function registerSettings() {
  game.settings.registerMenu(MODULE_ID, "settingsMenu", {
    name: game.i18n.localize(`${MODULE_ID}.settings.name`),
    label: game.i18n.localize(`${MODULE_ID}.settings.label`),
    icon: "fas fa-dice-d20",
    type: CharsToTableSettingsForm,
    restricted: true,
  });

  game.settings.register(MODULE_ID, "defaultTemplate", {
    name: game.i18n.localize(`${MODULE_ID}.settings.defaultTemplate`),
    hint: game.i18n.localize(`${MODULE_ID}.settings.defaultTemplateHint`),
    scope: "world",
    config: false,
    type: String,
    default: "default",
  });

  game.settings.register(MODULE_ID, "scale", {
    name: game.i18n.localize(`${MODULE_ID}.settings.scale`),
    hint: game.i18n.localize(`${MODULE_ID}.settings.scaleHint`),
    scope: "world",
    config: false,
    type: Number,
    default: 1,
  });

  game.settings.register(MODULE_ID, "snapToGrid", {
    name: game.i18n.localize(`${MODULE_ID}.settings.snapToGrid`),
    hint: game.i18n.localize(`${MODULE_ID}.settings.snapToGridHint`),
    scope: "world",
    config: false,
    type: Boolean,
    default: false,
  });

  game.settings.register(MODULE_ID, "fontFamily", {
    name: game.i18n.localize(`${MODULE_ID}.settings.fontFamily`),
    hint: game.i18n.localize(`${MODULE_ID}.settings.fontFamilyHint`),
    scope: "world",
    config: false,
    type: String,
    default: "",
  });

  game.settings.register(MODULE_ID, "textColor", {
    name: game.i18n.localize(`${MODULE_ID}.settings.textColor`),
    hint: game.i18n.localize(`${MODULE_ID}.settings.textColorHint`),
    scope: "world",
    config: false,
    type: String,
    default: "#000000",
  });

  game.settings.register(MODULE_ID, "fatePointImage", {
    name: game.i18n.localize(`${MODULE_ID}.settings.fatePointImage`),
    hint: game.i18n.localize(`${MODULE_ID}.settings.fatePointImageHint`),
    scope: "world",
    config: false,
    type: String,
    default: "",
  });
}

/** Reads the current placement options from the settings. */
export function getPlacementOptions() {
  return {
    templateId: game.settings.get(MODULE_ID, "defaultTemplate"),
    scale: Number(game.settings.get(MODULE_ID, "scale")) || 1,
    snapToGrid: !!game.settings.get(MODULE_ID, "snapToGrid"),
    fontFamily: game.settings.get(MODULE_ID, "fontFamily") ?? "",
    textColor: game.settings.get(MODULE_ID, "textColor") ?? "",
    fatePointImage: game.settings.get(MODULE_ID, "fatePointImage") ?? "",
  };
}

function getFontList() {
  try {
    return foundry.applications.settings.menus.FontConfig.getAvailableFonts();
  } catch (err) {
    console.error("[chars-to-table] Failed to list fonts:", err);
    return [];
  }
}

export class CharsToTableSettingsForm extends foundry.applications.api.HandlebarsApplicationMixin(
  foundry.applications.api.ApplicationV2,
) {
  static DEFAULT_OPTIONS = {
    id: "chars-to-table-settings",
    tag: "form",
    window: {
      resizable: true,
    },
    position: { width: 500, height: "auto" },
    form: { closeOnSubmit: true },
  };

  get title() {
    return game.i18n.localize(`${MODULE_ID}.settings.label`);
  }

  static PARTS = {
    settingsForm: {
      template: "modules/chars-to-table/templates/settings.html",
    },
  };

  async _prepareContext(options) {
    return {
      current: {
        defaultTemplate: game.settings.get(MODULE_ID, "defaultTemplate"),
        scale: game.settings.get(MODULE_ID, "scale"),
        snapToGrid: game.settings.get(MODULE_ID, "snapToGrid"),
        fontFamily: game.settings.get(MODULE_ID, "fontFamily"),
        textColor: game.settings.get(MODULE_ID, "textColor"),
        fatePointImage: game.settings.get(MODULE_ID, "fatePointImage"),
      },
      templates: getLayoutIds().map((id) => ({
        value: id,
        label: getLayout(id).name,
      })),
      fonts: getFontList(),
    };
  }

  async _onSubmit(context, event, formData) {
    const data = formData.object;
    await game.settings.set(MODULE_ID, "defaultTemplate", data.defaultTemplate);
    await game.settings.set(MODULE_ID, "scale", Number(data.scale) || 1);
    await game.settings.set(MODULE_ID, "snapToGrid", !!data.snapToGrid);
    await game.settings.set(MODULE_ID, "fontFamily", data.fontFamily ?? "");
    await game.settings.set(MODULE_ID, "textColor", data.textColor ?? "#000000");
    await game.settings.set(
      MODULE_ID,
      "fatePointImage",
      data.fatePointImage ?? "",
    );
    ui.notifications.info("Chars to Table: settings saved.");
  }

  _onRender(context, options) {
    this.element
      ?.querySelector('[data-action="pickFatePointImage"]')
      ?.addEventListener("click", async (event) => {
        const input = this.element.querySelector('[name="fatePointImage"]');
        new FilePicker({
          type: "imagevideo",
          current: input?.value || "",
          callback: (path) => {
            if (input) input.value = path;
          },
        }).browse();
      });
  }
}
