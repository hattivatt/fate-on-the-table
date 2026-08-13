/**
 * SituationAspectManager — GM dialog for managing the situation aspects of
 * the active scene (`fate-core-official.situation_aspects`), placing /
 * repositioning / removing the situation aspects widget, and editing the
 * aspect list (add, rename, remove, free_invokes +/-).
 *
 * The dialog edits live: every change (add, rename, remove, free_invokes
 * +/-) is written to the scene flag with one `scene.setFlag` and re-syncs an
 * already placed widget immediately — there is no separate Save step. The
 * same dialog is opened from the GM-only scene control tool and by a
 * double-click on any part of the placed widget (GM only — players see the
 * widget but never get the editor).
 */

import { PlacementManager } from "./PlacementManager.js";
import { toDocumentData } from "./WidgetBuilder.js";
import { getPlacementOptions, getSituationAspectOptions } from "./settings.js";
import {
  situationAspects,
  saRegistry,
  buildSaTextDoc,
  buildSaFrameDoc,
  buildSaBackgroundDoc,
  removeSituationAspectWidget,
  syncSituationAspects,
} from "./SituationAspectSync.js";
import {
  MODULE_ID,
  FLAG_SCOPE,
  SITUATION_ASPECTS_SCOPE,
  SITUATION_ASPECTS_KEY,
  SITUATION_ASPECTS_WIDGET_FLAG,
  SA_OWNER_TYPE,
} from "./constants.js";

const DIALOG_ID = "fate-on-the-table-situation-aspects";

/** True while a dialog operation is running (double-click guard). */
let busy = false;

export class SituationAspectManager {
  /** Opens the manager dialog (GM only). */
  static open() {
    if (!game.user.isGM) {
      ui.notifications.warn(
        game.i18n.localize(`${MODULE_ID}.situationAspects.gmOnly`),
      );
      return;
    }
    const existing = foundry.applications.instances.get(DIALOG_ID);
    // A closing application is still registered while close() runs; do not
    // re-render it (that would reopen the dialog) or duplicate it (the old
    // close would drop the new instance from the registry).
    if (existing && !existing.closing) {
      // Re-read the scene data so the dialog never shows a stale draft.
      existing.aspects = situationAspects(canvas?.scene);
      existing.addOpen = false;
      existing.renameIndex = null;
      existing.addName = "";
      existing.addInvokes = 1;
      existing.addCharacter = "";
      existing.render({ force: true });
      return;
    }
    new SituationAspectsDialog().render({ force: true });
  }

  /**
   * Places (or repositions) the situation aspects widget. Entry point for
   * the Fate Utilities button: uses the open dialog's draft when present,
   * otherwise the current scene data.
   * @returns {Promise<void>}
   */
  static placeWidget() {
    const app = foundry.applications.instances.get(DIALOG_ID);
    const aspects = app?.aspects ?? situationAspects(canvas?.scene);
    return placeWidget(aspects);
  }
}

