# План разработки модуля `fate-on-the-table`

Модуль Foundry VTT для Fate Core Official, который переносит данные
персонажей и служебные элементы на канвас сцены в виде групп
`Drawing` + `Tile` с размещением мышью, групповым drag и автосинхронизацией.

Система: **только `fate-core-official`**. Foundry: **v14** (минимум `14.354`).

Реализованное не хранится — история в `git log`. Раздел «Справочно»
содержит только актуальные архитектурные решения и форматы, невидимые из кода.

---

## Актуальный бэклог

Только нереализованное. Всё, что уже в коде, удалено. При сомнениях
помечено «требует проверки» — сверять `grep` по `scripts/`.

### 1. Конфликт-борд — расширения (вне MVP)

Схема и проекция v2 реализованы (`conflictBoardSchema.js` v2, `ConflictBoardSync`,
`ConflictInteractions`, `ConflictZoneEditor`). Ниже — то, что **не заявлено
как готовое** и остаётся в бэклоге (часть пересекается с `README` секцией
«Ограничения первой версии»):

- **Зоны — действия и полировка:**
  - переименование / изменение стиля / перемещение / resize / удаление зоны из
    контекстного меню (сейчас: переименование и удаление с подтверждением есть,
    перемещение/resize — через «Редактор зон»; стиль — нет);
  - зоны с препятствиями, дистанцией, стоимостью перемещения и ограничениями;
  - круговые/полигональные и вложенные зоны; автоматическая раскладка токенов
    внутри зоны и измерение дистанции (прямоугольники — единственный тип MVP).

- **Карточки участников:**
  - ручное перемещение карточки между областями (сейчас — автоматическая
    раскладка по `side` с pile-хвостом; ручной перенос — будущая работа);
  - ручная операция «Выбыл» (`eliminated`) и обратная «Вернуть в бой»;
    сейчас `eliminated` зеркалит `combatant.defeated` (двусторонний синк), но
    отдельного «Выбыл»-действия из меню карточки нет — есть «Выйти из боя»
    (`defeated+eliminated`);
  - авто-предложение «Выбыл» при удалении Combatant/Token;
  - доп. действия карточки: временно скрыть, отметить NPC/PC, открыть связанные
    аспекты/последствия;
  - автоматическая раскладка карточек с раскрытием pile; политика переполнения
    `expand` (сохранена в схеме, но не применяется к геометрии).

- **Ход и раунды:**
  - marker текущего хода как иконка/подсветка/рамка из настройки (сейчас —
    красный/серый overlay + `stroke`);
  - применение политики `overflow: expand` к геометрии борда;
  - связь борда с жизненным циклом `game.combat` и переключением между
    несколькими конфликтами (сейчас — один борд на сцену, `combatId`).

- **Завершение конфликта:**
  - явная операция завершения с диалогом: завершить/деактивировать `game.combat`,
    оставить/удалить борд и зоны, вернуть карточки из `acted`/`eliminated`,
    сбросить `hasActed`, очистить `Fleeting`-стресс, snapshot/экспорт.
    Автоматическая очистка при закрытии combat UI — намеренно отсутствует.

### 2. Виджет ситуативных аспектов — маркеры типов

- Пиктограммы-маркеры типов аспектов в SA-виджете по образцу зонального `◈`
  (`scripts/situationAspectZones.js: SA_ZONE_MARKER` / `saAspectLine`).
  Сейчас реализован только зональный маркер. Будущая работа: константа-маркер на
  тип (последствия и т.п.), дешёвое расширение отрисовки строк без изменения
  данных сцены. Глифы последствий по стоимости (`✚/⚠/☠`) уже есть в
  `situationAspectConsequences.js`.

### 3. Рефакторинг / техдолг

Зафиксирован в `git log` и в предыдущих версиях плана; перенесён сюда
как актуальный бэклог:

- **Тестируемость UI-менеджеров (приоритет: средний):**
  ленивый guard `ApplicationV2` по образцу `ConflictManager.js` для
  `FatePointManager` / `SituationAspectManager` / `ConflictZoneEditor` +
  вынос pure-логики (`renderContent`, действия) в тестируемые модули.
  Сейчас у трёх менеджеров 0 тестов (~45% кода непокрыто).

- **Декомпозиция гигантов (приоритет: средний):**
  `ConflictBoardSync.js` (~1669 строк, `syncConflictBoardNow` ~230 строк —
  отделить pure-подготовку от I/O),
  `ConflictManager.js` (~1579 строк, менеджер+3 диалога),
  `ConflictInteractions.js` (~1514 строк, 4 меню+drag-drop+хит-тесты).

