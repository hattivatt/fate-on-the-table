/**
 * conflictBoardSchema — validation and normalization of the conflict board
 * scene flag (schema v1) for feature 5 ("Розыгрыш конфликта на столе").
 *
 * Persisted under `scene.flags["fate-on-the-table"].conflictBoard`. This
 * module is pure: no `game`, `canvas`, `CONFIG` or other Foundry runtime
 * dependency. It is covered by the Node test suite, exactly like
 * `layoutSchema.js` / `layoutGeometry.js`.
 *
 * Canonical normalized state (schema v1):
 *
 * ```js
 * {
 *   version: 1,
 *   combatId: "<combatId>",
 *   sizePreset: "small" | "medium" | "large",
 *   board: {
 *     origin: { x: <number>, y: <number> },          // required
 *     boardSize: { width, height } | undefined,        // optional, kept as-is
 *     background: { color, texture, alpha }
 *   },
 *   zones: [
 *     {
 *       id: "<stable zone id>",                        // required, unique
 *       name: "<string>",
 *       rect: { x, y, width, height },
 *       style: { fill, alpha, stroke },
 *       sort: <number>
 *     }
 *   ],
 *   cards: {
 *     "<combatantId>": {
 *       side: "friendly" | "hostile",                  // home side area
 *       area: "side" | "acted" | "eliminated",         // current area
 *       order: <integer >= 0>                          // stable order
 *     }
 *   },
 *   tokenZones: {
 *     "<Scene.<sceneId>.Token.<tokenId>": "<zoneId>"   // zone must exist
 *   }
 * }
 * ```
 *
 * Rules implemented here:
 *   - zone ids are stable identifiers, independent of array order, and unique;
 *   - combatant ids in `cards` cannot be checked against live combatants
 *     without the runtime — `reconcileConflictBoard` performs that check
 *     against a passed set of available UUIDs;
 *   - `tokenZones` values must reference zones present in `zones` (checked
 *     within the same document);
 *   - enums (sizePreset/side/area), rects and styles are type-checked;
 *   - diagnostics have the shape `{ path, message, severity }`;
 *   - safe deterministic defaults are applied ONLY to structurally valid
 *     documents — structural errors are never repaired silently
 *     (`normalized` stays `null` when any error is present).
 */

export const CONFLICT_BOARD_VERSION = 1;
export const SIZE_PRESETS = Object.freeze(["small", "medium", "large"]);
export const CARD_SIDES = Object.freeze(["friendly", "hostile"]);
export const CARD_AREAS = Object.freeze(["side", "acted", "eliminated"]);
export const DEFAULT_SIZE_PRESET = "medium";

export const DEFAULT_BACKGROUND = Object.freeze({
  color: "#ffffff",
  texture: "",
  alpha: 1,
});
export const DEFAULT_ZONE_STYLE = Object.freeze({
  fill: "#ffffff",
  alpha: 0.12,
  stroke: "#000000",
});

/**
 * Foundry CONST.TOKEN_DISPOSITIONS values kept as literals so the module
 * stays runtime-free (same approach as FILL_* in layoutGeometry.js).
 */
export const TOKEN_DISPOSITION = Object.freeze({
  HOSTILE: -1,
  NEUTRAL: 0,
  FRIENDLY: 1,
  SECRET: 2,
});

const DISPOSITION_BY_VALUE = {
  [-1]: "hostile",
  [0]: "neutral",
  [1]: "friendly",
  [2]: "secret",
};
const DISPOSITION_BY_NAME = Object.freeze({
  hostile: "hostile",
  neutral: "neutral",
  friendly: "friendly",
  secret: "secret",
});

/**
 * Normalizes a token disposition to a canonical name.
 * @param {number|string|undefined} value  Foundry value (-1..2) or name.
 * @returns {"hostile"|"neutral"|"friendly"|"secret"|"unknown"}
 */
export function resolveDisposition(value) {
  if (typeof value === "string") return DISPOSITION_BY_NAME[value] ?? "unknown";
  if (typeof value === "number") return DISPOSITION_BY_VALUE[value] ?? "unknown";
  return "unknown";
}

/**
 * Primary initial side of a participant card (per PLAN):
 * player-owned or FRIENDLY → "friendly"; HOSTILE → "hostile";
 * NEUTRAL/SECRET/unknown → "friendly".
 * @param {{hasPlayerOwner?: boolean, disposition?: number|string}} descriptor
 * @returns {"friendly"|"hostile"}
 */
