/**
 * fate-on-the-table — module entry point.
 */

import {
  registerSettings,
  getConflictBoardOptions,
  CONFLICT_BOARD_SETTING_KEYS,
} from "./settings.js";
import { initialize as initializeLayouts } from "./layoutLoader.js";
import {
  scheduleActorSync,
  cleanupActor,
  reconcileScene,
} from "./WidgetSync.js";
import { initSheetButton } from "./sheetButton.js";
import { initWidgetDrag } from "./widgetDrag.js";
import {
  FatePointManager,
  initWidgetInteractions,
  initCanvasClickFallback,
} from "./FatePointManager.js";
import { syncGmFatePointRow } from "./FatePointSync.js";
import { SituationAspectManager } from "./SituationAspectManager.js";
import { syncSituationAspects } from "./SituationAspectSync.js";
import { LayoutImportExport } from "./LayoutImportExport.js";
import { initStressBoxInteractions } from "./StressBoxes.js";
import {
  MODULE_ID,
  FLAG_SCOPE,
  GM_FP_SCOPE,
  GM_FP_KEY,
  SITUATION_ASPECTS_SCOPE,
  SITUATION_ASPECTS_KEY,
  CONFLICT_BOARD_FLAG,
  TURN_MARKER_SETTING,
} from "./constants.js";
import {
  turnMarkerPatchFor,
  collectTurnMarkerPatches,
} from "./turnMarkerQol.js";
import {
  syncConflictBoard,
  reconcileConflictBoardProjection,
  readConflictBoard,
  writeConflictBoard,
  boardRegistry,
  removeConflictBoard,
  CONFLICT_BOARD_WIDGET_FLAG,
} from "./ConflictBoardSync.js";
import {
  ConflictManager,
  placeBoard,
  openConflictManager,
  returnTurn,
  canPlaceConflictBoard,
  getActiveConflictForScene,
} from "./ConflictManager.js";
import {
  registerConflictInteractions,
  registerConflictManager as injectConflictManager,
  reconcileTokenZoneMembership,
  handleTokenDropOnConflictZone,
} from "./ConflictInteractions.js";
import { toArray } from "./utils.js";
import {
  enterConflictZoneEditMode,
  exitConflictZoneEditMode,
  isConflictEditModeActive,
} from "./ConflictZoneEditor.js";
import {
  createCombatTrackerPlaceButton,
  createFateUtilsPlaceButton,
  insertCombatTrackerBoardPlacement,
  insertFateUtilsBoardPlacement,
  attachPlaceBoardClick,
} from "./conflictUi.js";
import { pickNewName } from "./nameGenerator.js";
import {
  resolveLanguage,
  loadNameGenDict,
} from "./nameGenLanguages.js";
import {
  isNameGenEnabled,
  getNameGenOptions,
} from "./settings.js";

// Canvas interaction patches must be applied on every module load (page
// reloads included), so this runs at top level — not inside a one-shot hook.
initWidgetInteractions();
initStressBoxInteractions();

console.log("[fate-on-the-table] module loaded");

// Random token name generation for unlinked tokens (adapted from Token Mold — trigram model).
// Pure logic lives in nameGenerator.js / nameGenLanguages.js; this hook only wires Foundry.
Hooks.on("preCreateToken", async (tokenDoc, data) => {
  try {
    if (typeof game !== "undefined" && game?.user?.isGM === false) return;
    if (!isNameGenEnabled()) return;
    const doc = tokenDoc ?? data;
    // In preCreateToken the TokenDocument has `actorLink`; creation data may also carry it.
    const actorLink =
      tokenDoc?.actorLink ?? tokenDoc?.getFlag?.("fate-on-the-table", "actorLink") ?? data?.actorLink;
    // Only unlinked tokens (actorLink === false). Linked tokens keep their actor name.
    // When actorLink is undefined (no actor) we treat as unlinked? But spec says strictly === false.
    if (actorLink !== false) {
      // Fallback: if both are undefined, the token has no actor — skip to avoid naming actor-less tokens.
      // However Foundry typically sets actorLink explicitly; we obey strict false check.
      return;
    }
    const opts = getNameGenOptions();
    const langKey = resolveLanguage(opts.language);
    let dict = null;
    try {
      dict = await loadNameGenDict(langKey);
    } catch (err) {
      console.warn("[fate-on-the-table] name dict load failed:", err);
      return;
    }
    if (!dict) {
      console.warn("[fate-on-the-table] name dict not available for", langKey);
      return;
    }
    let newName = "";
    try {
      newName = pickNewName(dict, { min: opts.min, max: opts.max });
    } catch (err) {
      console.warn("[fate-on-the-table] name generation failed:", err);
      return;
    }
    if (!newName || typeof newName !== "string") return;
    // Apply to the pending document; never block creation on failure.
    try {
      if (typeof tokenDoc?.updateSource === "function") {
        tokenDoc.updateSource({ name: newName });
      } else if (tokenDoc && typeof tokenDoc === "object") {
        tokenDoc.name = newName;
        if (data && typeof data === "object" && data !== tokenDoc) data.name = newName;
      } else if (data && typeof data === "object") {
        data.name = newName;
      }
    } catch (err) {
      console.warn("[fate-on-the-table] failed to apply generated name:", err);
    }
  } catch (err) {
    console.warn("[fate-on-the-table] preCreateToken name generation failed:", err);
  }
});

const FATE_POINT_SETTINGS = [
  "fatePointImage",
  "fatePointTileSize",
  "fatePointStep",
  "gmFatePointDirection",
];

const LAYOUT_SETTINGS = [
  "defaultTemplate",
  "playerLayout",
  "npcLayout",
];

