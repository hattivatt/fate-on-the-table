# План разработки модуля `chars-to-table`

Модуль Foundry VTT для Fate Core Official, который переносит данные персонажей
и игровые служебные элементы на канвас сцены в виде управляемых групп
`Drawing` + `Tile`. Группы можно размещать мышью, перетаскивать целиком и
автоматически синхронизировать с источниками данных системы.

Система: **только `fate-core-official`**. Foundry: **v14** (минимум `14.354`).

---

## Статус

### Фича 1 — «Вынести персонажа на стол»: РЕАЛИЗОВАНА ✅

- [x] Каркас модуля, языки и структура файлов.
- [x] Раскладка в `layouts.js` и сборка документов в `WidgetBuilder.js`.
- [x] Placement-flow: превью за мышью, клик/ПКМ/Esc, снап к сетке.
- [x] Кнопки «Вынести на стол» и «Убрать со стола» в меню чарника.
- [x] Автосинхронизация актёра с debounce и реконсиляция при загрузке сцены.
- [x] Создание/удаление переменных элементов: навыков, стресса и FP-жетонов.
- [x] Перетаскивание всей группы с сохранением anchor.
- [x] Раскладка по примеру чарлиста: имя над портретом, аспекты справа,
  жетоны FP, таблица компетенций, фон и «хватательный» бокс.
- [x] Фолбэк незарегистрированных шрифтов на Montserrat.
- [x] Совместимость с Advanced Drawing Tools.
- [x] README и ручная проверка в Foundry v14.

### Фича 2 — «FP-менеджер»: РЕАЛИЗОВАНА ✅

- [x] Управление FP игроков и мастера из GM-инструмента сцены.
- [x] Ряд FP игроков использует существующий `fatePointTokens` в actor-widget,
  без дублирования отдельными тайлами.
- [x] Отдельный ряд FP мастера с frame, scene registry, размещением,
  переразмещением, удалением и групповым drag.
- [x] Синхронизация системного флага `fate-core-official.gmfatepoints`.
- [x] Настройки изображения, размера, шага и направления ряда жетонов.
- [x] «Синхронизировать всех», «Рефреш всех» и «Новая сцена».
- [x] Очистка быстротечного стресса и расширяемое событие
  `chars-to-table.newScene`.
- [x] i18n, CSS диалога и README.

### Фича 3 — «Менеджер ситуативных аспектов»: РЕАЛИЗОВАНА ✅

- [x] Нормализация системного массива `situation_aspects` и безопасная работа
  с `free_invokes`.
- [x] ApplicationV2-меню: `+`/`−` invoke, добавление, переименование и
  удаление аспектов с подтверждением.
- [x] Отдельный сценовый виджет с текстом, frame и собственной подложкой.
- [x] Отдельные настройки размера, шрифта, цвета и фона.
- [x] Размещение, переразмещение, удаление и групповой drag.
- [x] Двойной клик GM по любой части виджета открывает меню управления;
  игроки видят виджет, но не получают редактор.
- [x] Выбор персонажа при добавлении аспекта и текстовая форма
  `Аспект (Персонаж)`.
- [x] Синхронизация по `updateScene`, `updateSetting`, `canvasReady`,
  сохранению и `chars-to-table.newScene`.
- [x] Ручная проверка в Foundry v14.

### Фича 4 — «Альтернативные лейауты»: РЕАЛИЗОВАНА (module-side) ✅

Подготовительный документ формата — `LAYOUT-FORMAT.md` (в `.gitignore`, рабочая
спецификация, в пакет модуля не входит). Module-side часть (загрузка,
валидация, реестр, встроенные раскладки, PC/NPC-выбор, identity и
импорт/экспорт) реализована; standalone-редактор остаётся отдельным проектом.

- [x] JSON-формат v1, validator/normalizer без Foundry-зависимостей.
- [x] Встроенные `Default` (доработан в layout-editor: FP-блок и портрет
  смещены, добавлен блок стресс-треков с маркерами `☐`/`☒`), `Minimal`,
  `Full`.
- [x] Loader через `fetch` в init до регистрации настроек; фолбэк на legacy JS.
- [x] Геометрия JSON-модели в WidgetBuilder (rows, tileRow, anchorTo, growTo,
  width:canvas, background, bounds) с паритетом default (покрыто Node-тестами).
- [x] Каталог resolver'ов: навыки, FP, стресс-треки, последствия, трюки,
  экстры, details/rich-text (text-only).