class SituationAspectsDialog extends foundry.applications.api.ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: DIALOG_ID,
    classes: ["fate-on-the-table", "situation-aspects"],
    position: { width: 460 },
    // Foundry localizes window.title itself — pass the raw i18n key.
    window: {
      title: `${MODULE_ID}.situationAspects.title`,
    },
    tag: "form",
    form: { submitOnChange: false, closeOnSubmit: false },
    actions: {
      invokePlus: (event, target) => runAction(target, "invoke-plus"),
      invokeMinus: (event, target) => runAction(target, "invoke-minus"),
      rename: (event, target) => runAction(target, "rename"),
      remove: (event, target) => runAction(target, "remove"),
      add: (event, target) => runAction(target, "add"),
      addSubmit: (event, target) => runAction(target, "add-submit"),
      addCancel: (event, target) => runAction(target, "add-cancel"),
      renameSubmit: (event, target) => runAction(target, "rename-submit"),
      renameCancel: (event, target) => runAction(target, "rename-cancel"),
      close: (event, target) => runAction(target, "close"),
      place: (event, target) => runAction(target, "place"),
      removeWidget: (event, target) => runAction(target, "remove-widget"),
    },
  };

  constructor() {
    super();
    this.aspects = situationAspects(canvas?.scene);
    this.addOpen = false;
    this.renameIndex = null;
    this.addName = "";
    this.addInvokes = 1;
    this.addCharacter = "";
  }

  async _renderHTML(context, options) {
    const div = document.createElement("div");
    div.innerHTML = renderContent(this);
    return div;
  }

  _replaceHTML(result, content, options) {
    content.innerHTML = "";
    content.append(result);
    if (this.addOpen) {
      content.querySelector?.('input[name="ctt-sa-name"]')?.focus?.();
    } else if (this.renameIndex !== null) {
      const input = content.querySelector?.(".ctt-sa-renaming input");
      input?.focus?.();
      input?.select?.();
    }
  }

  _onClose(options) {
    busy = false;
  }
}

function escapeHtml(text) {
  return String(text ?? "").replace(/[&<>"']/g, (c) => {
    const map = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return map[c];
  });
}

/**
 * Unique, sorted token names of the active scene — the character choices
 * for the aspect binding popup (token names, exactly like the system's
 * "add track aspect" button uses actor names).
 * @returns {string[]}
 */
function characterOptions() {
  const scene = canvas?.scene;
  if (!scene) return [];
  return [
    ...new Set(
      scene.tokens
        .map((t) => String(t.name ?? "").trim())
        .filter((n) => n.length > 0),
    ),
  ].sort((a, b) => a.localeCompare(b));
}