- **Стилевой рефакторинг (приоритет: низкий):**
  `Handlebars`-шаблоны вместо конкатенации HTML, `DOMPurify` вместо ручного
  `escapeHtml`, отказ от прототип-патчей где возможно (референс —
  паттерны `fate-core-official`).

### 4. Проверки и полировка

- Сквозная ручная проверка в Foundry v14 с Advanced Drawing Tools:
  размещение/синхронизация/перетаскивание виджетов, все раскладки (`Default`,
  `Minimal`, `Full`), SA-виджет с зональными аспектами, конфликт-борд
  (размещение, редактор зон, бросок токенов, меню карточки/поля, маркеры хода,
  order/round). Чистые модули покрыты `npm test`; интерактивные сценарии —
  только ручной прогон.
- Контракт `layout-editor` ↔ модуль: паритет `layoutSchema`/`layoutGeometry`,
  drift-guard констант метрик текста (тест `moduleCompatibility`), сохранение
  неизвестных полей `{...raw}` — поддерживать при изменении схемы.
- i18n-паритет `ru.json`/`en.json` (тест `i18nContract.test.js`).

---

## Справочно / архитектурные решения

Актуальная выжимка, необходимая для продолжения работы. Протухшие разделы удалены.

### Источники данных и флаги

- **FP игрока:** `actor.system.details.fatePoints` (`current`/`refresh`/`boosts`);
  отображается как числовые Drawing + тайлы-жетоны в виджете персонажа.
- **FP мастера:** системный флаг `fate-core-official.gmfatepoints` на `User`;
  ряд жетонов — scene-widget `scene.flags["fate-on-the-table"].gmFatePointWidget
  { widgetId, anchor }`.
- **Ситуативные аспекты:** системный флаг
  `scene.flags["fate-core-official"].situation_aspects: Array<{ name,
  free_invokes, zoneIds?, consequence? }>` — канонический список сцены.
  Виджет-реестр: `scene.flags["fate-on-the-table"].situationAspectsWidget
  { widgetId, anchor }`. Двойной клик GM по любой части виджета открывает
  менеджер.
- **Последствия как SA:** структурная привязка `aspect.consequence = { trackKey,
  cost, actorName }` + `aspect.zoneIds`. Глифы стоимости: `✚/⚠/☠` по `cost`
  (`situationAspectConsequences.js`). Автосинхронизация SA при
  `updateActor`/`updateToken delta`/`deleteToken` (последний токен актёра ушёл
  — чистка).

### Формат `situation_aspects`

```js
// scene.flags["fate-core-official"].situation_aspects
[
  {
    name: "Пожар",                 // без суффикса "(Зона)" — структурная привязка
    free_invokes: 2,               // integer >=0
    zoneIds: ["zone-1", "zone-2"], // структурная зональная привязка; [] = без зоны
    consequence: {                 // опционально — аспект-последствие
      trackKey: "PhysicalStress_2",
      cost: 2,
      actorName: "Alice"
    },
    // ...unknown fields preserved via { ...raw }
  }
]
```

- `zoneIds` — массив id зон живого борда `readConflictBoard(scene).zones`;
  не существует отдельно от борда. Текстовый суффикс `"Аспект (Зона)"` — LEGACY,
  мигрируется в `SituationAspectSync.migrateZoneSuffixes` (приоритет персонажа
  над зоной).
- Нормализация: `situationAspectData.js: normalizeAspects` + `situationAspectZones.js`
  (`normalizeZoneIds`, `SA_ZONE_MARKER = "◈"`, `migrateZoneSuffixes`,
  `applyAspectBinding`). Виджет маркирует зональные строки префиксом `◈`.

### Формат `conflictBoard` v2

```js
// scene.flags["fate-on-the-table"].conflictBoard
{
  version: 2,
  combatId: "<combatId>",
  sizePreset: "small"|"medium"|"large",
  board: {
    origin: { x, y },
    boardSize: { width, height } | undefined,
    background: { color: "#ffffff", texture: "", alpha: 1 }
  },
  zones: [
    {
      id: "zone-1",
      name: "Центр",
      rect: { x, y, width, height },
      style: { fill: "#ffffff", alpha: 0.12, stroke: "#000000" },
      sort: 0
    }
  ],
  cards: {
    "<combatantId>": {
      side: "friendly"|"hostile", // home side
      area: "side",               // всегда "side" в v2
      order: 0,                   // integer >=0
      acted: true|undefined,      // true когда hasActed
      eliminated: true|undefined  // зеркало combatant.defeated
    }
  },
  tokenZones: {
    "Scene.<sceneId>.Token.<tokenId>": "zone-1"
  }
}
```

- `acted`/`eliminated` — флаги; `area` не перемещается. `eliminated` зеркалит
  `combatant.defeated` в обе стороны (синк трекера ↔ борда).