- [x] Layout identity `layoutId`/`layoutVersion` в реестре виджетов и миграция
  legacy-записей при первом успешном синке.
- [x] Настройки `playerLayout`/`npcLayout` + `isPlayerCharacter`.
- [x] Публичный API реестра и менеджер раскладок (кнопка «Раскладки…» в
  настройках + инструмент сцены): единый список всех раскладок, экспорт
  каждой, переименование/удаление пользовательских, импорт из файла/буфера
  с валидацией и предложением переименовать при совпадении id.
- [x] i18n (en/ru), CSS, README.
- [ ] Ручная проверка в Foundry v14 с Advanced Drawing Tools (отдельно от
  среды разработки).

---

## Роадмап

1. **Альтернативные лейауты**:
   - загрузка и валидация раскладок из JSON;
   - перенос текущего `default` на новый формат;
   - встроенные `Default`, `Minimal`, `Full`;
   - отдельный выбор лейаута для персонажей игроков и NPC;
   - импорт/экспорт пользовательских JSON-раскладок внутри модуля;
   - отдельное standalone-приложение `../layout-editor` для визуального
     создания и редактирования JSON-раскладок.
2. **Challenge/Contest** — отдельная оценка переноса `challenge.js` после
   стабилизации scene-widget инфраструктуры.

Общие настройки, FP-менеджер и ситуативные аспекты уже реализованы и не должны
возвращаться в активный роадмап как новые фичи.

За пределами текущего роадмапа (оценка позже): `init_players.js`,
`ad-hoc_roll.js`, полный перенос `mac_settings.js` и автоматическая миграция
старых standalone-объектов макросов.

---

## Детальный план фичи 4 — альтернативные лейауты

Статус: **module-side реализован (этапы 0–8, 10); standalone-editor и
сквозная проверка обмена JSON — в `../layout-editor`**.

Граница ответственности:

- модуль умеет валидировать, загружать, хранить, выбирать и экспортировать
  раскладки;
- визуальное создание и изменение раскладки полностью вынесено в отдельный
  проект `../layout-editor`;
- модуль не содержит `LayoutEditor.js`, canvas-конструктора или UI для
  перетаскивания элементов раскладки;
- подробный план standalone-приложения находится в
  `../layout-editor/plan.md`.

### 1. Исследование реализуемости

#### JSON-формат и загрузчик: высокая реализуемость

`LAYOUT-FORMAT.md` уже описывает версию JSON, virtual canvas, anchor,
элементы, resolver'ы, повторяющиеся строки/тайлы, относительные связи,
background и bounds.

Рекомендуемый путь:

1. Нормализовать JSON в текущую внутреннюю модель `WidgetBuilder`.
2. Не позволять JSON содержать JavaScript-код: только имена разрешённых
   resolver'ов и декларативные параметры.
3. Добавить schema validation и миграцию версий формата.
4. Оставить текущий builder источником фактических Drawing/Tile payloads.
5. После стабилизации заменить статический объект `layouts.js` реестром,
   который умеет загружать built-in JSON и custom JSON.

Загрузка JSON должна быть проверена в Foundry v14 отдельно. Варианты —
предварительная загрузка через `fetch` до регистрации настроек или импорт
пакетных файлов через поддерживаемый module asset pipeline. Нельзя полагаться
на неподтверждённую поддержку `import ... from "*.json"` без import assertion.

#### Визуальный редактор: реализуемость высокая, но вне модуля

Редактор будет отдельным статическим web-приложением в `../layout-editor`, а не
частью Foundry-модуля. Это убирает из модуля зависимости от editor UI, браузерных
File API, временных preview-объектов и сложной интерактивной геометрии.

Рекомендуемый стек и архитектура описаны в `../layout-editor/plan.md`:

- Vite + TypeScript + React;
- SVG virtual canvas с DOM inspector;
- palette, preview, selection, drag/resize и undo/redo;
- локальные JSON import/export без backend;
- тот же versioned layout contract, что использует модуль.

Foundry нужен только для runtime-части: загрузить JSON, проверить его и
преобразовать через `WidgetBuilder` в Drawing/Tile. Standalone-editor не должен
зависеть от `game`, `canvas`, Foundry permissions или серверного API.

#### Встроенные лейауты: высокая реализуемость

После появления loader'а три встроенные раскладки — это обычные JSON-ресурсы:

