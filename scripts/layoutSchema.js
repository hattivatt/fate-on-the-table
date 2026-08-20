/**
 * layoutSchema — validation and normalization of layout documents
 * (JSON format "fate-on-the-table.layout", version 1, see LAYOUT-FORMAT.md).
 *
 * This module is the Foundry-side mirror of the standalone layout-editor
 * contract (`layout-editor/src/contract/validateLayout.ts` and
 * `normalizeLayout.ts`): both sides must accept exactly the same documents
 * and normalize them to the same canonical shape, so that exports of one
 * side import cleanly into the other (round-trip). The editor's resolver
 * catalog lives in `layout-editor/src/contract/resolverIds.ts` and is kept
 * in sync with `RESOLVER_MODES` below.
 *
 * The layout document is declarative: elements reference resolver ids from
 * a fixed catalog or runtime settings keys ("@setting.<key>"). No JavaScript
 * can appear inside a layout.
 *
 * This module must stay free of any Foundry runtime dependency (no `game`,
 * `canvas`, `CONFIG`): it is used both by the module at runtime and by the
 * Node test suite.
 */

export const FORMAT = "fate-on-the-table.layout";
export const VERSION = 1;

/** Anchor points usable for `position.anchorPoint` / `position.selfPoint`. */
export const ANCHOR_POINTS = [
  "topLeft",
  "topCenter",
  "topRight",
  "centerLeft",
  "center",
  "centerRight",
  "bottomLeft",
  "bottomCenter",
  "bottomRight",
];

/** Accepted aliases, normalized to the canonical ANCHOR_POINTS names. */
const POINT_ALIASES = {
  leftCenter: "centerLeft",
  rightCenter: "centerRight",
};

export const ELEMENT_TYPES = ["drawing", "tile", "tileRow"];
export const CONTENT_MODES = ["value", "image", "count", "rows", "empty", "boxRow"];
export const TEXT_ALIGNS = ["left", "center", "right"];

/** Same validation limits as the layout-editor (DEFAULT_LIMITS). */
const LIMITS = {
  maxElements: 500,
  maxCanvasDimension: 20000,
  minPitch: 0,
  maxFontSize: 1000,
};

/** Mode the given resolver may be used with (mirror of resolverIds.ts). */
const RESOLVER_MODES = {
  "@name": ["value"],
  "@portrait": ["image"],
  "@empty": ["empty"],
  "@headerAspects": ["value"],
  "@headerFatePoints": ["value"],
  "@headerSkills": ["value"],
  "@headerTracks": ["value"],
  "@headerConsequences": ["value"],
  "@consequencesHeader": ["value"],
  "@consequenceCostRows": ["rows"],
  "@headerStunts": ["value"],
  "@headerExtras": ["value"],
  "@aspects": ["value"],
  "@shortAspects": ["value"],
  "@skillNames": ["rows"],
  "@skillValues": ["rows"],
  "@fatePointTokens": ["count"],
  "@fatePointsValue": ["value"],
  "@stressTrackNames": ["rows"],
  "@stressTrackBoxes": ["rows"],
  "@stressBoxRows": ["boxRow"],
  "@stressTracks": ["rows"],
  "@consequenceNames": ["rows"],
  "@consequences": ["rows"],
  "@stunts": ["rows"],
  "@extras": ["rows"],
  "@description": ["value"],
  "@biography": ["value"],
  "@notes": ["value"],
  "@pronouns": ["value"],
};

/** All resolver ids the validator accepts (and the editor may use). */
export const ALLOWED_RESOLVERS = Object.freeze(Object.keys(RESOLVER_MODES));

/** Settings resolvers require a non-empty key after the "@setting." prefix. */
const SETTING_PREFIX = "@setting.";

function isSettingResolver(resolver) {
  return (
    resolver.startsWith(SETTING_PREFIX) && resolver.length > SETTING_PREFIX.length
  );
}

/**
 * Normalizes an anchor point name to its canonical form.
 * Accepts the documented names and the legacy aliases ("leftCenter",
 * "rightCenter") used by the reference layout.
 * @param {*} value
 * @returns {string|undefined}
 */
export function normalizePoint(value) {
  if (typeof value !== "string") return undefined;
  const canonical = POINT_ALIASES[value];
  if (canonical) return canonical;
  return ANCHOR_POINTS.includes(value) ? value : undefined;
}

/**
 * @param {string} resolver  Resolver id or "@setting.<key>".
 * @param {string} mode      Content mode of the element.
 * @returns {boolean}
 */
