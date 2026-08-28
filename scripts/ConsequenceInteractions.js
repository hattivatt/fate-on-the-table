/**
 * ConsequenceInteractions — double-click input for the consequence COST rows
 * of a conflict card (and, when present and routable, an ordinary actor
 * widget). A consequence cost row is a text Drawing (an occupied slot shows
 * the actual consequence name; a free slot shows its `harm_can_absorb` cost
 * padded with underscores). Double-clicking a cost row prompts for the
 * consequence name instead of opening the character sheet, writes it to the
 * actor's track as text (`system.tracks.<trackKey>.aspect.name`, writing an
 * empty `box_values` array `[]`). The Fate Core sheet renders consequence
 * checkboxes by iterating `box_values`, so `[]` draws NO consequence
 * checkbox at all — the card never marks a consequence box, and the cost
 * stays a read-only `harm_can_absorb` label — via the standard
 * linked/token-delta paths, and keeps the scene situation aspects
 * (`fate-core-official.situation_aspects`) in sync
 * with the Fate Core linked-aspect format:
 * `name: "<consequence> (<actor.name>)"`, `linked: true`, deduplicated.
 *
 * The check for this part MUST run before the general conflict-card
 * double-click (which opens the sheet), so the integration points in
 * FatePointManager call `handleConsequenceCostDoubleClick` first.
 */

import { FLAG_SCOPE, CONFLICT_CARD_OWNER_TYPE } from "./constants.js";
import {
  SITUATION_ASPECTS_SCOPE,
  SITUATION_ASPECTS_KEY,
} from "./constants.js";
import { consequenceCostTarget } from "./WidgetBuilder.js";
import { syncConflictBoard } from "./ConflictBoardSync.js";
import { buildConsequenceMeta } from "./situationAspectConsequences.js";

export const CONSEQUENCE_COST_ROWS_PART = "consequenceCostRows";

const OWNER = globalThis.CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 2;

/**
 * True when a Drawing document is an editable consequence cost row:
 * part `consequenceCostRows` with a flat `index >= 0`. Recognized on
 * conflict-card projections (`ownerType: conflictCard`) and on ordinary
 * actor widgets that carry the part + `actorUuid` identity.
 * @param {object} doc  Drawing/Tile document.
 * @returns {boolean}
 */
export function isConsequenceCostPart(doc) {
  const d = doc?.document ?? doc;
  if (!d?.getFlag) return false;
  if (d.getFlag(FLAG_SCOPE, "part") !== CONSEQUENCE_COST_ROWS_PART) return false;
  const index = Number(d.getFlag(FLAG_SCOPE, "index") ?? -1);
  if (!Number.isInteger(index) || index < 0) return false;
  const ownerType = d.getFlag(FLAG_SCOPE, "ownerType");
  if (ownerType === CONFLICT_CARD_OWNER_TYPE) return true;
  return !!d.getFlag(FLAG_SCOPE, "actorUuid");
}

/**
 * Double-click on a consequence cost row: prompts for the consequence name
 * (current name pre-filled) and, on OK, writes it to the track + situation
 * aspects. Cancel is a no-op. Only the actor owner may edit; everyone else
 * gets the localized warning. Returns true when the event was consumed
 * (a consequence cost part was handled).
 * @param {object} document  Drawing/Tile document.
 * @param {Event|null} event  DOM/MIM event (optional).
 * @returns {Promise<boolean>}
 */