- `default.json` — перенос текущего `layouts.js` без изменения внешнего вида;
- `minimal.json` — имя, портрет и аспекты;
- `full.json` — все поддерживаемые блоки данных персонажа.

Редактор может использовать эти файлы как read-only templates и создавать от
них пользовательские копии. Поэтому наличие конструктора не является
предусловием для встроенных раскладок.

#### Разделение PC/NPC: высокая реализуемость

У Fate Core Actor есть `actor.hasPlayerOwner`, а исходный system code уже
использует это свойство. Для надёжности нужен fallback на проверку
`testUserPermission` для всех не-GM пользователей.

В настройках можно зарегистрировать два выбора:

- `playerLayout` — лейаут актёров с игроками-владельцами;
- `npcLayout` — лейаут актёров без игроков-владельцев.

Внутри layout selection не следует дублировать раскладки: обе настройки хранят
только `layoutId` и используют общий реестр.

### 2. Единая модель layout registry

Добавить слой между JSON и текущими `layouts.js`:

- `layoutSchema.js` — проверка версии, обязательных полей и ссылок между
  элементами;
- `layoutRegistry.js` — built-in, custom и публичная регистрация раскладок;
- `layoutLoader.js` — загрузка JSON-ресурсов, импорт и нормализация;
- `layouts/*.json` — встроенные раскладки.

Каждая зарегистрированная раскладка получает:

```js
{
  id,
  name,
  source: "builtin" | "custom" | "registered",
  version,
  document
}
```

Custom layouts хранить в world setting как массив JSON-документов. Built-in
раскладки нельзя изменять напрямую: редактор создаёт custom copy с новым id.
Публичный API должен позволять другим модулям зарегистрировать layout в памяти
до построения списка выбора.

### 3. Миграция текущей раскладки

Первым реальным кодовым шагом сделать loader только для текущего `default`:

1. Перенести эффективную геометрию и правила из `layouts.js` в
   `layouts/default.json` по `LAYOUT-FORMAT.md`.
2. Сохранить текущие resolver'ы `@name`, `@portrait`, `@aspects`,
   `@skillNames`, `@skillValues`, `@fatePointTokens` и заголовки.
3. Сравнить output нового loader и старого builder по каждому типу документа:
   `kind`, `part`, `index`, координаты, размеры, текст, style и flags.
4. Только после совпадения переключить `getLayout("default")` на registry.

В actor registry текущих виджетов сейчас нет `layoutId`: там хранятся widget id,
scene id и anchor. При миграции:

- старую запись считать layout `default` или текущим legacy fallback;
- при первом успешном sync дописать `layoutId` и `layoutVersion`;
- не терять anchor и не создавать новый widget;
- не менять layout старого виджета неожиданно только из-за загрузки JSON.

Новые записи должны хранить layout identity:

```js
{
  widgetId,
  sceneId,
  anchor: { x, y },
  layoutId: "default",
  layoutVersion: 1
}
```

Это позволит существующему виджету оставаться на выбранной раскладке, даже если
дефолт для новых размещений позже изменён.

### 4. Каталог элементов персонажа

Конструктор не должен разрешать произвольные resolver strings без проверки.
Нужен каталог семантических элементов с типом данных и правилами preview.

#### Базовые элементы

- `name` — имя актёра;
- `portrait` — портрет актёра;
- `aspects` — аспекты актёра;
- `skills` — навыки с группировкой по рангу;
- `fatePoints` — текущие FP и/или ряд жетонов;
- `stressTracks` — треки стресса и их боксы;
- `consequences` — занятые и свободные последствия.

#### Расширенные элементы

- `stunts` — название, описание, связанный навык, бонус;
- `extras` — embedded Items типа `Extra`;
- `biography`, `description`, `notes` — rich-text поля актёра;
- `boosts`, `refresh`, `pronouns` и другие простые поля details;
- `track` — отдельный выбранный трек с настройкой отображения.

Источники данных Fate Core подтверждены локальным `FateCoreOfficialModels.js`:

- `system.aspects`, `system.skills`, `system.stunts`, `system.tracks` —
  объектные коллекции;
- `system.details.fatePoints` — current/refresh/boosts;
- `system.details.description`, `biography`, `notes` — HTML/string fields;
- `actor.items` содержит Extras.

Нужно не зашивать в layout конкретные имена вроде «Physical Stress». Треки
должны классифицироваться по данным (`recovery_type`, `aspect`, `enabled`,
`category`) и поддерживать пользовательские/системные дополнительные треки.
Последствия — это отдельный представляемый вид треков, обычно `Lasting` с
`track.aspect`, а не отдельная коллекция в actor data.