const SITUATION_ASPECT_SETTINGS = [
  "situationAspectsWidth",
  "situationAspectsHeight",
  "situationAspectsFontFamily",
  "situationAspectsFontSize",
  "situationAspectsTextColor",
  "situationAspectsBackgroundTexture",
  "situationAspectsBackgroundColor",
  "situationAspectsBackgroundAlpha",
];

// Scene-level keys that, when changed in the Scene Config, only refresh the
// projection of an existing conflict board (origin is never touched).
const SCENE_GEOMETRY_KEYS = [
  "width",
  "height",
  "padding",
  "grid",
  "gridType",
  "backgroundColor",
  "background",
  "backgroundElevation",
  "backgroundAlpha",
];

let gmSyncTimer = null;
let actorReconcileTimer = null;
let saSyncTimer = null;
let conflictSettingsTimer = null;
let conflictTokenTimer = null;
let conflictActorTimer = null;
// Token ids moved while the debounce is pending (a multi-token drag must
// reconcile every moved board token, not only the last update).
const pendingConflictTokens = new Set();
const saSyncTimers = new Map();
const conflictTokenTimers = new Map();
const conflictActorTimers = new Map();
const pendingConflictTokensByScene = new Map();
let sceneControlsRegistered = false;
// True while a Combat document (and its combatants) is being deleted, so the
// board is never auto-cleaned when a conflict/combat ends.
let combatDeleteInProgress = false;
let combatDeleteResetTimer = null;

Hooks.once("init", async () => {
  console.log("[fate-on-the-table] init hook");
  try {
    // The built-in layout JSON must be registered BEFORE the settings so
    // their choices already list every layout.
    await initializeLayouts();
    registerSettings();
    console.log("[fate-on-the-table] settings registered");
  } catch (err) {
    console.error("[fate-on-the-table] failed to register settings:", err);
  }
});

Hooks.once("ready", () => {
  console.log("[fate-on-the-table] ready hook");
  try {
    initSheetButton();
  } catch (err) {
    console.error("[fate-on-the-table] failed to init sheet button:", err);
  }
  initWidgetDrag();
  Hooks.on("updateActor", scheduleActorSync);
  // Distinct purpose: actor data changes that drive CONFLICT cards (stress,
  // consequences, aspects, skills, items) re-project the active board through
  // the same serialized sync queue. Kept separate from scheduleActorSync so
  // ordinary actor-widget sync and the fateOnTheTableSync recursion guard are
  // never touched.
  Hooks.on("updateActor", onConflictBoardActorUpdate);
  // Consequence → situation-aspect reconciliation: any actor track edit may
  // have renamed/cleared a consequence; if the actor has a token on the
  // active scene its linked aspect (suffix " (ActorName)") must be reconciled.
  // Cheap single-scene scan, debounced by scheduleSituationAspectSync (400 ms).
  Hooks.on("updateActor", onActorConsequenceSync);
  Hooks.on("deleteActor", cleanupActor);
  Hooks.on("updateUser", onUpdateUser);
  Hooks.on("updateSetting", onUpdateSetting);
  Hooks.on("updateScene", onUpdateScene);
  Hooks.on("canvasReady", onCanvasReady);
  Hooks.on("renderFateUtilities", onRenderFateUtilities);
  Hooks.on(`${MODULE_ID}.newScene`, onNewScene);
  registerSceneControl();
  try {
    // Feature 5 — conflict board integration (idempotent, guarded inside
    // ConflictInteractions/ConflictZoneEditor). Players get the read-only
    // interactions (sheets, no GM menus); GM-only paths are gated internally.
    registerConflictInteractions();
    injectConflictManager(ConflictManager);
    Hooks.on("renderCombatTracker", onRenderCombatTracker);
    Hooks.on("updateCombat", onUpdateCombat);
    Hooks.on("createCombatant", onCreateCombatant);
    Hooks.on("updateCombatant", onUpdateCombatant);
    Hooks.on("deleteCombatant", onDeleteCombatant);
    Hooks.on("updateToken", onUpdateToken);
    Hooks.on("deleteToken", onDeleteToken);
    // Close-combat guard: while a Combat document is being deleted the board
    // projection must stay untouched (no automatic cleanup on combat end).
    Hooks.on("preDeleteCombat", () => {
      combatDeleteInProgress = true;
      clearTimeout(combatDeleteResetTimer);
      combatDeleteResetTimer = setTimeout(() => {
        combatDeleteInProgress = false;
      }, 3000);
    });
    Hooks.on("deleteCombat", () => {
      combatDeleteInProgress = false;
      clearTimeout(combatDeleteResetTimer);
    });
    registerPublicApi();
  } catch (err) {
    console.error("[fate-on-the-table] failed to wire conflict integration:", err);
  }
  console.log("[fate-on-the-table] hooks wired");
});

function onCanvasReady() {
  if (!canvas?.scene) return;
  initCanvasClickFallback();
  reconcileScene(canvas.scene).catch((err) =>
    console.error("[fate-on-the-table] reconcile failed:", err),
  );
  syncGmFatePointRow(canvas.scene).catch((err) =>
    console.error("[fate-on-the-table] GM fate point sync failed:", err),
  );
  syncSituationAspects(canvas.scene).catch((err) =>
    console.error("[fate-on-the-table] situation aspects sync failed:", err),
  );
  syncConflictOnCanvasReady().catch((err) =>
    console.error("[fate-on-the-table] conflict board sync failed:", err),
  );
}

/**
 * Feature 5: reconcile + project the conflict board of the active scene.
 * Without a valid `conflictBoard` flag nothing is created. `game.combat` is
 * only passed to the projection when it matches the board's `combatId` and is
 * bound to the scene; otherwise the combat is resolved from the board state.
 */
function syncConflictOnCanvasReady() {
  const scene = canvas?.scene;
  if (!scene) return Promise.resolve();
  const state = readConflictBoard(scene);
  if (!state) return Promise.resolve();
  const combat = resolveSceneConflictCombat(scene, state);
  return syncConflictBoard(scene, combat ? { combat } : {});
}

