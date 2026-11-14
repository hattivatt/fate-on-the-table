/**
 * StressBoxes — interactive stress checkboxes on the character widget.
 *
 * Every checkbox of a "boxRow" layout element is its own Drawing placed
 * ABOVE the transparent widget grab frame (elevation/sort in the layout),
 * so a single left-click lands on the box. This module patches the single
 * click handler of Drawing placeables: when the clicked drawing is a
 * STRESS box of an actor widget, the box is toggled (checked/unchecked) on
 * the actor instead of selecting the drawing. Consequences have NO
 * interactive checkbox — they are text COST rows edited by double-click
 * (`ConsequenceInteractions`) — so only the stress box part toggles.
 *
 * Toggling a stress box writes `system.tracks.<key>.box_values` and relies
 * on the usual updateActor -> debounced widget sync to refresh the box text
 * ("X"/empty).
 *
 * Conflict-card stress rows are recognized too (ownerType conflictCard +
 * part stressBoxRows + valid index): their token/actor is resolved through
 * game.combats so both linked and unlinked token actors toggle, and the card
 * is re-projected by the existing updateActor/updateToken hooks.
 */

import { canEditActor, warnNotOwner } from "./utils.js";
import {
  FLAG_SCOPE,
  CONFLICT_CARD_OWNER_TYPE,
  STRESS_BOX_PART,
} from "./constants.js";
import { isStressBoxWidget } from "./widgetInteractionRouter.js";
import { stressBoxTarget } from "./WidgetBuilder.js";
import { wrapMethod } from "./patchMethod.js";

export { STRESS_BOX_PART };

let interactionsPatched = false;

/**
 * Resolves the Foundry v14 canvas placeable classes from
 * `foundry.canvas.placeables`. Returns `null` under Node (no `foundry`), so
 * callers can bail out and prototype patching is skipped.
 * @returns {{Drawing?: Function, Tile?: Function, Token?: Function}|null}
 */
function resolvePlaceables() {
  if (typeof foundry === "undefined") return null;
  return foundry.canvas?.placeables ?? null;
}

/**
 * Wraps Drawing#_onClickLeft (via `wrapMethod`: libWrapper when available,
 * MIXED because a box click never reaches the native handler). Runs at module load (top level), so it
 * survives page reloads. Only the native PIXI path (the Drawing layer is
 * active) reaches this handler; the module's DOM canvas fallback routes
 * box clicks through `handleStressBoxClick` as well, so owners can toggle
 * boxes no matter which layer is active.
 */
export function initStressBoxInteractions() {
  if (interactionsPatched) return;
  interactionsPatched = true;
  // Foundry v14: resolve the placeable class from the namespace (the bare
  // `Drawing` global is deprecated, removed in v15). Under Node this is null.
  const { Drawing } = resolvePlaceables() ?? {};
  if (!Drawing) return;
  wrapMethod(
    Drawing.prototype,
    {
      cls: "Drawing",
      path: "foundry.canvas.placeables.Drawing.prototype",
      method: "_onClickLeft",
    },
    async function (wrapped, event, ...rest) {
      const doc = this.document ?? this;
      if (!isBoxDrawing(doc)) {
        return wrapped(event, ...rest);
      }
      return handleStressBoxClick(doc, event);
    },
    { type: "MIXED" },
  );
}

/**
 * True when a Drawing document is an interactive STRESS box that toggles on
 * a single click. Two identity shapes are recognized:
 *  - ordinary actor widget stress boxes: the `stressBoxRows` part, an
 *    `actorUuid` identity and a flat `index >= 0`;
 *  - conflict-card stress box rows: `ownerType: conflictCard`, part
 *    `stressBoxRows` and a flat `index >= 0` (the conflict card has no
 *    `actorUuid` for unlinked tokens; consequence cost rows are text rows
 *    edited by double-click, not single-click boxes).
 * Consequence checkbox parts are NOT interactive: consequences are text only.
 * @param {object|null} doc  Drawing/Tile document.
 * @returns {boolean}
 */
export function isBoxDrawing(doc) {
  return isStressBoxWidget(doc);
}

/**
 * Compatibility alias used by FatePointManager's native/DOM click routing:
 * true when a Drawing document is an interactive ACTOR-WIDGET stress box
 * (an `actorUuid` identity and a flat `index >= 0`). Consequence checkbox
 * parts are not interactive and never match.
 * @param {object|null} doc
 * @returns {boolean}
 */
export function isStressBoxDrawing(doc) {
  return isBoxDrawing(doc);
}