Rich-text поля перед выводом на Drawing должны проходить отдельный formatter:
либо безопасное обогащение с потерей HTML, либо явное text-only представление.
JSON раскладки не должен содержать HTML/JavaScript, если это не разрешено
конкретным renderer'ом.

### 5. Три встроенные раскладки

#### `Default`

Точный перенос текущей раскладки:

- имя над портретом;
- портрет слева;
- аспекты справа;
- FP-жетоны под портретом;
- таблица навыков;
- текущий фон и drag-box.

#### `Minimal`

Содержит только:

- имя;
- портрет;
- аспекты.

Минимальный layout всё равно должен иметь background/bounds и корректные
динамические bounds. Отсутствие навыков/треков/жетонов означает отсутствие
соответствующих документов, а не пустые Drawing.

#### `Full`

Содержит все поддержанные на первом этапе каталога данные:

- имя и портрет;
- Fate Points/refresh;
- аспекты;
- навыки;
- стрессовые треки и боксы;
- последствия;
- трюки;
- Extras;
- при необходимости описание/биографию.

Полный layout следует сделать читабельным, а не просто сложить все элементы в
один длинный список. Для него заранее выбрать orientation и несколько секций с
явными bounds. Если данных нет, секция скрывается или получает пустое состояние
по декларативному правилу layout.

### 6. Разделение раскладок для PC и NPC

Добавить настройки:

- `playerLayout` — layout для Actor с хотя бы одним non-GM OWNER;
- `npcLayout` — layout для Actor без player owner.

Правила выбора:

1. Для placement определить `actor.hasPlayerOwner`.
2. Если свойство недоступно или не определено, проверить
   `actor.testUserPermission(user, OWNER)` по всем non-GM users.
3. Получить layout id из соответствующей настройки.
4. Если выбранный id удалён/невалиден, использовать `default` и показать
   предупреждение GM.
5. Явный layout id, сохранённый в widget registry, имеет приоритет над текущим
   default selection для уже размещённого widget.

В будущем можно добавить выбор layout непосредственно в placement dialog, но
первый этап должен работать только через две настройки, как требуется сейчас.

### 7. Граница с standalone layout-editor

В модуле не будет интерактивного конструктора, preview-редактора или
`LayoutEditor.js`. Эти функции реализуются в отдельном приложении;
архитектура, UI и этапы находятся в `../layout-editor/plan.md`.

Модуль обязан поддерживать только контракт обмена:

- экспортировать валидный JSON built-in/custom layout;
- импортировать JSON, созданный standalone-editor;
- валидировать и нормализовать JSON до записи;
- показывать список элементов и ошибки импорта;
- использовать импортированный layout в `WidgetBuilder` без ручной конвертации.

#### Сохранение и импорт/экспорт

Импорт/экспорт в модуле нужен для того, чтобы standalone-editor мог обмениваться
раскладками с Foundry:

- built-in layout открывается read-only;
- module UI импортирует JSON из выбранного файла или текстового буфера;
- импорт валидирует `format`, `version`, resolver'ы и ссылки между элементами;
- валидная раскладка сохраняется как custom layout в world setting
  `customLayouts` после подтверждения;
- export выбранной custom/built-in раскладки создаёт JSON-файл через
  Blob/download;
- при неизвестном resolver импорт блокируется с указанием элемента и поля;
- custom layout нельзя частично сохранить при ошибке validation;
- миграции schema version выполняются до записи в registry.

Визуальное «Сохранить как», drag/resize и редактирование draft выполняются
только в `../layout-editor`, а не в этом UI модуля.

### 8. Публичный API реестра

После появления loader'а предоставить минимальный API:

- `registerLayout(layout)`;
- `getLayout(id)`;
- `getLayoutIds()`;
- `validateLayout(layout)`;
- `exportLayout(id)` или получение нормализованного JSON-документа.

Регистрация должна происходить после загрузки встроенных JSON и до отображения
списков настроек. Внешний модуль может добавить layout, но не может заменить
зарегистрированный built-in id без явного override policy.

### 9. Порядок реализации

Реализация разбивается на последовательные этапы. Переходить к следующему
этапу можно после выполнения его exit criteria; полноценный редактор не должен
блокировать загрузчик и встроенные раскладки.

#### Этап 0 — зафиксировать контракт и fixtures