export function isResolverAllowed(resolver, mode) {
  if (typeof resolver !== "string" || !resolver) return false;
  if (isSettingResolver(resolver)) return true;
  const modes = RESOLVER_MODES[resolver];
  return !!modes && modes.includes(mode);
}

/** @param {string} resolver */
export function isKnownResolver(resolver) {
  return (
    typeof resolver === "string" &&
    (RESOLVER_MODES[resolver] !== undefined || isSettingResolver(resolver))
  );
}

/**
 * Validates a layout document. When the document is valid, `normalized`
 * mirrors the layout-editor `normalizeLayout()` output: safe defaults are
 * applied and unknown compatible fields are PRESERVED (not dropped), so the
 * module and the editor produce the same canonical document.
 * @param {*} input  Parsed JSON document.
 * @returns {{ok: boolean, errors: Array<{path: string, message: string}>,
 *   warnings: Array<{path: string, message: string}>,
 *   normalized: object|null}}
 */
export function analyzeLayout(input) {
  const errors = [];
  const warnings = [];
  const error = (path, message) => errors.push({ path, message });
  const warn = (path, message) => warnings.push({ path, message });

  if (!isObject(input)) {
    return {
      ok: false,
      errors: [{ path: "$", message: "Layout document must be a JSON object." }],
      warnings: [],
      normalized: null,
    };
  }

  // ---- top level ------------------------------------------------------
  if (input.format !== FORMAT) {
    error("$.format", `Expected "${FORMAT}", got ${JSON.stringify(input.format)}.`);
  }
  if (typeof input.version !== "number" || !Number.isInteger(input.version)) {
    error("$.version", "Expected an integer version.");
  } else if (input.version !== VERSION) {
    error("$.version", `Unsupported version ${input.version}; latest is ${VERSION}.`);
  }
  requireNonEmptyString(input.id, error, "$.id");
  requireNonEmptyString(input.name, error, "$.name");
  if (input.description !== undefined && !isNonEmptyString(input.description)) {
    error("$.description", "Expected a non-empty string.");
  }
  requirePositiveNumber(input.scale, error, "$.scale");
  for (const key of Object.keys(input)) {
    if (!TOP_LEVEL_KEYS.has(key)) warn(`$.${key}`, "Unknown top-level field (kept as-is).");
  }

  // ---- canvas ---------------------------------------------------------
  if (!isObject(input.canvas)) {
    error("$.canvas", "Expected an object.");
  } else {
    const canvas = input.canvas;
    if (!isObject(canvas.origin)) {
      error("$.canvas.origin", "Expected an object.");
    } else {
      requireFiniteNumber(canvas.origin.x, error, "$.canvas.origin.x");
      requireFiniteNumber(canvas.origin.y, error, "$.canvas.origin.y");
    }
    if (!isObject(canvas.size)) {
      error("$.canvas.size", "Expected an object.");
    } else {
      requirePositiveNumber(canvas.size.width, error, "$.canvas.size.width", LIMITS.maxCanvasDimension);
      requirePositiveNumber(canvas.size.height, error, "$.canvas.size.height", LIMITS.maxCanvasDimension);
    }
    if (canvas.sizePolicy !== undefined) {
      if (!isObject(canvas.sizePolicy)) {
        error("$.canvas.sizePolicy", "Expected an object.");
      } else {
        const policy = canvas.sizePolicy;
        if (policy.mode !== undefined && policy.mode !== "fixed" && policy.mode !== "content") {
          error("$.canvas.sizePolicy.mode", 'Expected "fixed" or "content".');
        }
        if (policy.minimum !== undefined) {
          if (!isObject(policy.minimum)) {
            error("$.canvas.sizePolicy.minimum", "Expected an object.");
          } else {
            requirePositiveNumber(policy.minimum.width, error, "$.canvas.sizePolicy.minimum.width", LIMITS.maxCanvasDimension);
            requirePositiveNumber(policy.minimum.height, error, "$.canvas.sizePolicy.minimum.height", LIMITS.maxCanvasDimension);
          }
        }
        if (policy.overflow !== undefined && policy.overflow !== "clip" && policy.overflow !== "expand") {
          error("$.canvas.sizePolicy.overflow", 'Expected "clip" or "expand".');
        }
      }
    }
  }

  // ---- anchor ---------------------------------------------------------
  if (!isObject(input.anchor)) {
    error("$.anchor", "Expected an object.");
  } else {
    const anchor = input.anchor;
    if (typeof anchor.element !== "string") {
      error("$.anchor.element", "Expected a string.");
    } else if (anchor.element === "") {
      warn("$.anchor.element", "Anchor element is not assigned.");
    }
    if (!normalizePoint(anchor.point)) {
      error(
        "$.anchor.point",
        `Expected one of: ${ANCHOR_POINTS.join(", ")}.`,
      );
    }
  }

  // ---- background -----------------------------------------------------
  if (input.background !== undefined) {
    if (!isObject(input.background)) {
      error("$.background", "Expected an object.");
    } else {
      const background = input.background;
      if (background.enabled !== undefined && typeof background.enabled !== "boolean") {
        error("$.background.enabled", "Expected a boolean.");
      }
      if (background.fill !== undefined) {
        if (!isObject(background.fill)) {
          error("$.background.fill", "Expected an object.");
        } else {
          if (typeof background.fill.color !== "string") {
            error("$.background.fill.color", "Expected a string.");
          }
          if (background.fill.alpha !== undefined) {
            requireAlpha(background.fill.alpha, error, "$.background.fill.alpha");
          }
        }
      }
      if (background.texture !== undefined) {
        if (!isObject(background.texture)) {
          error("$.background.texture", "Expected an object.");
        } else {
          requireNonEmptyString(background.texture.source, error, "$.background.texture.source");
          if (
            background.texture.whenEmpty !== undefined &&
            background.texture.whenEmpty !== "fill" &&
            background.texture.whenEmpty !== "none"
          ) {
            error("$.background.texture.whenEmpty", 'Expected "fill" or "none".');
          }
        }
      }
      validateLayer(background.layer, error, "$.background.layer");
    }
  }

  // ---- bounds ---------------------------------------------------------
  if (input.bounds !== undefined) {
    if (!isObject(input.bounds)) {
      error("$.bounds", "Expected an object.");
    } else {
      const bounds = input.bounds;
      if (bounds.enabled !== undefined && typeof bounds.enabled !== "boolean") {
        error("$.bounds.enabled", "Expected a boolean.");
      }
      if (bounds.rect !== undefined && bounds.rect !== "canvas") {
        error("$.bounds.rect", 'Expected "canvas".');
      }
      if (bounds.stroke !== undefined) {
        validateStroke(bounds.stroke, error, "$.bounds.stroke");
      }
      validateLayer(bounds.layer, error, "$.bounds.layer");
    }
  }

  // ---- elements -------------------------------------------------------
  const elementIds = new Set();
  if (!Array.isArray(input.elements)) {
    error("$.elements", "Expected an array.");
  } else {
    if (input.elements.length > LIMITS.maxElements) {
      error("$.elements", `Too many elements (${input.elements.length} > ${LIMITS.maxElements}).`);
    }
    if (input.elements.length === 0) {
      warn("$.elements", "Layout has no elements.");
    }
    input.elements.forEach((element, i) => {
      const p = `$.elements[${i}]`;
      if (!isObject(element)) {
        error(p, "Expected an object.");
        return;
      }
      for (const key of Object.keys(element)) {
        if (!ELEMENT_KEYS.has(key)) warn(`${p}.${key}`, "Unknown element field (kept as-is).");
      }
      if (!isNonEmptyString(element.id)) {
        error(`${p}.id`, "Expected a non-empty string.");
      } else if (elementIds.has(element.id)) {
        error(`${p}.id`, `Duplicate element id "${element.id}".`);
      } else {
        elementIds.add(element.id);
      }
      if (!ELEMENT_TYPES.includes(element.type)) {
        error(`${p}.type`, `Expected one of: ${ELEMENT_TYPES.join(", ")}.`);
      }
      if (!isObject(element.rect)) {
        error(`${p}.rect`, "Expected an object.");
      } else {
        requireFiniteNumber(element.rect.x, error, `${p}.rect.x`);
        requireFiniteNumber(element.rect.y, error, `${p}.rect.y`);
        requireNonNegativeNumber(element.rect.width, error, `${p}.rect.width`);
        requireNonNegativeNumber(element.rect.height, error, `${p}.rect.height`);
      }

      if (!isObject(element.content)) {
        error(`${p}.content`, "Expected an object.");
      } else {
        const { mode, resolver } = element.content;
        if (!CONTENT_MODES.includes(mode)) {
          error(`${p}.content.mode`, `Expected one of: ${CONTENT_MODES.join(", ")}.`);
        }
        if (!isNonEmptyString(resolver)) {
          error(`${p}.content.resolver`, "Expected a non-empty string.");
        } else if (!isKnownResolver(resolver)) {
          error(`${p}.content.resolver`, `Unknown resolver "${resolver}".`);
        } else if (CONTENT_MODES.includes(mode)) {
          if (!isResolverAllowed(resolver, mode)) {
            error(`${p}.content`, `Resolver "${resolver}" does not support mode "${mode}".`);
          }
        }
        if (mode === "count" && element.type !== "tileRow") {
          error(`${p}.content.mode`, 'Mode "count" requires type "tileRow".');
        }
        if (mode === "image" && element.type !== "tile") {
          error(`${p}.content.mode`, 'Mode "image" requires type "tile".');
        }
        if (mode === "boxRow" && element.type !== "drawing") {
          error(`${p}.content.mode`, 'Mode "boxRow" requires type "drawing".');
        }
        if (element.type === "tileRow" && mode !== "count") {
          error(`${p}.type`, 'Type "tileRow" requires content.mode "count".');
        }
        if (element.type === "tile" && mode !== "image") {
          error(`${p}.type`, 'Type "tile" requires content.mode "image".');
        }
        if (
          (mode === "rows" || mode === "boxRow" || element.type === "tileRow") &&
          !isObject(element.repeat)
        ) {
          warn(
            `${p}.repeat`,
            `Expected for ${mode === "rows" || mode === "boxRow" ? "rows" : "tileRow"} elements.`,
          );
        }
      }

      validateStyle(element.style, error, `${p}.style`);
      validatePosition(element.position, error, `${p}.position`);
      validateRepeat(element.repeat, error, `${p}.repeat`);
      validateSizing(element.sizing, error, `${p}.sizing`);
      validateLayer(element.layer, error, `${p}.layer`);
    });

    // Cross-element reference checks (after all ids are known).
    const hasId = (id) => elementIds.has(id);
    if (
      isObject(input.anchor) &&
      isNonEmptyString(input.anchor.element) &&
      !hasId(input.anchor.element)
    ) {
      error("$.anchor.element", `References unknown element "${input.anchor.element}".`);
    }
    input.elements.forEach((element, i) => {
      if (!isObject(element)) return;
      const p = `$.elements[${i}]`;
      if (
        isObject(element.position) &&
        isNonEmptyString(element.position.anchorTo) &&
        !hasId(element.position.anchorTo)
      ) {
        error(`${p}.position.anchorTo`, `References unknown element "${element.position.anchorTo}".`);
      }
      if (
        isObject(element.sizing) &&
        isNonEmptyString(element.sizing.growTo) &&
        !hasId(element.sizing.growTo)
      ) {
        error(`${p}.sizing.growTo`, `References unknown element "${element.sizing.growTo}".`);
      }
    });
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    normalized: errors.length === 0 ? normalizeDocument(input) : null,
  };
}