export async function handleConsequenceCostDoubleClick(document, event) {
  const doc = document?.document ?? document;
  if (!isConsequenceCostPart(doc)) return false;
  event?.preventDefault?.();
  event?.stopPropagation?.();
  const resolved = await resolveActor(doc);
  const actor = resolved?.actor;
  if (!actor) return true;
  if (!actor.testUserPermission?.(game.user, OWNER)) {
    if (typeof ui !== "undefined") {
      ui.notifications.warn(
        game.i18n.localize("fate-on-the-table.consequence.notOwner"),
      );
    }
    return true;
  }
  const index = Number(doc.getFlag(FLAG_SCOPE, "index"));
  const trackKey =
    doc.getFlag(FLAG_SCOPE, "trackKey") ?? consequenceCostTarget(actor, index)?.trackKey;
  if (!trackKey) return true;
  const track = actor.system?.tracks?.[trackKey];
  if (!track) return true;
  const currentName = String(track.aspect?.name ?? "").trim();

  const entered = await promptConsequenceName(currentName);
  if (entered === null || entered === undefined) return true; // cancelled

  const consequenceText = String(entered).trim();
  await writeConsequence(actor, resolved?.token ?? null, trackKey, consequenceText);

  const scene = canvas?.scene;
  const actorName = String(actor.name ?? "");
  if (scene && actorName && (consequenceText || currentName)) {
    const meta = buildConsequenceMeta(trackKey, actor.system?.tracks?.[trackKey]?.harm_can_absorb, actorName);
    await upsertSituationAspect(scene, actorName, consequenceText, currentName, meta);
  }

  // Re-project the board. The actor/token update already fires the module's
  // updateActor / updateToken hooks (debounced, serialized); the explicit,
  // idempotent sync gives immediate feedback without a recursive hook loop
  // (a later hook-fired sync of unchanged state is a no-op).
  if (scene && typeof syncConflictBoard === "function") {
    try {
      await syncConflictBoard(scene);
    } catch (err) {
      /* best-effort re-projection */
    }
  }
  return true;
}

/**
 * Resolves the target actor (and token for unlinked synthetic actors) of a
 * consequence cost row: conflict cards through game.combats / combatant /
 * tokenUuid, ordinary widgets through the `actorUuid`.
 * @param {object} doc  Drawing/Tile document.
 * @returns {Promise<{actor: object|null, token: object|null}|null>}
 */
async function resolveActor(doc) {
  const ownerType = doc.getFlag(FLAG_SCOPE, "ownerType");
  if (ownerType === CONFLICT_CARD_OWNER_TYPE) {
    return resolveConflictCardActor(doc);
  }
  const actorUuid = doc.getFlag(FLAG_SCOPE, "actorUuid");
  if (!actorUuid) return null;
  const actor = await fromUuidSafe(actorUuid);
  return actor ? { actor, token: null } : null;
}

/**
 * Resolves the token/actor behind a conflict-card consequence row through
 * the board's live combat, falling back to `tokenUuid`. Works for linked AND
 * unlinked synthetic token actors.
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
    const token = await fromUuidSafe(tokenUuid);
    if (token?.actor) return { actor: token.actor, token };
  }
  return null;
}

/**
 * Writes the consequence name to the track. Linked actors persist via
 * `actor.update`; unlinked synthetic token actors via `token.update({delta})`
 * (the standard Fate Core embedded-token-actor path). The consequence is
 * recorded as TEXT ONLY: `box_values` is always written as the empty array
 * `[]` — never `[false]` (the sheet iterates `box_values`, so that would draw
 * an empty consequence checkbox) and never `[true]` (a marked X) — both when
 * a name is entered and when the slot is emptied. This deliberately
 * normalizes away any `[true]` X or `[false]` checkbox that a previous
 * edit/hook may have left on the sheet's consequence row, and it matches the
 * canonical system `_on_aspect_change` handler, which changes only
 * `track.aspect.name`. The `harm_can_absorb` cost is read-only: it is never
 * included in the patch and never otherwise modified.
 * @param {object} actor  Actor document (linked or token actor).
 * @param {object|null} token  Token document for unlinked actors.
 * @param {string} trackKey  `actor.system.tracks` key.
 * @param {string} consequenceText  New consequence name ('' clears the slot).
 * @returns {Promise<void>}
 */
async function writeConsequence(actor, token, trackKey, consequenceText) {
  const current = actor.system?.tracks?.[trackKey];
  const baseAspect =
    current?.aspect && typeof current.aspect === "object" && !Array.isArray(current.aspect)
      ? foundry.utils.duplicate(current.aspect)
      : {};
  const aspect = { ...baseAspect, name: consequenceText };
  const trackPatch = {
    box_values: [],
    aspect,
  };
  if (token && actor.isToken) {
    await token.update({
      delta: { system: { tracks: { [trackKey]: trackPatch } } },
    });
  } else {
    await actor.update({ "system.tracks": { [trackKey]: trackPatch } });
  }
}