- [x] Принять `LAYOUT-FORMAT.md` как schema v1 и выписать обязательные поля,
  допустимые значения enum и правила ссылок между элементами.
- [x] Сохранить JSON-fixture текущего `default` и несколько маленьких fixtures:
  статический текст, tile, rows, tileRow, frame/growTo, background и bounds.
- [x] Описать fixture Actor с пустыми skills/tracks/stunts и fixture с
  максимальным набором данных.
- [x] Зафиксировать, что editor и loader работают только с разрешёнными
  resolver'ами, а не с произвольным кодом.

**Результат:** схема и тестовые данные, не зависящие от Foundry canvas.

#### Этап 1 — чистый validator и normalizer

Новые файлы: `scripts/layoutSchema.js`, при необходимости
`scripts/layoutModel.js`.

- [x] Проверять `format`, `version`, `id`, `name`, `anchor`, `canvas` и
  `elements`.
- [x] Проверять уникальность id и существование ссылок `anchorTo`, `growTo`,
  `frameFor`.
- [x] Проверять rect, размеры, pitch, font size, orientation и size policy.
- [x] Нормализовать сокращённые поля в каноническую модель builder:
  `rect`, `content`, `style`, `repeat`, `position`, `sizing`, `layer`.
- [x] Применять безопасные defaults, но не исправлять молча структурные ошибки.
- [x] Возвращать диагностический список `{ path, message, severity }`, пригодный
  для import UI и логов.

**Exit criteria:** validator работает в обычном Node-контексте без `canvas`,
корректный fixture нормализуется, каждый намеренно испорченный fixture даёт
понятную ошибку.

#### Этап 2 — loader, registry и первый JSON layout

Новые файлы: `scripts/layoutLoader.js`, `scripts/layoutRegistry.js`,
`layouts/default.json`.

- [x] Реализовать загрузку JSON-ресурса и нормализацию через этап 1.
- [x] На время миграции сохранить `layouts.js` как fallback, если JSON не
  загрузился.
- [x] Зарегистрировать `default` до построения choices в `settings.js`.
- [x] Зафиксировать стратегию загрузки в Foundry v14: предварительный `fetch`
  или другой проверенный module asset path; не использовать неподтверждённый
  JSON import без assertion.
- [x] Добавить `getLayout`, `getLayoutIds`, `registerLayout` и
  `validateLayout` через registry, сохранив текущий публичный контракт.

**Exit criteria:** при обычном запуске выбирается JSON `default`, а при
искусственной ошибке/отсутствии ресурса модуль не падает и использует fallback.

#### Этап 3 — адаптер в `WidgetBuilder` и паритет с текущим default

- [x] Преобразовать нормализованный JSON в текущие descriptors `kind/part/index`
  без изменения `PlacementManager` и `WidgetSync`.
- [x] Реализовать обязательные для текущей раскладки правила:
  `rows`, `tileRow`, `position.anchorTo`, `sizing.growTo`,
  `sizing.width: "canvas"`, background и bounds.
- [x] Сохранить текущую семантику `step` как pitch между началами тайлов.
- [x] Проверить scale, negative origin и dynamic content bounds.
- [x] Сравнить old/new output для Actor с разным числом skill rows и FP:
  документы, part/index, координаты, размеры, текст, font/style, flags.
- [x] После совпадения удалить зависимость runtime от статического описания
  default в `layouts.js`, оставив JS только как fallback/compatibility layer.

**Exit criteria:** переход на JSON не меняет внешний вид и синхронизацию текущих
виджетов; старые сцены открываются без ручного переразмещения.

#### Этап 4 — layout identity и миграция существующих widget

Файлы: `PlacementManager.js`, `WidgetSync.js`, `widgetDrag.js`,
`sheetButton.js`, actor registry.

- [x] При новых размещениях сохранять в actor registry `layoutId` и
  `layoutVersion` рядом с widgetId/sceneId/anchor.
- [x] Для старых записей без layout identity использовать безопасный legacy
  fallback `default`, не меняя anchor и не создавая новый widget.
- [x] При первом успешном sync дописывать identity только после успешной
  валидации выбранного layout.
- [x] Синхронизировать каждый widget по его layoutId, а не одним глобальным
  layout для всех записей актёра.
- [x] Добавить явную операцию «переложить виджет в другой layout», чтобы
  изменение дефолтной настройки не разрушало существующее оформление молча.

**Exit criteria:** два виджета одного Actor на разных сценах могут использовать
разные layouts и сохраняют собственные anchor/layout identity.