/* ------------------------------------------------------------------ *
 * Validation helpers
 * ------------------------------------------------------------------ */

const TOP_LEVEL_KEYS = new Set([
  "format",
  "version",
  "id",
  "name",
  "description",
  "anchor",
  "scale",
  "canvas",
  "background",
  "bounds",
  "elements",
]);
const ELEMENT_KEYS = new Set([
  "id",
  "type",
  "rect",
  "content",
  "style",
  "position",
  "repeat",
  "sizing",
  "layer",
]);

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function requireNonEmptyString(value, error, path) {
  if (!isNonEmptyString(value)) error(path, "Expected a non-empty string.");
}

function requireFiniteNumber(value, error, path) {
  if (!isFiniteNumber(value)) error(path, "Expected a finite number.");
}

function requireNonNegativeNumber(value, error, path) {
  if (!isFiniteNumber(value) || value < 0) error(path, "Expected a number >= 0.");
}

function requirePositiveNumber(value, error, path, max) {
  if (!isFiniteNumber(value) || value <= 0) {
    error(path, "Expected a positive number.");
  } else if (max !== undefined && value > max) {
    error(path, `Must be <= ${max}.`);
  }
}

function requireAlpha(value, error, path) {
  if (!isFiniteNumber(value) || value < 0 || value > 1) {
    error(path, "Expected a number in [0, 1].");
  }
}