function renderContent(app) {
  const t = (key) => game.i18n.localize(`${MODULE_ID}.${key}`);
  const placed = !!saRegistry()?.widgetId;

  let listHtml = "";
  if (!app.aspects.length) {
    listHtml = `<p class="ctt-sa-empty">${escapeHtml(
      t("situationAspects.empty"),
    )}</p>`;
  }
  app.aspects.forEach((aspect, i) => {
    if (app.renameIndex === i) {
      listHtml += `
        <div class="ctt-sa-row ctt-sa-renaming">
          <div class="ctt-sa-form">
            <input type="text" name="ctt-sa-name" value="${escapeHtml(
              aspect.name,
            )}">
            <button type="button" class="ctt-sa-btn" data-action="renameSubmit" title="${escapeHtml(
              t("situationAspects.confirm"),
            )}"><i class="fas fa-check"></i></button>
            <button type="button" class="ctt-sa-btn" data-action="renameCancel" title="${escapeHtml(
              t("situationAspects.cancel"),
            )}"><i class="fas fa-times"></i></button>
          </div>
        </div>`;
      return;
    }
    listHtml += `
      <div class="ctt-sa-row">
        <span class="ctt-sa-name" title="${escapeHtml(aspect.name)}">${escapeHtml(
          aspect.name,
        )}</span>
        <span class="ctt-sa-invokes">(${aspect.free_invokes})</span>
        <div class="ctt-sa-actions">
          <button type="button" class="ctt-sa-btn" data-action="invokePlus" data-index="${i}" title="${escapeHtml(
            t("situationAspects.giveInvoke"),
          )}"><i class="fas fa-plus"></i></button>
          <button type="button" class="ctt-sa-btn" data-action="invokeMinus" data-index="${i}" title="${escapeHtml(
            t("situationAspects.takeInvoke"),
          )}"><i class="fas fa-minus"></i></button>
          <button type="button" class="ctt-sa-btn" data-action="rename" data-index="${i}" title="${escapeHtml(
            t("situationAspects.rename"),
          )}"><i class="fas fa-pen"></i></button>
          <button type="button" class="ctt-sa-btn" data-action="remove" data-index="${i}" title="${escapeHtml(
            t("situationAspects.remove"),
          )}"><i class="fas fa-trash"></i></button>
        </div>
      </div>`;
  });

  const addForm = app.addOpen
    ? `
      <div class="ctt-sa-row">
        <div class="ctt-sa-add-form">
          <input type="text" name="ctt-sa-name" value="${escapeHtml(
            app.addName,
          )}" placeholder="${escapeHtml(t("situationAspects.addName"))}">
          <div class="ctt-sa-add-options">
            <input type="number" name="ctt-sa-invokes" value="${app.addInvokes}" min="0" title="${escapeHtml(
              t("situationAspects.addInvokes"),
            )}">
            <select name="ctt-sa-character" title="${escapeHtml(
              t("situationAspects.addCharacter"),
            )}">
              <option value="" ${app.addCharacter ? "" : "selected"}>—</option>
              ${characterOptions()
                .map(
                  (n) =>
                    `<option value="${escapeHtml(n)}" ${
                      app.addCharacter === n ? "selected" : ""
                    }>${escapeHtml(n)}</option>`,
                )
                .join("")}
            </select>
            <button type="button" class="ctt-sa-btn" data-action="addSubmit" title="${escapeHtml(
              t("situationAspects.confirm"),
            )}"><i class="fas fa-check"></i></button>
            <button type="button" class="ctt-sa-btn" data-action="addCancel" title="${escapeHtml(
              t("situationAspects.cancel"),
            )}"><i class="fas fa-times"></i></button>
          </div>
        </div>
      </div>`
    : "";

  return `
    <div class="ctt-sa-manager">
      <div class="ctt-sa-section">
        <h3>${escapeHtml(t("situationAspects.listHeader"))}</h3>
        ${listHtml}
        <div class="ctt-sa-actions-row">
          <button type="button" class="ctt-sa-btn-wide" data-action="add" ${app.addOpen ? "disabled" : ""}>
            <i class="fas fa-plus"></i> ${escapeHtml(t("situationAspects.add"))}
          </button>
        </div>
        ${addForm}
      </div>
      <div class="ctt-sa-section">
        <h3>${escapeHtml(t("situationAspects.widgetHeader"))}</h3>
        <div class="ctt-sa-actions-row">
          <button type="button" class="ctt-sa-btn-wide" data-action="place">
            <i class="fas ${placed ? "fa-arrows-alt" : "fa-level-down-alt"}"></i>
            ${escapeHtml(
              t(placed ? "situationAspects.reposition" : "situationAspects.place"),
            )}
          </button>
          <button type="button" class="ctt-sa-btn-wide" data-action="removeWidget" ${placed ? "" : "disabled"}>
            <i class="fas fa-level-up-alt"></i>
            ${escapeHtml(t("situationAspects.removeWidget"))}
          </button>
        </div>
      </div>
      <div class="ctt-sa-section">
        <div class="ctt-sa-actions-row">
          <button type="button" class="ctt-sa-btn-wide" data-action="close">
            <i class="fas fa-times"></i> ${escapeHtml(t("situationAspects.close"))}
          </button>
        </div>
      </div>
    </div>`;
}