#### Этап 5 — каталог resolver'ов и нормализаторы данных

Файлы: `WidgetBuilder.js` и новые чистые formatter/resolver modules.

- [x] Вынести resolver registry из одного объекта в проверяемый каталог с
  metadata: type, content mode, preview support, empty behavior.
- [x] Оставить базовые resolver'ы текущего default без изменения результата.
- [x] Добавить нормализаторы для:
  - skills по rank;
  - всех включённых stress tracks;
  - consequences по track metadata/aspect;
  - stunts;
  - Extras из `actor.items`;
  - details, fate points и rich-text.
- [x] Не полагаться на английские/русские имена треков: использовать поля
  `recovery_type`, `aspect`, `enabled`, `category` и fallback для custom tracks.
- [x] Отдельно решить формат rich-text: text-only или безопасно обогащённый
  текст; не вставлять сырой HTML в Drawing без явного renderer.
- [x] Для каждого resolver определить пустое состояние: скрыть элемент,
  оставить пустую область или показать заголовок.

**Exit criteria:** один fixture Actor с полными данными и один пустой Actor
проходят через все resolver'ы без исключений и с детерминированным output.

#### Этап 6 — встроенные Default, Minimal и Full

Файлы: `layouts/default.json`, `layouts/minimal.json`, `layouts/full.json`,
`settings.js`, языки.

- [x] `Default`: точный перенос текущего layout.
- [x] `Minimal`: только name, portrait и aspects, с собственными background/
  bounds и без пустых документов отсутствующих секций.
- [x] `Full`: name, portrait, FP, aspects, skills, stress, consequences,
  stunts, Extras и согласованный набор details.
- [x] Для Full выбрать читаемую секционную геометрию и orientation, а не
  складывать всё в один бесконечный Drawing.
- [x] Добавить layout names/descriptions в en/ru.
- [x] Проверить, что `getLayoutIds` и choices настроек включают только
  валидные built-in layouts.

**Exit criteria:** три layout доступны в настройках, каждый строится для
пустого и полного Actor, отсутствие данных не создаёт мусорных документов.

#### Этап 7 — PC/NPC layout selection

Файлы: `settings.js`, `PlacementManager.js`, `WidgetSync.js`, возможно
`FatePointManager.js` для списка/инструментов.

- [x] Добавить world settings `playerLayout` и `npcLayout`.
- [x] Реализовать `isPlayerCharacter(actor)` через `hasPlayerOwner` с fallback
  на ownership non-GM users.
- [x] При новом placement автоматически выбирать layout по роли Actor.
- [x] Для legacy records без layoutId применить fallback и сохранить identity.
- [x] Не менять layout уже размещённого widget только из-за изменения этих
  настроек.
- [x] Добавить явное действие смены layout для уже размещённого widget.

**Exit criteria:** PC и NPC в одной сцене используют разные layout по настройкам,
а ручное layout assignment одного виджета имеет приоритет.

#### Этап 8 — публичный registry API и module import/export

- [x] Оформить публичные exports: `registerLayout`, `getLayout`,
  `getLayoutIds`, `validateLayout`.
- [x] Определить policy конфликтов built-in/custom/registered id.
- [x] Реализовать module UI для списка layout, выбора, импорта и экспорта.
- [x] Импортировать JSON из файла или текстового буфера, показать ошибки с
  путями полей и не сохранять невалидные документы.
- [x] Сохранять custom layouts в `customLayouts` world setting.
- [x] Экспортировать выбранную раскладку исходным versioned JSON, совместимым
  со standalone `layout-editor`.

**Exit criteria:** layout можно зарегистрировать внешним модулем, импортировать
из standalone-editor и применить через `WidgetBuilder` без ручной конвертации.

#### Этап 9 — интеграция standalone-editor по контракту

Этап выполняется в проекте `../layout-editor`; модуль уже готов к обмену
(экспорт через `getLayoutJson`, импорт через `importLayoutText`/`saveCustomLayout`).
Контракт синхронизирован: `layoutSchema.js` повторяет валидацию и нормализацию
`layout-editor/src/contract/*` (обязательные `canvas.size`, `anchor`,
`anchor.point`, `scale > 0`, limits 500/20000/1000, дефолты `style.fill`/
`style.stroke`/`layer`/`repeat`/`position.offset`, сохранение неизвестных полей).
Кросс-проверка (Node): редактор принимает все встроенные раскладки модуля,
модуль — фикстуры редактора, нормализованные документы идентичны байт-в-байт,
валидаторы согласованы на испорченных документах.