/**
 * Toggles an interactive STRESS box from a click event. Shared by the native
 * `_onClickLeft` patch and the module's DOM canvas fallback so the toggle
 * works for the actor's owner regardless of the active canvas layer. Only the
 * owner may toggle; anyone else gets the localized warning. Consequences have
 * no single-click checkbox — they are text cost rows (double-click input).
 *
 * The target actor is resolved through the drawing's identity:
 *  - an ordinary actor widget box resolves its `actorUuid` via `fromUuid`;
 *  - a conflict-card stress row resolves its token/actor through
 *    `game.combats` / combatant / `tokenUuid` (linked AND unlinked synthetic
 *    token actors), never relying only on `fromUuid` for synthetic actors.
 * @param {object} doc  Box Drawing document.
 * @param {Event|null} event  DOM/MIM event (optional).
 * @returns {Promise<void>}
 */
export async function handleStressBoxClick(doc, event) {
  event?.preventDefault?.();
  event?.stopPropagation?.();
  const index = Number(doc.getFlag(FLAG_SCOPE, "index"));
  try {
    const resolved = await resolveBoxActor(doc);
    const actor = resolved?.actor;
    if (!actor) return;
    if (!canEditActor(actor)) {
      warnNotOwner("fate-on-the-table.stressBoxes.notOwner");
      return;
    }
    await toggleStressBox(actor, index, resolved?.token ?? null);
  } catch (err) {
    console.warn("[fate-on-the-table] stress box toggle failed:", err);
  }
}

/**
 * Resolves the target actor (+ token for unlinked synthetic actors) of an
 * interactive box document by its identity flags.
 * @param {object} doc  Box Drawing document.
 * @returns {Promise<{actor: object|null, token: object|null}|null>}
 */
async function resolveBoxActor(doc) {
  const ownerType = doc.getFlag(FLAG_SCOPE, "ownerType");
  if (ownerType === CONFLICT_CARD_OWNER_TYPE) {
    return resolveConflictCardActor(doc);
  }
  const actorUuid = doc.getFlag(FLAG_SCOPE, "actorUuid");
  if (!actorUuid) return null;
  const actor = await fromUuid(actorUuid);
  return actor ? { actor, token: null } : null;
}

/**
 * Resolves the token/actor behind a conflict-card stress box row through the
 * board's live combat (`game.combats` + combatantId), falling back to the
 * stored `tokenUuid`. Works for linked AND unlinked synthetic token actors.
 * @param {object} doc  Conflict-card Drawing document.
 * @returns {Promise<{actor: object|null, token: object|null}|null>}
 */
async function resolveConflictCardActor(doc) {
  const combatId = doc.getFlag(FLAG_SCOPE, "combatId");
  const combatantId = doc.getFlag(FLAG_SCOPE, "combatantId");
  const tokenUuid = doc.getFlag(FLAG_SCOPE, "tokenUuid");
  try {
    if (typeof game !== "undefined" && game?.combats?.get && combatId) {
      const combat = game.combats.get(combatId);
      const combatants = Array.isArray(combat?.combatants)
        ? combat.combatants
        : (combat?.combatants?.contents ?? []);
      const combatant = combatants.find((c) => c?.id === combatantId);
      if (combatant?.token?.actor) {
        return { actor: combatant.token.actor, token: combatant.token };
      }
      if (combatant?.actor) {
        return { actor: combatant.actor, token: combatant.token ?? null };
      }
    }
  } catch (err) {
    /* fall through to the tokenUuid lookup */
  }
  if (typeof fromUuid === "function" && tokenUuid) {
    try {
      const token = await fromUuid(tokenUuid);
      if (token?.actor) return { actor: token.actor, token };
    } catch (err) {
      return null;
    }
  }
  return null;
}

/**
 * Toggles the checked state of a stress box on the actor.
 * @param {object} actor
 * @param {number} flatIndex  Flat box index (the drawing's `index` flag).
 * @param {object|null} token  Token document for an unlinked synthetic token
 *   actor (writes through `token.update({delta})` so it persists).
 * @returns {Promise<boolean>}  True when a box was toggled.
 */
export async function toggleStressBox(actor, flatIndex, token = null) {
  if (!canEditActor(actor)) {
    warnNotOwner("fate-on-the-table.stressBoxes.notOwner");
    return false;
  }
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
  if (token && actor.isToken) {
    // Unlinked synthetic token actor: persist through the token document's
    // delta (the standard Fate Core path for embedded token actors).
    await token.update({
      delta: {
        system: { tracks: { [target.trackKey]: { box_values: values } } },
      },
    });
  } else {
    await actor.update({
      "system.tracks": { [target.trackKey]: { box_values: values } },
    });
  }
  return true;
}
