/**
 * FatePointManager — GM dialog for managing Fate Points of players and the
 * GM (fate-core-official.gmfatepoints), placing/repositioning/removing the
 * GM fate point row on the scene, and the "New Scene" operation (transfer
 * situation aspects, reset fleeting stress, set GM fate points).
 *
 * The dialog is opened from a GM-only scene control tool. For non-GM users
 * the GM operations, mass refresh and "New Scene" are hidden; the rest of
 * the actions still respect the normal permission rules.
 */

import { PlacementManager } from "./PlacementManager.js";
import { toDocumentData } from "./WidgetBuilder.js";
import { getPlacementOptions } from "./settings.js";
import { syncActorNow, reconcileScene, removeWidgetRecord } from "./WidgetSync.js";
import { allWidgetDocs } from "./widgetDocs.js";
import { SituationAspectManager } from "./SituationAspectManager.js";
import {
  buildGmRowDocs,
  buildGmFrameDoc,
  gmFrameBounds,
  gmFpRegistry,
  gmFatePoints,
  activeGm,
  removeGmFatePointRow,
  syncGmFatePointRow,
} from "./FatePointSync.js";
import {
  MODULE_ID,
  FLAG_SCOPE,
  WIDGETS_FLAG,
  GM_FP_SCOPE,
  GM_FP_KEY,
  GM_FP_WIDGET_FLAG,
  GM_OWNER_TYPE,
  SA_OWNER_TYPE,
  SITUATION_ASPECTS_SCOPE,
  SITUATION_ASPECTS_KEY,
} from "./constants.js";

const OWNER = CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;
const LIMITED = CONST.DOCUMENT_OWNERSHIP_LEVELS.LIMITED;

const MANAGER_DIALOG_ID = "chars-to-table-fp-manager";

/** True while a manager operation is running (double-click guard). */
let busy = false;

export class FatePointManager {
  static open() {
    if (!game.user.isGM) {
      ui.notifications.warn(
        game.i18n.localize(`${MODULE_ID}.manager.gmOnly`),
      );
      return;
    }
    const existing = foundry.applications.instances.get(MANAGER_DIALOG_ID);
    if (existing) {
      existing.render({ force: true });
      return;
    }
    new FatePointManagerDialog().render({ force: true });
  }

  /**
   * Places (or repositions) the GM fate point row. Shared entry point for
   * the manager dialog and the Fate Utilities button.
   */
  static placeGmFatePointRow() {
    return placeGmFatePointRow();
  }
}

/**
 * GM Fate Point Manager dialog (ApplicationV2, no legacy v1 Dialog render
 * callback involved — all buttons are wired through the `actions` system).
 */
class FatePointManagerDialog extends foundry.applications.api.ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: MANAGER_DIALOG_ID,
    classes: ["chars-to-table", "fp-manager"],
    position: { width: 480 },
    // Foundry localizes window.title itself — pass the raw i18n key.
    window: {
      title: `${MODULE_ID}.manager.title`,
    },
    tag: "form",
    form: { submitOnChange: false, closeOnSubmit: false },
    actions: {
      playerGive: (event, target) => runAction(target, "player-give"),
      playerTake: (event, target) => runAction(target, "player-take"),
      gmGive: (event, target) => runAction(target, "gm-give"),
      gmTake: (event, target) => runAction(target, "gm-take"),
      syncAll: (event, target) => runAction(target, "sync-all"),
      refreshAll: (event, target) => runAction(target, "refresh-all"),
      gmPlace: (event, target) => runAction(target, "gm-place"),
      gmRemove: (event, target) => runAction(target, "gm-remove"),
      newScene: (event, target) => runAction(target, "new-scene"),
    },
  };

  async _renderHTML(context, options) {
    const div = document.createElement("div");
    div.innerHTML = renderContent();
    return div;
  }

  _replaceHTML(result, content, options) {
    content.innerHTML = "";
    content.append(result);
  }

  _onClose(options) {
    busy = false;
  }
}

let interactionsPatched = false;

/**
 * Canvas interactions for chars-to-table widgets:
 * - double-click on a GM fate point box (or its tokens) opens the Fate Point
 *   Manager; double-click on the situation aspects widget opens its manager;
 *   double-click on an actor widget part opens the actor sheet (when the
 *   clicking user can view the actor);
 * - right-click on an actor widget part opens a small menu with
 *   give/take fate point actions (owner-only).
 * Patching runs at module load (top level), so it survives page reloads.
 */