/** GM fate points changed on some user: re-sync the GM row (debounced). */
function onUpdateUser(user, changed) {
  if (!user.isGM) return;
  const hasFlag = foundry.utils.hasProperty(
    changed,
    `flags.${GM_FP_SCOPE}.${GM_FP_KEY}`,
  );
  if (!hasFlag) return;
  scheduleGmSync();
}

/** Fate point settings changed: re-sync GM row and actor widgets. */
function onUpdateSetting(setting) {
  if (!setting.key?.startsWith(`${MODULE_ID}.`)) return;
  const key = setting.key.split(".")[1];
  if (FATE_POINT_SETTINGS.includes(key)) {
    scheduleGmSync();
    if (canvas?.scene) {
      clearTimeout(actorReconcileTimer);
      actorReconcileTimer = setTimeout(() => {
        reconcileScene(canvas.scene).catch((err) =>
          console.error("[fate-on-the-table] reconcile failed:", err),
        );
      }, 400);
    }
    return;
  }
  if (LAYOUT_SETTINGS.includes(key)) {
    // Role-based layout changes affect legacy widgets (records without an
    // explicit layout identity) and new placements only; widgets with an
    // explicit identity keep their layout.
    if (canvas?.scene) {
      clearTimeout(actorReconcileTimer);
      actorReconcileTimer = setTimeout(() => {
        reconcileScene(canvas.scene).catch((err) =>
          console.error("[fate-on-the-table] reconcile failed:", err),
        );
      }, 400);
    }
    return;
  }
  if (SITUATION_ASPECT_SETTINGS.includes(key)) {
    scheduleSituationAspectSync();
    return;
  }
  if (CONFLICT_BOARD_SETTING_KEYS.includes(key)) {
    // Conflict board background/size settings: refresh the projection of an
    // already placed board without moving its origin.
    scheduleConflictBoardSettingsSync();
  }
}

/** Conflict board settings changed: re-sync an existing board (debounced). */
function scheduleConflictBoardSettingsSync() {
  if (!canvas?.scene) return;
  clearTimeout(conflictSettingsTimer);
  conflictSettingsTimer = setTimeout(() => {
    syncConflictBoardSettings(canvas.scene).catch((err) =>
      console.error("[fate-on-the-table] conflict board settings sync failed:", err),
    );
  }, 400);
}

async function syncConflictBoardSettings(scene) {
  const state = readConflictBoard(scene);
  if (!state || !boardRegistry(scene)?.widgetId) return;
  const opts = getConflictBoardOptions();
  const origin = state.board?.origin ?? { x: 0, y: 0 };
  await writeConflictBoard(scene, {
    ...state,
    board: {
      ...(state.board ?? {}),
      origin,
      background: {
        color: opts.background.color,
        texture: opts.background.texture,
        alpha: opts.background.alpha,
      },
    },
  });
  await syncConflictBoard(scene);
}

/** Scene flags/settings changed: re-sync scene widgets + the conflict board. */
function onUpdateScene(scene, changed, options) {
  if (
    foundry.utils.hasProperty(
      changed,
      `flags.${SITUATION_ASPECTS_SCOPE}.${SITUATION_ASPECTS_KEY}`,
    )
  ) {
    scheduleSituationAspectSync(scene);
    // Zone-bound situation aspects changed: refresh the conflict zone
    // overlays on the same scene when a live board is present. The sync is
    // serialized through `syncConflictBoard`'s per-scene queue; its writes
    // are marked `fateOnTheTableSync` and the conflict-flag branch above
    // bails on that marker, so no hook loop is possible. Aspect changes are
    // rare (invoke spend), so an immediate per-change sync is acceptable;
    // the queue itself coalesces concurrent calls without extra debounce.
    if (readConflictBoard(scene) && boardRegistry(scene)?.widgetId) {
      syncConflictBoard(scene).catch((err) =>
        console.error("[fate-on-the-table] conflict board sync failed:", err),
      );
    }
  }

  // Feature 5 — conflict board flag changed: sync ONLY the current board.
  // `fateOnTheTableSync` marks our own writes (writeConflictBoard/registry)
  // and is ignored to prevent recursion.
  const conflictFlagChanged =
    foundry.utils.hasProperty(
      changed,
      `flags.${FLAG_SCOPE}.${CONFLICT_BOARD_FLAG}`,
    ) ||
    foundry.utils.hasProperty(
      changed,
      `flags.${FLAG_SCOPE}.${CONFLICT_BOARD_WIDGET_FLAG}`,
    );
  if (conflictFlagChanged) {
    if (options?.fateOnTheTableSync) return;
    if (!canvas?.scene || scene.id !== canvas.scene.id) return;
    syncConflictBoard(scene).catch((err) =>
      console.error("[fate-on-the-table] conflict board sync failed:", err),
    );
    return;
  }

  // Scene background/size settings changed in the Scene Config: refresh the
  // projection of an existing board without moving its origin.
  if (SCENE_GEOMETRY_KEYS.some((k) => foundry.utils.hasProperty(changed, k))) {
    if (options?.fateOnTheTableSync) return;
    if (!canvas?.scene || scene.id !== canvas.scene.id) return;
    const state = readConflictBoard(scene);
    if (!state || !boardRegistry(scene)?.widgetId) return;
    syncConflictBoard(scene).catch((err) =>
      console.error("[fate-on-the-table] conflict board sync failed:", err),
    );
  }
}

/** "New Scene" from the FatePointManager: update an already placed widget. */
function onNewScene({ scene } = {}) {
  scheduleSituationAspectSync(scene);
}

