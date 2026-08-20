/**
 * Node regression tests for conflictUi.js — the pure DOM helpers behind the
 * "Place conflict board" entry points in the standard Foundry Combat Tracker
 * and the Fate Core system's Fate Utilities app.
 *
 * No Foundry runtime is needed: the helpers only use browser DOM APIs, so this
 * suite runs against a minimal in-memory DOM stub (element tree + the small
 * selector subset used by the helpers: tag, `#id`, `.class`, `[data-*]`).
 *
 * Guards the exact placement contract from the integration tasks:
 *   1. the Combat Tracker button is a STANDALONE row directly ABOVE
 *      `.combat-controls` — it is never appended inside that flex row;
 *   2. the Fate Utilities button is icon-only (no text) and lands EXACTLY
 *      between `#fco_timed_event` and `#fco_next_conflict`;
 *   3. re-rendering the same DOM does NOT duplicate the button
 *      (`[data-ctt-conflict-place]` duplicate guard);
 *   4. clicking the button calls the shared `placeBoard` entry point exactly
 *      once and keeps the button disabled while a placement is in flight.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createCombatTrackerPlaceButton,
  createFateUtilsPlaceButton,
  insertCombatTrackerBoardPlacement,
  insertFateUtilsBoardPlacement,
  attachPlaceBoardClick,
  hasConflictPlaceButton,
} from "../scripts/conflictUi.js";

/* ------------------------------------------------------------------ *
 * Minimal in-memory DOM (element tree + tiny selector subset)
 * ------------------------------------------------------------------ */

function matchesSelector(el, selector) {
  const re = /(\w[\w-]*)|\.([\w-]+)|#([\w-]+)|\[([\w-]+)(?:="?([\w-]*)"?)?\]/g;
  let tag = null;
  const classes = [];
  const ids = [];
  const attrs = [];
  let m;
  while ((m = re.exec(selector)) !== null) {
    if (m[1] !== undefined) tag = m[1];
    else if (m[2] !== undefined) classes.push(m[2]);
    else if (m[3] !== undefined) ids.push(m[3]);
    else if (m[4] !== undefined) attrs.push([m[4], m[5]]);
  }
  if (tag && el.tagName.toLowerCase() !== tag.toLowerCase()) return false;
  for (const c of classes) {
    if (!(el.className || "").split(/\s+/).includes(c)) return false;
  }
  for (const id of ids) {
    if (el.id !== id) return false;
  }
  for (const [attr, expected] of attrs) {
    const key = attr.replace(/^data-/, "").replace(/-([a-z])/g, (_, c) =>
      c.toUpperCase(),
    );
    const value = el.dataset[key];
    if (expected !== undefined) {
      if (value !== expected) return false;
    } else if (value === undefined) {
      return false;
    }
  }
  return true;
}

function walk(el, visit) {
  visit(el);
  for (const child of el.children) walk(child, visit);
}

class FakeElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.dataset = {};
    this.style = {};
    this.listeners = {};
    this.className = "";
    this.id = "";
    this.innerHTML = "";
    this.title = "";
    this.href = "";
    this.type = "";
    this.disabled = false;
  }

  append(...nodes) {
    for (const node of nodes) {
      node.parentNode?._removeChildNode(node);
      this.children.push(node);
      node.parentNode = this;
    }
  }

  appendChild(node) {
    this.append(node);
    return node;
  }

  _removeChildNode(node) {
    const i = this.children.indexOf(node);
    if (i >= 0) {
      this.children.splice(i, 1);
      node.parentNode = null;
    }
  }

  insertBefore(node, ref) {
    node.parentNode?._removeChildNode(node);
    if (ref === null || ref === undefined) {
      this.children.push(node);
    } else {
      const i = this.children.indexOf(ref);
      if (i === -1) this.children.push(node);
      else this.children.splice(i, 0, node);
    }
    node.parentNode = this;
    return node;
  }

  remove() {
    this.parentNode?._removeChildNode(this);
  }

  querySelector(selector) {
    let found = null;
    walk(this, (el) => {
      if (el !== this && el.tagName && matchesSelector(el, selector)) found ??= el;
    });
    return found;
  }

  querySelectorAll(selector) {
    const out = [];
    walk(this, (el) => {
      if (el !== this && el.tagName && matchesSelector(el, selector)) {
        out.push(el);
      }
    });
    return out;
  }

  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn);
  }

  removeEventListener(type, fn) {
    this.listeners[type] = (this.listeners[type] ?? []).filter((f) => f !== fn);
  }

  click() {
    // Mirror real DOM semantics: a disabled <button> swallows clicks, a
    // disabled <a> (expando property only) still fires.
    if (this.disabled && this.tagName === "BUTTON") return;
    const event = { preventDefault() {}, stopPropagation() {} };
    for (const fn of this.listeners.click ?? []) fn(event);
  }

  get nextElementSibling() {
    if (!this.parentNode) return null;
    const i = this.parentNode.children.indexOf(this);
    return i >= 0 ? (this.parentNode.children[i + 1] ?? null) : null;
  }

  get previousElementSibling() {
    if (!this.parentNode) return null;
    const i = this.parentNode.children.indexOf(this);
    return i > 0 ? this.parentNode.children[i - 1] ?? null : null;
  }

  get textContent() {
    return String(this.innerHTML ?? "").replace(/<[^>]*>/g, "");
  }

  get classList() {
    const read = () => (this.className || "").split(/\s+/).filter(Boolean);
    const write = (list) => (this.className = list.join(" "));
    return {
      add: (...names) => {
        const list = read();
        for (const n of names) if (!list.includes(n)) list.push(n);
        write(list);
      },
      remove: (...names) => write(read().filter((c) => !names.includes(c))),
      contains: (name) => read().includes(name),
      toggle: (name, force) => {
        const has = read().includes(name);
        const want = force ?? !has;
        if (want && !has) {
          const list = read();
          list.push(name);
          write(list);
        } else if (!want && has) {
          write(read().filter((c) => c !== name));
        }
      },
    };
  }
}

class FakeDocument {
  createElement(tag) {
    return new FakeElement(tag);
  }
}

// The helpers create DOM elements via the browser `document` global.
globalThis.document = new FakeDocument();

/** Maps every element under `root` to its document-order index. */
function documentOrder(root) {
  const order = new Map();
  let i = 0;
  walk(root, (el) => order.set(el, i++));
  return order;
}

/* ------------------------------------------------------------------ *
 * Helpers building the real DOM shapes the hooks target
 * ------------------------------------------------------------------ */

/** Foundry v12+ combat tracker: list + footer nav with the controls row. */
function buildCombatTrackerDom(doc) {
  const root = doc.createElement("section");
  root.className = "sidebar-tab directory flexcol combat-sidebar";
  const list = doc.createElement("ol");
  list.className = "directory-list combat-tracker";
  list.id = "combat-tracker";
  const nav = doc.createElement("nav");
  nav.className = "encounters";
  nav.id = "combat-round";
  const controls = doc.createElement("div");
  controls.className = "combat-controls";
  for (const control of ["previousTurn", "nextTurn", "endCombat"]) {
    const a = doc.createElement("a");
    a.className = "combat-control";
    a.dataset.control = control;
    controls.append(a);
  }
  nav.append(controls);
  root.append(list, nav);
  return { root, list, nav, controls };
}

