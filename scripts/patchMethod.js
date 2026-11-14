/**
 * patchMethod — one entry point for every method wrap the module applies to
 * Foundry (or system) classes.
 *
 * With libWrapper (`lib-wrapper`, recommended in module.json) installed the wrap
 * is registered through `libWrapper.register(MODULE_ID, "<path>.<method>", fn,
 * type)`, so it composes with other modules wrapping the same method and
 * conflicts are reported by libWrapper instead of failing silently.
 *
 * Without libWrapper the helper falls back to a direct prototype patch that
 * keeps the libWrapper calling convention: the wrapper is always invoked as
 * `wrapper.call(this, wrapped, ...args)`, where `wrapped(...args)` calls the
 * ORIGINAL method with the same `this` (and returns `undefined` when the target
 * had no such method). The direct patch is idempotent per (target, key).
 *
 * Timing: the module applies most wraps at top level, before `init`, when
 * libWrapper may not be loaded or ready yet (it becomes ready during `init` and
 * fires `libWrapper.Ready`). A wrap requested before `setup` that cannot be
 * registered right away is therefore deferred to `libWrapper.Ready` (preferred)
 * or `setup` (libWrapper absent → direct patch). Both happen long before the
 * canvas is drawn, so no interaction is missed. Wraps requested after `setup`
 * (e.g. the sheet header at `ready`) resolve immediately.
 *
 * Types: "WRAPPER" when the wrapper always calls through to `wrapped`;
 * "MIXED" when it may consume the call and return without calling it.
 *
 * No top-level `foundry` / `game` / `canvas` access beyond guarded `Hooks`
 * look-ups: importable from Node tests.
 */

import { MODULE_ID } from "./constants.js";

/** Property (non-enumerable) holding the set of direct-patch keys on a target. */
const MARKER = Symbol.for(`${MODULE_ID}.wrappedMethods`);

/** libWrapper targets already registered by this module (idempotency). */
const registeredTargets = new Set();

/** Pending wraps requested before the lifecycle allowed a decision. */
let pending = [];
let deferHooksInstalled = false;
let setupPassed = false;

function hooksApi() {
  return typeof Hooks !== "undefined" ? Hooks : globalThis.Hooks;
}

// Track the `setup` phase from import time (module.js imports this before
// `init`), so a late wrap never waits for a hook that already fired.
{
  const hooks = hooksApi();
  if (hooks?.once) hooks.once("setup", () => {
    setupPassed = true;
  });
}

function lifecycleSettled() {
  if (setupPassed) return true;
  const g = typeof game !== "undefined" ? game : globalThis.game;
  return g?.ready === true;
}

/**
 * Resolves a global path such as `foundry.canvas.placeables.Drawing.prototype`
 * or `CONFIG.Actor.sheetClasses.character["fate-core-official.fcoCharacter"].cls`
 * against `globalThis`. Returns `undefined` when any segment is missing.
 * @param {string} path
 * @param {object} [root=globalThis]
 */
export function resolveGlobalPath(path, root = globalThis) {
  if (typeof path !== "string" || !path) return undefined;
  const segments = [];
  const re = /([^.[\]]+)|\[\s*(["'])((?:\\.|(?!\2).)*)\2\s*\]/g;
  let match;
  while ((match = re.exec(path))) {
    segments.push(match[1] ?? match[3].replace(/\\(.)/g, "$1"));
  }
  let value = root;
  for (const key of segments) {
    if (value == null) return undefined;
    value = value[key];
  }
  return value;
}

/** Builds a bracket-safe path segment for an arbitrary object key. */
export function pathKey(key) {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;
}

function directPatch(target, method, key, wrapper) {
  let keys = target[MARKER];
  if (!Object.prototype.hasOwnProperty.call(target, MARKER)) {
    keys = new Set();
    Object.defineProperty(target, MARKER, { value: keys, enumerable: false });
  }
  if (keys.has(key)) return "direct";
  keys.add(key);
  const original = target[method];
  target[method] = function (...args) {
    const wrapped = (...callArgs) =>
      typeof original === "function" ? original.apply(this, callArgs) : undefined;
    return wrapper.call(this, wrapped, ...args);
  };
  return "direct";
}

function tryLibWrapper(request) {
  const lw = globalThis.libWrapper;
  if (!lw?.register) return null;
  const { target, path, method, wrapper, type } = request;
  const fullPath = `${path}.${method}`;
  if (registeredTargets.has(`${fullPath}#${request.key}`)) return "libWrapper";
  // Only use libWrapper when the path reaches the very object we were asked to
  // wrap (e.g. not a CONFIG.*.objectClass subclass).
  if (resolveGlobalPath(path) !== target) return null;
  try {
    lw.register(MODULE_ID, fullPath, wrapper, type);
  } catch (err) {
    request.lastError = err;
    return null;
  }
  registeredTargets.add(`${fullPath}#${request.key}`);
  return "libWrapper";
}

function resolveRequest(request) {
  const viaLib = tryLibWrapper(request);
  if (viaLib) return viaLib;
  if (request.lastError) {
    console.warn(
      `[${MODULE_ID}] libWrapper registration failed for ${request.path}.${request.method}; patching directly:`,
      request.lastError,
    );
  }
  return directPatch(request.target, request.method, request.key, request.wrapper);
}

function flushPending() {
  const queue = pending;
  pending = [];
  for (const request of queue) resolveRequest(request);
}

function installDeferHooks(hooks) {
  if (deferHooksInstalled) return;
  deferHooksInstalled = true;
  hooks.once("libWrapper.Ready", flushPending);
  hooks.once("setup", flushPending);
}

/**
 * Wraps `target[method]` (normally a class prototype).
 *
 * @param {object} target  Object owning (or inheriting) the method.
 * @param {object} spec
 * @param {string} [spec.cls]  Human-readable owner name (diagnostics only).
 * @param {string} spec.path  Global path of `target` for libWrapper, e.g.
 *   `"foundry.canvas.placeables.Drawing.prototype"`.
 * @param {string} spec.method  Method name, e.g. `"_onClickLeft"`.
 * @param {string} [spec.key]  Idempotency key (defaults to `method`).
 * @param {(wrapped: Function, ...args: any[]) => any} wrapper  Called with the
 *   instance as `this`.
 * @param {object} [options]
 * @param {"WRAPPER"|"MIXED"|"OVERRIDE"} [options.type="WRAPPER"]
 * @returns {"libWrapper"|"direct"|"deferred"|null}  How the wrap was applied
 *   (`null` on invalid input).
 */
export function wrapMethod(target, { cls, path, method, key } = {}, wrapper, { type = "WRAPPER" } = {}) {
  if (!target || typeof method !== "string" || typeof wrapper !== "function") {
    return null;
  }
  const request = {
    target,
    cls: cls ?? null,
    path,
    method,
    key: key ?? method,
    wrapper,
    type,
  };
  if (tryLibWrapper(request)) return "libWrapper";
  const hooks = hooksApi();
  if (hooks?.once && !lifecycleSettled()) {
    pending.push(request);
    installDeferHooks(hooks);
    return "deferred";
  }
  return resolveRequest(request);
}

/** Test-only: resets the module-level registration state. */
export function _resetPatchMethodState() {
  registeredTargets.clear();
  pending = [];
  deferHooksInstalled = false;
  setupPassed = false;
}

/** Test-only: resolves every deferred wrap now. */
export function _flushPendingWraps() {
  flushPending();
}
