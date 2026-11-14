import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { isSyncAuthority, canRunSync } from "../scripts/syncAuthority.js";

const original = globalThis.game;
afterEach(() => {
  if (original === undefined) delete globalThis.game;
  else globalThis.game = original;
});

test("no game global: allowed (legacy Node semantics)", () => {
  delete globalThis.game;
  assert.equal(isSyncAuthority(), true);
  assert.equal(canRunSync(), true);
  assert.equal(canRunSync({ manual: true }), true);
});

test("active GM is authority (isActiveGM and activeGM.isSelf / id)", () => {
  globalThis.game = { user: { id: "a", isGM: true, isActiveGM: true } };
  assert.equal(isSyncAuthority(), true);
  globalThis.game = { user: { id: "a", isGM: true }, users: { activeGM: { id: "a", isSelf: true } } };
  assert.equal(isSyncAuthority(), true);
  globalThis.game = { user: { id: "a", isGM: true }, users: { activeGM: { id: "a" } } };
  assert.equal(isSyncAuthority(), true);
});

test("assistant GM that is not the active GM is not authority", () => {
  globalThis.game = { user: { id: "b", isGM: true, isActiveGM: false }, users: { activeGM: { id: "a" } } };
  assert.equal(isSyncAuthority(), false);
  globalThis.game = { user: { id: "b", isGM: true }, users: { activeGM: { id: "a", isSelf: false } } };
  assert.equal(isSyncAuthority(), false);
});

test("player is never authority", () => {
  globalThis.game = { user: { id: "p", isGM: false }, users: { activeGM: { id: "a" } } };
  assert.equal(isSyncAuthority(), false);
  assert.equal(canRunSync({ manual: true }), false);
});

test("manual path allows any GM, automatic path only the active GM", () => {
  globalThis.game = { user: { id: "b", isGM: true, isActiveGM: false } };
  assert.equal(canRunSync({ manual: true }), true);
  assert.equal(canRunSync(), false);
});
