/**
 * Node tests for widgetInteractionRouter.js — the pure, Foundry-free routing
 * table shared by the PIXI placeable patches and the DOM canvas fallback.
 *
 * The router must pick the same handler regardless of the active canvas layer,
 * so these tests model documents as plain `{ getFlag }` objects (exactly the
 * shape the tests of ConflictInteractions/StressBoxes already use) and assert
 * the route per event kind and document identity.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FLAG_SCOPE,
  GM_OWNER_TYPE,
  SA_OWNER_TYPE,
  CONFLICT_CARD_OWNER_TYPE,
  CONFLICT_ZONE_OWNER_TYPE,
  STRESS_BOX_PART,
  CONSEQUENCE_COST_ROWS_PART,
} from "../scripts/constants.js";
import {
  resolveWidgetRoute,
  WIDGET_ROUTE,
  WIDGET_EVENT_KINDS,
  CONFLICT_OWNER_TYPES,
  isGmRowWidget,
  isSaWidget,
  isActorWidget,
  isConflictWidget,
  isStressBoxWidget,
  isConsequenceCostWidget,
} from "../scripts/widgetInteractionRouter.js";

const { SINGLE_CLICK, DOUBLE_CLICK, CONTEXT_MENU } = WIDGET_EVENT_KINDS;

/** A minimal Drawing/Tile document with the given flags. */
function doc(flags = {}, { documentName = "Drawing" } = {}) {
  return {
    id: flags.id ?? "doc-1",
    documentName,
    getFlag(scope, key) {
      if (scope !== FLAG_SCOPE) return undefined;
      return flags[key];
    },
  };
}

/* ------------------------------------------------------------------ *
 * Predicates
 * ------------------------------------------------------------------ */

test("predicates identify the module widget families by flags", () => {
  assert.equal(isGmRowWidget(doc({ ownerType: GM_OWNER_TYPE, widgetId: "w1" })), true);
  assert.equal(isGmRowWidget(doc({ actorUuid: "Actor.a" })), false);

  assert.equal(isSaWidget(doc({ ownerType: SA_OWNER_TYPE, widgetId: "w1" })), true);
  assert.equal(isSaWidget(doc({ ownerType: GM_OWNER_TYPE })), false);

  assert.equal(isActorWidget(doc({ actorUuid: "Actor.a" })), true);
  assert.equal(isActorWidget(doc({ ownerType: SA_OWNER_TYPE })), false);

  assert.equal(isConflictWidget(doc({ ownerType: CONFLICT_CARD_OWNER_TYPE })), true);
  assert.equal(isConflictWidget(doc({ ownerType: CONFLICT_ZONE_OWNER_TYPE })), true);
  assert.equal(isConflictWidget(doc({ ownerType: "conflictBoard" })), true);
  assert.equal(isConflictWidget(doc({ ownerType: GM_OWNER_TYPE })), false);

  // placeable unwrapping (`.document`)
  const placeable = { document: doc({ actorUuid: "Actor.a" }) };
  assert.equal(isActorWidget(placeable), true);

  // null / malformed
  assert.equal(isActorWidget(null), false);
  assert.equal(isConflictWidget({}), false);
});

