import { FLAG_SCOPE } from "./constants.js";

/** All drawings and tiles of a widget on a given scene. */
export function allWidgetDocs(scene, widgetId) {
  return [...scene.drawings, ...scene.tiles].filter(
    (d) => d.getFlag(FLAG_SCOPE, "widgetId") === widgetId,
  );
}

/**
 * All drawings and tiles of a scene whose `ownerType` flag matches one of the
 * given types (optionally restricted to a single widget id). Used by the
 * conflict-document routing (module-owned docs only, never foreign ones).
 * @param {object} scene
 * @param {string|string[]} ownerTypes
 * @param {string|null} [widgetId]
 * @returns {object[]}
 */
export function widgetDocsByOwnerType(scene, ownerTypes, widgetId = null) {
  const types = new Set(Array.isArray(ownerTypes) ? ownerTypes : [ownerTypes]);
  return [...scene.drawings, ...scene.tiles].filter((d) => {
    const ownerType = d.getFlag(FLAG_SCOPE, "ownerType");
    if (!ownerType || !types.has(ownerType)) return false;
    if (widgetId && d.getFlag(FLAG_SCOPE, "widgetId") !== widgetId) return false;
    return true;
  });
}
