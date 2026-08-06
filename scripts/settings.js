/**
 * Module settings (all exposed in the standard module settings section) and
 * the renderSettingsConfig tweaks (font select refresh + file pickers).
 */

import { getLayout, getLayoutIds } from "./layouts.js";

export const MODULE_ID = "chars-to-table";

export function registerSettings() {
  game.settings.register(MODULE_ID, "defaultTemplate", {
    name: game.i18n.localize(`${MODULE_ID}.settings.defaultTemplate`),
    hint: game.i18n.localize(`${MODULE_ID}.settings.defaultTemplateHint`),
    scope: "world",
    config: true,
    type: String,
    default: "default",
    choices: Object.fromEntries(
      getLayoutIds().map((id) => [id, getLayout(id).name]),
    ),
  });

  game.settings.register(MODULE_ID, "scale", {
    name: game.i18n.localize(`${MODULE_ID}.settings.scale`),
    hint: game.i18n.localize(`${MODULE_ID}.settings.scaleHint`),
    scope: "world",
    config: true,
    type: Number,
    default: 1,
    range: { min: 0.25, max: 4, step: 0.05 },
  });

  game.settings.register(MODULE_ID, "snapToGrid", {
    name: game.i18n.localize(`${MODULE_ID}.settings.snapToGrid`),
    hint: game.i18n.localize(`${MODULE_ID}.settings.snapToGridHint`),
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
  });

  game.settings.register(MODULE_ID, "fontFamily", {
    name: game.i18n.localize(`${MODULE_ID}.settings.fontFamily`),
    hint: game.i18n.localize(`${MODULE_ID}.settings.fontFamilyHint`),
    scope: "world",
    config: true,
    type: String,
    default: "",
    choices: {},
  });

  game.settings.register(MODULE_ID, "textColor", {
    name: game.i18n.localize(`${MODULE_ID}.settings.textColor`),
    hint: game.i18n.localize(`${MODULE_ID}.settings.textColorHint`),
    scope: "world",
    config: true,
    type: String,
    default: "#000000",
  });

  game.settings.register(MODULE_ID, "fatePointImage", {
    name: game.i18n.localize(`${MODULE_ID}.settings.fatePointImage`),
    hint: game.i18n.localize(`${MODULE_ID}.settings.fatePointImageHint`),
    scope: "world",
    config: true,
    type: String,
    default: "",
  });

  game.settings.register(MODULE_ID, "backgroundTexture", {
    name: game.i18n.localize(`${MODULE_ID}.settings.backgroundTexture`),
    hint: game.i18n.localize(`${MODULE_ID}.settings.backgroundTextureHint`),
    scope: "world",
    config: true,
    type: String,
    default: "",
  });

  Hooks.on("renderSettingsConfig", onRenderSettingsConfig);
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
    backgroundTexture:
      game.settings.get(MODULE_ID, "backgroundTexture") ?? "",
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

/**
 * Enhances the standard settings view: refreshes the font select with the
 * currently registered fonts and adds file picker buttons to image settings.
 */
function onRenderSettingsConfig(app, html) {
  const fontInput = html.querySelector?.(
    `[name="${MODULE_ID}.fontFamily"]`,
  );
  if (fontInput) {
    const current = game.settings.get(MODULE_ID, "fontFamily") ?? "";
    fontInput.innerHTML = "";
    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = "—";
    if (!current) empty.selected = true;
    fontInput.append(empty);
    for (const font of getFontList()) {
      const option = document.createElement("option");
      option.value = font;
      option.textContent = font;
      if (font === current) option.selected = true;
      fontInput.append(option);
    }
  }

  const colorInput = html.querySelector?.(
    `[name="${MODULE_ID}.textColor"]`,
  );
  if (colorInput) colorInput.type = "color";

  for (const key of ["fatePointImage", "backgroundTexture"]) {
    const input = html.querySelector?.(`[name="${MODULE_ID}.${key}"]`);
    const fields = input?.closest(".form-fields");
    if (input && fields && !fields.querySelector("[data-ctt-picker]")) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.cttPicker = "";
      button.classList.add("file-picker");
      button.innerHTML = '<i class="fas fa-folder-open"></i>';
      button.addEventListener("click", () => {
        new foundry.applications.apps.FilePicker({
          type: "imagevideo",
          current: input.value,
          callback: (path) => {
            input.value = path;
          },
        }).browse();
      });
      fields.append(button);
    }
  }
}
