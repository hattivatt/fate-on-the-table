/**
 * conflictUi — pure DOM helpers for the "Place conflict board" entry points
 * (the standard Foundry Combat Tracker and the Fate Core system's Fate
 * Utilities app).
 *
 * Kept dependency-free (browser DOM only, no Foundry globals, no i18n) so the
 * insertion strategy can be regression-tested under Node with a minimal DOM
 * stub. Localization and permission gating stay in the hooks in module.js.
 */

/** Marker used to guard against duplicate insertion across re-renders. */
export const CONFLICT_PLACE_MARKER = "data-ctt-conflict-place";

/** True when a "Place conflict board" control already exists in `root`. */
export function hasConflictPlaceButton(root) {
  return !!(root?.querySelector?.(`[${CONFLICT_PLACE_MARKER}]`));
}

/**
 * Builds the Combat Tracker control — a compact `<a class="combat-control">`
 * carrying the label "Place on the table". It is inserted as its OWN row above
 * the standard `.combat-controls` (previous / next / end combat), so it keeps
 * the `combat-control` visual language without joining that flex row.
 * @param {string} label  Localized button text.
 * @returns {HTMLAnchorElement}
 */
export function createCombatTrackerPlaceButton(label) {
  const button = document.createElement("a");
  button.href = "#";
  button.dataset.cttConflictPlace = "";
  button.className = "combat-control ctt-combat-place";
  button.title = label;
  button.innerHTML = `<i class="fas fa-th-large"></i> ${label}`;
  return button;
}

/**
 * Inserts the Combat Tracker button as a standalone row directly ABOVE the
 * existing `.combat-controls` row (it never becomes part of that flex row).
 *
 * Anchor resolution (same hierarchy the module used before, kept as the
 * fallback chain):
 *   1. `.combat-controls`       — the standard previous/next/end row; the
 *      button is inserted immediately before it (still inside the footer nav);
 *   2. `header.encounters`      — system/apps without the core controls row;
 *   3. the tracker `root`       — last resort: appended like the old code.
 *
 * Duplicate guard: when `[data-ctt-conflict-place]` is already present the
 * button is not re-inserted (returns false).
 * @param {object} root   DOM root of the rendered tracker.
 * @param {object} button The `<a>` created by `createCombatTrackerPlaceButton`.
 * @returns {boolean}
 */
export function insertCombatTrackerBoardPlacement(root, button) {
  if (!root?.querySelector) return false;
  if (hasConflictPlaceButton(root)) return false;

  const controls = root.querySelector(".combat-controls");
  if (controls?.parentNode?.insertBefore) {
    controls.parentNode.insertBefore(button, controls);
    return true;
  }

  const header = root.querySelector("header.encounters");
  if (header?.parentNode?.insertBefore) {
    header.parentNode.insertBefore(button, header);
    return true;
  }

  if (typeof root?.append === "function") {
    root.append(button);
    return true;
  }
  return false;
}

/**
 * Builds the icon-only Fate Utilities button. Keeps ONLY the
 * `fas fa-th-large` icon (no text); the localized tooltip lives in `title`.
 * The inline style mirrors the neighbouring icon buttons of the Fate Core
 * conflict pane (`fu_button`, 35×35px, groove border, sheet colours).
 * @param {string} title  Localized tooltip.
 * @returns {HTMLButtonElement}
 */
export function createFateUtilsPlaceButton(title) {
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.cttConflictPlace = "";
  button.className = "fu_button ctt-fu-conflict-place";
  button.title = title;
  button.innerHTML = '<i class="fas fa-th-large"></i>';
  button.style.cssText =
    "border:2px groove var(--fco-foundry-interactable-color); " +
    "background-color:var(--fco-sheet-input-colour); " +
    "color:var(--fco-sheet-text-colour); width:35px; height:35px;";
  return button;
}

/**
 * Inserts the Fate Utilities icon button EXACTLY between the "Timed event"
 * control (`#fco_timed_event`) and the "Cycle to next available conflict"
 * control (`#fco_next_conflict`).
 *
 * Real DOM (Fate Core official `FateUtilities.html`, GM conflict pane <tr>):
 *   <tr>
 *     <td>  <div flex-row> [ #fco_next_exchange ] [ #fco_timed_event ] </div>        </td>
 *     <td>  <div flex-row> [ #fco_next_conflict ] [ #fco_add_conflict ] [ #fco_end_conflict ] </div> </td>
 *   </tr>
 *
 * `#fco_timed_event` and `#fco_next_conflict` live in DIFFERENT table cells,
 * so inserting "between" them must not splice the table structure. Instead the
 * button is appended into the timed event's own flex row directly AFTER
 * `#fco_timed_event` — which visually lands it right before the next cell
 * starting with `#fco_next_conflict`. Fallback: when the timed event is
 * missing, the button is inserted immediately before `#fco_next_conflict`
 * inside its own row.
 * @param {object} root   DOM root of the rendered Fate Utilities app.
 * @param {object} button The `<button>` created by `createFateUtilsPlaceButton`.
 * @returns {boolean}
 */
export function insertFateUtilsBoardPlacement(root, button) {
  if (!root?.querySelector) return false;
  if (hasConflictPlaceButton(root)) return false;

  const timedEvent = root.querySelector("#fco_timed_event");
  if (timedEvent?.parentNode?.insertBefore) {
    timedEvent.parentNode.insertBefore(
      button,
      timedEvent.nextElementSibling ?? null,
    );
    return true;
  }

  const nextConflict = root.querySelector("#fco_next_conflict");
  if (nextConflict?.parentNode?.insertBefore) {
    nextConflict.parentNode.insertBefore(button, nextConflict);
    return true;
  }

  return false;
}

/**
 * Wires the shared "Place conflict board" click handler used by BOTH buttons
 * (Combat Tracker and Fate Utilities). Single code path to
 * `ConflictManager.placeBoard()`; disables the button while a placement is in
 * flight so a re-render (or a second click) can never start a second one.
 * @param {object} button Button/anchor element.
 * @param {() => Promise<unknown>} onPlace The `placeBoard` entry point.
 */
export function attachPlaceBoardClick(button, onPlace) {
  button.addEventListener("click", (event) => {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    button.disabled = true;
    Promise.resolve()
      .then(onPlace)
      .catch((err) =>
        console.error?.(
          "[fate-on-the-table] conflict board placement failed:",
          err,
        ),
      )
      .finally(() => {
        button.disabled = false;
      });
  });
}