export function resolveInitialSide(descriptor) {
  if (descriptor?.hasPlayerOwner) return "friendly";
  return resolveDisposition(descriptor?.disposition) === "hostile"
    ? "hostile"
    : "friendly";
}

/**
 * Initial distribution of participants into the side areas.
 * @param {Array<object>} combatants  Plain descriptors in combat order:
 *   `{ combatantId|id, hasPlayerOwner?: boolean, disposition?: number|string }`
 *   (`disposition` uses TOKEN_DISPOSITION values or the same lowercase names).
 *   NOT Foundry Combatant documents — pass plain descriptors only.
 * @returns {{cards: object, order: string[]}}
 *   `cards[combatantId] = { side, area: "side", order }` with `order` equal to
 *   the descriptor index (stable), and `order` the same ids in input order.
 */
export function assignInitialCardAreas(combatants) {
  const cards = {};
  const order = [];
  const seen = new Set();
  (combatants ?? []).forEach((descriptor, index) => {
    if (!isObject(descriptor)) return;
    const combatantId = descriptor.combatantId ?? descriptor.id;
    if (!isNonEmptyString(combatantId) || seen.has(combatantId)) return;
    seen.add(combatantId);
    cards[combatantId] = {
      side: resolveInitialSide(descriptor),
      area: "side",
      order: index,
    };
    order.push(combatantId);
  });
  return { cards, order };
}

/* ------------------------------------------------------------------ *
 * Validation / normalization
 * ------------------------------------------------------------------ */

/**
 * Validates a conflict board document (no normalization).
 * @param {*} input
 * @returns {{ok: boolean, errors: Array<{path, message, severity}>,
 *   warnings: Array<{path, message, severity}>}}
 */
export function validateConflictBoard(input) {
  const { ok, errors, warnings } = analyzeConflictBoard(input);
  return { ok, errors, warnings };
}

/**
 * Validates AND normalizes a conflict board document. Safe defaults are
 * applied to structurally valid documents only; `normalized` is `null` when
 * any error is present (structural errors are never silently repaired).
 * @param {*} input
 * @returns {{ok: boolean, errors: Array, warnings: Array,
 *   normalized: object|null}}
 */
export function normalizeConflictBoard(input) {
  return analyzeConflictBoard(input);
}