export function initWidgetInteractions() {
  if (interactionsPatched) return;
  interactionsPatched = true;
  if (typeof Drawing === "undefined" || typeof Tile === "undefined") return;
  patchDoubleClick(Drawing.prototype);
  patchDoubleClick(Tile.prototype);
  patchRightClick(Drawing.prototype);
  patchRightClick(Tile.prototype);
  patchControlPermissions(Drawing.prototype);
  patchControlPermissions(Tile.prototype);
  window.addEventListener("pointerdown", onWindowPointerDown);
  window.addEventListener("keydown", onWindowKeyDown);
}

function patchDoubleClick(proto) {
  if (proto.__charsToTableDblClick) return;
  proto.__charsToTableDblClick = true;
  const original = proto._onClickLeft2;
  proto._onClickLeft2 = async function (event) {
    const doc = this.document ?? this;
    const widgetId = doc?.getFlag?.(FLAG_SCOPE, "widgetId");
    if (!widgetId) {
      return original?.call(this, event);
    }
    const ownerType = doc?.getFlag?.(FLAG_SCOPE, "ownerType");
    if (ownerType === GM_OWNER_TYPE) {
      event?.preventDefault?.();
      event?.stopPropagation?.();
      FatePointManager.open();
      return;
    }
    if (ownerType === SA_OWNER_TYPE) {
      event?.preventDefault?.();
      event?.stopPropagation?.();
      SituationAspectManager.open();
      return;
    }
    const actorUuid = doc?.getFlag?.(FLAG_SCOPE, "actorUuid");
    if (actorUuid) {
      event?.preventDefault?.();
      event?.stopPropagation?.();
      try {
        const actor = await fromUuid(actorUuid);
        if (
          actor?.testUserPermission?.(game.user, LIMITED)
        ) {
          actor.sheet.render(true);
        }
      } catch (err) {
        console.warn("[chars-to-table] actor sheet open failed:", err);
      }
      return;
    }
    return original?.call(this, event);
  };
}

/**
 * Right-click on an actor widget part opens the module's own menu
 * (give/take fate points, remove widget). The menu is GM-only; for other
 * users the standard config behaviour is suppressed on widget parts.
 */
function patchRightClick(proto) {
  if (proto.__charsToTableRightClick) return;
  proto.__charsToTableRightClick = true;
  const original = proto._onClickRight;
  const original2 = proto._onClickRight2;
  const handler = function (event) {
    const doc = this.document ?? this;
    if (doc?.getFlag?.(FLAG_SCOPE, "actorUuid")) {
      event?.preventDefault?.();
      event?.stopPropagation?.();
      if (game.user.isGM) openWidgetMenu(event, doc);
      return;
    }
    return original?.call(this, event);
  };
  proto._onClickRight = handler;
  proto._onClickRight2 = function (event) {
    const doc = this.document ?? this;
    if (doc?.getFlag?.(FLAG_SCOPE, "actorUuid")) {
      event?.preventDefault?.();
      event?.stopPropagation?.();
      return;
    }
    return original2?.call(this, event);
  };
}

/**
 * Canvas control permissions for actor widget parts:
 * - everyone can click (hover/control) the widget;
 * - only the GM can drag/move it.
 * Both the public `can(user, action)` (used by the mouse interaction
 * manager via CONFIG.Canvas.interactionPermissions) and the protected
 * `_canXxx` helpers are patched, so selection works for every user while
 * dragging stays GM-only. GM fate point boxes keep the default permissions.
 */
function patchControlPermissions(proto) {
  if (proto.__charsToTableControl) return;
  proto.__charsToTableControl = true;
  const isPlayerWidget = (obj) =>
    !!obj?.document?.getFlag?.(FLAG_SCOPE, "actorUuid") ||
    !!obj?.getFlag?.(FLAG_SCOPE, "actorUuid");

  const origCan = proto.can;
  proto.can = function (user, action) {
    if (isPlayerWidget(this)) {
      if (action === "hover" || action === "control" || action === "HUD") {
        return true;
      }
      if (action === "drag" || action === "configure") {
        return user?.isGM === true;
      }
    }
    return origCan?.call(this, user, action);
  };

  const origControl = proto._canControl;
  proto._canControl = function (user, event) {
    if (isPlayerWidget(this)) return true;
    return origControl?.call(this, user, event);
  };

  const origHover = proto._canHover;
  proto._canHover = function (user, event) {
    if (isPlayerWidget(this)) return true;
    return origHover?.call(this, user, event);
  };

  const origDrag = proto._canDrag;
  proto._canDrag = function (user, event) {
    if (isPlayerWidget(this)) return user?.isGM === true;
    return origDrag?.call(this, user, event);
  };

  const origDragStart = proto._canDragLeftStart;
  proto._canDragLeftStart = function (user, event, options) {
    if (isPlayerWidget(this)) return user?.isGM === true;
    return origDragStart?.call(this, user, event, options);
  };
}

