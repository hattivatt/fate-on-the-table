/**
 * SituationAspectManager — GM dialog for managing the situation aspects of
 * the active scene (`fate-core-official.situation_aspects`), placing /
 * repositioning / removing the situation aspects widget, and editing the
 * aspect list (add, inline edit (name / free invokes / character or zone
 * binding), remove, free_invokes +/-).
 *
 * The dialog edits live: every change (add, edit, remove, free_invokes
 * +/-) is written to the scene flag with one `scene.setFlag` and re-syncs an
 * already placed widget immediately — there is no separate Save step. The
 * same dialog is opened from the GM-only scene control tool and by a
 * double-click on any part of the placed widget (GM only — players see the
 * widget but never get the editor).
 *
 * Aspect binding: character is textual (Fate-Core-style) — `${base} (${choice})`;
 * zones are structural — `zoneIds: string[]` bound to the live conflict board.
 * The zone checkbox block exists only while a conflict board is actually placed
 * (`hasConflictBoardOnScene`); character and zone checkboxes are mutually exclusive.
 */

import { PlacementManager } from "./PlacementManager.js";
import { toDocumentData } from "./WidgetBuilder.js";
import { getPlacementOptions, getSituationAspectOptions } from "./settings.js";
import {
  situationAspects,
  saRegistry,
  buildSaTextDocs,
  buildSaFrameDoc,
  buildSaBackgroundDoc,
  removeSituationAspectWidget,
  syncSituationAspects,
} from "./SituationAspectSync.js";
import {
  hasConflictBoardOnScene,
  readConflictBoard,
} from "./ConflictBoardSync.js";
import { parseBinding } from "./situationAspectNames.js";
import {
  aspectZoneIds,
  normalizeZoneIds,
  applyAspectBinding,
} from "./situationAspectZones.js";
import {
  MODULE_ID,
  FLAG_SCOPE,
  SITUATION_ASPECTS_SCOPE,
  SITUATION_ASPECTS_KEY,
  SITUATION_ASPECTS_WIDGET_FLAG,
  SA_OWNER_TYPE,
} from "./constants.js";

const DIALOG_ID = "fate-on-the-table-situation-aspects";

/**
 * Module-level alias of the inline ADD-form helper (`beginAdd`, declared
 * further below — function declarations are hoisted). REQUIRED: the public
 * entry point `SituationAspectManager.open({ beginAdd })` destructures an
 * option of the SAME name, and that parameter lexically shadows this
 * function inside open()'s closures — calling plain `beginAdd(app)` from
 * there resolves to the boolean option and throws
 * "TypeError: beginAdd is not a function". The alias keeps the caller
 * contract intact (the FatePointManager widget menu passes
 * `{ beginAdd: true }`).
 */
const beginAddForm = beginAdd;

/** True while a dialog operation is running (double-click guard). */
let busy = false;