async function runAction(target, action) {
  if (busy) return;
  const app = foundry.applications.instances.get(DIALOG_ID);
  if (!app) return;
  busy = true;
  const element = target.closest(".situation-aspects");
  element?.classList.add("ctt-busy");
  try {
    switch (action) {
      case "invoke-plus":
        return await modifyInvokes(app, target, +1);
      case "invoke-minus":
        return await modifyInvokes(app, target, -1);
      case "rename":
        return beginRename(app, target);
      case "remove":
        return await removeAspect(app, target);
      case "add":
        return beginAdd(app);
      case "add-submit":
        return await submitAdd(app, target);
      case "add-cancel":
        return cancelAdd(app);
      case "rename-submit":
        return await submitRename(app, target);
      case "rename-cancel":
        return cancelRename(app);
      case "close":
        app.closing = true;
        return await app.close();
      case "place":
        return await placeWidget(app.aspects);
      case "remove-widget":
        return await removeWidget(app);
    }
  } catch (err) {
    console.error("[fate-on-the-table] situation aspects operation failed:", err);
    ui.notifications.error(
      game.i18n.localize(`${MODULE_ID}.situationAspects.error`),
    );
    // The failed write was not persisted — reset the dialog to the scene data.
    app.aspects = situationAspects(canvas?.scene);
    app.addOpen = false;
    app.renameIndex = null;
  } finally {
    busy = false;
    element?.classList.remove("ctt-busy");
    const live = foundry.applications.instances.get(DIALOG_ID);
    // A closing application is still registered while close() runs its
    // animation — never re-render it, that would reopen the dialog.
    if (live && !live.closing) live.render({ force: true });
  }
}

/** +/- on the aspect list; the invoke count never goes below zero. */
async function modifyInvokes(app, target, delta) {
  const index = Number(target.dataset.index);
  const aspect = app.aspects[index];
  if (!aspect) return;
  aspect.free_invokes = Math.max(
    0,
    (Number(aspect.free_invokes) || 0) + delta,
  );
  await commitAspects(app);
}

function beginRename(app, target) {
  app.renameIndex = Number(target.dataset.index);
  app.addOpen = false;
}

function beginAdd(app) {
  app.addName = "";
  app.addInvokes = 1;
  app.addCharacter = "";
  app.addOpen = true;
  app.renameIndex = null;
}

function cancelAdd(app) {
  app.addOpen = false;
}

function cancelRename(app) {
  app.renameIndex = null;
}

async function submitAdd(app, target) {
  const root = target.closest(".ctt-sa-manager");
  const name = String(
    root?.querySelector('input[name="ctt-sa-name"]')?.value ?? "",
  ).trim();
  const invokes = Math.max(
    0,
    Math.trunc(
      Number(root?.querySelector('input[name="ctt-sa-invokes"]')?.value || 1),
    ),
  );
  const character = String(
    root?.querySelector('select[name="ctt-sa-character"]')?.value ?? "",
  ).trim();
  // Keep the form state so a failed validation does not wipe the fields.
  app.addName = name;
  app.addInvokes = invokes;
  app.addCharacter = character;
  if (!name) {
    ui.notifications.warn(
      game.i18n.localize(`${MODULE_ID}.situationAspects.nameEmpty`),
    );
    return;
  }
  // Binding is textual, like the system's "add track aspect" button:
  // the character name goes in parentheses after the aspect text.
  const fullName = character ? `${name} (${character})` : name;
  app.aspects.push({ name: fullName, free_invokes: invokes });
  app.addOpen = false;
  await commitAspects(app);
}

async function submitRename(app, target) {
  const root = target.closest(".ctt-sa-manager");
  const name = String(
    root?.querySelector('input[name="ctt-sa-name"]')?.value ?? "",
  ).trim();
  if (!name) {
    ui.notifications.warn(
      game.i18n.localize(`${MODULE_ID}.situationAspects.nameEmpty`),
    );
    return;
  }
  const aspect = app.aspects[app.renameIndex];
  if (aspect) aspect.name = name;
  app.renameIndex = null;
  await commitAspects(app);
}

async function removeAspect(app, target) {
  const index = Number(target.dataset.index);
  const aspect = app.aspects[index];
  if (!aspect) return;
  const confirmed = await foundry.applications.api.DialogV2.confirm({
    window: {
      title: game.i18n.localize(`${MODULE_ID}.situationAspects.removeTitle`),
    },
    content: game.i18n.format(`${MODULE_ID}.situationAspects.removeConfirm`, {
      name: aspect.name,
    }),
    rejectClose: false,
  });
  if (!confirmed) return;
  app.aspects.splice(index, 1);
  if (app.renameIndex === index) app.renameIndex = null;
  await commitAspects(app);
}