function validateLayer(layer, error, path) {
  if (layer === undefined) return;
  if (!isObject(layer)) {
    error(path, "Expected an object.");
    return;
  }
  if (layer.elevation !== undefined) requireFiniteNumber(layer.elevation, error, `${path}.elevation`);
  if (layer.sort !== undefined) requireFiniteNumber(layer.sort, error, `${path}.sort`);
}

function validateStyle(style, error, path) {
  if (style === undefined) return;
  if (!isObject(style)) {
    error(path, "Expected an object.");
    return;
  }
  if (style.fontFamily !== undefined && !isNonEmptyString(style.fontFamily)) {
    error(`${path}.fontFamily`, "Expected a non-empty string.");
  }
  if (style.fontSize !== undefined) {
    if (!isFiniteNumber(style.fontSize) || style.fontSize < 0 || style.fontSize > LIMITS.maxFontSize) {
      error(`${path}.fontSize`, `Expected a number in [0, ${LIMITS.maxFontSize}].`);
    }
  }
  if (style.fontWeight !== undefined && !isFiniteNumber(style.fontWeight) && typeof style.fontWeight !== "string") {
    error(`${path}.fontWeight`, "Expected a number or string.");
  }
  if (style.textColor !== undefined && typeof style.textColor !== "string") {
    error(`${path}.textColor`, "Expected a string.");
  }
  if (style.textAlign !== undefined && !TEXT_ALIGNS.includes(style.textAlign)) {
    error(`${path}.textAlign`, `Expected one of: ${TEXT_ALIGNS.join(", ")}.`);
  }
  if (style.fill !== undefined) {
    if (!isObject(style.fill)) {
      error(`${path}.fill`, "Expected an object.");
    } else {
      if (style.fill.type !== undefined && !["none", "solid", "pattern"].includes(style.fill.type)) {
        error(`${path}.fill.type`, 'Expected "none", "solid" or "pattern".');
      }
      if (style.fill.color !== undefined && typeof style.fill.color !== "string") {
        error(`${path}.fill.color`, "Expected a string.");
      }
      if (style.fill.alpha !== undefined) requireAlpha(style.fill.alpha, error, `${path}.fill.alpha`);
    }
  }
  if (style.stroke !== undefined) {
    validateStroke(style.stroke, error, `${path}.stroke`);
  }
}