export class SituationAspectManager {
  /**
   * Opens the manager dialog (GM only).
   * @param {object} [options]
   * @param {number|null} [options.editIndex=null]  Aspect index to open
   *   directly in the inline EDIT form (entry point of the aspect context
   *   menu). Out-of-range/unknown indexes are ignored.
   * @param {boolean} [options.beginAdd=false]  Open with the inline ADD form
   *   expanded right away ("Add aspect" menu item). Ignored when an
   *   `editIndex` was armed — the edit form wins.
   */
  static open({ editIndex = null, beginAdd = false } = {}) {
    if (!game.user.isGM) {
      ui.notifications.warn(
        game.i18n.localize(`${MODULE_ID}.situationAspects.gmOnly`),
      );
      return;
    }
    const resetDraft = (app) => {
      // Re-read the scene data so the dialog never shows a stale draft.
      app.aspects = situationAspects(canvas?.scene);
      app.addOpen = false;
      app.renameIndex = null;
      app.addName = "";
      app.addInvokes = 1;
      app.addCharacter = "";
      app.addZoneIds = [];
    };
    const arm = (app) => {
      // beginAddForm, NOT beginAdd: inside this closure the identifier
      // `beginAdd` is the boolean option above (see the alias note at the
      // top of the module).
      if (!beginEdit(app, editIndex) && beginAdd) beginAddForm(app);
    };
    const existing = foundry.applications.instances.get(DIALOG_ID);
    // A closing application is still registered while close() runs; do not
    // re-render it (that would reopen the dialog) or duplicate it (the old
    // close would drop the new instance from the registry).
    if (existing && !existing.closing) {
      resetDraft(existing);
      arm(existing);
      existing.render({ force: true });
      return;
    }
    const dialog = new SituationAspectsDialog();
    arm(dialog);
    dialog.render({ force: true });
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

  /**
   * Removes the widget from the scene after confirmation; the system
   * aspects array is kept. Entry point for the widget context menu —
   * no-op when nothing is placed.
   * @returns {Promise<void>}
   */
  static removeWidget() {
    return removeWidget();
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
    this.addZoneIds = [];
    // Inline EDIT form draft (the renameIndex row). Kept on the app so the
    // automatic post-action re-render never wipes unsaved input.
    this.editName = "";
    this.editInvokes = 0;
    this.editCharacter = "";
    this.editZoneIds = [];
    // Whether the edited aspect carried a KNOWN binding (matched a token or
    // a structural zoneIds) when editing started — drives unknown-suffix preservation.
    this.editHadKnownBinding = false;
  }

  async _renderHTML(context, options) {
    const div = document.createElement("div");
    div.innerHTML = renderContent(this);
    return div;
  }

  _replaceHTML(result, content, options) {
    content.innerHTML = "";
    content.append(result);
    // The character select and zone checkboxes of BOTH inline forms are
    // mutually exclusive: picking one clears the other (onBindingSelectChange).
    // The delegated listener rides on the freshly attached subtree — exactly
    // one listener per render, never duplicated across re-renders.
    result.addEventListener("change", (event) =>
      onBindingSelectChange(this, event),
    );
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

/**
 * The zone binding block exists only while a conflict board is actually
 * placed on the active scene (valid state + registry widgetId).
 * @returns {boolean}
 */
function zonesAvailable() {
  return hasConflictBoardOnScene(canvas?.scene);
}

/**
 * One binding `<select>` with a leading empty option. Shared by the
 * character choice of the add and edit forms.
 * @param {string} name  Input name (`ctt-sa-character`).
 * @param {string} title  Localized title/tooltip of the select.
 * @param {string} emptyLabel  Text of the leading empty option.
 * @param {string[]} choices
 * @param {string} selected  Currently selected choice ('' = none).
 * @returns {string}
 */
function bindingSelectHtml(name, title, emptyLabel, choices, selected) {
  return `
    <select name="${name}" title="${escapeHtml(title)}">
      <option value="" ${selected ? "" : "selected"}>${escapeHtml(emptyLabel)}</option>
      ${choices
        .map(
          (n) =>
            `<option value="${escapeHtml(n)}" ${
              selected === n ? "selected" : ""
            }>${escapeHtml(n)}</option>`,
        )
        .join("")}
    </select>`;
}

/**
 * Live zone records of the active scene in storage order: `{id, name}`.
 * Empty/whitespace names filtered, order preserved. Requires a valid board
 * state via `readConflictBoard` (no registry check here — caller gates).
 * @returns {{id: string, name: string}[]}
 */
function liveZoneRecords() {
  const state = readConflictBoard(canvas?.scene);
  if (!state?.zones) return [];
  const out = [];
  for (const z of state.zones) {
    const id = String(z?.id ?? "").trim();
    const name = String(z?.name ?? "").trim();
    if (!id || !name) continue;
    out.push({ id, name });
  }
  return out;
}

/**
 * Multi-select zone block: a list of checkboxes (preferred for 2-6 zones).
 * Options come from the LIVE board (`readConflictBoard` → `state.zones`).
 * Returns '' when no board is placed or no zones exist.
 * @param {string[]} selectedIds
 * @returns {string}
 */
function zoneCheckboxesHtml(selectedIds) {
  if (!zonesAvailable()) return "";
  const zones = liveZoneRecords();
  if (!zones.length) return "";
  const t = (key) => game.i18n.localize(`${MODULE_ID}.${key}`);
  const label = t("situationAspects.addZone");
  const selectedSet = new Set(selectedIds ?? []);
  const boxes = zones
    .map(
      (z) =>
        `<label class="ctt-sa-zone-option"><input type="checkbox" name="ctt-sa-zone" value="${escapeHtml(
          z.id,
        )}" ${selectedSet.has(z.id) ? "checked" : ""}> ${escapeHtml(z.name)}</label>`,
    )
    .join("");
  return `<div class="ctt-sa-zones"><div class="ctt-sa-zones-label">${escapeHtml(
    label,
  )}</div><div class="ctt-sa-zones-options">${boxes}</div></div>`;
}

/** Zone names of an aspect resolved against the live board, in stored order. */
function zoneNamesForAspect(aspect) {
  const ids = aspectZoneIds(aspect);
  if (!ids.length) return [];
  const map = new Map(liveZoneRecords().map((z) => [z.id, z.name]));
  return ids.map((id) => map.get(id)).filter((n) => typeof n === "string" && n);
}

/**
 * Arms the inline EDIT form for `aspects[index]` — the pen button and the
 * public `SituationAspectManager.open({ editIndex })` entry point.
 * Out-of-range/unknown indexes are ignored silently. @returns {boolean}
 */
function beginEdit(app, index) {
  if (!Number.isInteger(index) || index < 0) return false;
  const aspect = app.aspects?.[index];
  if (!aspect) return false;
  app.renameIndex = index;
  app.addOpen = false;
  prepareEditDraft(app, aspect);
  return true;
}

/**
 * Fills the edit draft from an aspect: the name field shows the full name
 * verbatim; invokes are clamped to >= 0; the character select preselects
 * ONLY when the trailing `(suffix)` matches a known token name; zone
 * checkboxes are pre-checked from the structural `zoneIds` (filtered by
 * live board ids). An unrecognized suffix stays "no known binding"
 * (`editHadKnownBinding` is false), so saving without touching the inputs
 * keeps it verbatim.
 */
function prepareEditDraft(app, aspect) {
  const name = String(aspect?.name ?? "");
  const { suffix } = parseBinding(name);
  const characters = characterOptions();
  const boundCharacter = characters.includes(suffix) ? suffix : "";
  const liveZones = liveZoneRecords();
  const validIds = new Set(liveZones.map((z) => z.id));
  // Structural zone binding has priority over textual suffix.
  let zoneIds = aspectZoneIds(aspect).filter((id) => validIds.has(id));
  // If no structural binding, do NOT derive zone from suffix (structural only).
  // Character and zones are mutually exclusive for the draft.
  const hasZones = zoneIds.length > 0;
  const effectiveCharacter = hasZones ? "" : boundCharacter;
  if (hasZones) {
    // When zones are bound, ignore character suffix in hadKnownBinding.
    zoneIds = normalizeZoneIds(zoneIds, validIds);
  }
  app.editName = name;
  app.editInvokes = Math.max(0, Math.trunc(Number(aspect?.free_invokes) || 0));
  app.editCharacter = effectiveCharacter;
  app.editZoneIds = zoneIds;
  app.editHadKnownBinding = !!(effectiveCharacter || zoneIds.length > 0);
}

/**
 * Mutual exclusion of the binding inputs (delegated `change` listener from
 * the dialog root): picking a non-empty character clears all zone checkboxes
 * in the same row and vice versa (checking any zone clears the character
 * select). Setting the character back to empty or unchecking the last zone
 * leaves the other untouched. Draft state is kept in sync so any automatic
 * re-render preserves the visible choices.
 */
function onBindingSelectChange(app, event) {
  const el = event.target;
  if (!el) return;
  const isEdit = !!el.closest?.(".ctt-sa-renaming");
  if (el.name === "ctt-sa-character") {
    if (el.tagName !== "SELECT") return;
    const value = String(el.value ?? "").trim();
    if (isEdit) app.editCharacter = value;
    else app.addCharacter = value;
    if (value) {
      if (isEdit) app.editZoneIds = [];
      else app.addZoneIds = [];
      const row = el.closest?.(".ctt-sa-row");
      const checks = row?.querySelectorAll?.('input[name="ctt-sa-zone"]');
      checks?.forEach((c) => (c.checked = false));
    }
  } else if (el.name === "ctt-sa-zone") {
    if (el.type !== "checkbox") return;
    const row = el.closest?.(".ctt-sa-row");
    const checks = row?.querySelectorAll?.('input[name="ctt-sa-zone"]');
    const ids = checks ? [...checks].filter((c) => c.checked).map((c) => String(c.value)) : [];
    if (isEdit) app.editZoneIds = ids;
    else app.addZoneIds = ids;
    if (ids.length) {
      if (isEdit) app.editCharacter = "";
      else app.addCharacter = "";
      const other = row?.querySelector('select[name="ctt-sa-character"]');
      if (other) other.value = "";
    }
  }
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
              app.editName,
            )}">
            <input type="number" name="ctt-sa-invokes" value="${app.editInvokes}" min="0" title="${escapeHtml(
              t("situationAspects.addInvokes"),
            )}">
            ${bindingSelectHtml(
              "ctt-sa-character",
              t("situationAspects.addCharacter"),
              "—",
              characterOptions(),
              app.editCharacter,
            )}
            ${zoneCheckboxesHtml(app.editZoneIds)}
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
    const zoneNames = zoneNamesForAspect(aspect);
    const zoneHint = zoneNames.length
      ? `<span class="ctt-sa-zone-names" title="${escapeHtml(zoneNames.join(", "))}">${escapeHtml(zoneNames.join(", "))}</span>`
      : "";
    listHtml += `
      <div class="ctt-sa-row">
        <span class="ctt-sa-name" title="${escapeHtml(aspect.name)}">${escapeHtml(
          aspect.name,
        )}</span>
        ${zoneHint}
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
            ${bindingSelectHtml(
              "ctt-sa-character",
              t("situationAspects.addCharacter"),
              "—",
              characterOptions(),
              app.addCharacter,
            )}
            ${zoneCheckboxesHtml(app.addZoneIds)}
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
        return await removeWidget();
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
  // Delegates to beginEdit: fills the edit draft (name, invokes, binding
  // selects preselected from the parsed suffix) and hides the add form.
  beginEdit(app, Number(target.dataset.index));
}

function beginAdd(app) {
  app.addName = "";
  app.addInvokes = 1;
  app.addCharacter = "";
  app.addZoneIds = [];
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
  const zoneIdsRaw = [
    ...(root?.querySelectorAll('input[name="ctt-sa-zone"]:checked') ?? []),
  ].map((el) => String(el.value ?? "").trim()).filter((v) => v.length > 0);
  // Keep the form state so a failed validation does not wipe the fields.
  app.addName = name;
  app.addInvokes = invokes;
  app.addCharacter = character;
  app.addZoneIds = zoneIdsRaw;
  if (!name) {
    ui.notifications.warn(
      game.i18n.localize(`${MODULE_ID}.situationAspects.nameEmpty`),
    );
    return;
  }
  const validIds = liveZoneRecords().map((z) => z.id);
  const { name: finalName, zoneIds: finalZoneIds } = applyAspectBinding(
    name,
    { character, zoneIds: zoneIdsRaw },
    validIds,
  );
  const entry = { name: finalName, free_invokes: invokes };
  if (finalZoneIds.length) entry.zoneIds = finalZoneIds;
  app.aspects.push(entry);
  app.addOpen = false;
  await commitAspects(app);
}

/**
 * EDIT submit of the inline form (formerly rename-only): persists the name,
 * the free invokes and the character/zone binding of the aspect in one
 * commit. Validation failure keeps the row open with all drafts intact.
 */
async function submitRename(app, target) {
  const root = target.closest(".ctt-sa-manager");
  const name = String(
    root?.querySelector('input[name="ctt-sa-name"]')?.value ?? "",
  ).trim();
  const invokes = Math.max(
    0,
    Math.trunc(
      Number(root?.querySelector('input[name="ctt-sa-invokes"]')?.value || 0),
    ),
  );
  const character = String(
    root?.querySelector('select[name="ctt-sa-character"]')?.value ?? "",
  ).trim();
  const zoneIdsRaw = [
    ...(root?.querySelectorAll('input[name="ctt-sa-zone"]:checked') ?? []),
  ].map((el) => String(el.value ?? "").trim()).filter((v) => v.length > 0);
  // Preserve the drafts across the automatic re-render (validation failure).
  app.editName = name;
  app.editInvokes = invokes;
  app.editCharacter = character;
  app.editZoneIds = zoneIdsRaw;
  if (!name) {
    ui.notifications.warn(
      game.i18n.localize(`${MODULE_ID}.situationAspects.nameEmpty`),
    );
    return;
  }
  const aspect = app.aspects[app.renameIndex];
  if (aspect) {
    const validIds = liveZoneRecords().map((z) => z.id);
    const { name: nextName, zoneIds: nextZoneIds } = applyAspectBinding(
      name,
      { character, zoneIds: zoneIdsRaw, hadKnownBinding: app.editHadKnownBinding },
      validIds,
    );
    // Mutate the existing object (spread would drop linked) — preserve unknown fields.
    aspect.name = nextName;
    aspect.free_invokes = invokes;
    if (nextZoneIds.length) aspect.zoneIds = nextZoneIds;
    else delete aspect.zoneIds;
  }
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
  // Full part set from the start: one text Drawing PER ASPECT (plus frame
  // and background). The legacy single-text start trio left a window after
  // placement in which the right-click refinement saw no per-aspect rows
  // yet; the next sync migrates such widgets anyway.
  const docs = [
    ...buildSaTextDocs(normalized, opts),
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
async function removeWidget() {
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