/** Alias of `normalizeConflictBoard` keeping the `analyzeLayout`-style name. */
export const analyzeConflictBoard = function analyzeConflictBoard(input) {
  const errors = [];
  const warnings = [];
  const err = (path, message) => errors.push({ path, message, severity: "error" });
  const warn = (path, message) => warnings.push({ path, message, severity: "warning" });

  if (!isObject(input)) {
    return {
      ok: false,
      errors: [
        { path: "$", message: "Conflict board document must be a JSON object.", severity: "error" },
      ],
      warnings: [],
      normalized: null,
    };
  }

  // ---- top level ----------------------------------------------------
  if (typeof input.version !== "number" || !Number.isInteger(input.version)) {
    err("$.version", "Expected an integer version.");
  } else if (input.version !== CONFLICT_BOARD_VERSION) {
    err("$.version", `Unsupported version ${input.version}; latest is ${CONFLICT_BOARD_VERSION}.`);
  }
  if (!isNonEmptyString(input.combatId)) {
    err("$.combatId", "Expected a non-empty string.");
  }
  if (input.sizePreset !== undefined && !SIZE_PRESETS.includes(input.sizePreset)) {
    err("$.sizePreset", `Expected one of: ${SIZE_PRESETS.join(", ")}.`);
  }
  for (const key of Object.keys(input)) {
    if (!TOP_LEVEL_KEYS.has(key)) warn(`$.${key}`, "Unknown field (kept as-is).");
  }

  // ---- board --------------------------------------------------------
  if (!isObject(input.board)) {
    err("$.board", "Expected an object.");
  } else {
    const board = input.board;
    for (const key of Object.keys(board)) {
      if (!BOARD_KEYS.has(key)) warn(`$.board.${key}`, "Unknown field (kept as-is).");
    }
    if (!isObject(board.origin)) {
      err("$.board.origin", "Expected an object.");
    } else {
      requireFiniteNumber(board.origin.x, err, "$.board.origin.x");
      requireFiniteNumber(board.origin.y, err, "$.board.origin.y");
    }
    if (board.boardSize !== undefined) {
      if (!isObject(board.boardSize)) {
        err("$.board.boardSize", "Expected an object.");
      } else {
        requirePositiveNumber(board.boardSize.width, err, "$.board.boardSize.width");
        requirePositiveNumber(board.boardSize.height, err, "$.board.boardSize.height");
      }
    }
    if (board.background !== undefined) {
      if (!isObject(board.background)) {
        err("$.board.background", "Expected an object.");
      } else {
        const bg = board.background;
        if (bg.color !== undefined && typeof bg.color !== "string") {
          err("$.board.background.color", "Expected a string.");
        }
        if (bg.texture !== undefined && typeof bg.texture !== "string") {
          err("$.board.background.texture", "Expected a string.");
        }
        if (bg.alpha !== undefined) requireAlpha(bg.alpha, err, "$.board.background.alpha");
      }
    }
  }

  // ---- zones --------------------------------------------------------
  const zoneIds = new Set();
  const zones = input.zones;
  if (zones !== undefined && !Array.isArray(zones)) {
    err("$.zones", "Expected an array.");
  } else if (Array.isArray(zones)) {
    zones.forEach((zone, i) => {
      const p = `$.zones[${i}]`;
      if (!isObject(zone)) {
        err(p, "Expected an object.");
        return;
      }
      for (const key of Object.keys(zone)) {
        if (!ZONE_KEYS.has(key)) warn(`${p}.${key}`, "Unknown field (kept as-is).");
      }
      if (!isNonEmptyString(zone.id)) {
        err(`${p}.id`, "Expected a non-empty string.");
      } else if (zoneIds.has(zone.id)) {
        err(`${p}.id`, `Duplicate zone id "${zone.id}".`);
      } else {
        zoneIds.add(zone.id);
      }
      if (zone.name !== undefined && typeof zone.name !== "string") {
        err(`${p}.name`, "Expected a string.");
      }
      if (!isObject(zone.rect)) {
        err(`${p}.rect`, "Expected an object.");
      } else {
        requireFiniteNumber(zone.rect.x, err, `${p}.rect.x`);
        requireFiniteNumber(zone.rect.y, err, `${p}.rect.y`);
        requireNonNegativeNumber(zone.rect.width, err, `${p}.rect.width`);
        requireNonNegativeNumber(zone.rect.height, err, `${p}.rect.height`);
      }
      if (zone.style !== undefined) {
        if (!isObject(zone.style)) {
          err(`${p}.style`, "Expected an object.");
        } else {
          if (zone.style.fill !== undefined && typeof zone.style.fill !== "string") {
            err(`${p}.style.fill`, "Expected a string.");
          }
          if (zone.style.alpha !== undefined) requireAlpha(zone.style.alpha, err, `${p}.style.alpha`);
          if (zone.style.stroke !== undefined && typeof zone.style.stroke !== "string") {
            err(`${p}.style.stroke`, "Expected a string.");
          }
        }
      }
      if (zone.sort !== undefined) requireFiniteNumber(zone.sort, err, `${p}.sort`);
    });
  }

  // ---- cards --------------------------------------------------------
  if (input.cards !== undefined && !isObject(input.cards)) {
    err("$.cards", "Expected an object.");
  } else {
    for (const [combatantId, record] of Object.entries(input.cards ?? {})) {
      const p = `$.cards.${combatantId}`;
      if (!isNonEmptyString(combatantId)) {
        err("$.cards", "Combatant ids must be non-empty strings.");
        continue;
      }
      if (!isObject(record)) {
        err(p, "Expected an object.");
        continue;
      }
      for (const key of Object.keys(record)) {
        if (!CARD_RECORD_KEYS.has(key)) warn(`${p}.${key}`, "Unknown field (kept as-is).");
      }
      if (record.side !== undefined && !CARD_SIDES.includes(record.side)) {
        err(`${p}.side`, `Expected one of: ${CARD_SIDES.join(", ")}.`);
      }
      if (record.area !== undefined && !CARD_AREAS.includes(record.area)) {
        err(`${p}.area`, `Expected one of: ${CARD_AREAS.join(", ")}.`);
      }
      if (record.order !== undefined) {
        if (typeof record.order !== "number" || !Number.isInteger(record.order) || record.order < 0) {
          err(`${p}.order`, "Expected an integer >= 0.");
        }
      }
    }
  }

  // ---- tokenZones ---------------------------------------------------
  if (input.tokenZones !== undefined && !isObject(input.tokenZones)) {
    err("$.tokenZones", "Expected an object.");
  } else {
    for (const [tokenUuid, zoneId] of Object.entries(input.tokenZones ?? {})) {
      if (!isNonEmptyString(tokenUuid)) {
        err("$.tokenZones", "Token UUIDs must be non-empty strings.");
        continue;
      }
      if (!isNonEmptyString(zoneId)) {
        err(`$.tokenZones.${tokenUuid}`, "Expected a non-empty string zone id.");
      } else if (Array.isArray(zones) && !zoneIds.has(zoneId)) {
        err(`$.tokenZones.${tokenUuid}`, `References unknown zone "${zoneId}".`);
      }
    }
  }

  const ok = errors.length === 0;
  return { ok, errors, warnings, normalized: ok ? normalizeDocument(input) : null };
};

