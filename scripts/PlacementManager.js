/**
 * PlacementManager — interactive "place on table" mode.
 *
 * Shows a preview rectangle that follows the mouse; left-click commits the
 * widget documents onto the scene, right-click or Esc cancels.
 */

import { build, toDocumentData } from "./WidgetBuilder.js";
import { getLayout } from "./layouts.js";
import { getPlacementOptions } from "./settings.js";
import { MODULE_ID, FLAG_SCOPE, WIDGETS_FLAG } from "./constants.js";
import { allWidgetDocs } from "./widgetDocs.js";

export class PlacementManager {
  static active = null;

  /**
   * Starts the placement flow for an actor.
   * @param {object} actor
   */
  static async place(actor) {
    if (this.active) {
      ui.notifications.warn(game.i18n.localize(`${MODULE_ID}.placement.busy`));
      return;
    }
    if (!canvas || !canvas.ready || !canvas.scene) {
      ui.notifications.warn(game.i18n.localize(`${MODULE_ID}.placement.noScene`));
      return;
    }
    if (!game.user.isGM && !game.user.can("DRAWING_CREATE")) {
      ui.notifications.error(
        game.i18n.localize(`${MODULE_ID}.placement.noPermission`),
      );
      return;
    }

    const opts = getPlacementOptions();
    const layout = getLayout(opts.templateId);
    const { docs, bounds } = await build(actor, layout, {
      scale: opts.scale,
      fontFamily: opts.fontFamily,
      textColor: opts.textColor,
      fatePointImage: opts.fatePointImage,
      backgroundTexture: opts.backgroundTexture,
    });

    const manager = new PlacementManager(actor, docs, bounds, opts);
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
   * @param {object} actor
   * @param {object[]} docs  WidgetBuilder document descriptors (relative coords).
   * @param {{width: number, height: number}} bounds
   * @param {object} opts  Placement options (snapToGrid etc).
   */
  constructor(actor, docs, bounds, opts) {
    this.actor = actor;
    this.docs = docs;
    this.bounds = bounds;
    this.opts = opts;
    this.widgetId = foundry.utils.randomID();
    this._resolve = null;
    this._graphics = null;
    this._label = null;
    this._last = null;
    this._onCanvasReady = () => this.cancel();
  }

  /** Runs the interactive placement loop. Resolves with {x, y} or null. */
  run() {
    ui.notifications.info(
      game.i18n.localize(`${MODULE_ID}.placeOnTable.hint`),
    );
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
      const label = new PIXI.Text(this.actor.name, {
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
      this._label.text = this.actor.name;
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
    const flagsBase = { widgetId: this.widgetId, actorUuid: this.actor.uuid };

    const drawings = [];
    const tiles = [];
    for (const doc of this.docs) {
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

    const widgets = (this.actor.getFlag(FLAG_SCOPE, WIDGETS_FLAG) ?? []).filter(
      (w) => {
        const scene = game.scenes.get(w.sceneId);
        if (!scene) return false;
        return allWidgetDocs(scene, w.widgetId).length > 0;
      },
    );
    widgets.push({
      widgetId: this.widgetId,
      sceneId: canvas.scene.id,
      anchor,
    });
    await this.actor.setFlag(FLAG_SCOPE, WIDGETS_FLAG, widgets);

    ui.notifications.info(
      game.i18n.localize(`${MODULE_ID}.placement.success`),
    );
  }
}