/* --- Own widget context menu (GM: give/take/remove) --- */

let widgetMenu = null;function openWidgetMenu(event, doc) {
  closeWidgetMenu();
  const actorUuid = doc.getFlag?.(FLAG_SCOPE, "actorUuid");
  const widgetId = doc.getFlag?.(FLAG_SCOPE, "widgetId");
  let actor = null;
  if (actorUuid) {
    try {
      actor = fromUuidSync(actorUuid);
    } catch (err) {
      /* actor not resolvable — skip give/take */
    }
  }
  const menu = document.createElement("div");
  menu.className = "ctt-widget-menu";
  const add = (icon, key, fn, sep = false) => {
    const item = document.createElement("button");
    item.type = "button";
    if (sep) item.classList.add("ctt-menu-sep");
    item.innerHTML = `<i class="fas ${icon}"></i> ${game.i18n.localize(
      `${MODULE_ID}.${key}`,
    )}`;
    item.addEventListener("click", () => {
      closeWidgetMenu();
      Promise.resolve(fn()).catch((err) =>
        console.error("[chars-to-table] widget menu action failed:", err),
      );
    });
    menu.append(item);
  };
  if (actor) {
    add("fa-plus", "context.giveFatePoint", () =>
      modifyActorFatePoints(actor, +1),
    );
    add("fa-minus", "context.takeFatePoint", () =>
      modifyActorFatePoints(actor, -1),
    );
  }
  if (actor && widgetId) {
    add(
      "fa-trash",
      "context.removeWidget",
      () => removeWidgetFromMenu(actor, widgetId),
      true,
    );
  }
  if (!menu.childElementCount) return;
  document.body.append(menu);
  const rect = menu.getBoundingClientRect();
  const x = event?.clientX ?? 0;
  const y = event?.clientY ?? 0;
  menu.style.left = `${Math.min(x, window.innerWidth - rect.width - 8)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - rect.height - 8)}px`;
  widgetMenu = menu;
}

async function removeWidgetFromMenu(actor, widgetId) {
  const confirmed = await foundry.applications.api.DialogV2.confirm({
    window: {
      title: game.i18n.localize(`${MODULE_ID}.context.removeWidgetTitle`),
    },
    content: game.i18n.format(`${MODULE_ID}.context.removeWidgetConfirm`, {
      name: actor.name,
    }),
    rejectClose: false,
  });
  if (!confirmed) return;
  const removed = await removeWidgetRecord(actor, widgetId);
  if (removed) {
    ui.notifications.info(
      game.i18n.format(`${MODULE_ID}.remove.done`, { count: 1 }),
    );
  }
}

function closeWidgetMenu() {
  widgetMenu?.remove();
  widgetMenu = null;
}

function onWindowPointerDown(event) {
  if (!widgetMenu) return;
  if (event.button !== 0) return;
  // Clicks inside the menu must reach the buttons (the click event fires
  // after pointerdown — removing the menu here would swallow it).
  if (widgetMenu.contains(event.target)) return;
  closeWidgetMenu();
}

function onWindowKeyDown(event) {
  if (event.key === "Escape") closeWidgetMenu();
}

/**
 * Players' Fate Core actors sorted stably: owner name, actor name, actor id.
 * @returns {{actor: object, owner: object}[]}
 */
function playerActors() {
  const players = game.users.filter((u) => !u.isGM);
  return game.actors
    .filter(
      (a) =>
        a.type === "fate-core-official" &&
        players.some((p) => a.testUserPermission(p, OWNER)),
    )
    .map((actor) => ({
      actor,
      owner: players.find((p) => actor.testUserPermission(p, OWNER)),
    }))
    .sort(
      (a, b) =>
        a.owner.name.localeCompare(b.owner.name) ||
        a.actor.name.localeCompare(b.actor.name) ||
        a.actor.id.localeCompare(b.actor.id),
    );
}

function actorWidgetOnScene(actor) {
  const scene = canvas?.scene;
  if (!scene) return false;
  return (actor.getFlag(FLAG_SCOPE, WIDGETS_FLAG) ?? []).some(
    (w) => w.sceneId === scene.id && allWidgetDocs(scene, w.widgetId).length > 0,
  );
}

function escapeHtml(text) {
  return String(text ?? "").replace(/[&<>"']/g, (c) => {
    const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return map[c];
  });
}

