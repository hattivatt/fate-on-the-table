/**
 * Module settings (all exposed in the standard module settings section) and
 * the renderSettingsConfig tweaks (font select refresh + file pickers).
 */

import { getLayoutRecord, getLayoutIds } from "./layoutRegistry.js";
import { resolveFont } from "./WidgetBuilder.js";
import { LayoutImportExport } from "./LayoutImportExport.js";

export const MODULE_ID = "chars-to-table";

/** Layout settings whose choices must list every registered layout. */
const LAYOUT_SETTING_KEYS = ["defaultTemplate", "playerLayout", "npcLayout"];

/**
 * Human-readable layout name: the i18n key `chars-to-table.layouts.<id>.name`
 * when present, otherwise the layout document name.
 * @param {string} id
 */
export function layoutDisplayName(id) {
  const record = getLayoutRecord(id);
  if (!record) return id;
  const key = `${MODULE_ID}.layouts.${id}.name`;
  if (typeof game.i18n?.has === "function" && game.i18n.has(key)) {
    return game.i18n.localize(key);
  }
  return record.name;
}

/**
 * True for actors with at least one non-GM owner. Falls back to an ownership
 * check over all non-GM users when `hasPlayerOwner` is unavailable.
 * @param {object} actor
 */
export function isPlayerCharacter(actor) {
  if (!actor) return false;
  if (actor.hasPlayerOwner !== undefined) return !!actor.hasPlayerOwner;
  try {
    const owner = game.users?.some(
      (u) =>
        !u.isGM &&
        actor.testUserPermission(u, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER),
    );
    return !!owner;
  } catch (err) {
    console.warn("[chars-to-table] player owner check failed:", err);
    return false;
  }
}

/**
 * Chooses the layout id for a NEW widget of the actor: the role setting
 * (playerLayout/npcLayout), then the legacy defaultTemplate, then "default".
 * Falls back to "default" with a GM warning when the chosen id is invalid.
 * @param {object} actor
 * @returns {string}  A registered layout id.
 */
export function selectLayoutIdForActor(actor) {
  const settingKey = isPlayerCharacter(actor) ? "playerLayout" : "npcLayout";
  let id = String(game.settings.get(MODULE_ID, settingKey) ?? "");
  if (!getLayoutRecord(id)) {
    id = String(game.settings.get(MODULE_ID, "defaultTemplate") ?? "default");
    if (!getLayoutRecord(id)) id = "default";
    if (game.user?.isGM) {
      const settingName = game.i18n.localize(
        `${MODULE_ID}.settings.${settingKey}`,
      );
      ui.notifications?.warn(
        game.i18n.format(`${MODULE_ID}.layouts.missing`, {
          setting: settingName,
        }),
      );
    }
  }
  return getLayoutRecord(id) ? id : "default";
}

/** The currently open SettingsConfig window (to keep its layout selects live). */
let openSettingsConfig = null;

/**
 * Rebuilds the choices of the layout settings from the current registry and
 * updates the selects of an already open settings window. Called after a
 * custom layout is imported, renamed or deleted so the settings menu stays
 * up to date without a page reload.
 */
export function refreshLayoutChoices() {
  const choices = Object.fromEntries(
    getLayoutIds().map((id) => [id, layoutDisplayName(id)]),
  );
  for (const key of LAYOUT_SETTING_KEYS) {
    const setting = game.settings.settings.get(`${MODULE_ID}.${key}`);
    if (setting) setting.choices = choices;
  }
  updateSettingsSelects(choices);
}

/**
 * Re-renders the layout `<select>` elements of an already open settings
 * window in place (unsaved edits in other fields stay intact). A selection
 * that pointed to a deleted layout falls back to "default".
 * @param {Record<string, string>} choices  id -> display name.
 */
