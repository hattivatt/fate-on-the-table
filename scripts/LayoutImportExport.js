/**
 * LayoutImportExport — GM dialog for managing layouts.
 *
 * Lists ALL registered layouts (built-in, custom and layouts registered by
 * other modules). Every layout can be exported as JSON; custom layouts can
 * additionally be renamed and deleted. The import section at the bottom
 * accepts a JSON document from the standalone layout-editor (file or pasted
 * text); when the imported layout id collides with an existing layout the
 * GM is offered to rename it instead of failing.
 *
 * The dialog is reachable from the module settings ("Layouts" menu button)
 * and from the scene control tool.
 */

import {
  getLayoutRecords,
  getLayoutRecord,
  getLayoutJson,
} from "./layoutRegistry.js";
import {
  importLayoutText,
  saveCustomLayout,
  deleteCustomLayout,
} from "./layoutLoader.js";
import { refreshLayoutChoices, layoutDisplayName } from "./settings.js";
import { MODULE_ID } from "./constants.js";

export class LayoutImportExport extends foundry.applications.api.ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "chars-to-table-layout-io",
    classes: ["chars-to-table-layout-io"],
    position: { width: 760, height: 640 },
    window: {
      title: `${MODULE_ID}.layouts.title`,
      icon: "fas fa-table-columns",
      resizable: true,
    },
  };

  /** Currently open instance (focus instead of stacking duplicates). */
  static _instance = null;

  /** Opens (and focuses) the dialog. */
  static open() {
    if (this._instance && !this._instance.removed) {
      this._instance.render(true);
      this._instance.bringToFront?.();
      return this._instance;
    }
    const app = new this();
    this._instance = app;
    app.render(true);
    return app;
  }

  _onClose() {
    LayoutImportExport._instance = null;
    super._onClose?.();
  }

  async _renderHTML() {
    const root = document.createElement("div");
    root.classList.add("ctt-layout-io");

    root.append(this._sectionTitle("chars-to-table.layouts.listHeader"));
    const records = getLayoutRecords();
    root.append(
      records.length
        ? this._layoutList(records)
        : this._emptyNote("chars-to-table.layouts.empty"),
    );

    root.append(this._sectionTitle("chars-to-table.layouts.importHeader"));
    root.append(this._importSection());

    return root;
  }

  _replaceHTML(result, content, options) {
    content.innerHTML = "";
    content.append(result);
  }

  _sectionTitle(key) {
    const h = document.createElement("h3");
    h.textContent = game.i18n.localize(key);
    return h;
  }

  _emptyNote(key) {
    const p = document.createElement("p");
    p.className = "ctt-layout-io-empty";
    p.textContent = game.i18n.localize(key);
    return p;
  }

  _layoutList(records) {
    const ul = document.createElement("ul");
    ul.classList.add("ctt-layout-io-list");
    for (const record of records) {
      const readonly = record.source === "builtin";
      const li = document.createElement("li");
      const name = document.createElement("span");
      name.className = "ctt-layout-io-name";
      name.textContent = layoutDisplayName(record.id);
      const meta = document.createElement("span");
      meta.className = "ctt-layout-io-meta";
      meta.textContent = `(${record.id})`;
      li.append(name, meta);
      const tag = document.createElement("span");
      tag.className = `ctt-layout-io-tag ${
        readonly ? "ctt-layout-io-tag-builtin" : "ctt-layout-io-tag-custom"
      }`;
      tag.textContent = game.i18n.localize(
        readonly
          ? "chars-to-table.layouts.builtinTag"
          : "chars-to-table.layouts.customTag",
      );
      li.append(tag);

      const actions = document.createElement("span");
      actions.className = "ctt-layout-io-actions";
      actions.append(
        this._button("fas fa-download", "chars-to-table.layouts.exportButton", () =>
          this._export(record.id),
        ),
      );
      if (!readonly) {
        actions.append(
          this._button("fas fa-pen", "chars-to-table.layouts.rename", () =>
            this._rename(record.id),
          ),
          this._button(
            "fas fa-trash",
            "chars-to-table.layouts.deleteButton",
            () => this._delete(record.id),
            "ctt-layout-io-danger",
          ),
        );
      }
      li.append(actions);
      ul.append(li);
    }
    return ul;
  }

  _button(icon, labelKey, onClick, extraClass = "") {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `ctt-layout-io-btn ${extraClass}`.trim();
    b.innerHTML = `<i class="${icon}"></i> ${game.i18n.localize(labelKey)}`;
    b.addEventListener("click", (event) => {
      event.preventDefault();
      onClick();
    });
    return b;
  }

  _importSection() {
    const wrap = document.createElement("div");
    wrap.classList.add("ctt-layout-io-import");

    const textarea = document.createElement("textarea");
    textarea.placeholder = game.i18n.localize(
      "chars-to-table.layouts.importHint",
    );
    textarea.rows = 6;
    wrap.append(textarea);

    const row = document.createElement("div");
    row.classList.add("ctt-layout-io-import-row");

    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = ".json,application/json";
    fileInput.style.display = "none";
    const fileButton = this._button(
      "fas fa-folder-open",
      "chars-to-table.layouts.importFile",
      () => fileInput.click(),
    );
    fileInput.addEventListener("change", () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      file
        .text()
        .then((text) => {
          textarea.value = text;
          return this._import(text);
        })
        .catch((err) => {
          console.error("[chars-to-table] file read failed:", err);
        });
    });

    const importButton = this._button(
      "fas fa-file-import",
      "chars-to-table.layouts.importButton",
      () => this._import(textarea.value),
      "ctt-layout-io-import-main",
    );

    row.append(fileInput, fileButton, importButton);
    wrap.append(row);
    return wrap;
  }

  async _import(text) {
    const result = await LayoutImportExport.importJsonText(text);
    if (result?.ok) this.render(true);
  }

  async _export(id) {
    await LayoutImportExport.exportJson(id);
  }

  async _rename(id) {
    const ok = await LayoutImportExport.renameLayout(id);
    if (ok) this.render(true);
  }

  async _delete(id) {
    const record = getLayoutRecords().find((r) => r.id === id);
    if (!record) return;
    const name = layoutDisplayName(id);
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: {
        title: game.i18n.localize("chars-to-table.layouts.deleteConfirmTitle"),
      },
      content: game.i18n.format("chars-to-table.layouts.deleteConfirm", {
        name,
      }),
      rejectClose: false,
    });
    if (!confirmed) return;
    await deleteCustomLayout(id);
    refreshLayoutChoices();
    ui.notifications.info(
      game.i18n.format("chars-to-table.layouts.deleted", { name }),
    );
    this.render(true);
  }

  /* ------------------------------------------------------------------ *
   * Shared flows (also usable from other module UIs)
   * ------------------------------------------------------------------ */

  /**
   * Import flow: parse + validate, resolve id collisions by offering a
   * rename, confirm, save as a custom layout and refresh the registry
   * choices.
   * @param {string} text  Layout JSON text.
   * @returns {Promise<{ok: boolean, id?: string, name?: string, cancelled?: boolean}>}
   */
  static async importJsonText(text) {
    if (!text || !text.trim()) return { ok: false };
    const result = importLayoutText(text);
    if (!result.ok) {
      LayoutImportExport.showValidationErrors(result.errors);
      return { ok: false };
    }
    const normalized = result.normalized;

    if (getLayoutRecord(normalized.id)) {
      const newId = await LayoutImportExport.resolveCollisionId(normalized.id);
      if (!newId) return { ok: false, cancelled: true };
      normalized.id = newId;
    }

    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: {
        title: game.i18n.localize("chars-to-table.layouts.importConfirmTitle"),
      },
      content: game.i18n.format("chars-to-table.layouts.importConfirm", {
        name: normalized.name,
        id: normalized.id,
      }),
      rejectClose: false,
    });
    if (!confirmed) return { ok: false, cancelled: true };
    const saved = await saveCustomLayout(normalized);
    if (!saved.ok) {
      ui.notifications.error(
        saved.error ??
          (saved.errors ?? [])
            .map((e) => `${e.path}: ${e.message}`)
            .join("; "),
      );
      return { ok: false };
    }
    refreshLayoutChoices();
    ui.notifications.info(
      game.i18n.format("chars-to-table.layouts.imported", {
        name: normalized.name,
      }),
    );
    return { ok: true, id: normalized.id, name: normalized.name };
  }

  /**
   * Asks the GM for a new id when the imported id is already registered.
   * @param {string} currentId
   * @returns {Promise<string|null>}  The new id, or null when cancelled.
   */
  static async resolveCollisionId(currentId) {
    const choice = await foundry.applications.api.DialogV2.prompt({
      window: {
        title: game.i18n.localize(
          "chars-to-table.layouts.importCollisionTitle",
        ),
      },
      content: `<p>${game.i18n.format(
        "chars-to-table.layouts.importCollisionPrompt",
        { id: escapeHtml(currentId) },
      )}</p><input type="text" name="id" value="${escapeHtml(
        `${currentId}-copy`,
      )}">`,
      ok: {
        label: game.i18n.localize("chars-to-table.layouts.importButton"),
      },
      rejectClose: false,
    });
    const newId = String(choice?.id ?? "").trim();
    if (!newId) return null;
    if (getLayoutRecord(newId)) {
      ui.notifications.error(
        game.i18n.format("chars-to-table.layouts.importCollisionTaken", {
          id: newId,
        }),
      );
      return null;
    }
    return newId;
  }

  /**
   * Renames a custom layout (display name; the id stays the same).
   * @param {string} id
   * @returns {Promise<boolean>}  True when the layout was renamed.
   */
  static async renameLayout(id) {
    const record = getLayoutRecords().find(
      (r) => r.id === id && r.source === "custom",
    );
    if (!record) return false;
    const currentName = getLayoutJson(id).name ?? "";
    const choice = await foundry.applications.api.DialogV2.prompt({
      window: {
        title: game.i18n.localize("chars-to-table.layouts.renameTitle"),
      },
      content: `<p>${game.i18n.format(
        "chars-to-table.layouts.renamePrompt",
        { name: escapeHtml(currentName) },
      )}</p><input type="text" name="name" value="${escapeHtml(currentName)}">`,
      ok: {
        label: game.i18n.localize("chars-to-table.layouts.importButton"),
      },
      rejectClose: false,
    });
    const newName = String(choice?.name ?? "").trim();
    if (!newName) {
      ui.notifications.error(
        game.i18n.localize("chars-to-table.layouts.renameEmpty"),
      );
      return false;
    }
    const document = getLayoutJson(id);
    document.name = newName;
    const saved = await saveCustomLayout(document);
    if (!saved.ok) {
      ui.notifications.error(
        saved.error ??
          game.i18n.localize("chars-to-table.layouts.renameFailed"),
      );
      return false;
    }
    refreshLayoutChoices();
    ui.notifications.info(
      game.i18n.format("chars-to-table.layouts.renamed", { name: newName }),
    );
    return true;
  }

  /** Shows the validation diagnostics of a failed import. */
  static showValidationErrors(errors) {
    const list = errors
      .map((e) => `<li><b>${e.path || "—"}</b>: ${e.message}</li>`)
      .join("");
    foundry.applications.api.DialogV2.prompt({
      window: {
        title: game.i18n.localize("chars-to-table.layouts.importFailed"),
      },
      content: `<ul class="ctt-layout-io-errors">${list}</ul>`,
      rejectClose: true,
    });
  }

  /**
   * Downloads the JSON document of a registered layout.
   * Uses the native "Save As" dialog (File System Access API) when the
   * browser supports it, so the file is REALLY downloaded; otherwise falls
   * back to the standard blob+anchor download.
   * @param {string} id  Registered layout id.
   * @param {object} [opts]  { suggestedName }  File name (default
   *   `layout-<id>.json`).
   */
  static async exportJson(id, { suggestedName } = {}) {
    const json = JSON.stringify(getLayoutJson(id), null, 2);
    const name = suggestedName ?? `layout-${id}.json`;

    if (window.showSaveFilePicker) {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: name,
          types: [
            {
              description: game.i18n.localize(
                "chars-to-table.layouts.jsonDescription",
              ),
              accept: { "application/json": [".json"] },
            },
          ],
        });
        const writable = await handle.createWritable();
        await writable.write(json);
        await writable.close();
        ui.notifications.info(
          game.i18n.localize("chars-to-table.layouts.exportDone"),
        );
        return;
      } catch (err) {
        if (err?.name === "AbortError") return; // user cancelled the picker
        console.warn(
          "[chars-to-table] native save dialog failed; using the download fallback:",
          err,
        );
      }
    }
    downloadBlob(name, json);
  }
}

/**
 * Standard blob+anchor download fallback (Firefox, Safari and other browsers
 * without the File System Access API).
 */
function downloadBlob(name, json) {
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.dispatchEvent(
    new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      view: window,
    }),
  );
  setTimeout(() => {
    anchor.remove();
    URL.revokeObjectURL(url);
  }, 1000);
  ui.notifications.info(
    game.i18n.localize("chars-to-table.layouts.exportDone"),
  );
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