- Нижние боксы борда: `bottomFriendly`/`bottomHostile` (горизонтальная раскладка
  с pile-хвостом); бокс-разделитель с цифрой раунда; усиленная граница поля.
  Карточки: acted-оверлей (посерение) и eliminated-перечёркивание (rotation ±45).
- Меню карточки: «Выйти из боя» (`defeated+eliminated`), «Бросок» с подменю всех
  навыков (`rollSkill`). Даблклик сквозь маркер хода открывает чарник карточки
  (в т.ч. `unlinked`).
- Реестр проекции: `scene.flags["fate-on-the-table"].conflictBoardWidget
  { widgetId }`. Геометрия: `conflictBoardGeometry.js` (чистый).

### Версионирование схем

- `conflictBoard` v2 с мигратором `migrateConflictBoard` (v1 `area: acted|eliminated`
  → флаги). Неизвестные поля сохраняются (`{...raw}` spread).
- `layout` формат `fate-on-the-table.layout` v1 — `layoutSchema.js` валидирует,
  сохраняет неизвестные поля, применяет безопасные дефолты только на структурно
  валидных документах.

### Идентификация групп на сцене

- Actor-widget: `flags["fate-on-the-table"] = { widgetId, part, index, actorUuid }`
  + `layoutId`/`layoutVersion` в `actor.flags["fate-on-the-table"].widgets`
  `{ widgetId, sceneId, anchor:{x,y}, layoutId, layoutVersion }`.
  Legacy без `layoutId` — фолбэк `playerLayout`/`npcLayout` при первом синке.
- GM FP: `{ widgetId, part, index, ownerType: "gm" }`.
- SA-widget: `{ widgetId, part, index, ownerType: "situationAspects" }` (3 Drawing).
- Conflict zone: `{ widgetId, ownerType: "conflictZone" }`;
  conflict card: `{ widgetId, ownerType: "conflictCard", combatId, combatantId,
  tokenUuid, area }`.
- Осиротевшие записи чистятся только по module flags/registry; поиск по тексту
  Drawing не используется.

### Конвенции синков

- Все собственные записи модуля (`create/update/deleteEmbeddedDocuments` и
  `setFlag` борда) помечаются `{ fateOnTheTableSync: true }`; повторный синк — строго
  no-op (покрыто тестами).
- Хук-ветка на `fateOnTheTableSync` — `return` без рекурсии.
- Дебаунсы — пер-сценовые `Map<sceneId, timer>` (400 мс actor/SA, 150 мс
  token-drag), а не глобальные таймеры (иначе потеря кросс-сценовых апдейтов).
- `updateActor` → `scheduleActorSync` (виджет персонажа) + `onConflictBoardActorUpdate`
  (перепроекция борда, если актёр ведёт карточку) + `onActorConsequenceSync`
  (SA-последствия). `updateToken delta` / `deleteToken` — аналогично для
  `unlinked` и чистки SA.

### Layout — pipeline и реестр

```
JSON -> validate/normalize (layoutSchema) -> resolve data (resolver catalog)
     -> geometry (layoutGeometry) -> WidgetBuilder -> Drawing/Tile
```

- Resolver-каталог — единственное место исполнения кода; JSON декларативен.
  Resolver'ы: `@name`, `@portrait`, `@aspects`, `@shortAspects`, `@skill*`,
  `@fatePointTokens`, `@stress*`, `@consequenceCostRows` и т.д. (см. `WidgetBuilder.js`).
- Встроенные: `Default`, `Minimal`, `Full` (`layouts/*.json`); `layouts.js` —
  legacy fallback при недоступности JSON.
- Реестр: `layoutRegistry.js` (`registerLayout`, `getLayout`, `getLayoutIds`,
  `validateLayout`, `getLayoutJson`); `layoutLoader.js` грузит `fetch` в `init`.
- Выбор: `playerLayout`/`npcLayout` (`hasPlayerOwner` + fallback на
  `testUserPermission` по не-GM). Явная смена раскладки через меню чарника имеет
  приоритет.
- Standalone `../layout-editor` — отдельный проект с тем же контрактом;
  кросс-проверка и drift-guard констант метрик текста (`moduleCompatibility`).

### Инфраструктура

- `utils.js`: `escapeHtml`, `dialogField`, `canvasWorldPosition`, `toArray`
  (нормализация коллекций `Array/{contents}/{values()}/Map/iterable`).
- `menu.js`: единое контекстное меню с подменю (SA/борд/карточки).
- `situationAspectData.js`: единая нормализация SA.
- Константы метрик текста + drift-guard тест с `layout-editor`.
- `chatSpeaker.js`: alias чат-сообщений = имя токена (исправляет `rollSkill`
  для `unlinked`).
