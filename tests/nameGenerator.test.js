import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseWeighted, pickNewName, changeCase } from "../scripts/nameGenerator.js";
import { NAME_GEN_LANGUAGES, resolveLanguage, loadNameGenDict, _clearCacheForTests } from "../scripts/nameGenLanguages.js";

// Provide minimal foundry stubs for settings.js (which imports LayoutImportExport etc.)
globalThis.foundry = {
  applications: { api: { ApplicationV2: class {} }, settings: { menus: { FontConfig: { getAvailableFonts: () => [] } } }, apps: { FilePicker: class {} } },
  utils: { getProperty: () => undefined, hasProperty: () => false, mergeObject: (a,b)=>Object.assign(a,b), duplicate: (v)=>structuredClone(v), setProperty: ()=>{} },
  ...(globalThis.foundry ?? {}),
};
if (!globalThis.CONST) globalThis.CONST = { DOCUMENT_OWNERSHIP_LEVELS: { OWNER: 3 } };
if (!globalThis.CONFIG) globalThis.CONFIG = { fontDefinitions: {} };
globalThis.game = {
  user: { id: "u1", isGM: true },
  i18n: { localize: (k)=>k, format: (k)=>k, has: ()=>false },
  settings: { get: ()=>undefined, settings: new Map(), register: ()=>{}, registerMenu: ()=>{} },
  modules: new Map(),
  packs: [],
  tables: new Map(),
  ...(globalThis.game ?? {}),
};
globalThis.Hooks = { on: ()=>{}, once: ()=>{}, ...(globalThis.Hooks ?? {}) };
globalThis.canvas = { scene: null, ...(globalThis.canvas ?? {}) };
globalThis.ui = { notifications: { warn: ()=>{}, info: ()=>{} }, ...(globalThis.ui ?? {}) };

const { isNameGenEnabled, getNameGenOptions } = await import("../scripts/settings.js");

// Helper to stub Math.random with a fixed sequence
function withRandomSequence(seq, fn) {
  const orig = Math.random;
  let i = 0;
  Math.random = () => {
    const v = seq[i % seq.length];
    i++;
    return v;
  };
  try {
    return fn();
  } finally {
    Math.random = orig;
  }
}

function withRandomValue(val, fn) {
  const orig = Math.random;
  Math.random = () => val;
  try {
    return fn();
  } finally {
    Math.random = orig;
  }
}

test("chooseWeighted: deterministic roulette", () => {
  // weights a:1 b:2 c:7 sum10 cum [1,3,10]
  const w = { a: 1, b: 2, c: 7 };
  // rand = 0.0 *10 =0 => idx 0 => a
  withRandomValue(0.0, () => assert.equal(chooseWeighted(w), "a"));
  // rand 0.09*10=0.9 => idx 0 => a (cum 1 <=0.9? false? actually 1 <=0.9 false =>0)
  withRandomValue(0.09, () => assert.equal(chooseWeighted(w), "a"));
  // rand 0.15*10=1.5 => cum filter <=1.5 includes [1] =>1 => b
  withRandomValue(0.15, () => assert.equal(chooseWeighted(w), "b"));
  // rand 0.35*10=3.5 => cum filter <=3.5 includes [1,3] =>2 => c
  withRandomValue(0.35, () => assert.equal(chooseWeighted(w), "c"));
  // rand 0.99 => c
  withRandomValue(0.99, () => assert.equal(chooseWeighted(w), "c"));
});

test("chooseWeighted: empty weights returns undefined", () => {
  assert.equal(chooseWeighted({}), undefined);
  assert.equal(chooseWeighted(null), undefined);
  assert.equal(chooseWeighted(undefined), undefined);
});

test("chooseWeighted: single entry always chosen", () => {
  withRandomValue(0.0, () => assert.equal(chooseWeighted({ only: 5 }), "only"));
  withRandomValue(0.99, () => assert.equal(chooseWeighted({ only: 5 }), "only"));
});

