/**
 * Module settings (all exposed in the standard module settings section) and
 * the renderSettingsConfig tweaks (font select refresh + file pickers).
 */

import { getLayout, getLayoutIds } from "./layouts.js";
import { resolveFont } from "./WidgetBuilder.js";

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

  game.settings.register(MODULE_ID, "fatePointTileWidth", {
    name: game.i18n.localize(`${MODULE_ID}.settings.fatePointTileWidth`),
    hint: game.i18n.localize(`${MODULE_ID}.settings.fatePointTileWidthHint`),
    scope: "world",
    config: true,
    type: Number,
    default: 70,
    range: { min: 16, max: 256, step: 1 },
  });

  game.settings.register(MODULE_ID, "fatePointTileHeight", {
    name: game.i18n.localize(`${MODULE_ID}.settings.fatePointTileHeight`),
    hint: game.i18n.localize(`${MODULE_ID}.settings.fatePointTileHeightHint`),
    scope: "world",
    config: true,
    type: Number,
    default: 70,
    range: { min: 16, max: 256, step: 1 },
  });

  game.settings.register(MODULE_ID, "fatePointStep", {
    name: game.i18n.localize(`${MODULE_ID}.settings.fatePointStep`),
    hint: game.i18n.localize(`${MODULE_ID}.settings.fatePointStepHint`),
    scope: "world",
    config: true,
    type: Number,
    default: 20,
    range: { min: 0, max: 256, step: 1 },
  });

  game.settings.register(MODULE_ID, "gmFatePointDirection", {
    name: game.i18n.localize(`${MODULE_ID}.settings.gmFatePointDirection`),
    hint: game.i18n.localize(
      `${MODULE_ID}.settings.gmFatePointDirectionHint`,
    ),
    scope: "world",
    config: true,
    type: String,
    default: "ltr",
    choices: {
      ltr: game.i18n.localize(`${MODULE_ID}.settings.direction.ltr`),
      rtl: game.i18n.localize(`${MODULE_ID}.settings.direction.rtl`),
      ttb: game.i18n.localize(`${MODULE_ID}.settings.direction.ttb`),
      btt: game.i18n.localize(`${MODULE_ID}.settings.direction.btt`),
    },
  });

  game.settings.register(MODULE_ID, "backgroundTexture", {
    name: game.i18n.localize(`${MODULE_ID}.settings.backgroundTexture`),
    hint: game.i18n.localize(`${MODULE_ID}.settings.backgroundTextureHint`),
    scope: "world",
    config: true,
    type: String,
    default: "",
  });

  game.settings.register(MODULE_ID, "situationAspectsWidth", {
    name: game.i18n.localize(`${MODULE_ID}.settings.situationAspectsWidth`),
    hint: game.i18n.localize(
      `${MODULE_ID}.settings.situationAspectsWidthHint`,
    ),
    scope: "world",
    config: true,
    type: Number,
    default: 500,
    range: { min: 100, max: 4000, step: 10 },
  });

  game.settings.register(MODULE_ID, "situationAspectsHeight", {
    name: game.i18n.localize(`${MODULE_ID}.settings.situationAspectsHeight`),
    hint: game.i18n.localize(
      `${MODULE_ID}.settings.situationAspectsHeightHint`,
    ),
    scope: "world",
    config: true,
    type: Number,
    default: 800,
    range: { min: 100, max: 4000, step: 10 },
  });

  game.settings.register(MODULE_ID, "situationAspectsFontFamily", {
    name: game.i18n.localize(
      `${MODULE_ID}.settings.situationAspectsFontFamily`,
    ),
    hint: game.i18n.localize(
      `${MODULE_ID}.settings.situationAspectsFontFamilyHint`,
    ),
    scope: "world",
    config: true,
    type: String,
    default: "",
    choices: {},
  });

  game.settings.register(MODULE_ID, "situationAspectsFontSize", {
    name: game.i18n.localize(
      `${MODULE_ID}.settings.situationAspectsFontSize`,
    ),
    hint: game.i18n.localize(
      `${MODULE_ID}.settings.situationAspectsFontSizeHint`,
    ),
    scope: "world",
    config: true,
    type: Number,
    default: 32,
    range: { min: 8, max: 300, step: 1 },
  });

  game.settings.register(MODULE_ID, "situationAspectsTextColor", {
    name: game.i18n.localize(
      `${MODULE_ID}.settings.situationAspectsTextColor`,
    ),
    hint: game.i18n.localize(
      `${MODULE_ID}.settings.situationAspectsTextColorHint`,
    ),
    scope: "world",
    config: true,
    type: String,
    default: "#000000",
  });

  game.settings.register(MODULE_ID, "situationAspectsBackgroundTexture", {
    name: game.i18n.localize(
      `${MODULE_ID}.settings.situationAspectsBackgroundTexture`,
    ),
    hint: game.i18n.localize(
      `${MODULE_ID}.settings.situationAspectsBackgroundTextureHint`,
    ),
    scope: "world",
    config: true,
    type: String,
    default: "",
  });

  game.settings.register(MODULE_ID, "situationAspectsBackgroundColor", {
    name: game.i18n.localize(
      `${MODULE_ID}.settings.situationAspectsBackgroundColor`,
    ),
    hint: game.i18n.localize(
      `${MODULE_ID}.settings.situationAspectsBackgroundColorHint`,
    ),
    scope: "world",
    config: true,
    type: String,
    default: "#ffffff",
  });

  game.settings.register(MODULE_ID, "situationAspectsBackgroundAlpha", {
    name: game.i18n.localize(
      `${MODULE_ID}.settings.situationAspectsBackgroundAlpha`,
    ),
    hint: game.i18n.localize(
      `${MODULE_ID}.settings.situationAspectsBackgroundAlphaHint`,
    ),
    scope: "world",
    config: true,
    type: Number,
    default: 1,
    range: { min: 0, max: 1, step: 0.05 },
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
    fatePointTileWidth:
      Number(game.settings.get(MODULE_ID, "fatePointTileWidth")) || 70,
    fatePointTileHeight:
      Number(game.settings.get(MODULE_ID, "fatePointTileHeight")) || 70,
    fatePointStep:
      Number(game.settings.get(MODULE_ID, "fatePointStep")) || 20,
    gmFatePointDirection:
      game.settings.get(MODULE_ID, "gmFatePointDirection") ?? "ltr",
    backgroundTexture:
      game.settings.get(MODULE_ID, "backgroundTexture") ?? "",
  };
}