function renderContent() {
  const isGm = game.user.isGM;
  const t = (key) => game.i18n.localize(`${MODULE_ID}.${key}`);
  const rows = playerActors();

  let playersHtml = "";
  if (!rows.length) {
    playersHtml = `<p class="ctt-fp-empty">${escapeHtml(t("manager.noActors"))}</p>`;
  }
  for (const { actor } of rows) {
    const current = Number(actor.system?.details?.fatePoints?.current) || 0;
    const refresh = Number(actor.system?.details?.fatePoints?.refresh) || 0;
    const onScene = actorWidgetOnScene(actor);
    playersHtml += `
      <div class="ctt-fp-player" data-actor-id="${actor.id}">
        <div class="ctt-fp-player-info">
          <span class="ctt-fp-name" title="${escapeHtml(actor.name)}">${escapeHtml(actor.name)}</span>
          <span class="ctt-fp-values">
            <b class="ctt-fp-current">${current}</b>
            <span class="ctt-fp-sep">/</span>
            <span class="ctt-fp-refresh">${refresh}</span>
          </span>
          <span class="ctt-fp-badge ${onScene ? "ctt-fp-on-scene" : "ctt-fp-off-scene"}">
            ${escapeHtml(onScene ? t("manager.onScene") : t("manager.offScene"))}
          </span>
        </div>
        <div class="ctt-fp-player-actions">
          <button type="button" class="ctt-fp-btn ctt-fp-give" data-action="playerGive" data-actor-id="${actor.id}" title="${escapeHtml(t("manager.give"))}"><i class="fas fa-plus"></i></button>
          <button type="button" class="ctt-fp-btn ctt-fp-take" data-action="playerTake" data-actor-id="${actor.id}" title="${escapeHtml(t("manager.take"))}"><i class="fas fa-minus"></i></button>
        </div>
      </div>`;
  }

  const registry = gmFpRegistry();
  const rowPlaced = !!registry?.widgetId;
  const gmValue = gmFatePoints();

  let gmHtml = "";
  if (isGm) {
    gmHtml = `
      <div class="ctt-fp-section ctt-fp-gm-section">
        <h3>${escapeHtml(t("manager.gmHeader"))}</h3>
        <div class="ctt-fp-gm-row">
          <span class="ctt-fp-gm-value-label">${escapeHtml(t("manager.gmFatePoints"))}:</span>
          <b class="ctt-fp-gm-value">${gmValue}</b>
          <div class="ctt-fp-gm-actions">
            <button type="button" class="ctt-fp-btn" data-action="gmGive" title="${escapeHtml(t("manager.give"))}"><i class="fas fa-plus"></i></button>
            <button type="button" class="ctt-fp-btn" data-action="gmTake" title="${escapeHtml(t("manager.take"))}"><i class="fas fa-minus"></i></button>
          </div>
        </div>
        <div class="ctt-fp-gm-row-actions">
          <button type="button" class="ctt-fp-btn-wide" data-action="gmPlace">
            <i class="fas ${rowPlaced ? "fa-arrows-alt" : "fa-level-down-alt"}"></i>
            ${escapeHtml(t(rowPlaced ? "manager.reposition" : "manager.placeGmRow"))}
          </button>
          <button type="button" class="ctt-fp-btn-wide" data-action="gmRemove" ${rowPlaced ? "" : "disabled"}>
            <i class="fas fa-level-up-alt"></i>
            ${escapeHtml(t("manager.removeGmRow"))}
          </button>
        </div>
      </div>`;
  }

  return `
    <div class="ctt-fp-manager">
      <div class="ctt-fp-global">
        <button type="button" class="ctt-fp-btn-wide" data-action="syncAll">
          <i class="fas fa-sync"></i> ${escapeHtml(t("manager.syncAll"))}
        </button>
        <button type="button" class="ctt-fp-btn-wide" data-action="refreshAll" ${isGm ? "" : "disabled"}>
          <i class="fas fa-redo"></i> ${escapeHtml(t("manager.refreshAll"))}
        </button>
      </div>
      <div class="ctt-fp-section">
        <h3>${escapeHtml(t("manager.playersHeader"))}</h3>
        ${playersHtml}
      </div>
      ${gmHtml}
      <div class="ctt-fp-section">
        <button type="button" class="ctt-fp-btn-wide ctt-fp-new-scene" data-action="newScene" ${isGm ? "" : "disabled"}>
          <i class="fas fa-star"></i> ${escapeHtml(t("manager.newScene"))}
        </button>
      </div>
    </div>`;
}

