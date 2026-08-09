/**
 * PlacementManager — interactive "place on table" mode.
 *
 * Shows a preview rectangle that follows the mouse; left-click commits the
 * widget documents onto the scene, right-click or Esc cancels.
 *
 * The flow is generic: `placeGroup` accepts an arbitrary set of documents
 * and a commit callback, so both actor widgets and the GM fate point row
 * share the same interaction. `place(actor)` stays as a convenience wrapper
 * for the actor widget behaviour.
 */

import { build, toDocumentData } from "./WidgetBuilder.js";
import { getLayout } from "./layoutRegistry.js";
import {
  getPlacementOptions,
  selectLayoutIdForActor,
} from "./settings.js";
import { MODULE_ID, FLAG_SCOPE, WIDGETS_FLAG } from "./constants.js";
import { allWidgetDocs } from "./widgetDocs.js";

export class PlacementManager {
  static active = null;

  /**
   * Starts the placement flow for an actor (convenience wrapper).
   * The layout is chosen by the actor role settings (playerLayout/npcLayout).
   * @param {object} actor
   */
  static async place(actor) {
    const opts = getPlacementOptions();
    const layoutId = selectLayoutIdForActor(actor);
    const layout = getLayout(layoutId);
    if (!layout) {
      ui.notifications.error(
        game.i18n.localize(`${MODULE_ID}.layouts.notFound`),
      );
      return;
    }
    const { docs, bounds } = await build(actor, layout, {
      scale: opts.scale,
      fontFamily: opts.fontFamily,
      textColor: opts.textColor,
      fatePointImage: opts.fatePointImage,
      fatePointTileWidth: opts.fatePointTileWidth,
      fatePointTileHeight: opts.fatePointTileHeight,
      fatePointStep: opts.fatePointStep,
      backgroundTexture: opts.backgroundTexture,
    });

    await PlacementManager.placeGroup({
      docs,
      bounds,
      label: actor.name,
      options: opts,
      hintKey: `${MODULE_ID}.placeOnTable.hint`,
      commit: async (anchor, widgetId) => {
        await commitActorWidget(
          actor,
          docs,
          anchor,
          widgetId,
          layoutId,
          layout.version,
        );
      },
    });
  }

  /**
   * Generic placement flow for an arbitrary document group.
   * @param {object} cfg  {
   *   docs: object[],          WidgetBuilder descriptors (relative coords).
   *   bounds: {x, y, width, height},
   *   label: string,           Preview label.
   *   options: object,         Placement options (snapToGrid etc).
   *   hintKey: string,         i18n hint notification key.
   *   successKey: string,      i18n key shown after a successful commit.
   *   commit: (anchor, widgetId) => Promise,  Creates docs + registers.
   * }
   */
  static async placeGroup({
    docs,
    bounds,
    label,
    options,
    hintKey,
    successKey,
    commit,
  }) {
    if (this.active) {
      ui.notifications.warn(game.i18n.localize(`${MODULE_ID}.placement.busy`));
      return;
    }
    if (!canvas || !canvas.ready || !canvas.scene) {
      ui.notifications.warn(game.i18n.localize(`${MODULE_ID}.placement.noScene`));
      return;
    }
    // Widgets consist of drawings AND tiles; only the GM and Assistant GM
    // roles can create tiles on the scene, so placement is GM-only.
    if (!game.user.isGM) {
      ui.notifications.error(
        game.i18n.localize(`${MODULE_ID}.placement.noPermission`),
      );
      return;
    }

    const manager = new PlacementManager(
      { docs, bounds, label, options, hintKey, commit },
      canvas.scene,
    );
    this.active = manager;
    try {
      const point = await manager.run();
      if (!point) {
        ui.notifications.info(
          game.i18n.localize(`${MODULE_ID}.placement.cancelled`),
        );
        return;
      }
      await manager.commit(point);
    } finally {
      this.active = null;
    }
  }

  /**
   * @param {object} cfg  See placeGroup.
   * @param {object} scene  Target scene (created into).
   */
  constructor(cfg, scene) {
    this.docs = cfg.docs;
    this.bounds = cfg.bounds;
    this.label = cfg.label;
    this.opts = cfg.options;
    this.hintKey = cfg.hintKey;
    this.successKey = cfg.successKey ?? `${MODULE_ID}.placement.success`;
    this._commit = cfg.commit;
    this.scene = scene;
    this.widgetId = foundry.utils.randomID();
    this._resolve = null;
    this._graphics = null;
    this._label = null;
    this._last = null;
    this._onCanvasReady = () => this.cancel();
  }

  /** Runs the interactive placement loop. Resolves with {x, y} or null. */
  run() {
    ui.notifications.info(game.i18n.localize(this.hintKey));
    this._setup();
    return new Promise((resolve) => {
      this._resolve = resolve;
    });
  }