/* ------------------------------------------------------------------ *
 * Validation helpers
 * ------------------------------------------------------------------ */

const TOP_LEVEL_KEYS = new Set([
  "version",
  "combatId",
  "sizePreset",
  "board",
  "zones",
  "cards",
  "tokenZones",
]);
const BOARD_KEYS = new Set(["origin", "boardSize", "background"]);
const ZONE_KEYS = new Set(["id", "name", "rect", "style", "sort"]);
const CARD_RECORD_KEYS = new Set(["side", "area", "order"]);

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function requireFiniteNumber(value, err, path) {
  if (!isFiniteNumber(value)) err(path, "Expected a finite number.");
}

function requireNonNegativeNumber(value, err, path) {
  if (!isFiniteNumber(value) || value < 0) err(path, "Expected a number >= 0.");
}

function requirePositiveNumber(value, err, path) {
  if (!isFiniteNumber(value) || value <= 0) err(path, "Expected a positive number.");
}

function requireAlpha(value, err, path) {
  if (!isFiniteNumber(value) || value < 0 || value > 1) {
    err(path, "Expected a number in [0, 1].");
  }
}

/* ------------------------------------------------------------------ *
 * Normalization (safe deterministic defaults, structural errors never
 * repaired silently — normalization runs only when validation passed).
 * ------------------------------------------------------------------ */

function normalizeDocument(input) {
  const doc = clone(input);

  if (doc.sizePreset === undefined) doc.sizePreset = DEFAULT_SIZE_PRESET;
  doc.board = { ...(doc.board ?? {}) };
  if (!doc.board.background) {
    doc.board.background = { ...DEFAULT_BACKGROUND };
  } else {
    doc.board.background = {
      color: DEFAULT_BACKGROUND.color,
      texture: DEFAULT_BACKGROUND.texture,
      alpha: DEFAULT_BACKGROUND.alpha,
      ...doc.board.background,
    };
  }

  if (!Array.isArray(doc.zones)) doc.zones = [];
  doc.zones = doc.zones.map((zone) => ({
    ...zone,
    name: typeof zone.name === "string" ? zone.name : "",
    rect: { ...zone.rect },
    style: { ...DEFAULT_ZONE_STYLE, ...(zone.style ?? {}) },
    sort: isFiniteNumber(zone.sort) ? zone.sort : 0,
  }));

  if (!isObject(doc.cards)) doc.cards = {};
  const cards = {};
  for (const [combatantId, record] of Object.entries(doc.cards)) {
    if (!isObject(record)) continue;
    cards[combatantId] = {
      side: CARD_SIDES.includes(record.side) ? record.side : "friendly",
      area: CARD_AREAS.includes(record.area) ? record.area : "side",
      order:
        typeof record.order === "number" && Number.isInteger(record.order) && record.order >= 0
          ? record.order
          : 0,
      ...record,
    };
  }
  doc.cards = cards;

  if (!isObject(doc.tokenZones)) doc.tokenZones = {};
  return doc;
}

/** Deep-clones a plain JSON-ish value (objects/arrays/primitives). */
function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (isObject(value)) {
    const out = {};
    for (const key of Object.keys(value)) out[key] = clone(value[key]);
    return out;
  }
  return value;
}

/* ------------------------------------------------------------------ *
 * Reconcile
 * ------------------------------------------------------------------ */