async function runAction(target, action) {
  if (busy) return;
  const actorId = target.dataset.actorId;
  busy = true;
  const element = target.closest(".fp-manager");
  element?.classList.add("ctt-busy");
  try {
    switch (action) {
      case "player-give":
        return await modifyPlayerFp(actorId, +1);
      case "player-take":
        return await modifyPlayerFp(actorId, -1);
      case "gm-give":
        return await modifyGmFp(+1);
      case "gm-take":
        return await modifyGmFp(-1);
      case "sync-all":
        return await syncAll();
      case "refresh-all":
        return await refreshAll();
      case "gm-place":
        return await placeGmFatePointRow();
      case "gm-remove":
        return await removeGmRow();
      case "new-scene":
        return await startNewScene();
    }
  } catch (err) {
    console.error("[chars-to-table] manager operation failed:", err);
    ui.notifications.error(
      game.i18n.localize(`${MODULE_ID}.manager.error`),
    );
  } finally {
    busy = false;
    element?.classList.remove("ctt-busy");
    const app = foundry.applications.instances.get(MANAGER_DIALOG_ID);
    app?.render({ force: true });
  }
}

/** Give (+1) / take (−1) a player FP; never below zero. */
async function modifyPlayerFp(actorId, delta) {
  const actor = game.actors.get(actorId);
  if (!actor) return;
  await modifyActorFatePoints(actor, delta);
}

/**
 * Give (+1) / take (−1) fate points of an actor; never below zero.
 * Shared by the manager dialog, the canvas context menu and future entries.
 */
export async function modifyActorFatePoints(actor, delta) {
  if (!actor) return;
  const current = Number(actor.system?.details?.fatePoints?.current) || 0;
  const next = Math.max(0, current + delta);
  if (next === current) return;
  await actor.update({ "system.details.fatePoints.current": next });
  // Immediate sync; the debounced updateActor hook also fires but the
  // geometry is identical, so this does not duplicate or shift anything.
  await syncActorNow(actor);
}

/** Give (+1) / take (−1) GM fate points; never below zero. */
async function modifyGmFp(delta) {
  const gm = activeGm();
  if (!gm) {
    ui.notifications.warn(
      game.i18n.localize(`${MODULE_ID}.manager.noActiveGm`),
    );
    return;
  }
  const current = gmFatePoints();
  const next = Math.max(0, current + delta);
  if (next === current) return;
  await gm.setFlag(GM_FP_SCOPE, GM_FP_KEY, next);
  await syncGmFatePointRow();
}

/** Rebuilds actor widgets of the active scene + the GM row (no new widgets). */
async function syncAll() {
  if (!canvas?.scene) {
    ui.notifications.warn(
      game.i18n.localize(`${MODULE_ID}.placement.noScene`),
    );
    return;
  }
  ui.notifications.info(
    game.i18n.localize(`${MODULE_ID}.manager.syncing`),
  );
  await reconcileScene(canvas.scene);
  await syncGmFatePointRow(canvas.scene);
  ui.notifications.info(
    game.i18n.localize(`${MODULE_ID}.manager.syncDone`),
  );
}

/** Refresh all players: raise current to refresh, never lower a surplus. */
async function refreshAll() {
  for (const { actor } of playerActors()) {
    const current = Number(actor.system?.details?.fatePoints?.current) || 0;
    const refresh = Number(actor.system?.details?.fatePoints?.refresh) || 0;
    if (current < refresh) {
      await actor.update({ "system.details.fatePoints.current": refresh });
    }
  }
  await syncAll();
}

/** Places (or repositions, after confirmation) the GM fate point row. */
export async function placeGmFatePointRow() {
  const gm = activeGm();
  if (!gm) {
    ui.notifications.warn(
      game.i18n.localize(`${MODULE_ID}.manager.noActiveGm`),
    );
    return;
  }
  const opts = getPlacementOptions();
  if (!opts.fatePointImage) {
    ui.notifications.warn(
      game.i18n.localize(`${MODULE_ID}.manager.noImage`),
    );
    return;
  }

  const registry = gmFpRegistry();
  if (registry?.widgetId) {
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: {
        title: game.i18n.localize(`${MODULE_ID}.manager.repositionTitle`),
      },
      content: game.i18n.localize(`${MODULE_ID}.manager.repositionConfirm`),
      rejectClose: false,
    });
    if (!confirmed) return;
    await removeGmFatePointRow();
  }

  const docs = buildGmRowDocs();
  const frameDoc = buildGmFrameDoc();
  const bounds = gmFrameBounds();

  await PlacementManager.placeGroup({
    docs,
    bounds,
    label: game.i18n.localize(`${MODULE_ID}.manager.gmRowLabel`),
    options: opts,
    hintKey: `${MODULE_ID}.manager.gmPlaceHint`,
    successKey: `${MODULE_ID}.manager.gmPlaced`,
    commit: async (anchor, widgetId) => {
      const tiles = docs.map((doc) =>
        toDocumentData(
          { ...doc, x: doc.x + anchor.x, y: doc.y + anchor.y },
          {
            widgetId,
            part: doc.part,
            index: doc.index,
            ownerType: GM_OWNER_TYPE,
          },
        ),
      );
      if (tiles.length) {
        await canvas.scene.createEmbeddedDocuments("Tile", tiles);
      }
      // The frame (transparent draggable box) exists even at 0 fate points.
      const framePayload = toDocumentData(
        { ...frameDoc, x: frameDoc.x + anchor.x, y: frameDoc.y + anchor.y },
        {
          widgetId,
          part: frameDoc.part,
          index: frameDoc.index,
          ownerType: GM_OWNER_TYPE,
        },
      );
      await canvas.scene.createEmbeddedDocuments("Drawing", [framePayload]);
      await canvas.scene.setFlag(FLAG_SCOPE, GM_FP_WIDGET_FLAG, {
        widgetId,
        anchor,
      });
    },
  });
}

