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
 *  2. Otherwise asks what to create (Challenge or Contest), collects the rows
 *     and enters PlacementManager's click-to-place mode (move the mouse to
 *     position, left-click to commit, right-click / Esc to cancel):
 *     - Challenge: ONE Drawing (`challengeDrawingData`) with one text line per
 *       task (status mark prefix), fill/texture on the drawing itself; the
 *       task state lives in its module flags. Move stays native; resize is
 *       normalised to independent axes by `drawingFreeResize.js`.
 *     - Contest: ONE Drawing with all sides (`"<name>: [   ]…"` rows).
 *
 * Settings come from the standard module settings (`game.settings`, scope
 * `fate-on-the-table`); the journal-based settings of the old macro are NOT
 * read. Pure text/payload building lives in `challengeContest.js` and
 * `utils.js` provides `escapeHtml` / `dialogField` — both imported statically
 * so a renamed helper fails at module load instead of at macro run.
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
} from "./challengeContest.js";
import { escapeHtml, dialogField } from "./utils.js";

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

  // --- Settings (defaults match the legacy ChallengeContestManager page). ---
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

  // Module-wide `scale` setting: multiplies the whole created block (font size,
  // width/height and the contest row pitch). Invalid/missing -> 1.
  const readScale = () => {
    try {
      const n = Number(game?.settings?.get?.(MODULE_ID, "scale"));
      return Number.isFinite(n) && n > 0 ? n : 1;
    } catch (err) {
      console.warn("[fate-on-the-table] scale setting read failed:", err);
      return 1;
    }
  };
  const scale = readScale();

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
  if (!DIALOG?.input) {
    console.error("[fate-on-the-table] DialogV2.input is unavailable");
    notify("error", "challenge.moduleMissing");
    return;
  }

  // --- Dialog helpers (DialogV2.input, the module's standard pattern). ------
  const okCancel = (okKey) => ({
    ok: { label: t(okKey) },
    cancel: { label: t("challenge.cancel") },
  });

  const promptType = async () => {
    const content = `<div class="form-group"><label for="ctt-type">${escapeHtml(
      t("challenge.typePrompt"),
    )}</label><select id="ctt-type" name="type"><option value="challenge">${escapeHtml(
      t("challenge.typeChallenge"),
    )}</option><option value="contest">${escapeHtml(
      t("challenge.typeContest"),
    )}</option></select></div>`;
    const result = await DIALOG.input({
      window: { title: t("challenge.typeTitle") },
      content,
      ...okCancel("challenge.next"),
      rejectClose: false,
    });
    const value = dialogField(result, "type");
    return value === "challenge" || value === "contest" ? value : null;
  };

  const promptCount = async ({ titleKey, promptKey, id, value, min, max }) => {
    const content = `<div class="form-group"><label for="ctt-${id}">${escapeHtml(
      t(promptKey),
    )}</label><input type="number" id="ctt-${id}" name="count" value="${value}" min="${min}" max="${max}"></div>`;
    const result = await DIALOG.input({
      window: { title: t(titleKey) },
      content,
      ...okCancel("challenge.next"),
      rejectClose: false,
    });
    const parsed = parseInt(dialogField(result, "count"), 10);
    return Number.isFinite(parsed) ? parsed : null;
  };

  const promptItems = async (count) => {
    let fields = `<div class="form-group"><label>${escapeHtml(
      t("challenge.tasksHeader"),
    )}</label><label>${escapeHtml(t("challenge.difficultyHeader"))}</label></div>`;
    for (let i = 1; i <= count; i++) {
      fields += `<div class="form-group"><input type="text" name="line${i}" placeholder="${escapeHtml(
        t("challenge.taskPlaceholder", { index: i }),
      )}"><input type="number" name="difficulty${i}" value="2" min="0"></div>`;
    }
    const result = await DIALOG.input({
      window: { title: t("challenge.itemsTitle") },
      content: `<form>${fields}</form>`,
      ...okCancel("challenge.create"),
      rejectClose: false,
    });
    if (!result || typeof result !== "object") return null;
    const tasks = [];
    for (let i = 1; i <= count; i++) {
      const text = dialogField(result, `line${i}`);
      if (text !== undefined && text !== null && String(text).trim() !== "") {
        const difficulty = parseInt(dialogField(result, `difficulty${i}`), 10);
        tasks.push({
          text: String(text),
          difficulty: Number.isFinite(difficulty) ? difficulty : 2,
          status: "pending",
        });
      }
    }
    return tasks;
  };

  const promptSides = async (count) => {
    let fields = `<div class="form-group"><label>${escapeHtml(
      t("challenge.sidesHeader"),
    )}</label><label>${escapeHtml(t("challenge.boxesHeader"))}</label></div>`;
    for (let i = 1; i <= count; i++) {
      fields += `<div class="form-group"><input type="text" name="side${i}" placeholder="${escapeHtml(
        t("challenge.sidePlaceholder", { index: i }),
      )}"><input type="number" name="boxes${i}" value="3" min="1" max="20"></div>`;
    }
    const result = await DIALOG.input({
      window: { title: t("challenge.sidesTitle") },
      content: `<form>${fields}</form>`,
      ...okCancel("challenge.create"),
      rejectClose: false,
    });
    if (!result || typeof result !== "object") return null;
    const sides = [];
    for (let i = 1; i <= count; i++) {
      const name = dialogField(result, `side${i}`);
      const boxes = parseInt(dialogField(result, `boxes${i}`), 10);
      sides.push({
        name:
          name !== undefined && name !== null && String(name).trim() !== ""
            ? String(name)
            : t("challenge.defaultSide", { index: i }),
        boxes: Number.isFinite(boxes) ? boxes : 3,
        done: 0,
      });
    }
    return sides;
  };

  // --- Drawing creation. ----------------------------------------------------
  // `type` selects the text/shape data model; mirrors the module's own
  // WidgetBuilder.getRectangleType() fallback chain (v14).
  const drawingType = () =>
    globalThis.CONST?.DRAWING_TYPES?.RECTANGLE ??
    globalThis.foundry?.data?.ShapeData?.TYPES?.RECTANGLE ??
    "r";

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
  const createChallenge = async (tasks) => {
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
  const createContest = async (sides) => {
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

  // --- Flow. ----------------------------------------------------------------
  const type = await promptType();
  if (!type) return;

  if (type === "challenge") {
    const count = await promptCount({
      titleKey: "challenge.countTitle",
      promptKey: "challenge.challengeCountPrompt",
      id: "challenge-count",
      value: 3,
      min: 1,
      max: 20,
    });
    if (!count || count <= 0) return;
    const tasks = await promptItems(count);
    if (!tasks || tasks.length === 0) return;
    await createChallenge(tasks);
  } else {
    const count = await promptCount({
      titleKey: "challenge.sideCountTitle",
      promptKey: "challenge.sideCountPrompt",
      id: "side-count",
      value: 2,
      min: 1,
      max: 10,
    });
    if (!count || count <= 0) return;
    const sides = await promptSides(count);
    if (!sides || sides.length === 0) return;
    await createContest(sides);
  }
}
