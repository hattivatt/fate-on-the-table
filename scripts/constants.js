/** Shared constants for the chars-to-table module. */

export const MODULE_ID = "chars-to-table";
export const FLAG_SCOPE = "chars-to-table";
export const WIDGETS_FLAG = "widgets";

// GM fate points (system flag kept compatible with the legacy macro).
export const GM_FP_SCOPE = "fate-core-official";
export const GM_FP_KEY = "gmfatepoints";
// Scene registry of the GM fate point row.
export const GM_FP_WIDGET_FLAG = "gmFatePointWidget";
// Part name of the tiles in the GM fate point row.
export const GM_FP_PART = "gmFatePointTokens";
// Part name of the persistent (empty box included) GM fate point frame.
export const GM_FP_FRAME_PART = "gmFatePointFrame";
// ownerType marker: distinguishes GM rows from actor widgets (no actorUuid).
export const GM_OWNER_TYPE = "gm";

// Situation aspects scene flag (fate-core-official).
export const SITUATION_ASPECTS_SCOPE = "fate-core-official";
export const SITUATION_ASPECTS_KEY = "situation_aspects";