- `turnMarkerQol.js`: автовключение маркера хода при добавлении в бой на сцене
  с бордом (setting `autoTurnMarker`).
- `nameGenerator.js` + `nameGenLanguages.js` + `dict/*`: триграммная генерация
  имён (RU+EN, `unlinked`-only), адаптировано из Token Mold (MIT).

### Placement, drag, права

- Placement — `pointermove`/`pointerdown` на `canvas.app.view` (PIXI перехватывает),
  inverse world transform, snap к сетке (опция), batch `create` + запись registry.
- Групповой drag — `widgetDrag.js` (весь виджет по любому элементу), сохранение
  `anchor`.
- Борд — GM-only размещение/редактирование зон/меню; игроки видят борд read-only
  (manager без кнопок).
- Токены — нативные `TokenDocument.x/y` остаются каноном; `tokenZones` — только
  принадлежность. Бросок в зону — `handleTokenDropOnConflictZone`; ручной drag —
  `reconcileTokenZoneMembership`.

### Настройки и точки расширения

- `settings.js`: `defaultTemplate` (фолбэк), `playerLayout`/`npcLayout`,
  `customLayouts` (world), FP/image/size/step/direction, фон виджета, SA-размеры/
  шрифт/цвет/фон, борд `small/medium/large` + цвет/текстура/alpha + `overflow`.
  File/font pickers — штатные `game.settings`.
- Публичный API (`game.modules.get("fate-on-the-table").api`):
  `registerLayout`/`getLayout`/`getLayoutIds`/`validateLayout`/`getLayoutJson`,
  `conflict.{ ConflictManager, placeBoard, syncConflictBoard, readConflictBoard, ... }`.
- Внешний модуль может зарегистрировать layout в памяти до построения choices;
  built-in id нельзя перезаписать без явной политики.

### Зафиксированные решения

- Группы — отдельные `Drawing`+`Tile`, не растеризованная картинка.
- Источники данных — напрямую системные (FP, `situation_aspects`, `tracks`,
  `extras`), не копии в журнале.
- Layout — versioned JSON + builder с нормализованной моделью; визуальный
  редактор — standalone, не создаёт временных документов на сцене.
- Новые функции — `game.settings`, не JSON-страницы журнала.
- Шрифты — только `CONFIG.fontDefinitions`; фолбэк Montserrat с предупреждением.
- Legacy документы макросов не удаляются автоматически.
- Advanced Drawing Tools — текстовые Drawing получают `dropShadow:false`,
  `strokeThickness:0`, `align`, `fontWeight`.
- `fate-core-official` — read-only референс; `layout-editor` — отдельный
  репозиторий со своими тестами.

### Структура модуля

```
fate-on-the-table/
  module.json
  PLAN.md
  README.md
  LICENSE
  LAYOUT-FORMAT.md            # локально, ignored, спецификация JSON
  layouts/                    # built-in JSON layouts
  languages/{en,ru}.json
  styles/module.css
  scripts/
    module.js                 # init/ready, хуки, scene controls, public API
    constants.js
    settings.js
    sheetButton.js
    WidgetBuilder.js          # resolver-каталог, геометрия payloads
    layoutSchema.js           # validator/normalizer (чистый)
    layoutGeometry.js         # чистая геометрия (чистый)
    layoutLoader.js           # fetch + legacy fallback
    layoutRegistry.js         # публичный registry
    LayoutImportExport.js     # GM-диалог импорта/экспорта
    layouts.js                # legacy JS fallback
    PlacementManager.js
    WidgetSync.js
    FatePointManager.js
    FatePointSync.js
    SituationAspectManager.js
    SituationAspectSync.js
    situationAspectData.js
    situationAspectNames.js
    situationAspectZones.js   # SA_ZONE_MARKER, zoneIds, migrate/apply
    situationAspectConsequences.js
    situationAspectActions.js
    utils.js                  # escapeHtml/dialogField/canvasWorldPosition/toArray
    menu.js                   # единое меню с подменю
    chatSpeaker.js
    turnMarkerQol.js
    nameGenerator.js
    nameGenLanguages.js
    dict/{english,russian}.js
    conflictBoardSchema.js    # v2 + migrate + reconcile (чистый)
    conflictBoardGeometry.js  # чистая геометрия борда
    ConflictBoardSync.js
    ConflictManager.js
    ConflictZoneEditor.js
    ConflictInteractions.js
    ConsequenceInteractions.js
    StressBoxes.js
    widgetDocs.js
    widgetDrag.js
    conflictUi.js
  tests/                      # Node-тесты чистых модулей (npm test)
```