function updateSettingsSelects(choices) {
  if (!openSettingsConfig || openSettingsConfig.removed) return;
  const html = openSettingsConfig.element;
  if (!html?.querySelector) return;
  const entries = Object.entries(choices);
  for (const key of LAYOUT_SETTING_KEYS) {
    const select = html.querySelector(`[name="${MODULE_ID}.${key}"]`);
    if (!select) continue;
    const current = select.value;
    select.innerHTML = "";
    for (const [id, name] of entries) {
      const option = document.createElement("option");
      option.value = id;
      option.textContent = name;
      if (id === current) option.selected = true;
      select.append(option);
    }
    const stillExists = [...select.options].some((o) => o.value === current);
    if (!stillExists) {
      select.value = choices["default"] !== undefined ? "default" : entries[0]?.[0] ?? "";
    }
  }
}

export function registerSettings() {
  game.settings.register(MODULE_ID, "defaultTemplate", {
    name: game.i18n.localize(`${MODULE_ID}.settings.defaultTemplate`),
    hint: game.i18n.localize(`${MODULE_ID}.settings.defaultTemplateHint`),
    scope: "world",
    config: false,
    type: String,
    default: "default",
    choices: Object.fromEntries(
      getLayoutIds().map((id) => [id, layoutDisplayName(id)]),
    ),
  });

  // "Layouts" menu button: opens the layout manager dialog (list, export,
  // import, rename/delete of custom layouts).
  game.settings.registerMenu(MODULE_ID, "layoutManager", {
    name: game.i18n.localize(`${MODULE_ID}.settings.layoutManager`),
    label: game.i18n.localize(`${MODULE_ID}.settings.layoutManagerLabel`),
    hint: game.i18n.localize(`${MODULE_ID}.settings.layoutManagerHint`),
    icon: "fas fa-table-columns",
    type: LayoutImportExport,
    restricted: true,
  });

  game.settings.register(MODULE_ID, "playerLayout", {
    name: game.i18n.localize(`${MODULE_ID}.settings.playerLayout`),
    hint: game.i18n.localize(`${MODULE_ID}.settings.playerLayoutHint`),
    scope: "world",
    config: true,
    type: String,
    default: "default",
    choices: Object.fromEntries(
      getLayoutIds().map((id) => [id, layoutDisplayName(id)]),
    ),
  });

  game.settings.register(MODULE_ID, "npcLayout", {
    name: game.i18n.localize(`${MODULE_ID}.settings.npcLayout`),
    hint: game.i18n.localize(`${MODULE_ID}.settings.npcLayoutHint`),
    scope: "world",
    config: true,
    type: String,
    default: "default",
    choices: Object.fromEntries(
      getLayoutIds().map((id) => [id, layoutDisplayName(id)]),
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

  game.settings.register(MODULE_ID, "backgroundTexture", {
    name: game.i18n.localize(`${MODULE_ID}.settings.backgroundTexture`),
    hint: game.i18n.localize(`${MODULE_ID}.settings.backgroundTextureHint`),
    scope: "world",
    config: true,
    type: String,
    default: "",
  });

  game.settings.register(MODULE_ID, "fatePointImage", {
    name: game.i18n.localize(`${MODULE_ID}.settings.fatePointImage`),
    hint: game.i18n.localize(`${MODULE_ID}.settings.fatePointImageHint`),
    scope: "world",
    config: true,
    type: String,
    default: "",
  });

  game.settings.register(MODULE_ID, "fatePointTileSize", {
    name: game.i18n.localize(`${MODULE_ID}.settings.fatePointTileSize`),
    hint: game.i18n.localize(`${MODULE_ID}.settings.fatePointTileSizeHint`),
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
  Hooks.on("closeSettingsConfig", () => {
    openSettingsConfig = null;
  });
}

/** Reads the current placement options from the settings. */
export function getPlacementOptions() {
  return {
    templateId: game.settings.get(MODULE_ID, "defaultTemplate"),
    scale: Number(game.settings.get(MODULE_ID, "scale")) || 1,
    fontFamily: game.settings.get(MODULE_ID, "fontFamily") ?? "",
    textColor: game.settings.get(MODULE_ID, "textColor") ?? "",
    fatePointImage: game.settings.get(MODULE_ID, "fatePointImage") ?? "",
    fatePointTileSize:
      Number(game.settings.get(MODULE_ID, "fatePointTileSize")) || 70,
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
  openSettingsConfig = app;
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