- [ ] Зафиксировать в `../layout-editor/plan.md` тот же schema version и набор
  resolver ids, что использует модуль.
- [ ] Подготовить несколько JSON fixtures для обмена между двумя проектами.
- [ ] Проверить, что экспорт модуля открывается в standalone-editor.
- [ ] Проверить, что экспорт standalone-editor проходит module validator.
- [ ] Не переносить editor dependencies, React, SVG renderer или File API в
  `chars-to-table`.

**Exit criteria:** обмен JSON в обе стороны детерминирован, а модуль остаётся
работоспособным без наличия standalone-приложения.

#### Этап 10 — документация и ручная проверка module-side

- [x] Обновить README: выбор PC/NPC layout, custom layouts, import/export,
  ссылка на standalone-editor и ограничения импорта.
- [x] Обновить штатные настройки и i18n.
- [x] Проверить migration старых widget records и существующих сцен.
- [x] Проверить синхронизацию Actor после смены layout/данных.
- [x] Проверить Full на Actor с custom tracks, пустыми collections, stunts,
  Extras, последствиями и rich-text.
- [x] Проверить несколько виджетов одного Actor с разными layout ids.
- [x] Проверить права GM/player и невозможность записать invalid layout.
- [x] Провести ручную проверку в Foundry v14 с Advanced Drawing Tools.
- [x] Только после этого отметить module-side часть фичи 4 реализованной.

### 10. Критерии готовности

- `default.json` соответствует доработанной раскладке (layout-editor);
  legacy `layouts.js` сохранён как fallback и покрыт тестом на паритет со
  снапшотом `tests/fixtures/default-legacy.json`, с учётом динамических
  rows/FP.
- Невалидный JSON не попадает в registry и сообщает понятную ошибку.
- Старые widgets продолжают синхронизироваться и не теряют anchor.
- `Minimal` не создаёт скрытые пустые Drawing для отсутствующих секций.
- `Full` отображает skills, tracks/stress, consequences, stunts и Extras на
  реальных Fate Core Actors, включая пустые/кастомные поля.
- `playerLayout` и `npcLayout` выбираются независимо и не дублируют JSON.
- Module import принимает JSON standalone-editor без ручной конвертации.
- Module export открывается standalone-editor и возвращается обратно без потери
  версии, resolver ids и геометрии.
- Standalone-editor редактирует draft JSON без записи scene documents и сохраняет
  координаты в layout units с учётом scale/orientation.
- Built-in раскладки нельзя случайно перезаписать.
- Проверено в Foundry v14 с включённым Advanced Drawing Tools.

---

## Следующий этап после альтернативных лейаутов

После стабилизации layout registry и standalone-editor вернуться к переносу
`challenge.js` в отдельный scene-widget. За пределами текущего плана остаются
`init_players.js`, `ad-hoc_roll.js`, полный перенос `mac_settings.js` и
автоматическая миграция legacy standalone-объектов.

---

## Зафиксированные решения

- **Представление на сцене**: группы состоят из отдельных `Drawing` + `Tile`, а
  не из одной растеризованной картинки. Это даёт нативное редактирование и
  дешёвый автосинк.
- **Actor-widget**: actor-owned документы используют `actorUuid` и реестр
  `actor.flags["chars-to-table"].widgets`.
- **Scene-widget**: GM FP и ситуативные аспекты используют `ownerType`, scene
  registry и не требуют `actorUuid`.
- **Источники данных**: FP игрока хранится в actor system data, FP мастера — в
  совместимом системном user flag, ситуативные аспекты — в системном scene
  flag `fate-core-official.situation_aspects`.
- **Раскладки**: после фичи 4 источником layout data является versioned JSON,
  а builder работает с нормализованной внутренней моделью.
- **Редактор раскладок**: draft редактируется в отдельном standalone web-app и
  не создаёт временные Drawing/Tile-документы на сцене. Модуль содержит только
  runtime loader и import/export.
- **Интерактив сцены**: placement, автосинк и групповой drag входят в базовую
  инфраструктуру; кликабельные игровые элементы добавляются отдельными
  фичами.
- **Настройки**: новые функции используют штатные `game.settings`, а не
  JSON-страницы журнала старого набора макросов.
- **Шрифты**: используются только зарегистрированные в
  `CONFIG.fontDefinitions`; незарегистрированный шрифт заменяется на
  Montserrat с предупреждением.
