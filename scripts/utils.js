/**
 * Shared pure utilities (no Foundry globals at import time).
 * Extracted from duplicated copies across the codebase.
 */

/**
 * Escapes HTML special characters.
 * @param {*} text
 * @returns {string}
 */
export function escapeHtml(text) {
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
 * Reads a named field from a DialogV2.input() result. In Foundry v14 the
 * result is the submitted form data (a plain object keyed by the field `name`
 * attributes, or a FormData instance in some builds), the id of a non-ok
 * button (e.g. `"cancel"`), or `null` when the dialog was dismissed. Returns
 * the raw field value, or `undefined` when absent/cancelled.
 * @param {unknown} result
 * @param {string} name
 * @returns {string|number|File|null|undefined}
 */
export function dialogField(result, name) {
  if (!result || typeof result !== "object") return undefined;
  if (typeof FormData !== "undefined" && result instanceof FormData) {
    return result.get(name);
  }
  return result[name];
}

/**
 * Converts a pointer event's client coords into canvas world coords (unified,
 * most robust guard of the three former copies).
 * Returns null when the event, canvas, view, rect or worldTransform are
 * missing, or on any exception.
 * @param {MouseEvent|PointerEvent|null|undefined} event
 * @returns {{x:number,y:number}|null}
 */
export function canvasWorldPosition(event) {
  if (event == null || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return null;
  try {
    const c = typeof canvas !== "undefined" ? canvas : globalThis?.canvas;
    const view = c?.app?.view;
    if (!view) return null;
    const rect = view.getBoundingClientRect?.();
    if (!rect || !Number.isFinite(rect.left) || !Number.isFinite(rect.top)) return null;
    if (!Number.isFinite(rect.width) || !Number.isFinite(rect.height) || !rect.width || !rect.height) return null;
    const x = (event.clientX - rect.left) * (view.width / rect.width);
    const y = (event.clientY - rect.top) * (view.height / rect.height);
    const worldTransform = c?.stage?.worldTransform;
    if (!worldTransform?.applyInverse) return null;
    const P = typeof PIXI !== "undefined" ? PIXI : globalThis?.PIXI;
    if (!P?.Point) return null;
    const world = worldTransform.applyInverse(new P.Point(x, y));
    if (!world || !Number.isFinite(world.x) || !Number.isFinite(world.y)) return null;
    return { x: world.x, y: world.y };
  } catch {
    return null;
  }
}

/**
 * Normalizes any collection shape found in Foundry (Array, {contents}, {values()}, Map, iterable)
 * into an array. Non-collection / non-iterable -> [].
 * @param {*} collection
 * @returns {Array}
 */
export function toArray(collection) {
  if (!collection) return [];
  if (Array.isArray(collection)) return collection;
  if (Array.isArray(collection?.contents)) return collection.contents;
  if (typeof collection?.values === "function") {
    try {
      return [...collection.values()];
    } catch {
      // fall through to Map / iterable
    }
  }
  if (collection instanceof Map) return [...collection.values()];
  try {
    return [...collection];
  } catch {
    return [];
  }
}
