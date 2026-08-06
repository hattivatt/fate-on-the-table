import { FLAG_SCOPE } from "./constants.js";

/** All drawings and tiles of a widget on a given scene. */
export function allWidgetDocs(scene, widgetId) {
  return [...scene.drawings, ...scene.tiles].filter(
    (d) => d.getFlag(FLAG_SCOPE, "widgetId") === widgetId,
  );
}