test("changeCase: maps per from/to strings", () => {
  assert.equal(changeCase("ABC", "ABC", "abc"), "abc");
  assert.equal(changeCase("aBc", "ABC", "abc"), "abc"); // only upper mapped, lower stays (a kept, B->b, c kept)
  assert.equal(changeCase("Hello", "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "hello");
});

test("pickNewName: length within [min,max]", () => {
  // use a tiny deterministic dict to avoid reliance on real files
  const dict = {
    upper: "ABC",
    lower: "abc",
    beg: { "ABC": 1 },
    mid: { A: { B: { C: 1 } }, B: { C: { A: 1, B: 1 } }, C: { A: { B: 1 } } },
    end: { A: { B: { C: 1 } }, B: { C: { A: 1 } }, C: { A: { B: 1 } } },
    all: { A: { B: { C: 1 } }, B: { C: { A: 1, B: 1 } }, C: { A: { B: 1 } } },
  };
  // stub random to deterministic sequence: first for nameLength, then for chooseWeighted
  withRandomSequence([0.0, 0.0, 0.0, 0.0, 0.0], () => {
    const name = pickNewName(dict, { min: 6, max: 6 });
    assert.equal(name.length, 6);
  });
  withRandomSequence([0.5, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0], () => {
    const name = pickNewName(dict, { min: 6, max: 9 });
    assert.ok(name.length >= 6 && name.length <= 9, `length ${name.length} in [6,9]`);
  });
});

test("pickNewName: charset subset and first letter upper", async () => {
  const { lang: en } = await import("../scripts/dict/english.js");
  const allowed = new Set([...en.upper, ...en.lower]);
  // generate with fixed random to get deterministic names but still check charset
  withRandomSequence([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.15], () => {
    for (let i = 0; i < 20; i++) {
      const n = pickNewName(en, { min: 6, max: 9 });
      assert.ok(n.length >= 6 && n.length <= 9, `len ${n.length}`);
      for (const ch of n) {
        assert.ok(allowed.has(ch), `char ${ch} not in allowed`);
      }
      assert.ok(en.upper.includes(n[0]), `first char ${n[0]} should be upper`);
      // remaining chars should be lower (original lowercases rest)
      for (const ch of n.slice(1)) {
        // if language has lower mapping, rest should be lower; english lower is a-z
        assert.ok(en.lower.includes(ch) || en.upper.includes(ch) === false, `rest char ${ch} lower`);
      }
    }
  });
});

test("pickNewName: russian charset and first letter Cyrillic upper", async () => {
  const { lang: ru } = await import("../scripts/dict/russian.js");
  const allowed = new Set([...ru.upper, ...ru.lower]);
  withRandomSequence([0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.1, 0.15, 0.25], () => {
    for (let i = 0; i < 20; i++) {
      const n = pickNewName(ru, { min: 3, max: 7 });
      assert.ok(n.length >= 3 && n.length <= 7);
      for (const ch of n) assert.ok(allowed.has(ch), `ru char ${ch} not allowed`);
      assert.ok(ru.upper.includes(n[0]), `ru first char ${n[0]} upper`);
    }
  });
});

test("pickNewName: deterministic with fixed random sequence", async () => {
  const { lang: en } = await import("../scripts/dict/english.js");
  const seq = [0.42, 0.11, 0.73, 0.05, 0.88, 0.33, 0.67, 0.01, 0.99, 0.5];
  const a = withRandomSequence(seq, () => pickNewName(en, { min: 6, max: 9 }));
  const b = withRandomSequence(seq, () => pickNewName(en, { min: 6, max: 9 }));
  assert.equal(a, b);
});

test("pickNewName: handles triple letter filter (c1===c2)", () => {
  // dict that would otherwise produce triple A: beg "AAB", mid A->A->A weight, etc.
  const dict = {
    upper: "AB",
    lower: "ab",
    beg: { "AAB": 1 },
    mid: { A: { A: { A: 10, B: 1 } }, A: { B: { A: 1 } } },
    end: { A: { A: { A: 10, B: 1 } } },
    all: { A: { A: { A: 10, B: 1 } } },
  };
  // This should not produce "AAAA" triple — filter removes c1 when c1==c2
  withRandomSequence([0.0, 0.0, 0.0, 0.0, 0.0, 0.0], () => {
    const n = pickNewName(dict, { min: 6, max: 6 });
    // ensure no triple same char
    for (let i = 0; i < n.length - 2; i++) {
      const c1 = n[i], c2 = n[i + 1], c3 = n[i + 2];
      // original filters only generation, but we check our implementation prevents generation of triple
      // For this dict, after "AA", the next char should be B not A due to filter
      assert.ok(!(c1.toLowerCase() === c2.toLowerCase() && c2.toLowerCase() === c3.toLowerCase()), `triple found in ${n}`);
    }
  });
});

test("pickNewName: min>max swapped", () => {
  const dict = {
    upper: "ABC",
    lower: "abc",
    beg: { "ABC": 1 },
    mid: { A: { B: { C: 1 } }, B: { C: { A: 1 } }, C: { A: { B: 1 } } },
    end: { B: { C: { A: 1 } } },
    all: { A: { B: { C: 1 } }, B: { C: { A: 1 } }, C: { A: { B: 1 } } },
  };
  withRandomSequence([0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0], () => {
    const n = pickNewName(dict, { min: 9, max: 6 });
    assert.ok(n.length >= 6 && n.length <= 9);
  });
});

// Smoke: real dicts 50 names each
test("smoke: english dict 50 names valid", async () => {
  const { lang: en } = await import("../scripts/dict/english.js");
  const allowed = new Set([...en.upper, ...en.lower]);
  for (let i = 0; i < 50; i++) {
    const n = pickNewName(en, { min: 6, max: 9 });
    assert.ok(n.length >= 6 && n.length <= 9, `en len ${n.length}`);
    for (const ch of n) assert.ok(allowed.has(ch), `en char ${ch}`);
    assert.ok(en.upper.includes(n[0]), `en upper ${n[0]}`);
  }
});

test("smoke: russian dict 50 names valid", async () => {
  const { lang: ru } = await import("../scripts/dict/russian.js");
  const allowed = new Set([...ru.upper, ...ru.lower]);
  for (let i = 0; i < 50; i++) {
    const n = pickNewName(ru, { min: 6, max: 9 });
    assert.ok(n.length >= 6 && n.length <= 9, `ru len ${n.length}`);
    for (const ch of n) assert.ok(allowed.has(ch), `ru char ${ch}`);
    assert.ok(ru.upper.includes(n[0]), `ru upper ${n[0]}`);
  }
});

// Language registry
test("NAME_GEN_LANGUAGES contains english and russian only", () => {
  assert.deepEqual(Object.keys(NAME_GEN_LANGUAGES).sort(), ["english", "russian"]);
});

test("resolveLanguage: random picks one of keys", () => {
  withRandomValue(0.0, () => assert.equal(resolveLanguage("random"), "english"));
  withRandomValue(0.99, () => assert.equal(resolveLanguage("random"), "russian"));
  assert.equal(resolveLanguage("english"), "english");
  assert.equal(resolveLanguage("russian"), "russian");
});

test("resolveLanguage: unknown falls back to random", () => {
  const v = withRandomValue(0.0, () => resolveLanguage("unknown"));
  assert.ok(["english", "russian"].includes(v));
});

// Settings guards (isNameGenEnabled / getNameGenOptions) — pattern similar to isAutoTurnMarkerEnabled
test("isNameGenEnabled: true outside Foundry, true when undefined, false when disabled", () => {
  const origGame = globalThis.game;
  // outside Foundry (no game)
  delete globalThis.game;
  assert.equal(isNameGenEnabled(), true);
  // with game but undefined value -> true
  globalThis.game = { settings: { get: () => undefined } };
  assert.equal(isNameGenEnabled(), true);
  globalThis.game = { settings: { get: (_m, k) => (k === "nameGenEnable" ? false : undefined) } };
  assert.equal(isNameGenEnabled(), false);
  globalThis.game = { settings: { get: (_m, k) => (k === "nameGenEnable" ? true : undefined) } };
  assert.equal(isNameGenEnabled(), true);
  if (origGame !== undefined) globalThis.game = origGame; else delete globalThis.game;
});

test("getNameGenOptions: clamps and swaps min/max", () => {
  const origGame = globalThis.game;
  globalThis.game = {
    settings: {
      get: (_m, k) => {
        if (k === "nameGenMinLength") return 12;
        if (k === "nameGenMaxLength") return 5;
        if (k === "nameGenLanguage") return "english";
        return undefined;
      },
    },
  };
  const opts = getNameGenOptions();
  assert.equal(opts.min, 5);
  assert.equal(opts.max, 12);
  assert.equal(opts.language, "english");

  globalThis.game = {
    settings: {
      get: (_m, k) => {
        if (k === "nameGenMinLength") return 1; // below min clamp 3
        if (k === "nameGenMaxLength") return 100; // above max clamp 15
        return "random";
      },
    },
  };
  const opts2 = getNameGenOptions();
  assert.equal(opts2.min, 3);
  assert.equal(opts2.max, 15);

  if (origGame !== undefined) globalThis.game = origGame; else delete globalThis.game;
});

test("loadNameGenDict: caches and loads both langs", async () => {
  _clearCacheForTests();
  const en = await loadNameGenDict("english");
  assert.ok(en && typeof en.upper === "string");
  const en2 = await loadNameGenDict("english");
  assert.equal(en, en2, "cached same object");
  const ru = await loadNameGenDict("russian");
  assert.ok(ru && typeof ru.lower === "string");
  _clearCacheForTests();
});