function validateStroke(stroke, error, path) {
  if (!isObject(stroke)) {
    error(path, "Expected an object.");
    return;
  }
  if (stroke.width !== undefined) requireNonNegativeNumber(stroke.width, error, `${path}.width`);
  if (stroke.color !== undefined && typeof stroke.color !== "string") {
    error(`${path}.color`, "Expected a string.");
  }
  if (stroke.alpha !== undefined) requireAlpha(stroke.alpha, error, `${path}.alpha`);
}

function validatePosition(position, error, path) {
  if (position === undefined) return;
  if (!isObject(position)) {
    error(path, "Expected an object.");
    return;
  }
  requireNonEmptyString(position.anchorTo, error, `${path}.anchorTo`);
  requirePoint(position.anchorPoint, error, `${path}.anchorPoint`);
  requirePoint(position.selfPoint, error, `${path}.selfPoint`);
  if (position.offset !== undefined) {
    if (!isObject(position.offset)) {
      error(`${path}.offset`, "Expected an object.");
    } else {
      requireFiniteNumber(position.offset.x, error, `${path}.offset.x`);
      requireFiniteNumber(position.offset.y, error, `${path}.offset.y`);
    }
  }
}

function requirePoint(value, error, path) {
  if (!normalizePoint(value)) {
    error(path, `Expected one of: ${ANCHOR_POINTS.join(", ")}.`);
  }
}

function validateRepeat(repeat, error, path) {
  if (repeat === undefined) return;
  if (!isObject(repeat)) {
    error(path, "Expected an object.");
    return;
  }
  if (repeat.axis !== "x" && repeat.axis !== "y") {
    error(`${path}.axis`, 'Expected "x" or "y".');
  }
  if (repeat.direction !== undefined && repeat.direction !== "forward" && repeat.direction !== "backward") {
    error(`${path}.direction`, 'Expected "forward" or "backward".');
  }
  if (!isFiniteNumber(repeat.pitch) || repeat.pitch < LIMITS.minPitch) {
    error(`${path}.pitch`, `Expected a number >= ${LIMITS.minPitch}.`);
  }
  if (repeat.itemHeight !== undefined) {
    requirePositiveNumber(repeat.itemHeight, error, `${path}.itemHeight`);
  }
}

