/**
 * challengeContestMacro — thin Foundry glue behind the shipped
 * `challenge-contest` Macro compendium pack.
 *
 * Why this file exists: Foundry snapshots a hotbar macro into the world when
 * it is dragged there, so the old inline macro kept its own copy of the code
 * and went stale the moment the module changed (`challengeDrawingData is not a
 * function` regressions). The packed macro is now a thin launcher that calls
 * `module.api.challengeContest.run()` (registered in `module.js`), so every
 * world copy tracks the live module code.
 *
 * The ported flow:
 *  1. With exactly ONE controlled Drawing:
 *     - a NEW state-backed drawing (module flags ownerType challenge/contest)
 *       shows an info message pointing at the right-click context menu (the
 *       state lives in the flags, not in the text);
 *     - a LEGACY drawing with an unchecked box `[   ]` has its FIRST unchecked
 *       box checked (turn `[   ]` into `[ X ]`) — old objects are not adapted.
 *  2. Otherwise asks what to create (Challenge or Contest) with buttons, opens
 *     the row editor (defaults: three tasks / two sides) and enters
 *     PlacementManager's click-to-place mode (move the mouse to position,
 *     left-click to commit, right-click / Esc to cancel):
 *     - Challenge: ONE Drawing (`challengeDrawingData`) with one text line per
 *       task (status mark prefix), fill/texture on the drawing itself; the
 *       task state lives in its module flags. Move stays native; resize is
 *       normalised to independent axes by `drawingFreeResize.js`.
 *     - Contest: ONE Drawing with all sides (`"<name>: [   ]…"` rows).
 *
 * Settings come from the standard module settings (`game.settings`, scope
 * `fate-on-the-table`); the journal-based settings of the old macro are NOT
 * read. Pure text/payload building lives in `challengeContest.js` and
 * `utils.js` provides `escapeHtml` — both imported statically so a renamed
 * helper fails at module load instead of at macro run.
 *
 * Foundry v14 safe: no global `Drawing`/`Tile`/`Token` constructors are used
 * (documents are recognized via `documentName`), dialogs use
 * `foundry.applications.api.DialogV2` (referenced lazily), and drawing
 * creation is gated by the `DRAWING_CREATE` user permission (not GM status).
 * No top-level `foundry` / `game` / `canvas` access, so this module imports
 * cleanly in Node tests.
 */

import {
  MODULE_ID,
  FLAG_SCOPE,
  CHALLENGE_OWNER_TYPE,
  CONTEST_OWNER_TYPE,
} from "./constants.js";
import {
  challengeDrawingData,
  contestDrawingData,
  checkFirstUncheckedTask,
  CHALLENGE_CONTEST_SETTING_DEFAULTS,
  defaultChallengeTaskRows,
  defaultContestSideRows,
  editorTasksFromRows,
  editorSidesFromRows,
  normalizeTaskState,
  normalizeSideState,
  DEFAULT_TASK_DIFFICULTY,
  DEFAULT_SIDE_BOXES,
  DEFAULT_FONT_SIZE,
  TASK_STATUS,
} from "./challengeContest.js";
import { escapeHtml } from "./utils.js";

/** Localizes a module key. */
function t(key, data) {
  const full = `${MODULE_ID}.${key}`;
  return data ? game.i18n.format(full, data) : game.i18n.localize(full);
}

/** Sends a localized notification, never throwing. */
function notify(kind, key, data) {
  try {
    ui.notifications?.[kind]?.(t(key, data));
  } catch (err) {
    console.error("[fate-on-the-table] challenge/contest notification failed:", err);
  }
}

function readModuleSettings() {
  const readSetting = (key) => {
    const fallback = CHALLENGE_CONTEST_SETTING_DEFAULTS[key];
    try {
      if (typeof game?.settings?.get !== "function") return fallback;
      const value = game.settings.get(MODULE_ID, key);
      return value === undefined || value === null ? fallback : value;
    } catch (err) {
      console.warn(`[fate-on-the-table] setting "${key}" read failed:`, err);
      return fallback;
    }
  };
  const settings = {};
  for (const key of Object.keys(CHALLENGE_CONTEST_SETTING_DEFAULTS)) {
    settings[key] = readSetting(key);
  }
  return settings;
}

