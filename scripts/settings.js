/**
 * Module settings (all exposed in the standard module settings section) and
 * the renderSettingsConfig tweaks (font select refresh + file pickers).
 */

import { getLayoutRecord, getLayoutIds } from "./layoutRegistry.js";
import { resolveFont } from "./WidgetBuilder.js";
import { LayoutImportExport } from "./LayoutImportExport.js";
import { BOARD_SIZE_PRESETS } from "./conflictBoardGeometry.js";
import { TURN_MARKER_SETTING } from "./constants.js";
import {
  CHALLENGE_SETTING_DEFAULTS,
  CONTEST_SETTING_DEFAULTS,
  CHALLENGE_CONTEST_SETTING_DEFAULTS,
} from "./challengeContest.js";

export const MODULE_ID = "fate-on-the-table";

/** Layout settings whose choices must list every registered layout. */
const LAYOUT_SETTING_KEYS = ["defaultTemplate", "playerLayout", "npcLayout"];

/**
 * Conflict board (feature 5) setting keys. Exported so the manager/sync
 * modules (ConflictManager/ConflictBoardSync) can read the settings by these
 * exact names without duplicating strings. Sizes are the preset sides in
 * scene units, aligned with the pure geometry config `BOARD_SIZE_PRESETS`
 * (small/medium/large = 500/800/1200); a placed board that already stores its
 * own `board.boardSize` keeps that size (`normalizeBoardSize` in
 * conflictBoardGeometry.js) and is NOT resized by these presets.
 */
export const CONFLICT_BOARD_SETTING_KEYS = Object.freeze([
  "conflictBoardSizeSmall",
  "conflictBoardSizeMedium",
  "conflictBoardSizeLarge",
  "conflictBoardBackgroundColor",
  "conflictBoardBackgroundTexture",
  "conflictBoardBackgroundAlpha",
  "conflictBoardOverflowPolicy",
]);

/**
 * Safe defaults for the conflict board settings. Size defaults mirror
 * `BOARD_SIZE_PRESETS`; the background defaults mirror the schema defaults
 * `DEFAULT_BACKGROUND` in conflictBoardSchema.js (read by ConflictBoardSync
 * into `state.board.background`).
 */
export const CONFLICT_BOARD_SETTING_DEFAULTS = Object.freeze({
  conflictBoardSizeSmall: BOARD_SIZE_PRESETS.small,
  conflictBoardSizeMedium: BOARD_SIZE_PRESETS.medium,
  conflictBoardSizeLarge: BOARD_SIZE_PRESETS.large,
  conflictBoardBackgroundColor: "#ffffff",
  conflictBoardBackgroundTexture: "",
  conflictBoardBackgroundAlpha: 1,
  conflictBoardOverflowPolicy: "warn",
});

/**
 * Card overflow policies selectable in the settings UI. `warn` reports the
 * overflow (cards are never silently clipped — layoutConflictCards returns
 * a per-card overflow list), `expand` grows the side areas to fit all cards.
 */
export const CONFLICT_BOARD_OVERFLOW_POLICIES = Object.freeze([
  "warn",
  "expand",
]);

const CONFLICT_BOARD_OVERFLOW_CHOICES = Object.freeze({
  warn: `${MODULE_ID}.settings.conflictOverflow.warn`,
  expand: `${MODULE_ID}.settings.conflictOverflow.expand`,
});

/**
 * Human-readable layout name: the i18n key `fate-on-the-table.layouts.<id>.name`
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
    console.warn("[fate-on-the-table] player owner check failed:", err);
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

/**
 * Registers one setting. `name`/`hint` are derived from the i18n keys
 * `<nameKey>` / `<nameKey>Hint` under the module's `settings.` namespace;
 * settings are world-scoped and shown in the config by default, so the table
 * entries only spell out what differs from those defaults.
 */
function registerSetting(key, config, nameKey = key) {
  game.settings.register(MODULE_ID, key, {
    name: game.i18n.localize(`${MODULE_ID}.settings.${nameKey}`),
    hint: game.i18n.localize(`${MODULE_ID}.settings.${nameKey}Hint`),
    scope: "world",
    config: true,
    ...config,
  });
}