function validateSizing(sizing, error, path) {
  if (sizing === undefined) return;
  if (!isObject(sizing)) {
    error(path, "Expected an object.");
    return;
  }
  if (sizing.growTo !== undefined && !isNonEmptyString(sizing.growTo)) {
    error(`${path}.growTo`, "Expected a non-empty string.");
  }
  if (sizing.padding !== undefined) requireNonNegativeNumber(sizing.padding, error, `${path}.padding`);
  if (sizing.minimum !== undefined && typeof sizing.minimum !== "boolean") {
    error(`${path}.minimum`, "Expected a boolean.");
  }
  if (sizing.width !== undefined && sizing.width !== "canvas") {
    error(`${path}.width`, 'Expected "canvas".');
  }
}

/* ------------------------------------------------------------------ *
 * Normalization (mirror of the layout-editor normalizeLayout.ts)
 * ------------------------------------------------------------------ */

/**
 * Produces the canonical document: safe defaults applied, unknown compatible
 * fields preserved. Mirrors the layout-editor `normalizeLayout()`.
 * @param {object} input  Validated document (unknown fields kept).
 * @returns {object}
 */
function normalizeDocument(input) {
  const doc = clone(input);
  if (!doc.canvas) {
    doc.canvas = { origin: { x: 0, y: 0 }, size: { width: 800, height: 1200 } };
  }
  if (!doc.canvas.sizePolicy) {
    doc.canvas.sizePolicy = { mode: "fixed" };
  }
  if (doc.canvas.sizePolicy.mode === "content" && !doc.canvas.sizePolicy.minimum) {
    doc.canvas.sizePolicy.minimum = { ...doc.canvas.size };
  }
  if (doc.anchor) {
    const point = normalizePoint(doc.anchor.point);
    if (point) doc.anchor.point = point;
  }
  if (!Array.isArray(doc.elements)) {
    doc.elements = [];
  }
  doc.elements = doc.elements.map(normalizeElement);
  if (
    doc.anchor &&
    doc.elements.length > 0 &&
    (typeof doc.anchor.element !== "string" ||
      !doc.elements.some((e) => e.id === doc.anchor.element))
  ) {
    doc.anchor.element = doc.elements[0].id;
  }
  return doc;
}

/** @param {object} element */
function normalizeElement(element) {
  const el = clone(element);
  if (!el.rect) el.rect = { x: 0, y: 0, width: 100, height: 40 };
  el.rect = normalizeRect(el.rect);
  if (!el.content) el.content = { resolver: "@name", mode: "value" };
  if (!el.style) el.style = {};
  if (!el.style.fill) el.style.fill = { type: "none", color: "#ffffff", alpha: 0 };
  if (!el.style.stroke) el.style.stroke = { width: 0, color: "#000000", alpha: 0 };
  if (el.position) {
    if (!el.position.offset) el.position.offset = { x: 0, y: 0 };
    const anchorPoint = normalizePoint(el.position.anchorPoint);
    if (anchorPoint) el.position.anchorPoint = anchorPoint;
    else el.position.anchorPoint = "centerLeft";
    const selfPoint = normalizePoint(el.position.selfPoint);
    if (selfPoint) el.position.selfPoint = selfPoint;
    else el.position.selfPoint = "centerLeft";
  }
  if (el.layer === undefined) el.layer = { elevation: 0, sort: 0 };
  if (el.repeat) {
    if (el.repeat.axis === "y" && el.repeat.itemHeight === undefined) {
      el.repeat.itemHeight = el.rect.height;
    }
    if (el.repeat.direction === undefined) {
      el.repeat.direction = "forward";
    }
  }
  if ((el.content.mode === "rows" || el.content.mode === "boxRow" || el.type === "tileRow") && !el.repeat) {
    const axis =
      el.content.mode === "rows" || el.content.mode === "boxRow" ? "y" : "x";
    el.repeat = {
      axis,
      direction: "forward",
      pitch: axis === "y" ? el.rect.height : el.rect.width,
      itemHeight: el.content.mode === "rows" || el.content.mode === "boxRow" ? el.rect.height : undefined,
    };
  }
  return el;
}

/** @param {{x: *, y: *, width: *, height: *}} rect */
function normalizeRect(rect) {
  const r = { ...rect };
  if (!Number.isFinite(r.x)) r.x = 0;
  if (!Number.isFinite(r.y)) r.y = 0;
  if (!Number.isFinite(r.width) || r.width <= 0) r.width = 100;
  if (!Number.isFinite(r.height) || r.height <= 0) r.height = 40;
  return r;
}

/** Deep-clones a plain JSON-ish value (objects/arrays/primitives). */
function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (isObject(value)) {
    const out = {};
    for (const key of Object.keys(value)) out[key] = clone(value[key]);
    return out;
  }
  return value;
}