function scheduleGmSync() {
  // Global debounce: GM fate points are a single per-user flag (active GM),
  // the row lives on the ephemeral `canvas.scene` at fire time. No cross-scene
  // queue exists, so a single timer is correct.
  if (!canvas?.scene) return;
  clearTimeout(gmSyncTimer);
  gmSyncTimer = setTimeout(() => {
    syncGmFatePointRow(canvas.scene).catch((err) =>
      console.error("[fate-on-the-table] GM fate point sync failed:", err),
    );
  }, 400);
}

function scheduleSituationAspectSync(scene = canvas?.scene) {
  // Per-scene debounced: each scene has its own 400 ms window so
  // schedule(sceneA) + schedule(sceneB) both fire (last per-scene wins).
  // This prevents the real bug where a global timer cleared scene A's pending
  // sync when scene B was scheduled — situation_aspects is a per-scene flag.
  // Signature and default (`canvas?.scene`) are preserved for callers.
  if (!scene?.id) return;
  clearTimeout(saSyncTimers.get(scene.id));
  saSyncTimers.set(
    scene.id,
    setTimeout(() => {
      saSyncTimers.delete(scene.id);
      syncSituationAspects(scene).catch((err) =>
        console.error("[fate-on-the-table] situation aspects sync failed:", err),
      );
    }, 400),
  );
}

/**
 * Actor consequence track changed: if the actor is represented by a token on
 * the active scene, the per-scene situation aspects (linked consequence
 * aspects with " (ActorName)" suffix) may need rename/remove. The actual
 * reconcile is in SituationAspectSync (migrateAndClean + consequence pass);
 * here we only decide which scene to sync — for `updateActor` the flag is
 * per-scene, so the single active `canvas.scene` is relevant. Presence is
 * checked by `actorId` against the scene's token collection (various collection
 * shapes). No `fateOnTheTableSync` guard: the recon only writes
 * `flags.fate-core-official.situation_aspects`, whose loop
 * `sync → onUpdateScene → schedule → sync` is idempotent and self-extinguishing.
 */
function onActorConsequenceSync(actor, changed, options) {
  const scene = canvas?.scene;
  if (!scene || !actor?.id) return;
  const actorId = actor.id;
  let hasToken = false;
  try {
    const docs = toArray(scene.tokens);
    for (const t of docs) {
      if (!t) continue;
      const tid = t.actorId ?? t.document?.actorId ?? t.actor?.id ?? null;
      if (tid === actorId) {
        hasToken = true;
        break;
      }
      if (!tid && t.actor?.id === actorId) {
        hasToken = true;
        break;
      }
    }
  } catch {
    return;
  }
  if (!hasToken) return;
  scheduleSituationAspectSync(scene);
}

/* ------------------------------------------------------------------ *
 * Feature 5 — conflict board hooks (combat / combatant / token)
 * ------------------------------------------------------------------ */

/**
 * The combat a board is bound to, but only when it is pinned to the active
 * scene: `game.combat` when its id matches `state.combatId`, otherwise the
 * world combat of that id. Returns `null` for a deleted/foreign combat so a
 * board is never auto-cleaned when a conflict/combat ends.
 */
function resolveSceneConflictCombat(scene, state) {
  if (!state?.combatId || typeof game === "undefined") return null;
  const combatId = state.combatId;
  const combat =
    game.combat?.id === combatId
      ? game.combat
      : (game.combats?.get?.(combatId) ?? null);
  if (!combat) return null;
  return isCombatBoundToScene(combat, scene) ? combat : null;
}

/** True when a combat is pinned to the scene (sceneId or tokens on it). */
function isCombatBoundToScene(combat, scene) {
  if (!combat || !scene) return false;
  const combatSceneId = combat.scene?.id ?? combat.sceneId ?? null;
  if (combatSceneId) return combatSceneId === scene.id;
  try {
    const list = toArray(combat.combatants);
    return list.some((c) => c?.tokenId && scene.tokens?.get?.(c.tokenId));
  } catch (err) {
    return false;
  }
}

/** True when the active scene hosts a board bound to the given combat id. */
function hasActiveBoardForCombat(combatId) {
  const scene = canvas?.scene;
  if (!scene || !combatId) return false;
  const state = readConflictBoard(scene);
  if (!state || state.combatId !== combatId) return false;
  return !!boardRegistry(scene)?.widgetId;
}

/**
 * Resolves the combat id of a Combatant document. Foundry v14 removed the
 * `combatId` property: the relationship lives on `combatant.combat` /
 * `combatant.parent` (checked first, both alive and already-dropped parents).
 * A deleted combatant may have lost both links already, so the active scene's
 * board `combatId` is used as a last-resort fallback only when the
 * combatant's token is still present on that scene (v13 `combatId` is kept
 * for older API compatibility).
 */
function combatIdOfCombatant(combatant) {
  const id =
    combatant?.combat?.id ?? combatant?.parent?.id ?? combatant?.combatId ?? null;
  if (id) return id;
  const scene = canvas?.scene;
  if (!scene || !combatant?.tokenId) return null;
  const state = readConflictBoard(scene);
  if (!state?.combatId || !scene.tokens?.get?.(combatant.tokenId)) return null;
  return state.combatId;
}

/** Combat document updated (turn/round/started): re-project the board. */
function onUpdateCombat(combat, changed, options) {
  if (options?.fateOnTheTableSync) return;
  if (combatDeleteInProgress) return;
  if (!combat?.id || !hasActiveBoardForCombat(combat.id)) return;
  const combatDoc = resolveSceneConflictCombat(canvas?.scene, {
    combatId: combat.id,
  });
  if (!combatDoc) return;
  syncConflictBoard(canvas.scene, { combat: combatDoc }).catch((err) =>
    console.error("[fate-on-the-table] conflict board sync failed:", err),
  );
}