/** Fate Core official FateUtilities GM conflict pane (real template shape). */
function buildFateUtilsConflictPane(doc) {
  const root = doc.createElement("section");
  root.className = "window-content";
  const table = doc.createElement("table");
  const row = doc.createElement("tr");
  // Cell 1 (left): flex row with next-exchange + timed event.
  const td1 = doc.createElement("td");
  const flex1 = doc.createElement("div");
  flex1.style.cssText = "display:flex; flex-direction:row; gap:5px";
  const nextExchange = doc.createElement("button");
  nextExchange.id = "fco_next_exchange";
  nextExchange.classList?.add?.("fu_button");
  const timedEvent = doc.createElement("button");
  timedEvent.id = "fco_timed_event";
  timedEvent.classList?.add?.("fu_button");
  flex1.append(nextExchange, timedEvent);
  td1.append(flex1);
  // Cell 2 (right): flex row with next conflict + add + end.
  const td2 = doc.createElement("td");
  const flex2 = doc.createElement("div");
  flex2.style.cssText = "display:flex; flex-direction:row; gap:5px";
  const nextConflict = doc.createElement("button");
  nextConflict.id = "fco_next_conflict";
  nextConflict.classList?.add?.("fu_button");
  const addConflict = doc.createElement("button");
  addConflict.id = "fco_add_conflict";
  addConflict.classList?.add?.("fu_button");
  const endConflict = doc.createElement("button");
  endConflict.id = "fco_end_conflict";
  endConflict.classList?.add?.("fu_button");
  flex2.append(nextConflict, addConflict, endConflict);
  td2.append(flex2);
  row.append(td1, td2);
  table.append(row);
  root.append(table);
  return { root, row, td1, td2, flex1, flex2, nextExchange, timedEvent, nextConflict, addConflict, endConflict };
}

/* ------------------------------------------------------------------ *
 * Combat Tracker placement
 * ------------------------------------------------------------------ */

test("combat tracker button is NOT inside the controls row and sits right before it", () => {
  const doc = new FakeDocument();
  const { root, nav, controls } = buildCombatTrackerDom(doc);

  const button = createCombatTrackerPlaceButton("Place on the table");
  assert.equal(insertCombatTrackerBoardPlacement(root, button), true);

  // State before placement: nav.children = [controls].
  // After: nav.children = [button, controls] — button directly above the row.
  assert.equal(button.parentNode, nav);
  assert.ok(!controls.children.includes(button), "must not join the flex row");
  assert.equal(controls.previousElementSibling, button);
  assert.equal(nav.children.indexOf(button), nav.children.indexOf(controls) - 1);

  // The control keeps its marker, icon and label.
  assert.equal(button.dataset.cttConflictPlace, "");
  assert.equal(button.href, "#");
  assert.equal(button.title, "Place on the table");
  assert.ok(button.innerHTML.includes("fa-th-large"));
});

test("combat tracker button falls back above header.encounters when controls are absent", () => {
  const doc = new FakeDocument();
  const root = doc.createElement("section");
  root.className = "combat-sidebar";
  const header = doc.createElement("header");
  header.className = "encounters";
  root.append(header);

  const button = createCombatTrackerPlaceButton("Place on the table");
  assert.equal(insertCombatTrackerBoardPlacement(root, button), true);
  assert.equal(header.previousElementSibling, button);
  assert.equal(button.parentNode, root);
});

test("combat tracker button appends to the tracker root when no anchor exists", () => {
  const doc = new FakeDocument();
  const root = doc.createElement("section");
  root.className = "combat-sidebar";

  const button = createCombatTrackerPlaceButton("Place on the table");
  assert.equal(insertCombatTrackerBoardPlacement(root, button), true);
  assert.equal(button.parentNode, root);
  assert.ok(root.children.includes(button));
});

test("combat tracker re-render does not duplicate the button", () => {
  const doc = new FakeDocument();
  const { root, nav } = buildCombatTrackerDom(doc);

  const first = createCombatTrackerPlaceButton("Place on the table");
  assert.equal(insertCombatTrackerBoardPlacement(root, first), true);
  assert.ok(hasConflictPlaceButton(root));

  // Second pass of the same hook (same DOM root) must not insert again.
  const second = createCombatTrackerPlaceButton("Place on the table");
  assert.equal(insertCombatTrackerBoardPlacement(root, second), false);
  assert.equal(nav.children.length, 2);
  assert.ok(!nav.children.includes(second));
  assert.equal(nav.children[0], first);
});

/* ------------------------------------------------------------------ *
 * Fate Utilities placement
 * ------------------------------------------------------------------ */