- **Legacy-объекты**: старые документы макросов не удаляются автоматически без
  явной процедуры миграции.

---

## Структура модуля

```
chars-to-table/
  module.json
  PLAN.md
  README.md
  LICENSE
  LAYOUT-FORMAT.md          # локальный, ignored, рабочая спецификация JSON
  layouts/                  # built-in JSON layouts (default, minimal, full)
  languages/
    en.json
    ru.json
  styles/
    module.css
  scripts/
    module.js               # init/ready, хуки, scene controls
    constants.js            # module, actor/scene flags, системные ключи
    sheetButton.js          # команды в меню чарника
    WidgetBuilder.js        # resolver-каталог, геометрия, Drawing/Tile payloads
    layoutSchema.js         # validator/normalizer JSON-раскладок (чистый)
    layoutGeometry.js       # чистая геометрия JSON-модели (чистый)
    layoutLoader.js         # fetch built-in, legacy fallback, custom layouts
    layoutRegistry.js       # публичный registry API
    LayoutImportExport.js   # GM-диалог списка/импорта/экспорта раскладок
    layouts.js              # legacy JS-шаблон (fallback-источник)
    PlacementManager.js     # placement для actor и scene-owned групп
    WidgetSync.js            # actor-widget sync/reconcile
    FatePointManager.js      # GM-диалог, newScene, interactions
    FatePointSync.js         # отдельный GM FP-ряды и scene registry
    SituationAspectManager.js # менеджер аспектов и размещение
    SituationAspectSync.js   # нормализация, документы и sync аспектов
    widgetDocs.js            # поиск документов группы
    widgetDrag.js            # групповой drag и сохранение anchor
    settings.js              # штатные настройки и file/font pickers
  tests/                     # Node-тесты чистых модулей (npm test)
```

---

## Ключевые технические решения

### Идентификация групп

- Actor-widget:
  `flags["chars-to-table"] = { widgetId, part, index, actorUuid }`.
- GM scene-widget:
  `flags["chars-to-table"] = { widgetId, part, index, ownerType: "gm" }`.
- Situation aspect scene-widget:
  `flags["chars-to-table"] = { widgetId, part, index, ownerType: "situationAspects" }`.
- Осиротевшие записи очищаются только по module flags и registry; поиск по
  содержимому текста Drawing не используется.

### Формат layout

JSON layout содержит version, id, anchor, virtual canvas, background, bounds и
массив элементов. Каждый элемент имеет type, rect, content/resolver, style и
опциональные repeat/position/sizing правила. Внутри runtime:

```text
JSON -> validate/normalize (layoutSchema) -> resolve data (resolver catalog)
     -> geometry (layoutGeometry) -> WidgetBuilder -> Drawing/Tile
```

Resolver catalog является единственным местом, где разрешается код подготовки
данных. Сам JSON остаётся декларативным. Чистые модули (`layoutSchema`,
`layoutGeometry`, `layoutRegistry`) не зависят от Foundry и покрыты Node-тестами
в `tests/` (`npm test`). Геометрия `default` проверяется на паритет с прежней
`layouts.js` (включая legacy-конвертацию `legacyToJson` как fallback при
недоступности JSON-ресурсов).

Widget records хранят layout identity:

```js
{ widgetId, sceneId, anchor: { x, y }, layoutId: "default", layoutVersion: 1 }
```

Legacy-записи без identity получают роль-раскладку (`playerLayout`/`npcLayout`)
при первом успешном синке; явная смена раскладки через меню чарника имеет
приоритет над настройками.

### Placement и автосинк

- Placement использует DOM-события `pointermove`/`pointerdown` на
  `canvas.app.view`, потому что PIXI-события могут перехватываться Foundry.
- Координаты получают через inverse world transform или публичные методы Canvas
  преобразования координат.
- Коммит создаёт документы batch-запросами и сохраняет registry после успешного
  создания.
- `updateActor` вызывает actor-widget sync с debounce 400 мс.
- `canvasReady` выполняет реконсиляцию actor-widget и синхронизацию scene-owned
  групп.
- Обновления, инициированные синком, помечаются `charsToTableSync`, чтобы не
  запускать рекурсивный групповой drag.

### Advanced Drawing Tools

Текстовые Drawing получают ADT-флаги с `dropShadow: false`,
`strokeThickness: 0`, `align` и при необходимости `fontWeight`.
