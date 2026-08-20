/**
 * Node regression tests for the interactive stress box click path
 * (StressBoxes.js). The toggle must work for the actor's owner both through
 * the native Drawing layer and through the module's DOM canvas fallback
 * (players usually have the token layer active), so the shared helpers
 * `isStressBoxDrawing` and `handleStressBoxClick` are covered directly.
 */

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { FLAG_SCOPE } from "../scripts/constants.js";
import {
  isStressBoxDrawing,
  handleStressBoxClick,
  toggleStressBox,
} from "../scripts/StressBoxes.js";

let notified = [];
let fromUuidActor = null;

globalThis.CONST = { DOCUMENT_OWNERSHIP_LEVELS: { OWNER: 2 } };
globalThis.foundry = {
  utils: { duplicate: (value) => structuredClone(value) },
};
globalThis.game = {
  user: { id: "u1" },
  i18n: { localize: (key) => key },
};
globalThis.ui = {
  notifications: { warn: (msg) => notified.push(msg) },
};
globalThis.fromUuid = async () => fromUuidActor;

afterEach(() => {
  notified = [];
  fromUuidActor = null;
  delete globalThis.game.combats;
  globalThis.fromUuid = async () => fromUuidActor;
});

function boxDoc(overrides = {}) {
  return {
    getFlag(scope, key) {
      if (scope !== FLAG_SCOPE) return undefined;
      return overrides[key];
    },
  };
}

function actorDoc({ owner = true, update } = {}) {
  return {
    uuid: "Actor.abc",
    testUserPermission: () => owner,
    system: {
      tracks: {
        phys: { enabled: true, boxes: 2, box_values: [true, false] },
        ment: { enabled: true, boxes: 2, box_values: [false, false] },
      },
    },
    async update(data) {
      if (update) await update(data);
      return this;
    },
  };
}

test("isStressBoxDrawing recognizes only actor stress boxes", () => {
  assert.equal(
    isStressBoxDrawing(boxDoc({ part: "stressBoxRows", actorUuid: "Actor.a", index: 0 })),
    true,
  );
  assert.equal(
    isStressBoxDrawing(boxDoc({ part: "stressBoxRows", actorUuid: "Actor.a", index: 3 })),
    true,
  );
  // other parts are not boxes
  assert.equal(isStressBoxDrawing(boxDoc({ part: "name", actorUuid: "Actor.a", index: 0 })), false);
  // index must be present (>= 0)
  assert.equal(isStressBoxDrawing(boxDoc({ part: "stressBoxRows", actorUuid: "Actor.a", index: -1 })), false);
  assert.equal(isStressBoxDrawing(boxDoc({ part: "stressBoxRows", actorUuid: "Actor.a" })), false);
  // conflict card projections reuse the minimal layout but carry no actorUuid
  assert.equal(isStressBoxDrawing(boxDoc({ part: "stressBoxRows", index: 0 })), false);
  assert.equal(isStressBoxDrawing(boxDoc({ part: "stressBoxRows" })), false);
  assert.equal(isStressBoxDrawing(null), false);
  assert.equal(isStressBoxDrawing({}), false);
});

test("handleStressBoxClick toggles the matching box for the owner", async () => {
  let applied = null;
  fromUuidActor = actorDoc({
    update: (data) => {
      applied = data;
    },
  });
  await handleStressBoxClick(
    boxDoc({ part: "stressBoxRows", actorUuid: "Actor.abc", index: 1 }),
    null,
  );
  assert.ok(applied, "the actor update must be applied");
  assert.equal(applied["system.tracks"].phys.box_values[1], true);
  assert.equal(applied["system.tracks"].phys.box_values[0], true);
  assert.equal(notified.length, 0);
});

test("handleStressBoxClick warns and does not write for a non-owner", async () => {
  let applied = null;
  fromUuidActor = actorDoc({
    owner: false,
    update: (data) => {
      applied = data;
    },
  });
  await handleStressBoxClick(
    boxDoc({ part: "stressBoxRows", actorUuid: "Actor.abc", index: 0 }),
    null,
  );
  assert.equal(applied, null);
  assert.equal(notified.length, 1);
  assert.ok(notified[0].includes("stressBoxes"));
});

test("handleStressBoxClick is a safe no-op for a missing actor", async () => {
  fromUuidActor = null;
  await handleStressBoxClick(
    boxDoc({ part: "stressBoxRows", actorUuid: "Actor.ghost", index: 0 }),
    null,
  );
  assert.equal(notified.length, 0);
});

test("toggleStressBox maps the flat index to the right track and box", async () => {
  let applied = null;
  fromUuidActor = actorDoc({
    update: (data) => {
      applied = data;
    },
  });
  // index 2 -> ment track, box 0
  const ok = await toggleStressBox(fromUuidActor, 2);
  assert.equal(ok, true);
  assert.deepEqual(applied["system.tracks"].ment.box_values, [true, false]);
  // out of range -> no-op
  assert.equal(await toggleStressBox(fromUuidActor, 99), false);
});

/* ------------------------------------------------------------------ *
 * Consequence checkbox parts are NOT interactive (consequences are text)
 * ------------------------------------------------------------------ */

test("consequence checkbox parts are never interactive stress boxes", () => {
  // Consequence checkbox drawings are not toggled by StressBoxes: the only
  // single-click box part is the stress box row. A legacy consequenceBoxRows
  // Drawing (actor widget or conflict card) is NOT recognized and never
  // toggles on a single click — consequences are edited as text cost rows.
  assert.equal(
    isStressBoxDrawing(boxDoc({ part: "consequenceBoxRows", actorUuid: "Actor.a", index: 0 })),
    false,
  );
  assert.equal(
    isStressBoxDrawing(boxDoc({ part: "consequenceBoxRows", index: 0 })),
    false,
  );
  assert.equal(
    isStressBoxDrawing(boxDoc({ part: "consequenceBoxRows", ownerType: "conflictCard", index: 0 })),
    false,
  );
  // The stress box part still toggles.
  assert.equal(
    isStressBoxDrawing(boxDoc({ part: "stressBoxRows", actorUuid: "Actor.a", index: 0 })),
    true,
  );
});

