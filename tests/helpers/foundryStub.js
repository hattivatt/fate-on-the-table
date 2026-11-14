function getProperty(object, path) {
  let target = object;
  for (const key of String(path).split(".")) {
    if (target == null) return undefined;
    target = target[key];
  }
  return target;
}

function hasProperty(object, path) {
  let target = object;
  for (const key of String(path).split(".")) {
    if (target == null || !(key in target)) return false;
    target = target[key];
  }
  return true;
}

function setProperty(object, path, value) {
  const parts = String(path).split(".");
  let target = object;
  for (const key of parts.slice(0, -1)) {
    if (typeof target[key] !== "object" || target[key] === null) target[key] = {};
    target = target[key];
  }
  target[parts.at(-1)] = value;
}

function mergeObject(target, source) {
  return Object.assign(target, source);
}

export function createFoundryUtils(overrides = {}) {
  return {
    duplicate: (value) => structuredClone(value),
    getProperty,
    hasProperty,
    setProperty,
    mergeObject,
    ...overrides,
  };
}

export function createConst() {
  return {
    DRAWING_TYPES: { RECTANGLE: "r" },
    DRAWING_FILL_TYPES: { NONE: 0, SOLID: 1, PATTERN: 2 },
  };
}

export function createConfig() {
  return { fontDefinitions: {}, tileMappings: {} };
}

export function installFoundryStub({ foundry = {}, CONST, CONFIG } = {}) {
  const { applications = {}, utils = {}, ...rest } = foundry;
  globalThis.foundry = {
    ...rest,
    applications: {
      ...applications,
      api: {
        ApplicationV2: class {},
        ...(applications.api ?? {}),
      },
    },
    utils: createFoundryUtils(utils),
  };
  globalThis.CONST = CONST ?? createConst();
  globalThis.CONFIG = CONFIG ?? createConfig();
}

export function uninstallFoundryStub() {
  delete globalThis.foundry;
  delete globalThis.CONST;
  delete globalThis.CONFIG;
}