test("stress box and consequence cost row predicates mirror the handlers", () => {
  // Actor widget stress box.
  assert.equal(
    isStressBoxWidget(doc({ part: STRESS_BOX_PART, index: 0, actorUuid: "Actor.a" })),
    true,
  );
  // Conflict-card stress box (no actorUuid required).
  assert.equal(
    isStressBoxWidget(doc({ part: STRESS_BOX_PART, index: 2, ownerType: CONFLICT_CARD_OWNER_TYPE })),
    true,
  );
  // Invalid identity: wrong part, negative/missing index, no owner.
  assert.equal(isStressBoxWidget(doc({ part: "name", index: 0, actorUuid: "Actor.a" })), false);
  assert.equal(isStressBoxWidget(doc({ part: STRESS_BOX_PART, index: -1, actorUuid: "Actor.a" })), false);
  assert.equal(isStressBoxWidget(doc({ part: STRESS_BOX_PART, index: 0 })), false);
  // Consequence cost rows are NOT stress boxes (double-click text input).
  assert.equal(
    isStressBoxWidget(doc({ part: CONSEQUENCE_COST_ROWS_PART, index: 0, actorUuid: "Actor.a" })),
    false,
  );

  assert.equal(
    isConsequenceCostWidget(doc({ part: CONSEQUENCE_COST_ROWS_PART, index: 0, actorUuid: "Actor.a" })),
    true,
  );
  assert.equal(
    isConsequenceCostWidget(doc({ part: CONSEQUENCE_COST_ROWS_PART, index: 1, ownerType: CONFLICT_CARD_OWNER_TYPE })),
    true,
  );
  assert.equal(
    isConsequenceCostWidget(doc({ part: CONSEQUENCE_COST_ROWS_PART, index: 0, ownerType: CONFLICT_ZONE_OWNER_TYPE })),
    false,
  );
  assert.equal(isConsequenceCostWidget(null), false);
});

/* ------------------------------------------------------------------ *
 * Route resolution — double click
 * ------------------------------------------------------------------ */

test("double click routes each widget family to its own handler", () => {
  assert.equal(
    resolveWidgetRoute(doc({ ownerType: GM_OWNER_TYPE, widgetId: "w1" }), DOUBLE_CLICK),
    WIDGET_ROUTE.GM_ROW,
  );
  assert.equal(
    resolveWidgetRoute(doc({ ownerType: SA_OWNER_TYPE, widgetId: "w1" }), DOUBLE_CLICK),
    WIDGET_ROUTE.SA,
  );
  assert.equal(
    resolveWidgetRoute(doc({ actorUuid: "Actor.a", widgetId: "w1" }), DOUBLE_CLICK),
    WIDGET_ROUTE.ACTOR,
  );
  assert.equal(
    resolveWidgetRoute(doc({ ownerType: CONFLICT_CARD_OWNER_TYPE, widgetId: "w1" }), DOUBLE_CLICK),
    WIDGET_ROUTE.CONFLICT,
  );
  assert.equal(
    resolveWidgetRoute(doc({ ownerType: "conflictBoard", part: "conflictTurnMarker", widgetId: "w1" }), DOUBLE_CLICK),
    WIDGET_ROUTE.CONFLICT,
  );
  // Consequence cost row (conflict card AND actor widget) wins over conflict /
  // actor because it opens the text editor, not the sheet.
  assert.equal(
    resolveWidgetRoute(
      doc({ part: CONSEQUENCE_COST_ROWS_PART, index: 0, ownerType: CONFLICT_CARD_OWNER_TYPE, actorUuid: "Actor.a" }),
      DOUBLE_CLICK,
    ),
    WIDGET_ROUTE.CONSEQUENCE,
  );
  assert.equal(
    resolveWidgetRoute(
      doc({ part: CONSEQUENCE_COST_ROWS_PART, index: 0, actorUuid: "Actor.a" }),
      DOUBLE_CLICK,
    ),
    WIDGET_ROUTE.CONSEQUENCE,
  );
  // A conflict-card stress row is NOT a consequence: double click opens the sheet.
  assert.equal(
    resolveWidgetRoute(
      doc({ part: STRESS_BOX_PART, index: 0, ownerType: CONFLICT_CARD_OWNER_TYPE }),
      DOUBLE_CLICK,
    ),
    WIDGET_ROUTE.CONFLICT,
  );
});

test("double click priority: GM row > SA > consequence > conflict > actor", () => {
  // A conflict card carries an actorUuid for its token actor but must still
  // route through the conflict handler (never a plain actor sheet).
  const conflictWithActor = doc({
    ownerType: CONFLICT_CARD_OWNER_TYPE,
    actorUuid: "Actor.a",
    widgetId: "w1",
  });
  assert.equal(resolveWidgetRoute(conflictWithActor, DOUBLE_CLICK), WIDGET_ROUTE.CONFLICT);
});

