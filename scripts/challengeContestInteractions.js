/**
 * challengeContestInteractions — context-menu logic for the macro-created
 * challenge / contest drawings (ownerType `challenge` / `contest`).
 *
 * Mixed module: the PURE parts build the menu items and the next state; the
 * thin GLUE executes them against Foundry (one `updateEmbeddedDocuments` with
 * the merged flags + the derived text). No top-level `foundry` / `game` /
 * `canvas` access, so the pure builders import cleanly in Node tests.
 *
 * State contracts (module flags of the Drawing):
 *   challenge: { widgetId, ownerType: "challenge",
 *                tasks: [{text, difficulty, status}] } — status is
 *                `"pending" | "success" | "failed"`; `done: true` from older
 *                blocks normalizes to `"success"`. A challenge block is ONE
 *                drawing; legacy multi-drawing blocks (one `taskRow` part per
 *                task with the state on index 0) are still menu-driven through
 *                `findChallengeStateCarrier`, but receive no strike overlays.
 *   contest:   { widgetId, ownerType: "contest", sides: [{name, boxes, done}] }
 *                — ONE drawing.
 * The block text is always DERIVED from that state
 * (`renderChallengeText` / `renderContestText` in challengeContest.js), never
 * parsed back.
 *
 * Menus are GM-only: a right-click by a player returns false so the native
 * Foundry behaviour is untouched (see `routeWidgetInteractions` /
 * `patchRightClick`).
 */

import {
  MODULE_ID,
  FLAG_SCOPE,
  CHALLENGE_OWNER_TYPE,
  CONTEST_OWNER_TYPE,
} from "./constants.js";
import {
  MARK_SUCCESS,
  MARK_FAILED,
  TASK_STATUS,
  normalizeTaskState,
  normalizeSideState,
  setChallengeTaskStatus,
  advanceSide,
  renderChallengeText,
  renderChallengeTaskLine,
  renderContestText,
} from "./challengeContest.js";
import { allWidgetDocs, widgetDocsByOwnerType } from "./widgetDocs.js";
import { showCttMenu } from "./menu.js";

/** Relative-key helper for `fate-on-the-table.challengeContest.menu.*`. */
const ccT = (key) => game.i18n.localize(`${MODULE_ID}.challengeContest.menu.${key}`);

// Icon colors used by the status submenu (green success / red failure).
const STATUS_COLORS = Object.freeze({
  success: "#2e7d32",
  failed: "#c62828",
});

/**
 * Legacy multi-drawing challenge row part. The previous layout projected one
 * Drawing per task with `part: "taskRow"` and shared `widgetId`; the state
 * lived on index 0. New blocks are a single drawing and never carry this part.
 */
const LEGACY_TASK_ROW_PART = "taskRow";

/** True when the current user is the GM (safe under Node). */
function isGmUser() {
  return typeof game !== "undefined" && game?.user?.isGM === true;
}

/** Prevents the native Foundry/browser handling of a consumed event. */
function consumeEvent(event) {
  event?.preventDefault?.();
  event?.stopPropagation?.();
}

/** Module challenge task list of a drawing (copy; [] when absent). */
export function challengeStateOf(doc) {
  const tasks = doc?.getFlag?.(FLAG_SCOPE, "tasks");
  return Array.isArray(tasks) ? tasks.map((task) => ({ ...task })) : [];
}

/** Module contest side list of a drawing (copy; [] when absent). */
export function contestStateOf(doc) {
  const sides = doc?.getFlag?.(FLAG_SCOPE, "sides");
  return Array.isArray(sides) ? sides.map((side) => ({ ...side })) : [];
}

/** All challenge drawings of the clicked block (by widgetId + ownerType). */
function challengeGroupDocs(scene, widgetId) {
  if (!scene || !widgetId) return [];
  return widgetDocsByOwnerType(scene, CHALLENGE_OWNER_TYPE, widgetId);
}

/**
 * The challenge drawing carrying the block's `tasks` state. The clicked
 * document itself is returned when it carries the state (the new single-drawing
 * format, or the legacy index-0 row); otherwise the scene is scanned for the
 * sibling with the same `widgetId`. Returns null when no carrier can be found.
 * @param {object} scene
 * @param {object} doc
 * @returns {object|null}
 */
export function findChallengeStateCarrier(scene, doc) {
  if (Array.isArray(doc?.getFlag?.(FLAG_SCOPE, "tasks"))) return doc;
  const widgetId = doc?.getFlag?.(FLAG_SCOPE, "widgetId");
  if (!widgetId) return null;
  return (
    challengeGroupDocs(scene, widgetId).find((d) =>
      Array.isArray(d.getFlag?.(FLAG_SCOPE, "tasks")),
    ) ?? null
  );
}