test("fate utilities button is icon-only and lands between timed event and cycle target", () => {
  const doc = new FakeDocument();
  const { root, flex1, flex2, nextExchange, timedEvent, nextConflict, addConflict } =
    buildFateUtilsConflictPane(doc);

  const button = createFateUtilsPlaceButton("Place conflict board");
  assert.equal(insertFateUtilsBoardPlacement(root, button), true);

  // Icon-only: no text inside, only the fa-th-large icon.
  assert.match(button.innerHTML, /^<i class="fas fa-th-large"><\/i>$/);
  assert.equal(button.textContent, "");
  assert.ok(button.classList.contains("fu_button"), "uses the fu_button style");
  assert.equal(button.title, "Place conflict board");

  // After the timed event, inside the timed event's own flex row.
  assert.equal(button.parentNode, flex1);
  assert.equal(timedEvent.nextElementSibling, button);

  // Document order: next-exchange < timed-event < place < next-conflict.
  const order = documentOrder(root);
  assert.ok(order.get(nextExchange) < order.get(timedEvent));
  assert.ok(order.get(timedEvent) < order.get(button));
  assert.ok(order.get(button) < order.get(nextConflict));
  // The neighbouring cell (add conflict / end conflict) is untouched.
  assert.equal(flex2.children[0], nextConflict);
  assert.ok(flex2.children.includes(addConflict));
});

test("fate utilities falls back to before #fco_next_conflict when timed event is missing", () => {
  const doc = new FakeDocument();
  const root = doc.createElement("section");
  const nextConflict = doc.createElement("button");
  nextConflict.id = "fco_next_conflict";
  const addConflict = doc.createElement("button");
  addConflict.id = "fco_add_conflict";
  root.append(nextConflict, addConflict);

  const button = createFateUtilsPlaceButton("Place conflict board");
  assert.equal(insertFateUtilsBoardPlacement(root, button), true);
  assert.equal(nextConflict.previousElementSibling, button);
});

test("fate utilities re-render does not duplicate the button", () => {
  const doc = new FakeDocument();
  const { root, flex1 } = buildFateUtilsConflictPane(doc);

  const first = createFateUtilsPlaceButton("Place conflict board");
  assert.equal(insertFateUtilsBoardPlacement(root, first), true);
  assert.ok(hasConflictPlaceButton(root));

  const second = createFateUtilsPlaceButton("Place conflict board");
  assert.equal(insertFateUtilsBoardPlacement(root, second), false);
  assert.equal(flex1.children.length, 3);
  assert.ok(!flex1.children.includes(second));
  assert.equal(flex1.children[2], first);
});

/* ------------------------------------------------------------------ *
 * Click wiring -> single placeBoard entry point
 * ------------------------------------------------------------------ */

test("clicking the wired button calls placeBoard exactly once", async () => {
  const doc = new FakeDocument();
  const button = doc.createElement("button");
  let calls = 0;
  attachPlaceBoardClick(button, async () => {
    calls += 1;
  });

  button.click();
  button.click(); // second click during the async flight is harmless
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(calls, 1);
});

test("the button is disabled while a placement is in flight and re-enabled after", async () => {
  const doc = new FakeDocument();
  const button = doc.createElement("button");

  let release;
  const gate = new Promise((r) => (release = r));
  let calls = 0;
  attachPlaceBoardClick(button, async () => {
    await gate;
    calls += 1;
  });

  button.click();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(button.disabled, true, "disabled while placeBoard runs");

  release();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(calls, 1);
  assert.equal(button.disabled, false, "re-enabled after placeBoard settles");
});

test("a throwing placeBoard is swallowed and the button is restored", async () => {
  const doc = new FakeDocument();
  const button = doc.createElement("button");
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args);
  try {
    attachPlaceBoardClick(button, async () => {
      throw new Error("boom");
    });
    button.click();
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(errors.length >= 1, "error logged");
    assert.equal(button.disabled, false);
  } finally {
    console.error = originalError;
  }
});

test("the same placeBoard entry point is used by both buttons", async () => {
  const combatButton = createCombatTrackerPlaceButton("Place on the table");
  const fateButton = createFateUtilsPlaceButton("Place conflict board");

  const calls = [];
  attachPlaceBoardClick(combatButton, () => calls.push("combat"));
  attachPlaceBoardClick(fateButton, () => calls.push("fate"));

  combatButton.click();
  fateButton.click();
  combatButton.click();
  // The handler dispatches through Promise.resolve().then(...), so flush the
  // microtask queue before asserting.
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(calls, ["combat", "fate", "combat"]);
});