/** Combatant updated (hasActed, sort, flags): re-project the board. */
function onUpdateCombatant(combatant, changed, options) {
  if (options?.fateOnTheTableSync) return;
  if (combatDeleteInProgress) return;
  const combatId = combatIdOfCombatant(combatant);
  if (!combatId || !hasActiveBoardForCombat(combatId)) return;
  const combat = resolveSceneConflictCombat(canvas?.scene, { combatId });
  if (!combat) return;
  syncConflictBoard(canvas.scene, { combat }).catch((err) =>
    console.error("[fate-on-the-table] conflict board sync failed:", err),
  );
}

/**
 * Combatant created (a token enters combat mode mid-conflict): admit its card
 * immediately. Foundry v14 fires ONLY `createCombatant` when a new embedded
 * Combatant is created — the parent Combat document does not emit an
 * `updateCombat` for embedded-document create/delete, so this listener is the
 * single runtime path covering the "new token joins an active board" scenario.
 *
 * It runs the exact same guards as `updateCombatant` (anti-recursive
 * `fateOnTheTableSync`, no work during a combat deletion) and calls the SAME
 * serialized `syncConflictBoard(scene, { combat })` queue, where
 * `reconcileConflictBoardProjection` -> `reconcileConflictBoard` admits the
 * newcomer card via `admitMissingCards` — but only when the new combatant's
 * token is actually available on the pinned active scene (no card without a
 * token). The hook signature is Foundry v14's `(combatant, options, userId)`.
 * @param {object} combatant  The created Combatant document.
 * @param {object} options    Operation options (may carry the module's own
 *   `fateOnTheTableSync` marker from other module writes).
 */
function onCreateCombatant(combatant, options) {
  if (options?.fateOnTheTableSync) return;
  if (combatDeleteInProgress) return;
  const combatId = combatIdOfCombatant(combatant);
  if (!combatId || !hasActiveBoardForCombat(combatId)) return;
  const combat = resolveSceneConflictCombat(canvas?.scene, { combatId });
  if (!combat) return;
  syncConflictBoard(canvas.scene, { combat }).catch((err) =>
    console.error("[fate-on-the-table] conflict board sync failed:", err),
  );
  // QoL — auto-enable turn marker for the new combatant's token (GM only, setting-gated).
  maybeEnableTurnMarkerForCombatant(combatant, combatId).catch((err) =>
    console.warn("[fate-on-the-table] turn marker auto-enable failed:", err),
  );
}

/**
 * GM-only, setting-gated auto-enable of a single newly created combatant's token turnMarker.
 * No-op for players, when the setting is off, when the combat is not on an active board,
 * when the combatant lacks a tokenId, when the token is not on the board scene, or when
 * the turnMarker is already enabled / not an object.
 * @param {object} combatant
 * @param {string} combatId
 * @returns {Promise<void>}
 */
async function maybeEnableTurnMarkerForCombatant(combatant, combatId) {
  try {
    if (typeof game !== "undefined" && game?.user?.isGM === false) return;
    if (!isAutoTurnMarkerEnabled()) return;
    if (!combatant?.tokenId) return;
    if (!hasActiveBoardForCombat(combatId)) return;
    const scene = canvas?.scene;
    if (!scene) return;
    let tokenDoc = null;
    try {
      tokenDoc =
        combatant.token?.document ??
        combatant.token ??
        scene.tokens?.get?.(combatant.tokenId) ??
        null;
      // Some mocks expose the token directly on `combatant.token` being the doc itself.
      if (!tokenDoc && combatant.tokenId) tokenDoc = scene.tokens?.get?.(combatant.tokenId) ?? null;
    } catch {
      tokenDoc = scene.tokens?.get?.(combatant.tokenId) ?? null;
    }
    if (!tokenDoc) return;
    const tm = tokenDoc.turnMarker ?? tokenDoc.document?.turnMarker ?? null;
    const patch = turnMarkerPatchFor(tm);
    if (!patch) return;
    try {
      await tokenDoc.update({ turnMarker: patch });
    } catch (err) {
      console.warn("[fate-on-the-table] turn marker auto-enable failed:", err);
    }
  } catch (err) {
    console.warn("[fate-on-the-table] turn marker auto-enable failed:", err);
  }
}

/**
 * Reads the world `autoTurnMarker` setting. Safe outside Foundry (tests)
 * -> enabled by default. Returns `false` only when explicitly disabled.
 * @returns {boolean}
 */
function isAutoTurnMarkerEnabled() {
  try {
    if (typeof game === "undefined" || typeof game?.settings?.get !== "function") return true;
    const v = game.settings.get(MODULE_ID, TURN_MARKER_SETTING);
    // Foundry returns `undefined` before the setting is registered (init not yet);
    // treat that as enabled to keep QoL on for existing tokens.
    if (v === undefined) return true;
    return !!v;
  } catch {
    return true;
  }
}

/**
 * Batch helper for the placement flow: enables turn markers for all combatants
 * of a combat whose tokens are on the scene and currently have mode 0.
 * Exported for testing (pure-ish, Foundry-tolerant) but also used from
 * ConflictManager.commitBoardPlacement.
 * @param {object} scene
 * @param {object} combat
 * @returns {Promise<void>}
 */