/** Removes the GM fate point box after confirmation. */
async function removeGmRow() {
  if (!gmFpRegistry()?.widgetId) return;
  const confirmed = await foundry.applications.api.DialogV2.confirm({
    window: {
      title: game.i18n.localize(`${MODULE_ID}.manager.removeGmTitle`),
    },
    content: game.i18n.localize(`${MODULE_ID}.manager.removeGmConfirm`),
    rejectClose: false,
  });
  if (!confirmed) return;
  const removed = await removeGmFatePointRow();
  if (removed) {
    ui.notifications.info(
      game.i18n.localize(`${MODULE_ID}.manager.removeGmDone`),
    );
  }
}

/**
 * "New Scene" operation. First shows a dialog; nothing changes on cancel.
 */
async function startNewScene() {
  const scene = canvas?.scene;
  if (!scene) {
    ui.notifications.warn(
      game.i18n.localize(`${MODULE_ID}.placement.noScene`),
    );
    return;
  }
  const aspects =
    scene.getFlag(SITUATION_ASPECTS_SCOPE, SITUATION_ASPECTS_KEY) ?? [];
  const setup = await promptForNewScene(aspects);
  if (!setup) {
    ui.notifications.info(
      game.i18n.localize(`${MODULE_ID}.manager.newSceneCancelled`),
    );
    return;
  }
  await executeNewScene(scene, setup);
}

/**
 * New Scene setup prompt (ApplicationV2). Resolves with
 * { playerCount, keptAspects } or null on cancel.
 */
class NewScenePromptDialog extends foundry.applications.api.ApplicationV2 {
  constructor(aspects, resolve) {
    super();
    this.aspects = aspects;
    this._resolve = resolve;
  }

  static DEFAULT_OPTIONS = {
    id: "chars-to-table-new-scene",
    classes: ["chars-to-table", "new-scene"],
    position: { width: 420 },
    // Foundry localizes window.title itself — pass the raw i18n key.
    window: {
      title: `${MODULE_ID}.manager.newSceneTitle`,
    },
    tag: "form",
    form: { submitOnChange: false, closeOnSubmit: false },
    actions: {
      confirm(event, target) {
        this.#confirm();
      },
      cancel(event, target) {
        this.#cancel();
      },
    },
  };

  async _renderHTML(context, options) {
    const t = (key) => game.i18n.localize(`${MODULE_ID}.${key}`);
    const playerCount = Math.max(1, playerActors().length);
    const aspectHtml = this.aspects.length
      ? `<hr>
         <p>${escapeHtml(t("manager.newSceneAspectsLabel"))}</p>
         ${this.aspects
           .map(
             (aspect, i) => `
         <div class="form-group">
           <input type="checkbox" id="ctt-keep-aspect-${i}" name="ctt-keep-aspect" value="${i}" checked>
           <label for="ctt-keep-aspect-${i}">${escapeHtml(aspect.name ?? "")}</label>
         </div>`,
           )
           .join("")}`
      : "";
    const div = document.createElement("div");
    div.innerHTML = `
      <div class="ctt-new-scene">
        <div class="form-group">
          <label for="ctt-player-count">${escapeHtml(t("manager.newScenePlayerCount"))}</label>
          <input type="number" id="ctt-player-count" name="ctt-player-count" value="${playerCount}" min="0">
        </div>
        ${aspectHtml}
        <div class="ctt-new-scene-buttons">
          <button type="button" data-action="confirm"><i class="fas fa-check"></i> ${escapeHtml(t("manager.newSceneConfirm"))}</button>
          <button type="button" data-action="cancel"><i class="fas fa-times"></i> ${escapeHtml(t("manager.cancel"))}</button>
        </div>
      </div>`;
    return div;
  }