  _setup() {
    const g = new PIXI.Graphics();
    g.eventMode = "static";
    g.hitArea = canvas.dimensions.rect;
    g.cursor = "crosshair";
    canvas.controls.addChild(g);
    this._graphics = g;

    try {
      const label = new PIXI.Text(this.label, {
        fontFamily: "Montserrat",
        fontSize: 18,
        fill: 0x22ff22,
      });
      label.visible = false;
      canvas.controls.addChild(label);
      this._label = label;
    } catch (err) {
      console.warn("[chars-to-table] label creation failed:", err);
      this._label = null;
    }

    // Use DOM listeners on the canvas element: they always fire, unlike PIXI
    // events which Foundry's canvas may intercept for pointerdown.
    this._onMoveBound = this._onMove.bind(this);
    this._onDownBound = this._onDown.bind(this);
    this._view = canvas.app.view;
    this._view.addEventListener("pointermove", this._onMoveBound);
    this._view.addEventListener("pointerdown", this._onDownBound);
    window.addEventListener("keydown", this._onKey);
    Hooks.on("canvasReady", this._onCanvasReady);
  }

  _worldPosition(event) {
    try {
      if (event?.getLocalPosition) {
        return event.getLocalPosition(canvas.controls);
      }
    } catch (err) {
      /* fall through */
    }
    try {
      const view = canvas.app.view;
      const rect = view.getBoundingClientRect();
      const x = (event.clientX - rect.left) * (view.width / rect.width);
      const y = (event.clientY - rect.top) * (view.height / rect.height);
      const world = canvas.stage.worldTransform.applyInverse(
        new PIXI.Point(x, y),
      );
      return { x: world.x, y: world.y };
    } catch (err) {
      console.warn("[chars-to-table] position resolve failed:", err);
      return { x: 0, y: 0 };
    }
  }

  _onMove(event) {
    const p = this._worldPosition(event);
    if (this._last && p.x === this._last.x && p.y === this._last.y) return;
    this._last = { x: p.x, y: p.y };
    try {
      this._draw(this._last);
    } catch (err) {
      if (!this._drawErrorLogged) {
        this._drawErrorLogged = true;
        console.warn("[chars-to-table] preview draw failed:", err);
      }
    }
  }

  _draw(p) {
    const g = this._graphics;
    const { x: bx, y: by, width, height } = this.bounds;
    g.clear();
    g.beginFill(0x22ff22, 0.08);
    g.lineStyle(2, 0x22ff22, 0.9);
    g.drawRect(p.x + bx, p.y + by, width, height);
    g.endFill();
    if (this._label) {
      this._label.text = this.label;
      this._label.position.set(p.x + bx, p.y + by - 24);
      this._label.visible = true;
    }
  }

  _onDown(event) {
    event.preventDefault();
    event.stopPropagation();
    if (event.button === 2) {
      this.cancel();
      return;
    }
    if (event.button !== 0) return;
    const p = this._worldPosition(event);
    let point = { x: p.x, y: p.y };
    if (this.opts.snapToGrid && canvas.grid) {
      const snapped = canvas.grid.getSnappedPosition(p.x, p.y);
      point = { x: snapped.x, y: snapped.y };
    }
    this._finish(point);
  }

  _onKey = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      this.cancel();
    }
  };

  cancel() {
    this._finish(null);
  }

  _finish(point) {
    if (!this._resolve) return;
    const resolve = this._resolve;
    this._resolve = null;
    this._cleanup();
    resolve(point);
  }

  _cleanup() {
    this._view?.removeEventListener("pointermove", this._onMoveBound);
    this._view?.removeEventListener("pointerdown", this._onDownBound);
    this._graphics?.off?.();
    this._label?.off?.();
    window.removeEventListener("keydown", this._onKey);
    Hooks.off("canvasReady", this._onCanvasReady);
    try {
      this._graphics?.destroy({ children: true });
    } catch (err) {
      console.warn("[chars-to-table] overlay cleanup:", err);
    }
    try {
      this._label?.destroy({ children: true });
    } catch (err) {
      console.warn("[chars-to-table] overlay label cleanup:", err);
    }
    this._graphics = null;
    this._label = null;
    this._view = null;
  }

  /** Creates the widget documents on the scene and registers the widget. */
  async commit(point) {
    const anchor = { x: Math.round(point.x), y: Math.round(point.y) };
    await this._commit(anchor, this.widgetId);
    ui.notifications.info(game.i18n.localize(this.successKey));
  }
}

/** Default actor-widget commit: create docs + register on the actor. */
async function commitActorWidget(
  actor,
  docs,
  anchor,
  widgetId,
  layoutId,
  layoutVersion,
) {
  const flagsBase = { widgetId, actorUuid: actor.uuid };

  const drawings = [];
  const tiles = [];
  for (const doc of docs) {
    const data = toDocumentData(
      { ...doc, x: doc.x + anchor.x, y: doc.y + anchor.y },
      { ...flagsBase, part: doc.part, index: doc.index },
    );
    (doc.kind === "tile" ? tiles : drawings).push(data);
  }

  if (drawings.length) {
    await canvas.scene.createEmbeddedDocuments("Drawing", drawings);
  }
  if (tiles.length) {
    await canvas.scene.createEmbeddedDocuments("Tile", tiles);
  }

  const widgets = (actor.getFlag(FLAG_SCOPE, WIDGETS_FLAG) ?? []).filter(
    (w) => {
      const scene = game.scenes.get(w.sceneId);
      if (!scene) return false;
      return allWidgetDocs(scene, w.widgetId).length > 0;
    },
  );
  widgets.push({
    widgetId,
    sceneId: canvas.scene.id,
    anchor,
    layoutId,
    layoutVersion,
  });
  await actor.setFlag(FLAG_SCOPE, WIDGETS_FLAG, widgets);
}