/**
 * Admits (adds) participant cards for available combatants that do NOT yet
 * have a card in the conflict board state. The reverse of orphan removal:
 * when a combatant becomes available on the current scene mid-conflict (a new
 * token is introduced into `game.combat` / combat mode), its card appears
 * automatically without disturbing existing assignments.
 *
 * Pure function: never touches `game`, never mutates `state`. Existing cards
 * (their `side`/`area`/`order`) are NEVER rewritten; only missing combatant
 * ids are added. Cards are only admitted for combatants whose plain
 * descriptor is present in `available.descriptors` — the caller (runtime
 * `resolveAvailable`) only includes combatants with an actual token on the
 * scene, so combatants without a token are never admitted here.
 *
 * Side and area follow the exact primary-placement rules (`resolveInitialSide`:
 * player-owned / FRIENDLY / NEUTRAL / unknown -> "friendly"; HOSTILE ->
 * "hostile"; area always "side"). `order` is a deterministic non-negative
 * integer that never collides with an already-assigned card: newcomers are
 * admitted in `available.descriptors` order and each gets the smallest free
 * order. Re-running with the same input yields the same result (no
 * duplicates, no order drift).
 *
 * @param {object} state  Conflict board state (normalized).
 * @param {object} available {
 *   descriptors: Array<{combatantId|id, hasPlayerOwner?, disposition?}>
 *     Plain combatant descriptors in combat order, only for combatants with
 *     an available token on the current scene.
 * }
 * @returns {{state: object, admittedCombatantIds: string[]}}
 *   New state + the ids of cards actually added.
 */
export function admitMissingCards(state, available = {}) {
  const existing = state?.cards ?? {};
  const usedOrders = new Set(
    Object.values(existing)
      .map((r) => (isObject(r) ? r.order : undefined))
      .filter((o) => typeof o === "number" && Number.isInteger(o) && o >= 0),
  );
  const cards = { ...existing };
  const admittedCombatantIds = [];

  for (const descriptor of Array.isArray(available?.descriptors)
    ? available.descriptors
    : []) {
    const combatantId = descriptor?.combatantId ?? descriptor?.id;
    if (!isNonEmptyString(combatantId)) continue;
    if (cards[combatantId]) continue;
    let order = 0;
    while (usedOrders.has(order)) order += 1;
    usedOrders.add(order);
    cards[combatantId] = {
      side: resolveInitialSide({
        hasPlayerOwner: descriptor.hasPlayerOwner,
        disposition: descriptor.disposition,
      }),
      area: "side",
      order,
    };
    admittedCombatantIds.push(combatantId);
  }

  return { state: { ...state, cards }, admittedCombatantIds };
}

/**
 * Removes orphaned card/token-zone assignments from a conflict board state
 * AND admits newcomer cards for available combatants (see `admitMissingCards`).
 *
 * Pure function: never touches `game`, never mutates `state`, never removes
 * data owned by other features (zones, board, background stay untouched).
 *
 * The two operations are deliberately combined here so a single reconcile
 * pass keeps `cards` in lock-step with the combat's current availability: an
 * orphan (combatant gone / token gone) is dropped, while a newly available
 * combatant (in `available.descriptors`, absent from `state.cards`) is added
 * with primary-placement side/area and a conflict-free deterministic order.
 *
 * @param {object} state     Conflict board state (normalized).
 * @param {object} available {
 *   combatantIds: Iterable<string>,   Available combatant ids.
 *   tokenUuids:   Iterable<string>    Available token UUIDs.
 *   descriptors:  Array<object>       Plain combatant descriptors (combat
 *                                     order) for combatants with an available
 *                                     token on the scene — used for admission.
 * }
 * @returns {{state: object, removedCombatantIds: string[],
 *   removedTokenUuids: string[], removedZoneEntries: Array<{tokenUuid, zoneId}>,
 *   admittedCombatantIds: string[]}}
 *   `removedZoneEntries` lists tokenZones entries dropped because their zone
 *   id no longer exists in `state.zones`.
 */