/**
 * Reads the current situation aspect widget options from the settings.
 * The font follows the legacy macro default: empty setting means BadScript
 * when it is registered, otherwise the Montserrat fallback.
 */
export function getSituationAspectOptions() {
  const fontSetting =
    game.settings.get(MODULE_ID, "situationAspectsFontFamily") ?? "";
  const alpha = Number(
    game.settings.get(MODULE_ID, "situationAspectsBackgroundAlpha"),
  );
  return {
    width: Number(game.settings.get(MODULE_ID, "situationAspectsWidth")) || 500,
    height:
      Number(game.settings.get(MODULE_ID, "situationAspectsHeight")) || 800,
    fontFamily: resolveFont(fontSetting || "BadScript"),
    fontSize:
      Number(game.settings.get(MODULE_ID, "situationAspectsFontSize")) || 32,
    textColor:
      game.settings.get(MODULE_ID, "situationAspectsTextColor") || "#000000",
    backgroundTexture:
      game.settings.get(MODULE_ID, "situationAspectsBackgroundTexture") ?? "",
    backgroundColor:
      game.settings.get(MODULE_ID, "situationAspectsBackgroundColor") ||
      "#ffffff",
    // Foundry requires every Drawing to have a visible fill, text or line:
    // a fully transparent fill (alpha 0) is invalid, so keep a tiny floor.
    backgroundAlpha: Number.isFinite(alpha)
      ? Math.max(alpha, 0.01)
      : 1,
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
 * Enhances the standard settings view: refreshes the font selects with the
 * currently registered fonts and adds file picker buttons to image settings.
 */
function onRenderSettingsConfig(app, html) {
  for (const key of ["fontFamily", "situationAspectsFontFamily"]) {
    const fontInput = html.querySelector?.(
      `[name="${MODULE_ID}.${key}"]`,
    );
    if (!fontInput) continue;
    const current = game.settings.get(MODULE_ID, key) ?? "";
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

  for (const key of [
    "textColor",
    "situationAspectsTextColor",
    "situationAspectsBackgroundColor",
  ]) {
    const colorInput = html.querySelector?.(
      `[name="${MODULE_ID}.${key}"]`,
    );
    if (colorInput) colorInput.type = "color";
  }

  for (const key of [
    "fatePointImage",
    "backgroundTexture",
    "situationAspectsBackgroundTexture",
  ]) {
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
