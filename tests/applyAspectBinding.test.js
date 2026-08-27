/**
 * Unit tests for applyAspectBinding (gap from T1/T3) — pure helper added with
 * structural zone binding. Covers character priority, zone suffix stripping,
 * validIds filtering, and hadKnownBinding unknown-suffix preservation.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { applyAspectBinding, SA_ZONE_MARKER } from "../scripts/situationAspectZones.js";

test("applyAspectBinding: character has priority over zoneIds", () => {
  const res = applyAspectBinding("Fire (Bridge)", { character: "Goblin", zoneIds: ["z1", "z2"], hadKnownBinding: false }, ["z1", "z2"]);
  assert.equal(res.name, "Fire (Goblin)");
  assert.deepEqual(res.zoneIds, []);
});

test("applyAspectBinding: zone binding strips textual suffix and persists normalized zoneIds", () => {
  // raw name carries a legacy suffix, zones chosen -> suffix stripped, name bare
  const res = applyAspectBinding("Smoke (Bridge) ", { zoneIds: ["z1"], hadKnownBinding: false }, ["z1", "z2"]);
  assert.equal(res.name, "Smoke");
  assert.deepEqual(res.zoneIds, ["z1"]);
  // also when raw had no suffix, name stays
  const res2 = applyAspectBinding("Rubble", { zoneIds: ["z2"] }, ["z1", "z2"]);
  assert.equal(res2.name, "Rubble");
  assert.deepEqual(res2.zoneIds, ["z2"]);
});

test("applyAspectBinding: normalizeZoneIds with validIds filters dupes and unknowns", () => {
  const res = applyAspectBinding("A", { zoneIds: ["z1", "z2", "z1", "z9", 123, null] }, ["z1", "z2"]);
  assert.deepEqual(res.zoneIds, ["z1", "z2"]);
  // without validIds duplicates still deduped
  const res2 = applyAspectBinding("A", { zoneIds: ["z1", "z1", "z3"] });
  assert.deepEqual(res2.zoneIds, ["z1", "z3"]);
});

test("applyAspectBinding: hadKnownBinding=false keeps custom suffix verbatim", () => {
  // unknown suffix like "(custom note)" is not a known binding -> hadKnownBinding false
  const res = applyAspectBinding("Fire (custom note)", { hadKnownBinding: false }, ["z1"]);
  assert.equal(res.name, "Fire (custom note)");
  assert.deepEqual(res.zoneIds, []);
  // same for character-like but unknown token
  const res2 = applyAspectBinding("Trap (old) door", { hadKnownBinding: false });
  assert.equal(res2.name, "Trap (old) door");
});

test("applyAspectBinding: hadKnownBinding=true + empty choice strips known suffix", () => {
  // aspect carried a known binding (zone or character) when editing started,
  // user cleared both inputs -> suffix stripped to base
  const res = applyAspectBinding("Fire (Bridge)", { hadKnownBinding: true }, ["z1"]);
  assert.equal(res.name, "Fire");
  assert.deepEqual(res.zoneIds, []);
  const res2 = applyAspectBinding("Fire (Goblin)", { hadKnownBinding: true });
  assert.equal(res2.name, "Fire");
});

test("applyAspectBinding: empty base fallback and trim", () => {
  // raw is only whitespace suffix-like "(Bridge)" -> base empty, fallback to raw trimmed
  const res = applyAspectBinding("   ", { hadKnownBinding: false });
  assert.equal(res.name, "");
  // when zones chosen but base empty, fallback keeps raw
  const res2 = applyAspectBinding("   ", { zoneIds: ["z1"] }, ["z1"]);
  // parseBinding("").base is "" -> || raw => "" (no name), zoneIds still filtered but name stays ""
  assert.equal(res2.name, "");
  assert.deepEqual(res2.zoneIds, ["z1"]);
});

test("applyAspectBinding: zones filtered to empty falls through to hadKnownBinding/verbatim", () => {
  // user selected ["z9"] but none valid -> zones.length 0 after normalize
  const res = applyAspectBinding("Fire (Bridge)", { zoneIds: ["z9"], hadKnownBinding: true }, ["z1"]);
  assert.equal(res.name, "Fire"); // hadKnownBinding strips
  const res2 = applyAspectBinding("Fire (custom note)", { zoneIds: ["z9"], hadKnownBinding: false }, ["z1"]);
  assert.equal(res2.name, "Fire (custom note)");
});

test("SA_ZONE_MARKER constant is ◈", () => {
  assert.equal(SA_ZONE_MARKER, "◈");
});