function readModuleScale() {
  try {
    const n = Number(game?.settings?.get?.(MODULE_ID, "scale"));
    return Number.isFinite(n) && n > 0 ? n : 1;
  } catch (err) {
    console.warn("[fate-on-the-table] scale setting read failed:", err);
    return 1;
  }
}

function drawingType() {
  return (
    globalThis.CONST?.DRAWING_TYPES?.RECTANGLE ??
    globalThis.foundry?.data?.ShapeData?.TYPES?.RECTANGLE ??
    "r"
  );
}

function editorRowMarkup(kind, row, index) {
  const isChallenge = kind === "challenge";
  const rawValue = isChallenge ? row.difficulty : row.boxes;
  const numericValue = Number.isFinite(Number(rawValue))
    ? Number(rawValue)
    : isChallenge
      ? DEFAULT_TASK_DIFFICULTY
      : DEFAULT_SIDE_BOXES;
  const min = isChallenge ? 0 : 1;
  const maxAttribute = isChallenge ? "" : ' max="20"';
  const textValue = isChallenge ? row.text : row.name;
  const placeholder = escapeHtml(
    t(isChallenge ? "challenge.taskPlaceholder" : "challenge.sidePlaceholder", {
      index: index + 1,
    }),
  );
  const numericTitle = escapeHtml(
    t(isChallenge ? "challenge.difficultyHeader" : "challenge.boxesHeader"),
  );
  const removeTitle = escapeHtml(
    t(isChallenge ? "challenge.removeTask" : "challenge.removeSide"),
  );
  const status = isChallenge ? String(row.status ?? TASK_STATUS.PENDING) : "";
  const done = isChallenge ? "" : String(row.done ?? 0);
  return `<div class="ctt-editor-row" data-ctt-row data-ctt-status="${escapeHtml(status)}" data-ctt-done="${escapeHtml(done)}"><input type="text" name="ctt-text-${index}" data-ctt-text value="${escapeHtml(textValue ?? "")}" placeholder="${placeholder}"><input type="number" name="ctt-value-${index}" data-ctt-value value="${numericValue}" min="${min}"${maxAttribute} step="1" inputmode="numeric" title="${numericTitle}"><button type="button" class="ctt-editor-remove" data-ctt-remove title="${removeTitle}" aria-label="${removeTitle}"><i class="fas fa-trash"></i></button></div>`;
}

function buildEditorContent(kind, rows) {
  const isChallenge = kind === "challenge";
  const textHeader = escapeHtml(
    t(isChallenge ? "challenge.tasksHeader" : "challenge.sidesHeader"),
  );
  const valueHeader = escapeHtml(
    t(isChallenge ? "challenge.difficultyHeader" : "challenge.boxesHeader"),
  );
  const addLabel = escapeHtml(t(isChallenge ? "challenge.addTask" : "challenge.addSide"));
  const list = Array.isArray(rows) ? rows : [];
  const rowsHtml = list
    .map((row, index) => editorRowMarkup(kind, row, index))
    .join("");
  return `<div class="ctt-editor" data-ctt-editor="${kind}"><div class="ctt-editor-head"><span>${textHeader}</span><span>${valueHeader}</span><span></span></div><div class="ctt-editor-rows" data-ctt-rows>${rowsHtml}</div><button type="button" class="ctt-editor-add" data-ctt-add><i class="fas fa-plus"></i> ${addLabel}</button></div>`;
}

function createEditorRow(kind, index) {
  const row =
    kind === "challenge"
      ? { text: "", difficulty: DEFAULT_TASK_DIFFICULTY, status: TASK_STATUS.PENDING }
      : { name: "", boxes: DEFAULT_SIDE_BOXES, done: 0 };
  const wrapper = document.createElement("div");
  wrapper.innerHTML = editorRowMarkup(kind, row, index);
  return wrapper.firstElementChild;
}

