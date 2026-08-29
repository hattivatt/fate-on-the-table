import { test } from "node:test";
import assert from "node:assert/strict";
import { correctedAlias, resolveSpeakerTokenId } from "../scripts/chatSpeaker.js";

test("correctedAlias: alias matches tokenName → null (no correction)", () => {
  assert.equal(correctedAlias({ token: "t1", alias: "Hero" }, "Hero"), null);
});

test("correctedAlias: alias differs from tokenName → tokenName", () => {
  assert.equal(correctedAlias({ token: "t1", alias: "New Character" }, "Aria Swift"), "Aria Swift");
});

test("correctedAlias: no token field → null", () => {
  assert.equal(correctedAlias({ alias: "Hero" }, "Hero"), null);
  assert.equal(correctedAlias({ token: null, alias: "Hero" }, "Hero"), null);
  assert.equal(correctedAlias({ token: "", alias: "Hero" }, "Hero"), null);
  assert.equal(correctedAlias({ token: "   ", alias: "Hero" }, "Hero"), null);
  assert.equal(correctedAlias({ token: undefined, alias: "Hero" }, "Hero"), null);
});

test("correctedAlias: empty/undefined alias with token → tokenName", () => {
  assert.equal(correctedAlias({ token: "t1", alias: undefined }, "Aria"), "Aria");
  assert.equal(correctedAlias({ token: "t1", alias: "" }, "Aria"), "Aria");
  assert.equal(correctedAlias({ token: "t1", alias: null }, "Aria"), "Aria");
  assert.equal(correctedAlias({ token: "t1" }, "Aria"), "Aria");
});

test("correctedAlias: no speaker → null", () => {
  assert.equal(correctedAlias(null, "Aria"), null);
  assert.equal(correctedAlias(undefined, "Aria"), null);
});

test("correctedAlias: empty/whitespace tokenName → null (nothing to correct to)", () => {
  assert.equal(correctedAlias({ token: "t1", alias: "Hero" }, ""), null);
  assert.equal(correctedAlias({ token: "t1", alias: "Hero" }, "   "), null);
  assert.equal(correctedAlias({ token: "t1", alias: "Hero" }, null), null);
  assert.equal(correctedAlias({ token: "t1", alias: "Hero" }, undefined), null);
});

test("correctedAlias: differing alias still returns tokenName even when alias is similar", () => {
  assert.equal(correctedAlias({ token: "t1", alias: "hero" }, "Hero"), "Hero");
  assert.equal(correctedAlias({ token: "t1", alias: "Other" }, "Hero"), "Hero");
});

test("correctedAlias: non-string tokenName → null", () => {
  assert.equal(correctedAlias({ token: "t1", alias: "Hero" }, 123), null);
  assert.equal(correctedAlias({ token: "t1", alias: "Hero" }, {}), null);
});

test("resolveSpeakerTokenId: returns token id or null", () => {
  assert.equal(resolveSpeakerTokenId({ token: "t1" }), "t1");
  assert.equal(resolveSpeakerTokenId({ token: null }), null);
  assert.equal(resolveSpeakerTokenId({}), null);
  assert.equal(resolveSpeakerTokenId(null), null);
  assert.equal(resolveSpeakerTokenId(undefined), null);
  assert.equal(resolveSpeakerTokenId({ token: "" }), "");
});