export async function maybeEnableTurnMarkersForCombat(scene, combat) {
  try {
    if (typeof game !== "undefined" && game?.user?.isGM === false) return;
    if (!isAutoTurnMarkerEnabled()) return;
    if (!scene || !combat) return;
    if (!hasActiveBoardForCombat(combat.id)) return;
    const list = toArray(combat.combatants ?? combat.turns);
    const tokenDocs = [];
    for (const c of list) {
      if (!c?.tokenId) continue;
      const doc = scene.tokens?.get?.(c.tokenId);
      if (doc) tokenDocs.push(doc);
    }
    const patches = collectTurnMarkerPatches(tokenDocs);
    if (!patches.length) return;
    // Batch update when available: one embedded-document write.
    if (typeof scene.updateEmbeddedDocuments === "function") {
      const updates = patches.map((p) => ({ _id: p._id, turnMarker: p.turnMarker }));
      try {
        await scene.updateEmbeddedDocuments("Token", updates);
        return;
      } catch (err) {
        console.warn("[fate-on-the-table] turn marker batch update failed, falling back to per-token:", err);
      }
    }
    // Fallback per-token updates.
    for (const p of patches) {
      const doc = scene.tokens.get(p._id);
      if (!doc) continue;
      try {
        await doc.update({ turnMarker: p.turnMarker });
      } catch (err) {
        console.warn("[fate-on-the-table] turn marker auto-enable failed:", err);
      }
    }
  } catch (err) {
    console.warn("[fate-on-the-table] turn marker batch auto-enable failed:", err);
  }
}

/** Combatant removed: prune its orphan card/zone projections (module-owned). */
function onDeleteCombatant(combatant, options) {
  if (options?.fateOnTheTableSync) return;
  if (combatDeleteInProgress) return;
  const combatId = combatIdOfCombatant(combatant);
  if (!combatId || !hasActiveBoardForCombat(combatId)) return;
  const combat = resolveSceneConflictCombat(canvas?.scene, { combatId });
  if (!combat) return;
  syncConflictBoard(canvas.scene, { combat }).catch((err) =>
    console.error("[fate-on-the-table] conflict board sync failed:", err),
  );
}

/**
 * Token updated: reconcile `tokenZones` membership on a manual x/y change
 * (never on the module's own drop/sync) and re-project the board. Debounced
 * so continuous drags do not hammer the scene. A shared debounce would drop
 * earlier tokens of a simultaneous multi-token move, so the pending token ids
 * are accumulated and every moved board token is reconciled on the fire.
 */
function onUpdateToken(token, changed, options) {
  // Situation aspects: unlinked token consequence edit (delta) — synthetic
  // tokens store actor data in `token.delta` (token.update({ delta: { system:
  // { tracks: {...} } } })), not via updateActor. When delta.system.tracks
  // changes a consequence may have been renamed/cleared, so the per-scene
  // situation aspect with suffix " (ActorName)" must be reconciled. Debounced
  // (400 ms) and idempotent; not gated by fateOnTheTableSync — it only writes
  // situation_aspects and loops via onUpdateScene as a self-extinguishing no-op.
  try {
    const hasTrackDelta = foundry?.utils?.hasProperty
      ? foundry.utils.hasProperty(changed, "delta.system.tracks")
      : !!(changed?.delta?.system?.tracks);
    if (hasTrackDelta) {
      const saScene = token?.parent ?? token?.scene ?? canvas?.scene;
      if (saScene) scheduleSituationAspectSync(saScene);
    }
  } catch (err) {
    // best-effort; never block conflict path
  }

  if (options?.fateOnTheTableSync) return;
  const scene = canvas?.scene;
  const tokenSceneId = token?.scene?.id ?? token?.parent?.id ?? null;
  if (!scene || !token || tokenSceneId !== scene.id) return;
  const state = readConflictBoard(scene);
  if (!state || !state.combatId || !boardRegistry(scene)?.widgetId) return;
  // Per-scene pending so tokens from different boards never mix (cross-scene loss fix).
  if (changed?.x !== undefined || changed?.y !== undefined) {
    let set = pendingConflictTokensByScene.get(scene.id);
    if (!set) {
      set = new Set();
      pendingConflictTokensByScene.set(scene.id, set);
    }
    set.add(token.id);
  }
  clearTimeout(conflictTokenTimers.get(scene.id));
  // A synthetic (unlinked token) actor data change arrives as a `delta`
  // update to the TokenDocument (e.g. a stress/consequence row edited on a
  // conflict card). Re-project the board so the card reflects it, the same
  // way a linked actor's `updateActor` hook does. The serialized, idempotent
  // sync handles both position and actor-data paths without a hook loop.
  // Debounced per scene (150 ms) — A and B both fire, last per-scene wins.
  conflictTokenTimers.set(
    scene.id,
    setTimeout(() => {
      conflictTokenTimers.delete(scene.id);
      const pendingSet = pendingConflictTokensByScene.get(scene.id);
      const pending = pendingSet ? [...pendingSet] : [];
      if (pendingSet) pendingSet.clear();
      const done = Promise.all(
        pending.map((id) => {
          const doc = scene.tokens?.get?.(id);
          if (!doc) return Promise.resolve({ changed: false, zoneId: null });
          return reconcileTokenZoneMembership(scene, doc);
        }),
      );
      done.catch((err) =>
        console.error(
          "[fate-on-the-table] conflict token zone reconcile failed:",
          err,
        ),
      ).then(() =>
        syncConflictBoard(scene).catch((err) =>
          console.error("[fate-on-the-table] conflict board sync failed:", err),
        ),
      );
    }, 150),
  );
}

/**
 * True when the given ACTOR document is the data source of a card currently
 * projected on the active board: any board combatant whose token (or the
 * combatant's own actor for tokens without one) is this actor, on this scene.
 * Used by `updateActor` to decide whether a conflict card must be refreshed.
 * @param {object} scene   Active scene with the board.
 * @param {object} combat  Board-bound combat.
 * @param {object} actor   The updated Actor document.
 * @returns {boolean}
 */
function actorDrivesBoardCard(scene, combat, actor) {
  const actorUuid = actor?.uuid ?? actor?.id ?? null;
  const actorId = actor?.id;
  if (!actorUuid && !actorId) return false;
  const combatants = toArray(combat?.combatants);
  for (const c of combatants ?? []) {
    if (!c?.tokenId) continue;
    const token = scene?.tokens?.get?.(c.tokenId);
    if (!token) continue;
    const a = token.actor ?? c.actor ?? null;
    if (!a) continue;
    if (actorUuid && a.uuid && a.uuid === actorUuid) return true;
    if (actorId && a.id && a.id === actorId) return true;
  }
  return false;
}

