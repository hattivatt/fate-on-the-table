/**
 * situationAspectActions — mutation logic for the situation aspects list
 * (`fate-core-official.situation_aspects`) behind the GM context menu of the
 * situation aspects widget (FatePointManager right-click routing).
 *
 * Split in two layers so Node tests can cover everything without Foundry:
 * - PURE list/menu helpers (no Foundry globals at call time):
 *     `adjustInvokesInList`, `removeAspectFromList`, `saAspectMenuItems`,
 *     `saWidgetMenuItems`;
 * - GM-guarded SCENE operations with the same commit path as the manager's
 *     `commitAspects` (read -> mutate a clone -> one setFlag ->
 *     `syncSituationAspects`): `adjustInvokes`, `removeAspectAt`.
 *
 * Unknown extra fields of the system aspect objects (e.g. `linked`) are
 * preserved verbatim; the data format itself is NOT extended.
 */

import {
  situationAspects,
  syncSituationAspects,
} from "./SituationAspectSync.js";
import {
  SITUATION_ASPECTS_SCOPE,
  SITUATION_ASPECTS_KEY,
} from "./constants.js";

/** Non-negative integer of free invokes (fixes strings / negatives / NaN). */
function clampInvokes(value) {
  return Math.max(0, Math.trunc(Number(value) || 0));
}

/** True when `index` addresses an element of `list`. */
function validIndex(list, index) {
  return (
    Array.isArray(list) &&
    Number.isInteger(index) &&
    index >= 0 &&
    index < list.length
  );
}

/**
 * Pure +/- on the free invokes of one aspect. Returns a NEW list (new aspect
 * objects via shallow copies — unknown fields survive); `null` for an
 * invalid list or index. The invoke count never goes below zero.
 * @param {object[]} list  Aspect list (raw or normalized).
 * @param {number} index  List position of the aspect.
 * @param {number} delta  Signed amount of invokes to add.
 * @returns {object[]|null}
 */
export function adjustInvokesInList(list, index, delta) {
  if (!validIndex(list, index)) return null;
  const step = Math.trunc(Number(delta) || 0);
  return list.map((aspect, i) =>
    i === index
      ? {
          ...aspect,
          // Number() first: a raw string value ("3") would otherwise do JS
          // string concatenation ("3" + 1 -> "31") instead of arithmetic.
          free_invokes: clampInvokes(Number(aspect.free_invokes) + step),
        }
      : { ...aspect },
  );
}

/**
 * Pure removal of one aspect by position. Returns a NEW list without the
 * element (other element references preserved); `null` for an invalid list
 * or index.
 * @param {object[]} list  Aspect list.
 * @param {number} index  List position to remove.
 * @returns {object[]|null}
 */
export function removeAspectFromList(list, index) {
  if (!validIndex(list, index)) return null;
  return [...list.slice(0, index), ...list.slice(index + 1)];
}

/**
 * PURE builder of the per-aspect context menu items (showMenu-style:
 * `{icon, label, disabled?, sep?, onClick}`; labels arrive ALREADY
 * localized). Layout: add invoke, remove invoke (disabled at 0 free
 * invokes), separator, edit, delete.
 * @param {object} [options]
 * @param {number} [options.freeInvokes]  Current free_invokes of the aspect.
 * @param {{addInvoke?: string, removeInvoke?: string, edit?: string, delete?: string}} [options.labels]
 * @param {{addInvoke?: Function, removeInvoke?: Function, edit?: Function, delete?: Function}} [options.handlers]
 * @returns {object[]}
 */
export function saAspectMenuItems({
  freeInvokes = 0,
  labels = {},
  handlers = {},
} = {}) {
  return [
    {
      icon: "fa-plus",
      label: labels.addInvoke ?? "",
      onClick: handlers.addInvoke,
    },
    {
      icon: "fa-minus",
      label: labels.removeInvoke ?? "",
      disabled: !(Number(freeInvokes) > 0),
      onClick: handlers.removeInvoke,
    },
    { icon: "", label: "", sep: true },
    {
      icon: "fa-pen",
      label: labels.edit ?? "",
      onClick: handlers.edit,
    },
    {
      icon: "fa-trash",
      label: labels.delete ?? "",
      onClick: handlers.delete,
    },
  ];
}

/**
 * PURE builder of the widget (empty-place) context menu items: open the
 * manager, begin adding an aspect, separator, remove the widget. The remove
 * item renders disabled unless `widgetPlaced` confirms a live registry
 * record.
 * @param {object} [options]
 * @param {boolean} [options.widgetPlaced]
 * @param {{openManager?: string, addAspect?: string, removeWidget?: string}} [options.labels]
 * @param {{openManager?: Function, addAspect?: Function, removeWidget?: Function}} [options.handlers]
 * @returns {object[]}
 */
export function saWidgetMenuItems({
  widgetPlaced = true,
  labels = {},
  handlers = {},
} = {}) {
  return [
    {
      icon: "fa-list-ul",
      label: labels.openManager ?? "",
      onClick: handlers.openManager,
    },
    {
      icon: "fa-plus",
      label: labels.addAspect ?? "",
      onClick: handlers.addAspect,
    },
    { icon: "", label: "", sep: true },
    {
      icon: "fa-trash",
      label: labels.removeWidget ?? "",
      disabled: !widgetPlaced,
      onClick: handlers.removeWidget,
    },
  ];
}

/** GM guard shared by the scene operations below. */
function isGm() {
  try {
    return game?.user?.isGM === true;
  } catch {
    return false;
  }
}

/**
 * Commits a mutated aspect list the same way the manager dialog does: ONE
 * setFlag on the system scope, then an immediate widget re-sync.
 * @param {object} scene  Scene document.
 * @param {object[]} list  New aspect list.
 */
async function commitList(scene, list) {
  await scene.setFlag(SITUATION_ASPECTS_SCOPE, SITUATION_ASPECTS_KEY, list);
  await syncSituationAspects(scene);
}

/**
 * GM operation: adds `delta` free invokes to `aspects[index]` (never below
 * zero) and re-syncs the widget. No-op for non-GM users, a missing scene or
 * an out-of-range index.
 * @param {object} scene  Scene document.
 * @param {number} index  List position of the aspect.
 * @param {number} delta  Signed amount (+1 / −1 from the menu).
 * @returns {Promise<boolean>}  True when the list was changed.
 */
export async function adjustInvokes(scene, index, delta) {
  if (!scene || !isGm()) return false;
  const next = adjustInvokesInList(situationAspects(scene), index, delta);
  if (!next) return false;
  await commitList(scene, next);
  return true;
}

/**
 * GM operation: removes `aspects[index]` and re-syncs the widget. No-op for
 * non-GM users, a missing scene or an out-of-range index. The caller owns
 * the confirmation dialog (same wording as the manager dialog).
 * @param {object} scene  Scene document.
 * @param {number} index  List position to remove.
 * @returns {Promise<boolean>}  True when the list was changed.
 */
export async function removeAspectAt(scene, index) {
  if (!scene || !isGm()) return false;
  const next = removeAspectFromList(situationAspects(scene), index);
  if (!next) return false;
  await commitList(scene, next);
  return true;
}