  _replaceHTML(result, content, options) {
    content.innerHTML = "";
    content.append(result);
  }

  #confirm() {
    const el = this.element;
    const count = parseInt(
      el.querySelector("#ctt-player-count")?.value ?? "",
      10,
    );
    const keptAspects = [...el.querySelectorAll('input[name="ctt-keep-aspect"]:checked')]
      .map((cb) => this.aspects[Number(cb.value)]);
    this._resolve({ playerCount: count, keptAspects });
    this.close();
  }

  #cancel() {
    this._resolve(null);
    this.close();
  }

  _onClose(options) {
    if (this._resolve) {
      this._resolve(null);
      this._resolve = null;
    }
  }
}

function promptForNewScene(aspects) {
  return new Promise((resolve) => {
    new NewScenePromptDialog(aspects, resolve).render({ force: true });
  });
}

async function executeNewScene(scene, { playerCount, keptAspects }) {
  const gm = activeGm();
  const gmFp = Math.max(0, Number(playerCount) || 0);

  // 1. Transfer the selected situation aspects (names/free_invokes kept).
  await scene.setFlag(
    SITUATION_ASPECTS_SCOPE,
    SITUATION_ASPECTS_KEY,
    keptAspects,
  );
  // 2. Extensible event for the future situation aspects manager.
  Hooks.callAll(`${MODULE_ID}.newScene`, {
    scene,
    keptAspects,
    playerCount: gmFp,
  });

  // 3. GM fate points = player count, then sync the GM row.
  if (gm) {
    await gm.setFlag(GM_FP_SCOPE, GM_FP_KEY, gmFp);
    await syncGmFatePointRow(scene);
  } else {
    ui.notifications.warn(
      game.i18n.localize(`${MODULE_ID}.manager.noActiveGm`),
    );
  }

  // 4. Clear only fleeting stress on the token actors of the scene.
  const clearedTracks = await clearFleetingStress(scene);

  // 5. Summary.
  ui.notifications.info(
    game.i18n.format(`${MODULE_ID}.manager.newSceneDone`, {
      gmFp,
      aspects: keptAspects.length,
      tracks: clearedTracks,
    }),
  );
}

/**
 * Clears the fleeting stress of the actors behind the scene tokens:
 * box_values -> false, linked stress aspect cleared. Other stress types are
 * untouched. Regular actors and embedded token actors are updated through
 * their respective v14 APIs; duplicate tokens of one actor produce one update.
 * @returns {Promise<number>}  Number of affected actors/tokens.
 */
async function clearFleetingStress(scene) {
  const actorUpdates = new Map();
  const tokenUpdates = new Map();

  for (const token of scene.tokens) {
    const actor = token.actor;
    if (!actor?.system?.tracks) continue;
    const tracks = foundry.utils.duplicate(actor.system.tracks);
    let changed = false;
    for (const key of Object.keys(tracks)) {
      const track = tracks[key];
      if (track?.recovery_type !== "Fleeting") continue;
      if (track.box_values?.some(Boolean)) {
        track.box_values = track.box_values.map(() => false);
        changed = true;
      }
      if (
        track.aspect &&
        typeof track.aspect === "object" &&
        track.aspect.name
      ) {
        track.aspect = { ...track.aspect, name: "" };
        changed = true;
      }
    }
    if (!changed) continue;
    if (actor.isToken) {
      // Embedded (unlinked) token actor: update the Token document itself.
      tokenUpdates.set(token.id, {
        _id: token.id,
        "delta.system.tracks": tracks,
      });
    } else {
      // Regular (linked) actor: one update per actor covers all its tokens.
      actorUpdates.set(actor.id, {
        _id: actor.id,
        "system.tracks": tracks,
      });
    }
  }

  if (actorUpdates.size) {
    await Actor.updateDocuments([...actorUpdates.values()]);
  }
  if (tokenUpdates.size) {
    await scene.updateEmbeddedDocuments("Token", [...tokenUpdates.values()]);
  }
  return actorUpdates.size + tokenUpdates.size;
}