function bindEditorRows(root, kind) {
  const list = root.querySelector("[data-ctt-rows]");
  const addButton = root.querySelector("[data-ctt-add]");
  if (!list || !addButton) return;
  let nextIndex = list.querySelectorAll("[data-ctt-row]").length;
  const refresh = () => {
    const rows = [...list.querySelectorAll("[data-ctt-row]")];
    for (const row of rows) {
      const button = row.querySelector("[data-ctt-remove]");
      if (button) button.disabled = rows.length <= 1;
    }
  };
  addButton.addEventListener("click", () => {
    list.append(createEditorRow(kind, nextIndex++));
    refresh();
  });
  list.addEventListener("click", (event) => {
    const button = event.target?.closest?.("[data-ctt-remove]");
    if (!button) return;
    if (list.querySelectorAll("[data-ctt-row]").length <= 1) return;
    button.closest("[data-ctt-row]")?.remove();
    refresh();
  });
  refresh();
}

function createEditorDialogClass(DIALOG) {
  return class ChallengeContestEditorDialog extends DIALOG {
    async _onRender(context, options) {
      await super._onRender?.(context, options);
      const root = this.element;
      if (!root) return;
      const editor = root.querySelector("[data-ctt-editor]");
      if (!editor) return;
      bindEditorRows(root, editor.dataset.cttEditor);
    }
  };
}

function readEditorRows(root, kind) {
  const rows = Array.from(root.querySelectorAll("[data-ctt-row]")).map((row) => {
    const text = String(row.querySelector("[data-ctt-text]")?.value ?? "");
    const numeric = parseInt(row.querySelector("[data-ctt-value]")?.value ?? "", 10);
    if (kind === "challenge") {
      return {
        text,
        difficulty: Number.isFinite(numeric) ? numeric : DEFAULT_TASK_DIFFICULTY,
        status: row.dataset.cttStatus || TASK_STATUS.PENDING,
      };
    }
    return {
      name: text,
      boxes: Number.isFinite(numeric) ? numeric : DEFAULT_SIDE_BOXES,
      done: parseInt(row.dataset.cttDone ?? "0", 10) || 0,
    };
  });
  return kind === "challenge"
    ? editorTasksFromRows(rows)
    : editorSidesFromRows(rows, (index) =>
        t("challenge.defaultSide", { index: index + 1 }),
      );
}

async function promptEditor(kind, rows, { titleKey, okKey }) {
  const DIALOG = globalThis.foundry?.applications?.api?.DialogV2;
  if (!DIALOG?.wait) {
    notify("error", "challenge.moduleMissing");
    return null;
  }
  const EditorDialog = createEditorDialogClass(DIALOG);
  const result = await EditorDialog.wait({
    classes: ["ctt-challenge-contest-editor"],
    window: { title: t(titleKey) },
    position: { width: 560 },
    content: buildEditorContent(kind, rows),
    buttons: [
      {
        action: "save",
        label: t(okKey),
        default: true,
        callback: (event, button, dialog) =>
          readEditorRows(dialog.element, kind),
      },
      {
        action: "cancel",
        label: t("challenge.cancel"),
        callback: () => null,
      },
    ],
    rejectClose: false,
  });
  return result ?? null;
}

/**
 * Runs the whole Challenge / Contest flow. Exposed through
 * `module.api.challengeContest.run()` for the shipped macro; never called at
 * import time.
 * @returns {Promise<void>}
 */