test("handleStressBoxClick is a safe no-op for a consequence checkbox part", async () => {
  // Even if a stale consequenceBoxRows Drawing reaches the handler, it must
  // NOT write to the actor: it is not a toggleable box.
  let applied = null;
  fromUuidActor = {
    uuid: "Actor.conseq",
    testUserPermission: () => true,
    system: {
      tracks: {
        mild: {
          name: "Mild Consequence",
          enabled: true,
          boxes: 0,
          box_values: [true],
          aspect: { when_marked: true, name: "Broken leg" },
        },
      },
    },
    async update(data) {
      applied = data;
      return this;
    },
  };
  await handleStressBoxClick(
    boxDoc({ part: "consequenceBoxRows", actorUuid: "Actor.conseq", index: 0 }),
    null,
  );
  assert.equal(applied, null, "consequence checkbox part must not write to the actor");
  assert.equal(notified.length, 0);
});

/* ------------------------------------------------------------------ *
 * Conflict-card stress boxes (part A)
 * ------------------------------------------------------------------ */

/** A conflict-card stress box document with the identity flags. */
function conflictCardBox(n, overrides = {}) {
  return boxDoc({
    part: "stressBoxRows",
    ownerType: "conflictCard",
    combatId: "combat-abc",
    combatantId: "c1",
    tokenUuid: "Scene.scene1.Token.t1",
    actorUuid: "Actor.abc",
    index: n,
    ...overrides,
  });
}

function installCombat(combat) {
  globalThis.game.combats = { get: () => combat };
  return combat;
}

test("isStressBoxDrawing recognizes a conflict-card stress row (no actorUuid required)", () => {
  assert.equal(
    isStressBoxDrawing(conflictCardBox(0, { actorUuid: undefined })),
    true,
  );
  assert.equal(isStressBoxDrawing(conflictCardBox(3)), true);
  // a conflict card has no single-click consequence box (text cost rows only)
  assert.equal(
    isStressBoxDrawing(
      boxDoc({ part: "consequenceBoxRows", ownerType: "conflictCard", index: 0 }),
    ),
    false,
  );
  // invalid index / wrong part are not boxes
  assert.equal(isStressBoxDrawing(conflictCardBox(-1)), false);
  assert.equal(
    isStressBoxDrawing(boxDoc({ part: "name", ownerType: "conflictCard", index: 0 })),
    false,
  );
});

test("conflict card stress click resolves a LINKED token actor via game.combats and toggles the correct track", async () => {
  let applied = null;
  const actor = actorDoc({
    owner: true,
    update: (data) => {
      applied = data;
    },
  });
  installCombat({
    id: "combat-abc",
    combatants: [
      { id: "c1", token: { actor }, actor },
    ],
  });
  await handleStressBoxClick(conflictCardBox(1), null);
  assert.ok(applied, "the linked actor update must be applied");
  assert.equal(applied["system.tracks"].phys.box_values[1], true);
  assert.equal(notified.length, 0);
});

test("conflict card stress click resolves an UNLINKED synthetic token actor and writes a token delta", async () => {
  let tokenDelta = null;
  const actor = {
    uuid: "Token.scene1.t1.actor.synthetic",
    isToken: true,
    testUserPermission: () => true,
    system: {
      tracks: {
        phys: { enabled: true, boxes: 2, box_values: [false, false] },
        ment: { enabled: true, boxes: 2, box_values: [false, false] },
      },
    },
  };
  const token = {
    id: "t1",
    actor,
    update: (data) => {
      tokenDelta = data;
      return Promise.resolve(token);
    },
  };
  installCombat({
    id: "combat-abc",
    combatants: [{ id: "c1", token, actor }],
  });
  await handleStressBoxClick(conflictCardBox(1), null);
  assert.ok(tokenDelta, "the unlinked token must be updated");
  assert.deepEqual(
    tokenDelta.delta.system.tracks.phys.box_values,
    [false, true],
  );
  assert.equal(notified.length, 0);
});

test("conflict card stress click denies a non-owner (warns, no write)", async () => {
  let applied = null;
  const actor = actorDoc({
    owner: false,
    update: (data) => {
      applied = data;
    },
  });
  installCombat({
    id: "combat-abc",
    combatants: [{ id: "c1", token: { actor }, actor }],
  });
  await handleStressBoxClick(conflictCardBox(0), null);
  assert.equal(applied, null);
  assert.equal(notified.length, 1);
  assert.ok(notified[0].includes("stressBoxes"));
});

test("conflict card stress click is a safe no-op when the combat/combatant is missing", async () => {
  installCombat({ id: "combat-abc", combatants: [] });
  await handleStressBoxClick(conflictCardBox(0), null);
  assert.equal(notified.length, 0);
});

test("conflict card stress click falls back to tokenUuid when game.combats is absent", async () => {
  let applied = null;
  fromUuidActor = actorDoc({
    owner: true,
    update: (data) => {
      applied = data;
    },
  });
  delete globalThis.game.combats;
  // fromUuid resolves the token whose .actor is fromUuidActor
  globalThis.fromUuid = async () => ({ actor: fromUuidActor });
  await handleStressBoxClick(conflictCardBox(0), null);
  assert.ok(applied, "the tokenUuid fallback must resolve the actor");
  // box 0 was initially checked (true) and is toggled off
  assert.equal(applied["system.tracks"].phys.box_values[0], false);
});