/* ------------------------------------------------------------------ *
 * Route resolution — context menu
 * ------------------------------------------------------------------ */

test("context menu routes conflict > SA > actor and leaves the GM row native", () => {
  assert.equal(
    resolveWidgetRoute(doc({ ownerType: CONFLICT_ZONE_OWNER_TYPE, widgetId: "w1" }), CONTEXT_MENU),
    WIDGET_ROUTE.CONFLICT,
  );
  assert.equal(
    resolveWidgetRoute(doc({ ownerType: CONFLICT_CARD_OWNER_TYPE, actorUuid: "Actor.a", widgetId: "w1" }), CONTEXT_MENU),
    WIDGET_ROUTE.CONFLICT,
  );
  assert.equal(
    resolveWidgetRoute(doc({ ownerType: SA_OWNER_TYPE, widgetId: "w1" }), CONTEXT_MENU),
    WIDGET_ROUTE.SA,
  );
  assert.equal(
    resolveWidgetRoute(doc({ actorUuid: "Actor.a", widgetId: "w1" }), CONTEXT_MENU),
    WIDGET_ROUTE.ACTOR,
  );
  // GM row keeps the native context menu (no module route).
  assert.equal(
    resolveWidgetRoute(doc({ ownerType: GM_OWNER_TYPE, widgetId: "w1" }), CONTEXT_MENU),
    WIDGET_ROUTE.NONE,
  );
});

/* ------------------------------------------------------------------ *
 * Route resolution — single click
 * ------------------------------------------------------------------ */

test("single click routes stress boxes to the toggle and other parts to selection", () => {
  assert.equal(
    resolveWidgetRoute(doc({ part: STRESS_BOX_PART, index: 0, actorUuid: "Actor.a" }), SINGLE_CLICK),
    WIDGET_ROUTE.STRESS_BOX,
  );
  assert.equal(
    resolveWidgetRoute(doc({ part: STRESS_BOX_PART, index: 0, ownerType: CONFLICT_CARD_OWNER_TYPE }), SINGLE_CLICK),
    WIDGET_ROUTE.STRESS_BOX,
  );
  assert.equal(
    resolveWidgetRoute(doc({ part: "name", actorUuid: "Actor.a", widgetId: "w1" }), SINGLE_CLICK),
    WIDGET_ROUTE.SELECT,
  );
  // A foreign document (no widget identity) is never claimed.
  assert.equal(
    resolveWidgetRoute(doc({ part: "name" }), SINGLE_CLICK),
    WIDGET_ROUTE.NONE,
  );
});

/* ------------------------------------------------------------------ *
 * Guards / malformed input
 * ------------------------------------------------------------------ */

test("unknown kinds, foreign and malformed documents resolve to NONE", () => {
  const foreign = doc({ part: "name" });
  assert.equal(resolveWidgetRoute(foreign, DOUBLE_CLICK), WIDGET_ROUTE.NONE);
  assert.equal(resolveWidgetRoute(foreign, CONTEXT_MENU), WIDGET_ROUTE.NONE);
  assert.equal(resolveWidgetRoute(null, DOUBLE_CLICK), WIDGET_ROUTE.NONE);
  assert.equal(resolveWidgetRoute({}, CONTEXT_MENU), WIDGET_ROUTE.NONE);
  assert.equal(resolveWidgetRoute(doc({ actorUuid: "Actor.a" }), "bogusKind"), WIDGET_ROUTE.NONE);
});

test("conflict owner types match the persisted schema set", () => {
  assert.deepEqual(
    [...CONFLICT_OWNER_TYPES].sort(),
    ["conflictBoard", "conflictCard", "conflictZone"],
  );
});