export async function runChallengeContest() {
  const DIALOG = globalThis.foundry?.applications?.api?.DialogV2;
  // Lazy import: PlacementManager's import chain (settings.js ->
  // LayoutImportExport.js) touches `foundry` at module top level, so a static
  // import here would break the Node-safety contract of this thin glue.
  const { PlacementManager } = await import("./PlacementManager.js");

  const settings = readModuleSettings();
  const scale = readModuleScale();

  // --- Drawing recognition / controlled selection (v14, no `instanceof`). ---
  const asDocument = (entry) => entry?.document ?? entry;
  const isDrawing = (entry) => asDocument(entry)?.documentName === "Drawing";

  const controlledEntries = Array.from(
    canvas?.activeLayer?.controlled ?? canvas?.drawings?.controlled ?? [],
  );

  // Branch 1: a single selected Drawing -> toggle its first unchecked box.
  if (controlledEntries.length === 1 && isDrawing(controlledEntries[0])) {
    const document = asDocument(controlledEntries[0]);
    const ownerType = document.getFlag?.(MODULE_ID, "ownerType");
    // NEW state-backed drawing: the task/side state lives in the flags and is
    // edited through the right-click context menu, not by rewriting the text.
    if (ownerType === CHALLENGE_OWNER_TYPE || ownerType === CONTEST_OWNER_TYPE) {
      notify("info", "challengeContest.useContextMenu");
      return;
    }
    // LEGACY drawing (no module flags): keep the old first-unchecked toggle.
    const result = checkFirstUncheckedTask(document.text);
    if (result.changed) {
      await document.update({ text: result.text });
    } else {
      notify("info", "challenge.allChecked");
    }
    return;
  }

  // Branch 2: create a new challenge / contest.
  if (!canvas?.ready || !canvas?.scene) {
    notify("warn", "challenge.noScene");
    return;
  }
  if (!game.user.can("DRAWING_CREATE")) {
    notify("error", "challenge.noPermission");
    return;
  }
  if (!DIALOG?.wait) {
    console.error("[fate-on-the-table] DialogV2.wait is unavailable");
    notify("error", "challenge.moduleMissing");
    return;
  }

  const type = await promptType(DIALOG);
  if (!type) return;

  const rows =
    type === "challenge" ? defaultChallengeTaskRows() : defaultContestSideRows();
  const edited = await promptEditor(type, rows, {
    titleKey: type === "challenge" ? "challenge.itemsTitle" : "challenge.sidesTitle",
    okKey: "challenge.create",
  });
  if (!edited || edited.length === 0) return;

  if (type === "challenge") {
    await createChallenge(edited, { PlacementManager, settings, scale });
  } else {
    await createContest(edited, { PlacementManager, settings, scale });
  }
}

async function promptType(DIALOG) {
  const result = await DIALOG.wait({
    window: { title: t("challenge.typeTitle") },
    content: `<p>${escapeHtml(t("challenge.typePrompt"))}</p>`,
    buttons: [
      {
        action: "challenge",
        icon: "fa-solid fa-list",
        label: t("challenge.typeChallenge"),
        default: true,
        callback: () => "challenge",
      },
      {
        action: "contest",
        icon: "fa-solid fa-users",
        label: t("challenge.typeContest"),
        callback: () => "contest",
      },
      {
        action: "cancel",
        label: t("challenge.cancel"),
        callback: () => null,
      },
    ],
    rejectClose: false,
  });
  return result === "challenge" || result === "contest" ? result : null;
}

