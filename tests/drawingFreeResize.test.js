/**
 * Node tests for the Foundry glue of `drawingFreeResize` — only the pure target
 * predicate and the Foundry-absent inertness are asserted here (the prototype
 * wrapping itself is exercised in the live client).
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  isFreeResizeTarget,
  initDrawingFreeResize,
} from "../scripts/drawingFreeResize.js";
import {
  FLAG_SCOPE,
  CHALLENGE_OWNER_TYPE,
  CONTEST_OWNER_TYPE,
} from "../scripts/constants.js";

/** Minimal Drawing-document double exposing `getFlag`. */
function docWith(ownerType) {
  return {
    getFlag(scope, key) {
      if (scope !== FLAG_SCOPE || key !== "ownerType") return undefined;
      return ownerType;
    },
  };
}

test("only challenge / contest drawings are free-resize targets", () => {
  assert.equal(isFreeResizeTarget(docWith(CHALLENGE_OWNER_TYPE)), true);
  assert.equal(isFreeResizeTarget(docWith(CONTEST_OWNER_TYPE)), true);
  assert.equal(isFreeResizeTarget(docWith("conflictCard")), false);
  assert.equal(isFreeResizeTarget(docWith("gm")), false);
  assert.equal(isFreeResizeTarget(docWith(undefined)), false);
  assert.equal(isFreeResizeTarget({}), false);
  assert.equal(isFreeResizeTarget(null), false);
});

test("initDrawingFreeResize is an inert no-op without Foundry (Node)", () => {
  assert.equal(typeof foundry, "undefined");
  assert.doesNotThrow(() => initDrawingFreeResize());
  assert.doesNotThrow(() => initDrawingFreeResize());
});
