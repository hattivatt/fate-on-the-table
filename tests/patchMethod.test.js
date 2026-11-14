/**
 * patchMethod — libWrapper registration vs direct prototype fallback.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  wrapMethod,
  resolveGlobalPath,
  pathKey,
  _resetPatchMethodState,
  _flushPendingWraps,
} from "../scripts/patchMethod.js";
import { MODULE_ID } from "../scripts/constants.js";

function makeClass() {
  class Base {
    constructor(name) {
      this.name = name;
    }
    greet(a, b) {
      return `${this.name}:${a}:${b}`;
    }
  }
  class Child extends Base {}
  return { Base, Child };
}

function withGlobals(globals, fn) {
  const saved = {};
  for (const key of Object.keys(globals)) {
    saved[key] = Object.getOwnPropertyDescriptor(globalThis, key);
    if (globals[key] === undefined) delete globalThis[key];
    else globalThis[key] = globals[key];
  }
  _resetPatchMethodState();
  try {
    return fn();
  } finally {
    for (const [key, desc] of Object.entries(saved)) {
      if (desc) Object.defineProperty(globalThis, key, desc);
      else delete globalThis[key];
    }
    _resetPatchMethodState();
  }
}

function fakeLibWrapper() {
  const calls = [];
  return {
    calls,
    register(moduleId, target, fn, type) {
      calls.push({ moduleId, target, fn, type });
    },
  };
}

test("resolveGlobalPath walks dotted and bracket paths", () => {
  const root = { CONFIG: { Actor: { sheetClasses: { "fate-core-official": { "fco.Sheet": { cls: 42 } } } } } };
  assert.equal(
    resolveGlobalPath('CONFIG.Actor.sheetClasses["fate-core-official"]["fco.Sheet"].cls', root),
    42,
  );
  assert.equal(resolveGlobalPath("CONFIG.Missing.x", root), undefined);
  assert.equal(pathKey("character"), ".character");
  assert.equal(pathKey("fate-core-official.fco"), '["fate-core-official.fco"]');
});

test("without libWrapper: direct patch, wrapped calls the original with this/args", () => {
  withGlobals({ libWrapper: undefined, Hooks: undefined, game: undefined }, () => {
    const { Base, Child } = makeClass();
    const seen = [];
    const result = wrapMethod(
      Base.prototype,
      { cls: "Base", path: "fakeNs.Base.prototype", method: "greet" },
      function (wrapped, ...args) {
        seen.push({ self: this, args });
        return `[${wrapped(...args)}]`;
      },
    );
    assert.equal(result, "direct");
    const obj = new Child("x");
    assert.equal(obj.greet(1, 2), "[x:1:2]");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].self, obj);
    assert.deepEqual(seen[0].args, [1, 2]);
  });
});

test("direct patch is idempotent per target + key", () => {
  withGlobals({ libWrapper: undefined, Hooks: undefined, game: undefined }, () => {
    const { Base } = makeClass();
    let count = 0;
    const wrapper = function (wrapped, ...args) {
      count += 1;
      return wrapped(...args);
    };
    const spec = { path: "fakeNs.Base.prototype", method: "greet" };
    wrapMethod(Base.prototype, spec, wrapper);
    const once = Base.prototype.greet;
    wrapMethod(Base.prototype, spec, wrapper);
    assert.equal(Base.prototype.greet, once);
    new Base("y").greet("a", "b");
    assert.equal(count, 1);
    // A different key on the same method stacks deliberately.
    wrapMethod(Base.prototype, { ...spec, key: "other" }, wrapper);
    assert.notEqual(Base.prototype.greet, once);
  });
});

test("direct patch: MIXED wrapper may skip the original; missing original yields undefined", () => {
  withGlobals({ libWrapper: undefined, Hooks: undefined, game: undefined }, () => {
    const { Base } = makeClass();
    let originalCalled = false;
    Base.prototype.maybe = function () {
      originalCalled = true;
      return "native";
    };
    wrapMethod(
      Base.prototype,
      { path: "x", method: "maybe" },
      function (wrapped, flag) {
        return flag ? "consumed" : wrapped(flag);
      },
      { type: "MIXED" },
    );
    const obj = new Base("z");
    assert.equal(obj.maybe(true), "consumed");
    assert.equal(originalCalled, false);
    assert.equal(obj.maybe(false), "native");
    assert.equal(originalCalled, true);

    wrapMethod(Base.prototype, { path: "x", method: "absent" }, function (wrapped) {
      return wrapped() ?? "fallback";
    });
    assert.equal(obj.absent(), "fallback");
  });
});

test("with libWrapper: registers MODULE_ID + full path + type, prototype untouched", () => {
  const { Base } = makeClass();
  const lw = fakeLibWrapper();
  withGlobals({ libWrapper: lw, fakeNs: { Base }, Hooks: undefined }, () => {
    const original = Base.prototype.greet;
    const wrapper = function (wrapped, ...args) {
      return wrapped(...args);
    };
    const result = wrapMethod(
      Base.prototype,
      { cls: "Base", path: "fakeNs.Base.prototype", method: "greet" },
      wrapper,
      { type: "MIXED" },
    );
    assert.equal(result, "libWrapper");
    assert.equal(Base.prototype.greet, original);
    assert.equal(lw.calls.length, 1);
    assert.deepEqual(
      { ...lw.calls[0], fn: undefined },
      { moduleId: MODULE_ID, target: "fakeNs.Base.prototype.greet", fn: undefined, type: "MIXED" },
    );
    assert.equal(lw.calls[0].fn, wrapper);
    // Idempotent: a second request does not register again.
    wrapMethod(Base.prototype, { path: "fakeNs.Base.prototype", method: "greet" }, wrapper);
    assert.equal(lw.calls.length, 1);
  });
});

test("with libWrapper: defaults to WRAPPER type", () => {
  const { Base } = makeClass();
  const lw = fakeLibWrapper();
  withGlobals({ libWrapper: lw, fakeNs: { Base }, Hooks: undefined }, () => {
    wrapMethod(Base.prototype, { path: "fakeNs.Base.prototype", method: "greet" }, (w, ...a) => w(...a));
    assert.equal(lw.calls[0].type, "WRAPPER");
  });
});

test("with libWrapper but path resolving elsewhere: falls back to the direct patch", () => {
  const { Base, Child } = makeClass();
  const lw = fakeLibWrapper();
  // The path names the subclass prototype, but the target is the base one.
  withGlobals({ libWrapper: lw, fakeNs: { Base: Child }, Hooks: undefined, game: undefined }, () => {
    const result = wrapMethod(
      Base.prototype,
      { path: "fakeNs.Base.prototype", method: "greet" },
      function (wrapped, ...args) {
        return `!${wrapped(...args)}`;
      },
    );
    assert.equal(result, "direct");
    assert.equal(lw.calls.length, 0);
    assert.equal(new Base("b").greet(1, 2), "!b:1:2");
  });
});

test("with libWrapper whose register throws: falls back to the direct patch", () => {
  const { Base } = makeClass();
  const lw = {
    register() {
      throw new Error("not ready");
    },
  };
  const warn = console.warn;
  console.warn = () => {};
  try {
    withGlobals({ libWrapper: lw, fakeNs: { Base }, Hooks: undefined, game: undefined }, () => {
      const result = wrapMethod(
        Base.prototype,
        { path: "fakeNs.Base.prototype", method: "greet" },
        function (wrapped, ...args) {
          return wrapped(...args).toUpperCase();
        },
      );
      assert.equal(result, "direct");
      assert.equal(new Base("q").greet("a", "b"), "Q:A:B");
    });
  } finally {
    console.warn = warn;
  }
});

test("before setup without a ready libWrapper: deferred, then resolved via libWrapper.Ready", () => {
  const { Base } = makeClass();
  const handlers = {};
  const Hooks = {
    once(name, fn) {
      (handlers[name] ??= []).push(fn);
    },
  };
  withGlobals({ libWrapper: undefined, fakeNs: { Base }, Hooks, game: { ready: false } }, () => {
    const original = Base.prototype.greet;
    const wrapper = function (wrapped, ...args) {
      return wrapped(...args);
    };
    const result = wrapMethod(
      Base.prototype,
      { path: "fakeNs.Base.prototype", method: "greet" },
      wrapper,
      { type: "MIXED" },
    );
    assert.equal(result, "deferred");
    assert.equal(Base.prototype.greet, original);
    assert.ok(handlers["libWrapper.Ready"]?.length);
    assert.ok(handlers.setup?.length);
    // libWrapper becomes ready during init.
    const lw = fakeLibWrapper();
    globalThis.libWrapper = lw;
    for (const fn of handlers["libWrapper.Ready"]) fn(lw);
    assert.equal(lw.calls.length, 1);
    assert.equal(lw.calls[0].target, "fakeNs.Base.prototype.greet");
    assert.equal(lw.calls[0].type, "MIXED");
    // `setup` afterwards is a no-op for the already resolved wrap.
    for (const fn of handlers.setup) fn();
    assert.equal(lw.calls.length, 1);
    assert.equal(Base.prototype.greet, original);
  });
});

test("before setup without libWrapper installed: deferred, then direct patch at setup", () => {
  const { Base } = makeClass();
  const handlers = {};
  const Hooks = {
    once(name, fn) {
      (handlers[name] ??= []).push(fn);
    },
  };
  withGlobals({ libWrapper: undefined, Hooks, game: { ready: false } }, () => {
    const result = wrapMethod(
      Base.prototype,
      { path: "fakeNs.Base.prototype", method: "greet" },
      function (wrapped, ...args) {
        return `<${wrapped(...args)}>`;
      },
    );
    assert.equal(result, "deferred");
    assert.equal(new Base("d").greet(1, 2), "d:1:2");
    for (const fn of handlers.setup) fn();
    assert.equal(new Base("d").greet(1, 2), "<d:1:2>");
    // Flushing again never double-wraps.
    _flushPendingWraps();
    assert.equal(new Base("d").greet(1, 2), "<d:1:2>");
  });
});

test("after game.ready: resolves immediately (no deferral)", () => {
  const { Base } = makeClass();
  const Hooks = { once() {} };
  withGlobals({ libWrapper: undefined, Hooks, game: { ready: true } }, () => {
    const result = wrapMethod(
      Base.prototype,
      { path: "fakeNs.Base.prototype", method: "greet" },
      (wrapped, ...args) => wrapped(...args),
    );
    assert.equal(result, "direct");
  });
});