/**
 * Resolves the challenge task list for ANY clicked drawing (the new single
 * drawing, or a legacy row) from the block's state carrier.
 * @param {object} scene
 * @param {object} doc
 * @returns {Array<{text: string, difficulty: number, status: string}>}
 */
export function resolveChallengeState(scene, doc) {
  return challengeStateOf(findChallengeStateCarrier(scene, doc) ?? doc);
}

/** True when `doc` is the `partName`/`index` row of a legacy challenge block. */
function isChallengeRowPart(doc, partName, index) {
  return (
    doc?.getFlag?.(FLAG_SCOPE, "part") === partName &&
    Number(doc?.getFlag?.(FLAG_SCOPE, "index")) === index
  );
}

/** Status mark prefix shown in a menu label (or the empty string). */
function statusMark(status) {
  if (status === TASK_STATUS.SUCCESS) return MARK_SUCCESS;
  if (status === TASK_STATUS.FAILED) return MARK_FAILED;
  return "";
}

/** Menu icon of a task row for its status. */
function statusIcon(status) {
  if (status === TASK_STATUS.SUCCESS) return "fa-check";
  if (status === TASK_STATUS.FAILED) return "fa-xmark";
  return "fa-minus";
}

/** Inline icon color of a task row for its status (undefined = default). */
function statusIconColor(status) {
  if (status === TASK_STATUS.SUCCESS) return STATUS_COLORS.success;
  if (status === TASK_STATUS.FAILED) return STATUS_COLORS.failed;
  return undefined;
}

/**
 * PURE builder of the challenge context-menu items: one item per task with a
 * status submenu, plus a trailing "Delete block" entry. The label carries the
 * status mark as a prefix (`✅`/`❌`/none). The state is read from the block's
 * carrier, so a click on any legacy row yields the same menu.
 * @param {object} doc  Any Drawing of a challenge block.
 * @param {object} [scene]  Scene holding the block (defaults to `doc.parent`).
 * @param {{success?: string, failed?: string, reset?: string,
 *   removeBlock?: string}} [labels]  Localized labels (English defaults keep
 *   the pure builder testable).
 * @returns {Array<object>}  menu.js items.
 */
export function buildChallengeMenuItems(doc, scene = doc?.parent, labels = {}) {
  const success = labels.success ?? "Success";
  const failed = labels.failed ?? "Failed";
  const reset = labels.reset ?? "Reset";
  const editLabel = labels.edit ?? "Edit";
  const removeBlockLabel = labels.removeBlock ?? "Delete block";
  // Normalize ONCE and let every onClick capture that exact array, so the index
  // shown in the menu is applied to the same sequence the executor mutates.
  const tasks = normalizeTaskState(resolveChallengeState(scene, doc));
  const items = tasks.map((task, index) => {
    const mark = statusMark(task.status);
    return {
      icon: statusIcon(task.status),
      iconColor: statusIconColor(task.status),
      label: `${mark ? `${mark} ` : ""}${task.text} +${task.difficulty}`,
      children: [
        {
          icon: "fa-check",
          iconColor: STATUS_COLORS.success,
          label: success,
          disabled: task.status === TASK_STATUS.SUCCESS,
          onClick: async () =>
            setStatusChallengeTaskAndSync(doc, index, TASK_STATUS.SUCCESS, tasks, scene),
        },
        {
          icon: "fa-xmark",
          iconColor: STATUS_COLORS.failed,
          label: failed,
          disabled: task.status === TASK_STATUS.FAILED,
          onClick: async () =>
            setStatusChallengeTaskAndSync(doc, index, TASK_STATUS.FAILED, tasks, scene),
        },
        {
          icon: "fa-rotate-left",
          label: reset,
          disabled: task.status === TASK_STATUS.PENDING,
          onClick: async () =>
            setStatusChallengeTaskAndSync(doc, index, TASK_STATUS.PENDING, tasks, scene),
        },
      ],
    };
  });
  if (items.length) {
    items.push({ sep: true });
  }
  const legacy = doc?.getFlag?.(FLAG_SCOPE, "part") === LEGACY_TASK_ROW_PART;
  if (!legacy) {
    items.push({
      icon: "fa-pen-to-square",
      label: editLabel,
      onClick: () => openBlockEditor(doc, scene),
    });
  }
  items.push({
    icon: "fa-trash",
    label: removeBlockLabel,
    onClick: () => removeBlock(doc, scene),
  });
  return items;
}

