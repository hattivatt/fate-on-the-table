/**
 * Layout templates for the "fate-on-the-table" module.
 *
 * A layout describes the character widget as a list of elements with
 * coordinates RELATIVE to the widget anchor (top-left corner of the
 * portrait, per LAYOUT.md).
 *
 * Element types:
 *   - "tile":    single image (portrait). `content` resolves to a texture src.
 *   - "tileRow": horizontal row of images (fate point tokens). `content`
 *                resolves to a count; `src` comes from the module setting
 *                "fatePointImage"; `step` is the horizontal pitch.
 *   - "drawing": text (or a shape frame if `content` resolves to "").
 *                Either `content` (single drawing) or `rows` (one drawing
 *                per row, stacked with `lineHeight`).
 *                Optional `stroke` (px) draws a box outline around the
 *                element (used for the skills table grid and the FP frame).
 *
 * Content keys (`@name`, `@aspects`, ...) are resolved by WidgetBuilder.
 */

export const layouts = {
  default: {
    id: "default",
    name: "Default",
    scale: 1,
    // Uniform shift applied to every element except the portrait (the anchor).
    drawingOffset: { x: -135, y: -150 },
    // "Grab" box over the whole widget: transparent, thin outline, on top.
    // Drag it to move the whole widget (widgetDrag). `alpha: 0` = invisible.
    bounds: { stroke: 1, alpha: 0.2, color: "#000000", elevation: 10, sort: 1000 },
    // Background "card" under the widget. Texture comes from the module
    // setting `backgroundTexture`; empty texture = plain solid fill.
    background: { fillColor: "#ffffff", alpha: 1 },
    elements: [
      // 1. Имя — по центру виджета, над портретом; ширина = ширина листа
      {
        id: "name",
        type: "drawing",
        content: "@name",
        x: 102,
        y: -50,
        w: 361,
        h: 28,
        font: "Montserrat",
        size: 26,
        align: "center",
        color: "#000000",
        weight: 800,
        matchBoundsWidth: true,
      },
      // 2. Портрет — якорь раскладки
      {
        id: "portrait",
        type: "tile",
        content: "@portrait",
        x: 0,
        y: 0,
        w: 270,
        h: 270,
      },
      // 3. Заголовок «Аспекты»
      {
        id: "aspectsHeader",
        type: "drawing",
        content: "@headerAspects",
        x: 310,
        y: 0,
        w: 300,
        h: 68,
        font: "Montserrat",
        size: 20,
        align: "center",
        color: "#000000",
      },
      // 3. Список аспектов — под заголовком, по центру колонки
      {
        id: "aspects",
        type: "drawing",
        content: "@aspects",
        x: 300,
        y: 68,
        w: 333,
        h: 450,
        font: "Montserrat",
        size: 20,
        align: "center",
        color: "#000000",
      },
      // 4. Подпись «Жетоны» — по центру портрета
      {
        id: "fatePointsLabel",
        type: "drawing",
        content: "@headerFatePoints",
        x: 33,
        y: 303,
        w: 200,
        h: 17,
        font: "Montserrat",
        size: 18,
        align: "center",
        color: "#000000",
      },
      // 4. Рамка с жетонами (пустой текст + обводка). Ширина/высота — это
      //    минимальный размер: при переполнении рамка расширяется под
      //    фактический ряд жетонов (см. frameFor/pad в WidgetBuilder).
      {
        id: "fatePointsFrame",
        type: "drawing",
        content: "@empty",
        x: -15,
        y: 336,
        w: 307,
        h: 97,
        stroke: 2,
        color: "#000000",
        frameFor: "fatePointTokens",
        pad: 7,
      },
      // 4. Ряд жетонов FP (w/h/step переопределяются настройками).
      //    Ряд привязан к левой границе рамки fatePointsFrame (frameAnchor):
      //    начинается ровно от неё (padX = 0),
      //    по вертикали центрируется в рамке. x/y ниже — фолбэк на случай
      //    отсутствия рамки.
      {
        id: "fatePointTokens",
        type: "tileRow",
        content: "@fatePointTokens",
        x: -8,
        y: 350,
        w: 70,
        h: 70,
        step: 20,
        frameAnchor: { frame: "fatePointsFrame", padX: 0 },
      },
      // 5. Заголовок «Компетенции»
      {
        id: "skillsHeader",
        type: "drawing",
        content: "@headerSkills",
        x: 17,
        y: 479,
        w: 300,
        h: 17,
        font: "Montserrat",
        size: 18,
        align: "center",
        color: "#000000",
      },
      // 5. Таблица навыков: колонка названий (по центру)
      {
        id: "skillName",
        type: "drawing",
        rows: "@skillNames",
        x: -7,
        y: 527,
        w: 583,
        h: 68,
        lineHeight: 68,
        font: "Montserrat",
        size: 16,
        align: "center",
        color: "#000000",
        stroke: 2,
      },
      // 5. Таблица навыков: колонка значений (+N, по центру, в рамке)
      {
        id: "skillValue",
        type: "drawing",
        rows: "@skillValues",
        x: 576,
        y: 527,
        w: 68,
        h: 68,
        lineHeight: 68,
        font: "Bruno Ace",
        size: 30,
        align: "center",
        color: "#000000",
        stroke: 2,
      },
    ],
  },
};

/**
 * Returns a layout by id (falls back to "default").
 * @param {string} id
 */
export function getLayout(id = "default") {
  return layouts[id] ?? layouts.default;
}

/**
 * Returns the ids of all registered layouts.
 * @returns {string[]}
 */
export function getLayoutIds() {
  return Object.keys(layouts);
}