/**
 * Keeps the scene situation aspects in sync after a consequence edit, using
 * the Fate Core linked-aspect format:
 *   - entered consequence: record `{ name: "<consequence> (<actor.name>)",
 *     free_invokes: 1, linked: true }`, deduplicated by name;
 *   - renamed: the previous linked record (matched by old name) is renamed;
 *   - cleared: the previous linked record is removed.
 * Foreign (unlinked) situation aspects are preserved untouched.
 * @param {object} scene  Scene document.
 * @param {string} actorName  Actor name for the parenthetical.
 * @param {string} consequenceText  New consequence text ('' clears).
 * @param {string} oldText  Previous consequence text ('' = was free).
 * @returns {Promise<void>}
 */
export async function upsertSituationAspect(
  scene,
  actorName,
  consequenceText,
  oldText,
  meta,
) {
  if (!scene) return;
  const list = foundry.utils.duplicate(
    scene.getFlag(SITUATION_ASPECTS_SCOPE, SITUATION_ASPECTS_KEY) ?? [],
  );
  const oldName = oldText ? `${oldText} (${actorName})` : null;
  const newText = consequenceText ? `${consequenceText} (${actorName})` : null;
  let oldIndex = -1;
  if (oldName) {
    oldIndex = list.findIndex((a) => a?.name === oldName);
  }
  if (newText) {
    if (oldIndex >= 0) {
      // Rename in place: keep free_invokes and any other fields.
      const prev = list[oldIndex];
      const nextMeta = meta !== undefined ? meta : prev.consequence;
      const updated = { ...prev, name: newText, linked: true };
      if (nextMeta !== undefined) updated.consequence = nextMeta;
      list[oldIndex] = updated;
    } else if (!list.some((a) => a?.name === newText)) {
      // New consequence: dedupe by name, then add the linked record.
      const entry = { name: newText, free_invokes: 1, linked: true };
      if (meta !== undefined) entry.consequence = meta;
      list.push(entry);
    }
  } else if (oldIndex >= 0) {
    // Slot cleared: remove the previous linked record.
    list.splice(oldIndex, 1);
  }
  await scene.setFlag(SITUATION_ASPECTS_SCOPE, SITUATION_ASPECTS_KEY, list);
}

/**
 * DialogV2.input prompt for a consequence name. The current name is the
 * initial value; OK (localized "Save") persists the trimmed text ('' allowed
 * → clears the slot), and a visible localized Cancel button (v12+/v14
 * `DialogV2.input` supports the `cancel` button config; pressing it dismisses
 * the dialog) is a no-op. Resolves with the trimmed name or `null` on
 * cancel/dismiss.
 * @param {string} currentName  Current consequence name.
 * @returns {Promise<string|null>}
 */
export function promptConsequenceName(currentName) {
  if (
    typeof foundry === "undefined" ||
    !foundry?.applications?.api?.DialogV2?.input
  ) {
    return Promise.resolve(null);
  }
  const current = escapeHtml(String(currentName ?? ""));
  return foundry.applications.api.DialogV2.input({
    window: {
      title: game.i18n.localize("fate-on-the-table.consequence.title"),
    },
    content: `<div class="form-group"><label for="ctt-consequence-name">${escapeHtml(
      game.i18n.localize("fate-on-the-table.consequence.namePrompt"),
    )}</label><input type="text" id="ctt-consequence-name" name="name" value="${current}"></div>`,
    ok: { label: game.i18n.localize("fate-on-the-table.consequence.ok") },
    cancel: { label: game.i18n.localize("fate-on-the-table.consequence.cancel") },
    rejectClose: false,
  }).then((result) => {
    const value = dialogField(result, "name");
    if (value === undefined || value === null) return null;
    return String(value).trim();
  });
}

/** Reads a named field from a DialogV2.input() result. */
function dialogField(result, name) {
  if (!result || typeof result !== "object") return undefined;
  if (typeof FormData !== "undefined" && result instanceof FormData) {
    return result.get(name);
  }
  return result[name];
}

function escapeHtml(text) {
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

async function fromUuidSafe(uuid) {
  if (typeof fromUuid !== "function") return null;
  try {
    return await fromUuid(uuid);
  } catch (err) {
    return null;
  }
}
