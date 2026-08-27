/** Shared constants for the fate-on-the-table module. */

export const MODULE_ID = "fate-on-the-table";
export const FLAG_SCOPE = "fate-on-the-table";
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
// Scene registry of the situation aspects widget.
export const SITUATION_ASPECTS_WIDGET_FLAG = "situationAspectsWidget";
// ownerType marker: standalone scene widget without actorUuid.
export const SA_OWNER_TYPE = "situationAspects";
// Part names of the situation aspects widget drawings.
export const SA_TEXT_PART = "situationAspectsText";
export const SA_FRAME_PART = "situationAspectsFrame";
export const SA_BACKGROUND_PART = "situationAspectsBackground";

// Feature 5 — conflict board (scene-owned conflict widget).
// Scene flag key holding the conflict board state (schema v1).
export const CONFLICT_BOARD_FLAG = "conflictBoard";
// ownerType markers: zone projections and participant cards of the board.
export const CONFLICT_ZONE_OWNER_TYPE = "conflictZone";
export const CONFLICT_CARD_OWNER_TYPE = "conflictCard";
// Part names of the conflict board drawings.
export const CONFLICT_BOARD_BACKGROUND_PART = "conflictBoardBackground";
export const CONFLICT_AREA_PART = "conflictArea";
export const CONFLICT_ZONE_BODY_PART = "conflictZoneBody";
export const CONFLICT_ZONE_LABEL_PART = "conflictZoneLabel";
export const CONFLICT_ZONE_ASPECTS_PART = "conflictZoneAspects";
export const CONFLICT_CARD_PART = "conflictCard";
export const CONFLICT_TURN_MARKER_PART = "conflictTurnMarker";