export function registerSettings() {
  const layoutChoices = Object.fromEntries(
    getLayoutIds().map((id) => [id, layoutDisplayName(id)]),
  );

  registerSetting("defaultTemplate", {
    config: false,
    type: String,
    default: "default",
    choices: layoutChoices,
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

  // Role -> layout mapping. The choices come from the layout registry and are
  // rebuilt in place by refreshLayoutChoices() after a custom layout changes.
  for (const key of ["playerLayout", "npcLayout"]) {
    registerSetting(key, {
      type: String,
      default: "default",
      choices: layoutChoices,
    });
  }

  /**
   * Declarative settings table: `[key, config]` in registration (= display)
   * order. An `i18n` key overrides the name/hint namespace when the i18n key
   * differs from the setting key.
   */
  const SETTINGS = [
    [
      "scale",
      {
        type: Number,
        default: 1,
        range: { min: 0.25, max: 4, step: 0.05 },
      },
    ],
    ["fontFamily", { type: String, default: "", choices: {} }],
    ["textColor", { type: String, default: "#000000" }],
    ["backgroundTexture", { type: String, default: "" }],
    ["fatePointImage", { type: String, default: "" }],
    [
      "fatePointTileSize",
      {
        type: Number,
        default: 70,
        range: { min: 16, max: 256, step: 1 },
      },
    ],
    [
      "fatePointStep",
      {
        type: Number,
        default: 20,
        range: { min: 0, max: 256, step: 1 },
      },
    ],
    [
      "gmFatePointDirection",
      {
        type: String,
        default: "ltr",
        choices: {
          ltr: game.i18n.localize(`${MODULE_ID}.settings.direction.ltr`),
          rtl: game.i18n.localize(`${MODULE_ID}.settings.direction.rtl`),
          ttb: game.i18n.localize(`${MODULE_ID}.settings.direction.ttb`),
          btt: game.i18n.localize(`${MODULE_ID}.settings.direction.btt`),
        },
      },
    ],
    [
      "situationAspectsWidth",
      {
        type: Number,
        default: 500,
        range: { min: 100, max: 4000, step: 10 },
      },
    ],
    [
      "situationAspectsHeight",
      {
        type: Number,
        default: 800,
        range: { min: 100, max: 4000, step: 10 },
      },
    ],
    ["situationAspectsFontFamily", { type: String, default: "", choices: {} }],
    [
      "situationAspectsFontSize",
      {
        type: Number,
        default: 32,
        range: { min: 8, max: 300, step: 1 },
      },
    ],
    ["situationAspectsTextColor", { type: String, default: "#000000" }],
    ["situationAspectsBackgroundTexture", { type: String, default: "" }],
    ["situationAspectsBackgroundColor", { type: String, default: "#ffffff" }],
    [
      "situationAspectsBackgroundAlpha",
      {
        type: Number,
        default: 1,
        range: { min: 0, max: 1, step: 0.05 },
      },
    ],

    // Conflict board (feature 5): independent world settings. They configure
    // only the board itself and never the actor-widget or situation aspect
    // backgrounds. Preset sizes are editable so GMs can tune the placement
    // dialog; a stored `board.boardSize` still wins over these values.
    [
      "conflictBoardSizeSmall",
      {
        type: Number,
        default: CONFLICT_BOARD_SETTING_DEFAULTS.conflictBoardSizeSmall,
        range: { min: 100, max: 4000, step: 10 },
      },
    ],
    [
      "conflictBoardSizeMedium",
      {
        type: Number,
        default: CONFLICT_BOARD_SETTING_DEFAULTS.conflictBoardSizeMedium,
        range: { min: 100, max: 4000, step: 10 },
      },
    ],
    [
      "conflictBoardSizeLarge",
      {
        type: Number,
        default: CONFLICT_BOARD_SETTING_DEFAULTS.conflictBoardSizeLarge,
        range: { min: 100, max: 4000, step: 10 },
      },
    ],
    [
      "conflictBoardBackgroundColor",
      {
        type: String,
        default: CONFLICT_BOARD_SETTING_DEFAULTS.conflictBoardBackgroundColor,
      },
    ],
    [
      "conflictBoardBackgroundTexture",
      {
        type: String,
        default:
          CONFLICT_BOARD_SETTING_DEFAULTS.conflictBoardBackgroundTexture,
      },
    ],
    [
      "conflictBoardBackgroundAlpha",
      {
        type: Number,
        default: CONFLICT_BOARD_SETTING_DEFAULTS.conflictBoardBackgroundAlpha,
        range: { min: 0, max: 1, step: 0.05 },
      },
    ],
    [
      "conflictBoardOverflowPolicy",
      {
        type: String,
        default: CONFLICT_BOARD_SETTING_DEFAULTS.conflictBoardOverflowPolicy,
        choices: Object.fromEntries(
          CONFLICT_BOARD_OVERFLOW_POLICIES.map((policy) => [
            policy,
            game.i18n.localize(CONFLICT_BOARD_OVERFLOW_CHOICES[policy]),
          ]),
        ),
      },
    ],

    [
      TURN_MARKER_SETTING,
      {
        i18n: "autoTurnMarker",
        type: Boolean,
        default: true,
        requiresReload: false,
      },
    ],

    // Random name generation for unlinked tokens (adapted from Token Mold)
    ["nameGenEnable", { type: Boolean, default: true }],
    [
      "nameGenLanguage",
      {
        type: String,
        default: "random",
        choices: {
          random: game.i18n.localize(
            `${MODULE_ID}.settings.nameGenLanguageChoices.random`,
          ),
          english: game.i18n.localize(
            `${MODULE_ID}.settings.nameGenLanguageChoices.english`,
          ),
          russian: game.i18n.localize(
            `${MODULE_ID}.settings.nameGenLanguageChoices.russian`,
          ),
        },
      },
    ],
    [
      "nameGenMinLength",
      {
        type: Number,
        default: 6,
        range: { min: 3, max: 15, step: 1 },
      },
    ],
    [
      "nameGenMaxLength",
      {
        type: Number,
        default: 9,
        range: { min: 3, max: 15, step: 1 },
      },
    ],

    // Challenge / Contest macro (shipped in the `challenge-contest` Macro
    // pack). These replace the legacy journal-page settings of the standalone
    // macro; the old journal data is intentionally NOT migrated. Defaults
    // mirror the old `ChallengeContestManager` page (see challengeContest.js).
    // Font size is intentionally NOT configurable: one fixed constant
    // multiplied by the module-wide `scale` setting.
    [
      "challengeFontFamily",
      {
        type: String,
        default: CHALLENGE_SETTING_DEFAULTS.challengeFontFamily,
        choices: {},
      },
    ],
    [
      "challengeAddBackground",
      {
        type: Boolean,
        default: CHALLENGE_SETTING_DEFAULTS.challengeAddBackground,
      },
    ],
    [
      "challengeBackgroundColor",
      {
        type: String,
        default: CHALLENGE_SETTING_DEFAULTS.challengeBackgroundColor,
      },
    ],
    [
      "challengeTextColor",
      {
        type: String,
        default: CHALLENGE_SETTING_DEFAULTS.challengeTextColor,
      },
    ],
    [
      "contestFontFamily",
      {
        type: String,
        default: CONTEST_SETTING_DEFAULTS.contestFontFamily,
        choices: {},
      },
    ],
    [
      "contestAddBackground",
      {
        type: Boolean,
        default: CONTEST_SETTING_DEFAULTS.contestAddBackground,
      },
    ],
    [
      "contestBackgroundColor",
      {
        type: String,
        default: CONTEST_SETTING_DEFAULTS.contestBackgroundColor,
      },
    ],
    [
      "contestTextColor",
      {
        type: String,
        default: CONTEST_SETTING_DEFAULTS.contestTextColor,
      },
    ],

    // Shared background texture of the Challenge / Contest macro: one setting
    // drives BOTH kinds of drawing. When set, each drawing is filled with the
    // texture (PATTERN fill, the background color is ignored); when empty the
    // `challengeAddBackground` / `contestAddBackground` color rule applies.
    // Registered like the other file-picker texture settings.
    [
      "challengeContestBackgroundTexture",
      {
        type: String,
        default:
          CHALLENGE_CONTEST_SETTING_DEFAULTS.challengeContestBackgroundTexture,
      },
    ],
  ];

  for (const [key, config] of SETTINGS) {
    const { i18n: nameKey = key, ...rest } = config;
    registerSetting(key, rest, nameKey);
  }

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

/**
 * Reads the current conflict board options from the settings (feature 5).
 * Safe outside Foundry: defaults come from the pure geometry/schema config
 * and every runtime read is guarded, so this helper never throws. Stored
 * `board.boardSize` still wins over the preset sizes here (see
 * `normalizeBoardSize` in conflictBoardGeometry.js). The returned background
 * maps directly onto `state.board.background` consumed by ConflictBoardSync.
 * @returns {{
 *   keys: string[],
 *   defaults: Record<string, number|string>,
 *   current: Record<string, number|string>,
 *   sizePresets: {small: number, medium: number, large: number},
 *   background: {color: string, texture: string, alpha: number},
 *   overflowPolicy: string
 * }}
 */
export function getConflictBoardOptions() {
  const defaults = { ...CONFLICT_BOARD_SETTING_DEFAULTS };
  const read = (key, fallback) => {
    // `typeof game` first: optional chaining on an undeclared identifier
    // would itself throw, so guard the identifier before touching settings.
    if (typeof game === "undefined" || typeof game?.settings?.get !== "function") {
      return fallback;
    }
    try {
      const value = game.settings.get(MODULE_ID, key);
      return value === undefined ? fallback : value;
    } catch (err) {
      console.warn("[fate-on-the-table] conflict board setting read failed:", err);
      return fallback;
    }
  };
  const size = (key) =>
    Math.max(
      Math.min(Number(read(key, defaults[key])) || defaults[key], 4000),
      100,
    );
  const alpha = (key) =>
    Math.min(Math.max(Number(read(key, defaults[key])) || 0, 0), 1);
  const str = (key) => String(read(key, defaults[key]) ?? "");

  return {
    keys: [...CONFLICT_BOARD_SETTING_KEYS],
    defaults,
    current: Object.fromEntries(
      CONFLICT_BOARD_SETTING_KEYS.map((key) => [key, read(key, defaults[key])]),
    ),
    sizePresets: {
      small: size("conflictBoardSizeSmall"),
      medium: size("conflictBoardSizeMedium"),
      large: size("conflictBoardSizeLarge"),
    },
    background: {
      color: str("conflictBoardBackgroundColor"),
      texture: str("conflictBoardBackgroundTexture"),
      alpha: alpha("conflictBoardBackgroundAlpha"),
    },
    overflowPolicy: String(
      read("conflictBoardOverflowPolicy", defaults.conflictBoardOverflowPolicy),
    ),
  };
}

/**
 * Name generation settings helpers (pure-ish, testable).
 */
export function isNameGenEnabled() {
  try {
    if (typeof game === "undefined" || typeof game?.settings?.get !== "function") return true;
    const v = game.settings.get(MODULE_ID, "nameGenEnable");
    if (v === undefined) return true;
    return !!v;
  } catch {
    return true;
  }
}

export function getNameGenOptions() {
  const read = (key, fallback) => {
    if (typeof game === "undefined" || typeof game?.settings?.get !== "function") return fallback;
    try {
      const v = game.settings.get(MODULE_ID, key);
      return v === undefined ? fallback : v;
    } catch {
      return fallback;
    }
  };
  let min = Number(read("nameGenMinLength", 6));
  let max = Number(read("nameGenMaxLength", 9));
  if (!Number.isFinite(min)) min = 6;
  if (!Number.isFinite(max)) max = 9;
  min = Math.max(3, Math.min(15, Math.floor(min)));
  max = Math.max(3, Math.min(15, Math.floor(max)));
  if (min > max) {
    const t = min;
    min = max;
    max = t;
  }
  const language = String(read("nameGenLanguage", "random") ?? "random");
  return { min, max, language };
}

function getFontList() {
  try {
    return foundry.applications.settings.menus.FontConfig.getAvailableFonts();
  } catch (err) {
    console.error("[fate-on-the-table] Failed to list fonts:", err);
    return [];
  }
}

/**
 * Enhances the standard settings view: refreshes the font selects with the
 * currently registered fonts and adds file picker buttons to image settings.
 */
function onRenderSettingsConfig(app, html) {
  openSettingsConfig = app;
  for (const key of [
    "fontFamily",
    "situationAspectsFontFamily",
    "challengeFontFamily",
    "contestFontFamily",
  ]) {
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
    let hasCurrent = false;
    for (const font of getFontList()) {
      const option = document.createElement("option");
      option.value = font;
      option.textContent = font;
      if (font === current) {
        option.selected = true;
        hasCurrent = true;
      }
      fontInput.append(option);
    }
    // Keep a configured font selectable even when it is not a registered game
    // font (e.g. the legacy Montserrat default of the Challenge/Contest macro).
    if (current && !hasCurrent) {
      const option = document.createElement("option");
      option.value = current;
      option.textContent = current;
      option.selected = true;
      fontInput.append(option);
    }
  }

  for (const key of [
    "textColor",
    "situationAspectsTextColor",
    "situationAspectsBackgroundColor",
    "conflictBoardBackgroundColor",
    "challengeTextColor",
    "challengeBackgroundColor",
    "contestTextColor",
    "contestBackgroundColor",
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
    "conflictBoardBackgroundTexture",
    "challengeContestBackgroundTexture",
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