/**
 * Live commit: writes the current list to the scene flag with one setFlag,
 * re-syncs an already placed widget and re-reads the scene data so the
 * dialog never shows a stale draft. Called after every edit — there is no
 * separate "Save" step.
 */
async function commitAspects(app) {
  const scene = canvas?.scene;
  if (!scene) {
    ui.notifications.warn(
      game.i18n.localize(`${MODULE_ID}.placement.noScene`),
    );
    return;
  }
  await scene.setFlag(
    SITUATION_ASPECTS_SCOPE,
    SITUATION_ASPECTS_KEY,
    app.aspects,
  );
  await syncSituationAspects(scene);
  app.aspects = situationAspects(scene);
}

/**
 * Places (or repositions) the situation aspects widget through the shared
 * PlacementManager. The given list is persisted first so the placed text
 * and the scene flag never diverge.
 * @param {object[]} aspects  Aspect list to place.
 */
async function placeWidget(aspects) {
  const scene = canvas?.scene;
  if (!scene) {
    ui.notifications.warn(
      game.i18n.localize(`${MODULE_ID}.placement.noScene`),
    );
    return;
  }
  const registry = saRegistry(scene);
  if (registry?.widgetId) {
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: {
        title: game.i18n.localize(
          `${MODULE_ID}.situationAspects.repositionTitle`,
        ),
      },
      content: game.i18n.localize(
        `${MODULE_ID}.situationAspects.repositionConfirm`,
      ),
      rejectClose: false,
    });
    if (!confirmed) return;
    await removeSituationAspectWidget(scene);
  }

  await scene.setFlag(
    SITUATION_ASPECTS_SCOPE,
    SITUATION_ASPECTS_KEY,
    aspects,
  );
  const normalized = situationAspects(scene);
  const opts = getSituationAspectOptions();
  const docs = [
    buildSaTextDoc(normalized, opts),
    buildSaFrameDoc(opts),
    buildSaBackgroundDoc(opts),
  ];

  await PlacementManager.placeGroup({
    docs,
    bounds: { x: 0, y: 0, width: opts.width, height: opts.height },
    label: game.i18n.localize(`${MODULE_ID}.situationAspects.placeLabel`),
    options: getPlacementOptions(),
    hintKey: `${MODULE_ID}.situationAspects.placeHint`,
    successKey: `${MODULE_ID}.situationAspects.placed`,
    commit: async (anchor, widgetId) => {
      const payloads = docs.map((doc) =>
        toDocumentData(
          { ...doc, x: doc.x + anchor.x, y: doc.y + anchor.y },
          {
            widgetId,
            part: doc.part,
            index: doc.index,
            ownerType: SA_OWNER_TYPE,
          },
        ),
      );
      await scene.createEmbeddedDocuments("Drawing", payloads);
      await scene.setFlag(FLAG_SCOPE, SITUATION_ASPECTS_WIDGET_FLAG, {
        widgetId,
        anchor,
      });
    },
  });
}

/** Removes the widget from the scene; the system aspects array is kept. */
async function removeWidget(app) {
  const scene = canvas?.scene;
  if (!scene) return;
  if (!saRegistry(scene)?.widgetId) return;
  const confirmed = await foundry.applications.api.DialogV2.confirm({
    window: {
      title: game.i18n.localize(
        `${MODULE_ID}.situationAspects.removeWidgetTitle`,
      ),
    },
    content: game.i18n.localize(
      `${MODULE_ID}.situationAspects.removeWidgetConfirm`,
    ),
    rejectClose: false,
  });
  if (!confirmed) return;
  const removed = await removeSituationAspectWidget(scene);
  if (removed) {
    ui.notifications.info(
      game.i18n.localize(`${MODULE_ID}.situationAspects.removeWidgetDone`),
    );
  }
}