export async function editChallengeContestDocument(doc, scene = doc?.parent) {
  const ownerType = doc?.getFlag?.(FLAG_SCOPE, "ownerType");
  const isChallenge = ownerType === CHALLENGE_OWNER_TYPE;
  const isContest = ownerType === CONTEST_OWNER_TYPE;
  if (!isChallenge && !isContest) return;
  const kind = isChallenge ? "challenge" : "contest";
  const current = isChallenge
    ? normalizeTaskState(doc.getFlag(FLAG_SCOPE, "tasks"))
    : normalizeSideState(doc.getFlag(FLAG_SCOPE, "sides"));
  const rows = current.length
    ? current
    : isChallenge
      ? defaultChallengeTaskRows()
      : defaultContestSideRows();
  const edited = await promptEditor(kind, rows, {
    titleKey: isChallenge
      ? "challenge.editChallengeTitle"
      : "challenge.editContestTitle",
    okKey: "challenge.save",
  });
  if (!edited || edited.length === 0) return;
  const targetScene =
    scene ?? doc?.parent ?? (typeof canvas !== "undefined" ? canvas?.scene : undefined);
  if (!targetScene?.updateEmbeddedDocuments) return;
  const settings = readModuleSettings();
  const configuredScale = readModuleScale();
  const font = Number(doc.fontSize);
  const scale =
    Number.isFinite(font) && font > 0 ? font / DEFAULT_FONT_SIZE : configuredScale;
  const scopeFlags = doc.getFlag(FLAG_SCOPE) ?? {};
  const common = {
    type: doc.type ?? drawingType(),
    scale,
    fontFamily:
      doc.fontFamily ??
      (isChallenge ? settings.challengeFontFamily : settings.contestFontFamily),
    textColor:
      doc.textColor ??
      (isChallenge ? settings.challengeTextColor : settings.contestTextColor),
    addBackground: doc.fillType === 1,
    backgroundColor:
      doc.fillColor ??
      (isChallenge
        ? settings.challengeBackgroundColor
        : settings.contestBackgroundColor),
    backgroundTexture: doc.texture ?? "",
    widgetId: scopeFlags.widgetId ?? null,
  };
  const position = { x: Number(doc.x) || 0, y: Number(doc.y) || 0 };
  const data = isChallenge
    ? challengeDrawingData(edited, position, common)
    : contestDrawingData(edited, position, common);
  const flags = {
    ...(doc.flags ?? {}),
    [FLAG_SCOPE]: {
      ...scopeFlags,
      ...(isChallenge ? { tasks: edited } : { sides: edited }),
    },
  };
  await targetScene.updateEmbeddedDocuments(
    "Drawing",
    [{ _id: doc.id, text: data.text, shape: data.shape, flags }],
    { fateOnTheTableSync: true },
  );
}

  /**
   * Translates each block document to the placement anchor and stamps the
   * shared widget id into its module flags (the docs are built at the origin
   * so `placeGroup` can preview them under the cursor).
   */
  const positionedDocs = (docs, anchor, widgetId) =>
    docs.map((doc) => ({
      ...doc,
      x: Math.round(doc.x + anchor.x),
      y: Math.round(doc.y + anchor.y),
      flags: {
        ...doc.flags,
        [FLAG_SCOPE]: {
          ...(doc.flags?.[FLAG_SCOPE] ?? {}),
          widgetId,
        },
      },
    }));

  // Challenge is ONE Drawing holding every task (one text line per task, a
  // status mark prefix); move is native and resize is normalised to free axes
  // by drawingFreeResize.js (fontSize stays untouched).
  // Placement picks the top-left anchor with a click (as for every other
  // widget); Escape / right-click cancels.
  const createChallenge = async (tasks, { PlacementManager, settings, scale }) => {
    const data = challengeDrawingData(tasks, { x: 0, y: 0 }, {
      type: drawingType(),
      scale,
      fontFamily: settings.challengeFontFamily,
      textColor: settings.challengeTextColor,
      addBackground: settings.challengeAddBackground,
      backgroundColor: settings.challengeBackgroundColor,
      backgroundTexture: settings.challengeContestBackgroundTexture,
    });
    const bounds = {
      x: 0,
      y: 0,
      width: data.shape?.width ?? 0,
      height: data.shape?.height ?? 0,
    };
    await PlacementManager.placeGroup({
      docs: [data],
      bounds,
      label: t("challenge.typeChallenge"),
      options: { scale },
      hintKey: `${MODULE_ID}.challenge.placeHint`,
      successKey: `${MODULE_ID}.challenge.placeSuccess`,
      commit: async (anchor, widgetId) => {
        await canvas.scene.createEmbeddedDocuments(
          "Drawing",
          positionedDocs([data], anchor, widgetId),
          { fateOnTheTableSync: true },
        );
        notify("info", "challenge.createdChallenge", { count: tasks.length });
      },
    });
  };

  // Contest is ONE drawing holding every side (one text line per side); resize
  // is normalised to free axes by drawingFreeResize.js. Placement is the same
  // click flow.
  const createContest = async (sides, { PlacementManager, settings, scale }) => {
    const data = contestDrawingData(sides, { x: 0, y: 0 }, {
      type: drawingType(),
      scale,
      fontFamily: settings.contestFontFamily,
      textColor: settings.contestTextColor,
      addBackground: settings.contestAddBackground,
      backgroundColor: settings.contestBackgroundColor,
      backgroundTexture: settings.challengeContestBackgroundTexture,
    });
    const bounds = {
      x: 0,
      y: 0,
      width: data.shape?.width ?? 0,
      height: data.shape?.height ?? 0,
    };
    await PlacementManager.placeGroup({
      docs: [data],
      bounds,
      label: t("challenge.typeContest"),
      options: { scale },
      hintKey: `${MODULE_ID}.challenge.placeHint`,
      successKey: `${MODULE_ID}.challenge.placeSuccess`,
      commit: async (anchor, widgetId) => {
        await canvas.scene.createEmbeddedDocuments(
          "Drawing",
          positionedDocs([data], anchor, widgetId),
          { fateOnTheTableSync: true },
        );
        notify("info", "challenge.createdContest", { count: sides.length });
      },
    });
  };
