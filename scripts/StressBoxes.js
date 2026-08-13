/**
 * StressBoxes — interactive stress checkboxes on the character widget.
 *
 * Every checkbox of a "boxRow" layout element is its own Drawing placed
 * ABOVE the transparent widget grab frame (elevation/sort in the layout),
 * so a single left-click lands on the box. This module patches the single
 * click handler of Drawing placeables: when the clicked drawing is a stress
 * box of an actor widget, the box is toggled (checked/unchecked) on the
 * actor instead of selecting the drawing.
 *
 * Toggling writes `system.tracks.<key>.box_values` and relies on the usual
 * updateActor -> debounced widget sync to refresh the box text ("X"/empty).
 */

import { FLAG_SCOPE } from "./constants.js";
import { stressBoxTarget } from "./WidgetBuilder.js";

const BOX_PART = "stressBoxRows";

let interactionsPatched = false;

/**
 * Patches Drawing#_onClickLeft. Runs at module load (top level), so it
 * survives page reloads.
 */
export function initStressBoxInteractions() {
  if (interactionsPatched) return;
  interactionsPatched = true;
  if (typeof Drawing === "undefined") return;
  const proto = Drawing.prototype;
  if (proto.__fateOnTheTableStressClick) return;
  proto.__fateOnTheTableStressClick = true;

  const original = proto._onClickLeft;
  proto._onClickLeft = async function (event) {
    const doc = this.document ?? this;
    const isStressBox =
      doc?.getFlag?.(FLAG_SCOPE, "part") === BOX_PART &&
      doc?.getFlag?.(FLAG_SCOPE, "actorUuid") &&
      Number(doc.getFlag?.(FLAG_SCOPE, "index") ?? -1) >= 0;
    if (!isStressBox) {
      return original?.call(this, event);
    }
    event?.preventDefault?.();
    event?.stopPropagation?.();
    const actorUuid = doc.getFlag(FLAG_SCOPE, "actorUuid");
    const index = Number(doc.getFlag(FLAG_SCOPE, "index"));
    try {
      const actor = await fromUuid(actorUuid);
      if (!actor) return;
      if (
        !actor.testUserPermission?.(
          game.user,
          CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER,
        )
      ) {
        ui.notifications.warn(
          game.i18n.localize("fate-on-the-table.stressBoxes.notOwner"),
        );
        return;
      }
      await toggleStressBox(actor, index);
    } catch (err) {
      console.warn("[fate-on-the-table] stress box toggle failed:", err);
    }
  };
}

/**
 * Toggles the checked state of a stress box on the actor.
 * @param {object} actor
 * @param {number} flatIndex  Flat box index (the drawing's `index` flag).
 * @returns {Promise<boolean>}  True when a box was toggled.
 */
export async function toggleStressBox(actor, flatIndex) {
  const target = stressBoxTarget(actor, flatIndex);
  if (!target) return false;
  const tracks = foundry.utils.duplicate(actor.system.tracks);
  const track = tracks[target.trackKey];
  if (!track) return false;
  const values = Array.isArray(track.box_values)
    ? [...track.box_values]
    : [];
  while (values.length <= target.boxIndex) values.push(false);
  values[target.boxIndex] = !values[target.boxIndex];
  await actor.update({
    "system.tracks": { [target.trackKey]: { box_values: values } },
  });
  return true;
}