/**
 * PURE builder of the contest context-menu items: one item per side with an
 * "Advance forward" / "Advance back" submenu, plus a trailing "Delete block"
 * entry. The parent item is NEVER disabled (menu.js only opens a submenu for a
 * non-disabled parent); the boundary is expressed by disabling the individual
 * child option instead: forward is disabled at `done >= boxes`, back at
 * `done <= 0`.
 * @param {object} doc  Drawing with the module contest flags.
 * @param {{advanceForward?: string, advanceBack?: string, removeBlock?: string}}
 *   [labels]  Localized labels; English defaults keep the pure builder testable.
 * @param {object} [scene]  Scene holding the block (defaults to `doc.parent`).
 * @returns {Array<object>}  menu.js items.
 */
export function buildContestMenuItems(doc, labels = {}, scene = doc?.parent) {
  const advanceForward = labels.advanceForward ?? "Advance forward";
  const advanceBack = labels.advanceBack ?? "Advance back";
  const editLabel = labels.edit ?? "Edit";
  const removeBlockLabel = labels.removeBlock ?? "Delete block";
  const items = normalizeSideState(contestStateOf(doc)).map((side, index) => ({
    icon: "fa-bolt",
    label: side.name,
    children: [
      {
        icon: "fa-arrow-right",
        label: advanceForward,
        disabled: side.done >= side.boxes,
        onClick: async () => advanceSideAndSync(doc, index, +1),
      },
      {
        icon: "fa-arrow-left",
        label: advanceBack,
        disabled: side.done <= 0,
        onClick: async () => advanceSideAndSync(doc, index, -1),
      },
    ],
  }));
  if (items.length) {
    items.push({ sep: true });
  }
  items.push(
    {
      icon: "fa-pen-to-square",
      label: editLabel,
      onClick: () => openBlockEditor(doc, scene),
    },
    {
      icon: "fa-trash",
      label: removeBlockLabel,
      onClick: () => removeBlock(doc, scene),
    },
  );
  return items;
}

/**
 * Merges `scopeFlags` into the `fate-on-the-table` scope of `doc`, preserving
 * every other flag (including the ADT drop-shadow flags).
 * @param {object} doc
 * @param {object} scopeFlags
 * @returns {object}
 */
function mergedScopeFlags(doc, scopeFlags) {
  const existing = doc?.flags ?? {};
  const currentScope = existing[FLAG_SCOPE] ?? {};
  return {
    ...existing,
    [FLAG_SCOPE]: { ...currentScope, ...scopeFlags },
  };
}

/**
 * Writes the derived text + the merged module flags in ONE embedded update.
 * The existing flags (including the ADT drop-shadow flags) are preserved; only
 * the `fate-on-the-table` scope keys in `scopeFlags` are replaced.
 * @param {object} doc  Drawing document.
 * @param {{text: string, scopeFlags: object}} input
 */
async function writeDrawingState(doc, { text, scopeFlags }) {
  const scene = doc?.parent ?? canvas?.scene;
  if (!scene?.updateEmbeddedDocuments) return;
  await scene.updateEmbeddedDocuments(
    "Drawing",
    [{ _id: doc.id, text, flags: mergedScopeFlags(doc, scopeFlags) }],
    { fateOnTheTableSync: true },
  );
}

/**
 * Glue: set one challenge task's status and persist the block state in ONE
 * marked `updateEmbeddedDocuments` (flags + derived text). For the new
 * single-drawing format the whole block text is re-rendered onto the carrier.
 * For a LEGACY multi-drawing block the clicked task's own row text is updated
 * (`renderChallengeTaskLine`) while the state stays on the index-0 carrier;
 * strike overlays are no longer created or removed.
 *
 * The caller passes the SAME normalized list the menu was built from; without a
 * list (defensive call) the block state is resolved here.
 */
async function setStatusChallengeTaskAndSync(
  doc,
  index,
  status,
  tasks,
  scene = doc?.parent ?? (typeof canvas !== "undefined" ? canvas?.scene : undefined),
) {
  const carrier = findChallengeStateCarrier(scene, doc) ?? doc;
  const list = Array.isArray(tasks)
    ? normalizeTaskState(tasks)
    : resolveChallengeState(scene, doc);
  const next = setChallengeTaskStatus(list, index, status);
  if (!next) return;
  if (!scene?.updateEmbeddedDocuments) return;

  const widgetId =
    carrier?.getFlag?.(FLAG_SCOPE, "widgetId") ??
    doc?.getFlag?.(FLAG_SCOPE, "widgetId") ??
    null;
  const legacy =
    carrier?.getFlag?.(FLAG_SCOPE, "part") === LEGACY_TASK_ROW_PART;

  const updates = [];
  const carrierUpdate = {
    _id: carrier.id,
    flags: mergedScopeFlags(carrier, { tasks: next }),
  };
  if (!legacy) {
    // New single drawing: the carrier IS the block; rewrite the whole text.
    carrierUpdate.text = renderChallengeText(next);
  } else {
    // Legacy: the carrier may be index 0 while another row holds the task.
    const carrierIndex = Number(carrier.getFlag(FLAG_SCOPE, "index"));
    if (carrierIndex === index) {
      carrierUpdate.text = renderChallengeTaskLine(next[index]);
    }
  }
  updates.push(carrierUpdate);

  if (legacy) {
    const row = challengeGroupDocs(scene, widgetId).find((d) =>
      isChallengeRowPart(d, LEGACY_TASK_ROW_PART, index),
    );
    if (row && row.id !== carrier.id) {
      updates.push({ _id: row.id, text: renderChallengeTaskLine(next[index]) });
    }
  }

  await scene.updateEmbeddedDocuments("Drawing", updates, {
    fateOnTheTableSync: true,
  });
}