/* ------------------------------------------------------------------ */
/*  Canvas click fallback                                              */
/*                                                                     */
/*  Placeable interaction in Foundry requires the object's LAYER to be */
/*  active. Players without drawing/tile tools cannot activate those   */
/*  layers, so widget parts are unreachable for them through PIXI.     */
/*  This DOM listener on the canvas view handles clicks on widget      */
/*  parts regardless of the active layer: single click selects the     */
/*  part, double click opens the actor sheet (or the manager for the   */
/*  GM fate point box). When the part's own layer IS active, the       */
/*  normal PIXI flow takes over (with the permission patches above).   */
/* ------------------------------------------------------------------ */

let lastWidgetClick = null;

/** Attach the fallback listener to the current canvas view (idempotent). */
export function initCanvasClickFallback() {
  const view = canvas?.app?.view;
  if (!view || view.dataset.cttClickFallback) return;
  view.dataset.cttClickFallback = "true";
  view.addEventListener("pointerdown", onCanvasPointerDown);
}

function onCanvasPointerDown(event) {
  if (PlacementManager.active) return;
  if (event.button !== 0) return;
  const part = hitTestWidgetPart(event);
  if (!part) return;
  // When the part's own layer is active the standard PIXI/MIM flow (plus
  // the permission patches) already handles it — do not double-handle.
  const layerActive =
    part.documentName === "Drawing"
      ? canvas.drawings?.active
      : canvas.tiles?.active;
  if (layerActive) return;
  event.preventDefault();
  event.stopPropagation();
  const now = Date.now();
  const isDouble =
    lastWidgetClick?.id === part.id && now - lastWidgetClick.time <= 300;
  lastWidgetClick = { id: part.id, time: now };
  if (isDouble) {
    handleWidgetDoubleClick(part);
    return;
  }
  selectWidgetPart(part);
}

/** The topmost widget part (drawing/tile) under the cursor, or null. */
function hitTestWidgetPart(event) {
  if (!canvas?.scene) return null;
  const p = canvasWorldPosition(event);
  if (!p) return null;
  const candidates = [];
  for (const doc of canvas.scene.drawings) {
    if (!doc.getFlag?.(FLAG_SCOPE, "widgetId")) continue;
    const w = doc.shape?.width ?? 0;
    const h = doc.shape?.height ?? 0;
    if (p.x >= doc.x && p.x <= doc.x + w && p.y >= doc.y && p.y <= doc.y + h) {
      candidates.push({ doc, isDrawing: true, z: (doc.elevation ?? 0) * 1000 + (doc.sort ?? 0) });
    }
  }
  for (const doc of canvas.scene.tiles) {
    if (!doc.getFlag?.(FLAG_SCOPE, "widgetId")) continue;
    if (
      p.x >= doc.x &&
      p.x <= doc.x + doc.width &&
      p.y >= doc.y &&
      p.y <= doc.y + doc.height
    ) {
      candidates.push({ doc, isDrawing: false, z: doc.sort ?? 0 });
    }
  }
  if (!candidates.length) return null;
  // Drawings render above tiles; within a layer the highest z wins.
  candidates.sort((a, b) => (b.isDrawing - a.isDrawing) || (b.z - a.z));
  return candidates[0].doc;
}

function canvasWorldPosition(event) {
  try {
    const view = canvas.app.view;
    const rect = view.getBoundingClientRect();
    const x = (event.clientX - rect.left) * (view.width / rect.width);
    const y = (event.clientY - rect.top) * (view.height / rect.height);
    const world = canvas.stage.worldTransform.applyInverse(
      new PIXI.Point(x, y),
    );
    return { x: world.x, y: world.y };
  } catch (err) {
    return null;
  }
}

/** Selects a widget part so the click gives visible feedback. */
function selectWidgetPart(part) {
  try {
    const placeable =
      part.documentName === "Drawing"
        ? canvas.drawings?.get(part.id)
        : canvas.tiles?.get(part.id);
    placeable?.control({ releaseOthers: false });
  } catch (err) {
    console.warn("[chars-to-table] widget select failed:", err);
  }
}

/** Double click on a widget part: actor sheet or the GM managers. */
function handleWidgetDoubleClick(part) {
  const ownerType = part.getFlag?.(FLAG_SCOPE, "ownerType");
  if (ownerType === GM_OWNER_TYPE) {
    FatePointManager.open();
    return;
  }
  if (ownerType === SA_OWNER_TYPE) {
    SituationAspectManager.open();
    return;
  }
  const actorUuid = part.getFlag?.(FLAG_SCOPE, "actorUuid");
  if (!actorUuid) return;
  fromUuid(actorUuid)
    .then((actor) => {
      if (actor?.testUserPermission?.(game.user, LIMITED)) {
        actor.sheet.render(true);
      }
    })
    .catch((err) => console.warn("[chars-to-table] actor sheet open failed:", err));
}