/**
 * Actor document updated: re-project the active conflict board when the actor
 * drives a card (linked token actor → stress/consequences/aspects/skills/items
 * on the card). Runs the SAME serialized, idempotent `syncConflictBoard`
 * queue as every other conflict hook, guarded by `fateOnTheTableSync` and
 * filtered to the active scene board. Debounced so sheet editing does not
 * hammer the scene; completely independent of the actor-widget
 * `scheduleActorSync` debounce, so neither path interferes with the other.
 * Synthetic (unlinked token) actor data changes arrive through `updateToken`
 * and are handled by `onUpdateToken` instead.
 */
function onConflictBoardActorUpdate(actor, changed, options) {
  if (options?.fateOnTheTableSync) return;
  const scene = canvas?.scene;
  if (!scene || !actor) return;
  const state = readConflictBoard(scene);
  if (!state?.combatId || !boardRegistry(scene)?.widgetId) return;
  const combat = resolveSceneConflictCombat(scene, state);
  if (!combat) return;
  if (!actorDrivesBoardCard(scene, combat, actor)) return;
  // Per-scene debounce (400 ms): actor sheet edits for different scenes' boards
  // do not cancel each other; last per-scene wins. `combat` and `scene` are
  // captured at schedule time so the pending sync always targets the correct board.
  if (!scene?.id) return;
  clearTimeout(conflictActorTimers.get(scene.id));
  conflictActorTimers.set(
    scene.id,
    setTimeout(() => {
      conflictActorTimers.delete(scene.id);
      syncConflictBoard(scene, { combat }).catch((err) =>
        console.error("[fate-on-the-table] conflict board sync failed:", err),
      );
    }, 400),
  );
}

/** Token deleted: safely clean up orphan card/tokenZone projections. */
function onDeleteToken(token, options) {
  // Situation aspects: last token of its actor removed from its scene — a
  // consequence aspect is linked by suffix " (ActorName)" and recon resolves
  // actors via tokens on the same scene. When the last token of an actor
  // leaves scene S, all its consequence aspects must be removed from S. The
  // document may be half-deleted, so actorId is read from the document fields
  // themselves (token.actorId), not a fetched Actor. Cheap scan of S's
  // remaining tokens (excluding the deleted id); if none remain, schedule the
  // debounced, idempotent situation-aspect sync. Not gated by
  // fateOnTheTableSync — it only writes situation_aspects and the loop
  // sync → onUpdateScene → schedule → sync is self-extinguishing.
  try {
    const saScene = token?.parent ?? token?.scene ?? canvas?.scene;
    const actorId = token?.actorId ?? token?.document?.actorId ?? token?.actor?.id ?? null;
    if (saScene && actorId) {
      let remaining = false;
      try {
        const docs = toArray(saScene.tokens);
        for (const t of docs) {
          if (!t) continue;
          if (t.id === token.id) continue;
          const tid = t.actorId ?? t.document?.actorId ?? t.actor?.id ?? null;
          if (tid === actorId) {
            remaining = true;
            break;
          }
          if (!tid && t.actor?.id === actorId) {
            remaining = true;
            break;
          }
        }
      } catch {}
      if (!remaining) {
        scheduleSituationAspectSync(saScene);
      }
    }
  } catch (err) {
    // best-effort; never block conflict path
  }

  if (options?.fateOnTheTableSync) return;
  const scene = canvas?.scene;
  if (!scene || !token) return;
  const state = readConflictBoard(scene);
  if (!state || !state.combatId || !boardRegistry(scene)?.widgetId) return;
  syncConflictBoard(scene).catch((err) =>
    console.error("[fate-on-the-table] conflict board sync failed:", err),
  );
}

/** Extends the module public API with the conflict integration (in `ready`). */
function registerPublicApi() {
  try {
    const moduleData = game.modules?.get?.(MODULE_ID);
    if (!moduleData) return;
    moduleData.api = {
      ...(moduleData.api ?? {}),
      conflict: {
        ConflictManager,
        placeBoard,
        openConflictManager,
        returnTurn,
        getActiveConflictForScene,
        canPlaceConflictBoard,
        syncConflictBoard,
        removeConflictBoard,
        reconcileConflictBoardProjection,
        readConflictBoard,
        writeConflictBoard,
        boardRegistry,
        registerConflictInteractions,
        registerConflictManager: injectConflictManager,
        reconcileTokenZoneMembership,
        handleTokenDropOnConflictZone,
        enterConflictZoneEditMode,
        exitConflictZoneEditMode,
        isConflictEditModeActive,
      },
    };
  } catch (err) {
    console.warn("[fate-on-the-table] failed to register public API:", err);
  }
}

/** Resolves the DOM root of a render hook payload (v13 jQuery or v14 node). */
function resolveHtmlRoot(html) {
  if (!html) return null;
  if (typeof html.querySelector === "function") return html;
  if (Array.isArray(html)) return html[0] ?? null;
  const first = html?.[0];
  if (first && typeof first.querySelector === "function") return first;
  return null;
}

/**
 * GM-only "Place conflict board" control in the Combat Tracker. Added only
 * when placement is currently possible; it calls `placeBoard()` unchanged.
 * The control is inserted as its OWN row directly ABOVE the standard
 * `.combat-controls` (previous/next/end combat) — never inside that flex row
 * — via the pure `conflictUi` helper.
 */