/** Glue: open the shared editor for a challenge/contest block. */
async function openBlockEditor(doc, scene = doc?.parent) {
  const { editChallengeContestDocument } = await import(
    "./challengeContestMacro.js"
  );
  await editChallengeContestDocument(doc, scene);
}

/** Glue: advance one contest side (clamped) and persist text + state. */
async function advanceSideAndSync(doc, index, delta) {
  const next = advanceSide(contestStateOf(doc), index, delta);
  if (!next) return;
  await writeDrawingState(doc, {
    text: renderContestText(next),
    scopeFlags: { sides: next },
  });
}

/**
 * Glue: delete every drawing/tile of the block in ONE marked batch, IMMEDIATELY
 * (no confirmation dialog — the context-menu action is the confirmation). The
 * group is resolved by `widgetId` (legacy multi-drawing blocks included); a
 * single drawing without a `widgetId` deletes only itself.
 * @param {object} doc  Any Drawing of the block.
 * @param {object} [scene]  Scene holding the block (defaults to `doc.parent`).
 */
async function removeBlock(doc, scene = doc?.parent) {
  const targetScene =
    scene ?? (typeof canvas !== "undefined" ? canvas?.scene : undefined);
  if (!targetScene?.deleteEmbeddedDocuments) return;
  const widgetId = doc?.getFlag?.(FLAG_SCOPE, "widgetId");
  const docs = widgetId ? allWidgetDocs(targetScene, widgetId) : [doc];
  const drawingIds = docs
    .filter((d) => d?.documentName !== "Tile" && d?.id)
    .map((d) => d.id);
  const tileIds = docs
    .filter((d) => d?.documentName === "Tile" && d?.id)
    .map((d) => d.id);
  const options = { fateOnTheTableSync: true };
  if (drawingIds.length) {
    await targetScene.deleteEmbeddedDocuments("Drawing", drawingIds, options);
  }
  if (tileIds.length) {
    await targetScene.deleteEmbeddedDocuments("Tile", tileIds, options);
  }
}

/**
 * GM-only entry point for the challenge/contest context menu. Returns false
 * for a non-GM (native flow must continue), a foreign document, or an EMPTY
 * menu (no task / side to act on — the native event must stay untouched).
 * A shown menu returns true and is the ONLY place the event is consumed.
 * @param {object} doc  Drawing document with the module challenge/contest flags.
 * @param {Event|null} event  Pointer event.
 * @returns {Promise<boolean>}  True when a menu was shown (and the event consumed).
 */
export async function handleChallengeContestContextMenu(doc, event) {
  if (!isGmUser()) return false;
  const ownerType = doc?.getFlag?.(FLAG_SCOPE, "ownerType");
  const scene =
    doc?.parent ??
    (typeof canvas !== "undefined" ? canvas?.scene : undefined);
  if (ownerType === CHALLENGE_OWNER_TYPE) {
    const items = buildChallengeMenuItems(doc, scene, {
      success: ccT("success"),
      failed: ccT("failed"),
      reset: ccT("reset"),
      edit: ccT("edit"),
      removeBlock: ccT("removeBlock"),
    });
    if (!items.length) return false;
    consumeEvent(event);
    showCttMenu({
      items,
      event,
      // Keep the base class so the shared .ctt-menu styling applies.
      menuClass: "ctt-menu ctt-challenge-menu",
    });
    return true;
  }
  if (ownerType === CONTEST_OWNER_TYPE) {
    const items = buildContestMenuItems(
      doc,
      {
        advanceForward: ccT("advanceForward"),
        advanceBack: ccT("advanceBack"),
        edit: ccT("edit"),
        removeBlock: ccT("removeBlock"),
      },
      scene,
    );
    if (!items.length) return false;
    consumeEvent(event);
    showCttMenu({
      items,
      event,
      // Keep the base class so the shared .ctt-menu styling applies.
      menuClass: "ctt-menu ctt-contest-menu",
    });
    return true;
  }
  return false;
}