export function reconcileConflictBoard(state, available = {}) {
  const combatantIds = toSet(available.combatantIds);
  const tokenUuids = toSet(available.tokenUuids);
  const zoneIds = new Set((Array.isArray(state?.zones) ? state.zones : []).map((z) => z?.id));

  const cards = {};
  const removedCombatantIds = [];
  for (const [id, record] of Object.entries(state?.cards ?? {})) {
    if (combatantIds.has(id)) cards[id] = record;
    else removedCombatantIds.push(id);
  }

  const tokenZones = {};
  const removedTokenUuids = [];
  const removedZoneEntries = [];
  for (const [uuid, zoneId] of Object.entries(state?.tokenZones ?? {})) {
    if (!tokenUuids.has(uuid)) {
      removedTokenUuids.push(uuid);
    } else if (!zoneIds.has(zoneId)) {
      removedZoneEntries.push({ tokenUuid: uuid, zoneId });
    } else {
      tokenZones[uuid] = zoneId;
    }
  }

  const admitted = admitMissingCards(
    { ...state, cards, tokenZones },
    available,
  );

  return {
    state: admitted.state,
    removedCombatantIds,
    removedTokenUuids,
    removedZoneEntries,
    admittedCombatantIds: admitted.admittedCombatantIds,
  };
}

/** @param {Iterable<string>|undefined} values */
function toSet(values) {
  return new Set(values ?? []);
}

/**
 * Projects the live combat turn state (`fate-core-official.hasActed`) onto
 * the board state's cards. Pure: never mutates `state`, never touches
 * `game`/combat documents — pass a plain `combatantStates` map instead.
 *
 * This is a cached projection only: the combatants' `hasActed` flags (written
 * exclusively through the standard `fate-core-official` API) remain the
 * source of truth. The board flag is never used to derive them.
 *
 * Rules (priority order):
 * - a card whose combatant id is NOT listed in `combatantStates` is left
 *   untouched (orphan removal is `reconcileConflictBoard`'s job);
 * - an "eliminated" card is never overwritten;
 * - the combatant matching `options.currentCombatantId` (the id at
 *   `combat.turns[combat.turn]`, i.e. the current actor) ALWAYS stays in its
 *   side area (`area: "side"`) even when `hasActed === true` — the
 *   `fate-core-official` popcorn semantics mark the acting combatant as both
 *   current and `hasActed` at the same time;
 * - non-current + `hasActed === true`  -> `area` becomes "acted";
 * - non-current + `hasActed === false` -> `area` returns to "side" (its
 *   friendly/hostile `side` and `order` are preserved);
 * - when no current is given (`options.currentCombatantId` missing/null, i.e.
 *   `combat.turn === null`) the legacy mapping is kept: true -> "acted",
 *   false -> "side".
 *
 * @param {object} state  Normalized conflict board state.
 * @param {Record<string, boolean>} combatantStates  `{ [combatantId]: hasActed }`.
 * @param {object} [options]  `{ currentCombatantId: string|null }` — the id of
 *   the current combatant (`combat.turns[combat.turn]`, Fate Utilities order).
 * @returns {{state: object, changed: string[]}}  New state + ids whose `area`
 *   actually changed.
 */
export function applyCombatTurnStateToCards(state, combatantStates = {}, options = {}) {
  const cards = {};
  const changed = [];
  const currentId = options?.currentCombatantId ?? null;
  for (const [combatantId, record] of Object.entries(state?.cards ?? {})) {
    if (!isObject(record)) {
      cards[combatantId] = record;
      continue;
    }
    const hasActed = combatantStates[combatantId];
    if (typeof hasActed !== "boolean") {
      cards[combatantId] = record;
      continue;
    }
    if (record.area === "eliminated") {
      cards[combatantId] = record;
      continue;
    }
    const isCurrent = currentId !== null && combatantId === currentId;
    const nextArea = isCurrent ? "side" : hasActed ? "acted" : "side";
    if (record.area !== nextArea) {
      cards[combatantId] = { ...record, area: nextArea };
      changed.push(combatantId);
    } else {
      cards[combatantId] = record;
    }
  }
  return { state: { ...state, cards }, changed };
}

/**
 * Creates a fresh empty conflict board document (schema v1) with safe
 * defaults. Useful for initial placement before zones/cards are assigned.
 * @param {{combatId?: string, sizePreset?: string, origin?: {x, y}}} [options]
 * @returns {object}
 */
export function createConflictBoard({ combatId = "", sizePreset, origin } = {}) {
  const doc = {
    version: CONFLICT_BOARD_VERSION,
    combatId,
    sizePreset: SIZE_PRESETS.includes(sizePreset) ? sizePreset : DEFAULT_SIZE_PRESET,
    board: {
      origin: isObject(origin) ? { ...origin } : { x: 0, y: 0 },
      background: { ...DEFAULT_BACKGROUND },
    },
    zones: [],
    cards: {},
    tokenZones: {},
  };
  return doc;
}