function onRenderCombatTracker(app, html) {
  if (!game?.user?.isGM) return;
  const scene = canvas?.scene;
  if (!scene) return;
  if (!canPlaceConflictBoard(scene, game.combat)) return;
  const root = resolveHtmlRoot(html);
  if (!root?.querySelector) return;
  const button = createCombatTrackerPlaceButton(
    game.i18n.localize(`${MODULE_ID}.conflict.placement.fromCombatTracker`),
  );
  if (!insertCombatTrackerBoardPlacement(root, button)) return;
  attachPlaceBoardClick(button, placeBoard);
}

/** GM-only scene control tools opening the manager dialogs. */
function registerSceneControl() {
  if (sceneControlsRegistered) return;
  sceneControlsRegistered = true;
  Hooks.on("getSceneControlButtons", (controls) => {
    const group = controls.find((c) => c.name === "token");
    if (!group) return;
    group.tools.push({
      name: "fateOnTheTableFatePoints",
      title: game.i18n.localize(`${MODULE_ID}.manager.tool`),
      icon: "fas fa-star",
      visible: game.user.isGM,
      onClick: () => FatePointManager.open(),
      button: true,
    });
    group.tools.push({
      name: "fateOnTheTableSituationAspects",
      title: game.i18n.localize(`${MODULE_ID}.situationAspects.tool`),
      icon: "fas fa-fire",
      visible: game.user.isGM,
      onClick: () => SituationAspectManager.open(),
      button: true,
    });
    group.tools.push({
      name: "fateOnTheTableLayouts",
      title: game.i18n.localize(`${MODULE_ID}.layouts.tool`),
      icon: "fas fa-table-columns",
      visible: game.user.isGM,
      onClick: () => LayoutImportExport.open(),
      button: true,
    });
    group.tools.push({
      name: "fateOnTheTableConflictManager",
      title: game.i18n.localize(`${MODULE_ID}.conflict.tool`),
      icon: "fas fa-crosshairs",
      visible: game.user.isGM,
      onClick: () => openConflictManager(),
      button: true,
    });
    // GM toggle for the conflict zone editor. Outside the mode the zone
    // drawings never intercept token clicks/drags (the editor only attaches
    // its own listeners while it is active).
    group.tools.push({
      name: "fateOnTheTableConflictZoneEditor",
      title: game.i18n.localize(`${MODULE_ID}.conflict.zone.editor`),
      icon: "fas fa-draw-polygon",
      visible: game.user.isGM,
      toggle: true,
      active: isConflictEditModeActive(),
      onClick: () => {
        if (isConflictEditModeActive()) {
          exitConflictZoneEditMode();
          return false;
        }
        return enterConflictZoneEditMode();
      },
    });
  });
}

/**
 * Adds buttons to the system's Fate Utilities app (no modification of
 * system files): a "Place GM fate points" button next to the Scene Fate
 * Points control of the current GM, and a "Place situation aspects" button
 * in the situation aspects row of the scene tab.
 */
function onRenderFateUtilities(app, html) {
  if (!game.user.isGM) return;
  const root = resolveHtmlRoot(html);
  const input = html.querySelector?.(
    `input[name="gmfp"][data-gmid="${game.user.id}"]`,
  );
  const cell = input?.closest?.("td");
  if (cell && !cell.querySelector("[data-ctt-gm-place]")) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.cttGmPlace = "";
    button.className = "fu_button";
    button.innerHTML = `<i class="fas fa-level-down-alt"></i> ${game.i18n.localize(
      `${MODULE_ID}.manager.placeGmRow`,
    )}`;
    button.style.cssText =
      "border:2px groove var(--fco-foundry-interactable-color); " +
      "margin-left:8px; background-color:var(--fco-sheet-input-colour); " +
      "color:var(--fco-sheet-text-colour); font-size:inherit;";
    button.addEventListener("click", () => {
      button.disabled = true;
      FatePointManager.placeGmFatePointRow().finally(() => {
        button.disabled = false;
      });
    });
    cell.append(button);
  }

  // The situation aspects section of the scene tab: the first child div is
  // the GM-only action row (Add New Aspect, label settings, countdowns).
  const saRow = html.querySelector?.("#fu_scene_sit_aspects_container > div");
  if (saRow && !saRow.querySelector("[data-ctt-sa-place]")) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.cttSaPlace = "";
    button.className = "fu_button";
    button.innerHTML = `<i class="fas fa-fire"></i> ${game.i18n.localize(
      `${MODULE_ID}.situationAspects.placeFromFateUtils`,
    )}`;
    button.style.cssText =
      "border:2px groove var(--fco-foundry-interactable-color); " +
      "margin-left:8px; background-color:var(--fco-sheet-input-colour); " +
      "color:var(--fco-sheet-text-colour); font-size:inherit;";
    button.addEventListener("click", () => {
      button.disabled = true;
      SituationAspectManager.placeWidget().finally(() => {
        button.disabled = false;
      });
    });
    saRow.append(button);
  }

  // Feature 5 — "Place conflict board" icon button in the conflict pane of
  // the scene tab (GM-only action row). Icon-only `fu_button` inserted via the
  // pure `conflictUi` helper EXACTLY between the "Timed event"
  // (`#fco_timed_event`) and the "Cycle to next available conflict"
  // (`#fco_next_conflict`) controls (the latter lives in a neighbouring
  // table cell, so the button goes into the timed event's own flex row). Same
  // shared `placeBoard()` handler as the Combat Tracker; no second board
  // variant. Hidden when no combat is pinned to the scene, and panes without
  // the conflict controls never break the rest of the utilities.
  if (root?.querySelector && canPlaceConflictBoard(canvas?.scene, game.combat)) {
    const button = createFateUtilsPlaceButton(
      game.i18n.localize(`${MODULE_ID}.conflict.placement.fromFateUtils`),
    );
    if (!insertFateUtilsBoardPlacement(root, button)) return;
    attachPlaceBoardClick(button, placeBoard);
  }
}
