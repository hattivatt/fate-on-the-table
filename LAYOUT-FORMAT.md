# Формат JSON-раскладки виджета персонажа

Документ описывает внешний текстовый формат раскладок для виджета персонажа.
Раскладка должна описывать не только список элементов, но и виртуальный canvas,
на котором эти элементы размещаются: его начало, размеры, поведение при
переполнении и служебные слои фона/границ.

Формат рассчитан на последующую загрузку из JSON-файлов. Он не обязан повторять
внутреннюю структуру `layouts.js`: внутренний builder должен преобразовывать
JSON в текущие дескрипторы `WidgetBuilder`.

## Основные цели

- одна раскладка описывается обычным JSON без JavaScript-кода;
- координаты и размеры элементов видны непосредственно в документе;
- у раскладки есть собственный canvas с шириной и высотой;
- поддерживаются статические элементы, строки переменной длины и ряды тайлов;
- можно описывать зависимости между элементами, например «ряд жетонов внутри
  рамки»;
- фон, рамка и drag-box являются частью описания, а не скрытой логикой builder;
- размеры и координаты масштабируются общим параметром `scale`;
- формат позволяет сохранить текущую геометрию `default` без потери поведения.

## Минимальная структура документа

```json
{
  "format": "fate-on-the-table.layout",
  "version": 1,
  "id": "unique-layout-id",
  "name": "Human-readable name",
  "anchor": {
    "element": "portrait",
    "point": "topLeft"
  },
  "scale": 1,
  "canvas": {},
  "background": {},
  "bounds": {},
  "elements": []
}
```

### Обязательные поля верхнего уровня

| Поле | Тип | Назначение |
|---|---|---|
| `format` | string | Идентификатор формата. Всегда `fate-on-the-table.layout`. |
| `version` | integer | Версия схемы JSON. Начальная версия — `1`. |
| `id` | string | Стабильный уникальный идентификатор раскладки. |
| `name` | string | Название для списка выбора в настройках. |
| `anchor` | object | Точка, относительно которой размещается canvas. |
| `scale` | number | Базовый масштаб раскладки до runtime-override модуля. |
| `canvas` | object | Виртуальная рабочая поверхность раскладки. |
| `elements` | array | Элементы персонажного виджета. |

`background` и `bounds` необязательны. Если они отсутствуют, canvas не получает
автоматическую подложку или drag-box.

## Координатная система и canvas

Canvas раскладки — это не canvas Foundry, а локальная поверхность дизайна.

- X направлен вправо, Y — вниз.
- Единицы — базовые scene-пиксели до применения runtime-масштаба.
- `canvas.origin` задаёт положение верхнего левого угла поверхности относительно
  anchor виджета.
- Координаты элементов (`rect.x`, `rect.y`) задаются относительно левого
  верхнего угла canvas.
- Фактическая координата сцены рассчитывается так:

  ```text
  scene = widgetAnchor + canvas.origin + element.rect.position
  ```

- `scale` умножает `origin`, координаты, размеры, line height, pitch и размеры
  шрифтов.
- Никаких неявных общих сдвигов вроде `drawingOffset` в JSON нет: такой сдвиг
  должен быть отражён в `canvas.origin` или в явных координатах элементов.

### Поля canvas

```json
{
  "origin": { "x": -150, "y": -200 },
  "size": { "width": 659, "height": 849 },
  "sizePolicy": {
    "mode": "content",
    "minimum": { "width": 659, "height": 568 },
    "overflow": "expand"
  }
}
```

- `origin` обязателен. Он выражен относительно anchor.
- `size` обязателен: это базовый/reference-размер canvas. Он нужен для дизайна,
  preview и элементов, растягиваемых на canvas.
- `sizePolicy.mode`:
  - `fixed` — размеры canvas всегда равны `size`;
  - `content` — bounds вычисляются по элементам, но не меньше `minimum`.
- `sizePolicy.minimum` — минимальные размеры при `mode: "content"`.
- `sizePolicy.overflow`:
  - `clip` — элементы не расширяют canvas;
  - `expand` — canvas расширяется вправо/вниз под динамический контент.

Если `sizePolicy` отсутствует, используется `fixed`.

## Anchor

`anchor` обязателен и должен ссылаться на элемент раскладки:

```json
"anchor": {
  "element": "portrait",
  "point": "topLeft"
}
```

`element` должен ссылаться на элемент раскладки. Допустимые точки:

- `topLeft`, `topCenter`, `topRight`;
- `centerLeft`, `center`, `centerRight`;
- `bottomLeft`, `bottomCenter`, `bottomRight`.

Для текущего виджета anchor — левый верхний угол портрета. В placement-flow
пользователь выбирает положение этой точки на сцене.

## Элемент раскладки

Каждый объект в `elements` имеет следующую общую форму:

```json
{
  "id": "unique-element-id",
  "type": "drawing",
  "rect": {
    "x": 0,
    "y": 0,
    "width": 200,
    "height": 40
  },
  "content": {
    "resolver": "@name",
    "mode": "value"
  },
  "style": {},
  "position": {},
  "repeat": {},
  "sizing": {},
  "layer": {}
}
```

### Идентификатор и тип

- `id` обязателен и уникален внутри раскладки. На него могут ссылаться другие
  элементы через `anchorTo` или `growTo`.
- `type` определяет создаваемый документ:
  - `tile` — один `Tile`, обычно изображение портрета;
  - `tileRow` — несколько `Tile`, количество задаётся resolver'ом;
  - `drawing` — один или несколько `Drawing` с текстом или рамкой.

### Rect

`rect` всегда содержит `x`, `y`, `width`, `height`.

- Для обычного элемента все значения — числа.
- `width`/`height` описывают область документа, а не только размер видимого
  текста.
- Для динамического элемента `rect` задаёт размер одного экземпляра или
  минимальный размер области; фактический canvas может расшириться по
  `sizePolicy`.
- `rect.x` и `rect.y` используются как fallback, если элемент имеет
  относительную привязку в `position`.

### Content и resolver'ы

```json
"content": {
  "resolver": "@aspects",
  "mode": "value"
}
```

`resolver` — ключ функции, которая получает actor и возвращает данные.
`mode` определяет, как эти данные интерпретируются:

- `value` — одна строка для `Drawing`;
- `image` — путь к текстуре для одного `Tile`;
- `count` — целое количество экземпляров для `tileRow`;
- `rows` — массив строк для повторяющегося `Drawing`;
- `boxRow` — массив массивов текстов для чекбоксов **стресса**: каждая
  вложенная строка создаёт отдельный Drawing на каждый бокс; строки идут по
  вертикали через `repeat.pitch`, боксы внутри строки — по горизонтали с
  небольшим зазором. Последствия чекбоксов **не имеют** — они текстовые
  строки цены (`@consequenceCostRows`). Без `position` boxRow позиционируется
  собственным абсолютным `rect`/`repeat` (так заданы встроенные раскладки);
  `position.anchorTo` для boxRow — legacy-совместимая опция;
- `empty` — пустой `Drawing`, используемый как рамка.

На первом этапе формат должен поддержать текущие resolver'ы:

| Resolver | Mode | Результат |
|---|---|---|
| `@name` | `value` | Имя актёра. |
| `@portrait` | `image` | Путь к портрету актёра. |
| `@headerAspects` | `value` | Локализованный заголовок «Аспекты». |
| `@aspects` | `value` | Аспекты актёра одной строкой с разделителями. |
| `@shortAspects` | `value` | Первые два непустых аспекта в порядке `system.aspects`. |
| `@headerFatePoints` | `value` | Локализованный заголовок «Жетоны». |
| `@fatePointTokens` | `count` | Текущее количество FP актёра. |
| `@headerSkills` | `value` | Локализованный заголовок «Компетенции». |
| `@skillNames` | `rows` | Группы названий навыков по рангам. |
| `@skillValues` | `rows` | Значения рангов (`+4`, `+3` и т.д.). |
| `@stressTrackNames` | `rows` | Названия включённых стресс-треков. |
| `@stressBoxRows` | `boxRow` | Тексты отдельных стресс-боксов (`X` или пустая строка). |
| `@consequencesHeader` | `value` | Локализованный заголовок «Последствия»; пустой, если у актёра нет слотов последствий. |
| `@consequenceCostRows` | `rows` | Строки последствий по цене: занятый слот — имя последствия (с ценой `harm_can_absorb`, если есть), свободный слот — цена с подчёркиваниями. |
| `@empty` | `empty` | Пустой Drawing без текста. |

> **Последствия — только текст.** Интерактивных consequence-чекбоксов нет:
> последствия отображаются текстовым блоком «заголовок + строки цены»
> (`@consequencesHeader` + `@consequenceCostRows`), редактируются двойным
> кликом. Resolver `@consequenceBoxRows` (режим `boxRow`, одиночная ячейка
> на aspect-трек) **удалён и не поддерживается** — layouts, ссылающиеся на
> него, отклоняются валидатором (неизвестный resolver) и не создают
> чекбоксов. Текстовый дублирующий `@consequenceNames` больше не нужен на
> карточке и не входит во встроенные раскладки.

Позднее могут появляться resolver'ы для стресс-треков, предметов, аспектов
статуса и других данных, но JSON раскладки не должен содержать JavaScript-код.

#### Правило `@consequenceCostRows` / `@consequencesHeader`

Правило применяется только к aspect-трекам (`isAspectTrack`: у трека есть
`aspect.when_marked` или `aspect.as_name`) в исходном порядке
`actor.system.tracks`. **Каждый включённый aspect-трек — занятый или
свободный — получает свою строку** `@consequenceCostRows` (занятый: имя
последствия, свободный: его цену `harm_can_absorb` с подчёркиваниями) и одну
строку заголовка `@consequencesHeader` на всю секцию (пустой, если слотов
нет). Трек считается **занятым**, если непусто `aspect.name` и/или истинно
`box_values[0]`. Свободные последствия не исчезают: у свободного трека
показывается цена с подчёркиваниями. Актёр без aspect-треков вообще не
создаёт ни строк, ни заголовка. Legacy `@consequences` (`[ ]`/`[X]`) и
удалённый `@consequenceBoxRows` не используются во встроенных раскладках.

#### Правило `@shortAspects`

`@shortAspects` берёт **первые два непустых** значения `.value` объектной
коллекции `actor.system.aspects` в её каноническом (порядок ключей чарника)
порядке — обычно это High concept и Trouble. Сортировки нет, имена слотов не
захардкожены (не зависят от языка), пустые/отсутствующие значения пропускаются,
а пустой или отсутствующий actor даёт пустую строку. Разделитель между
аспектами — пустая строка (`\n\n`), как у `@aspects`.

### Style

Стиль хранится отдельно от геометрии:

```json
"style": {
  "fontFamily": "Montserrat",
  "fontSize": 20,
  "fontWeight": 400,
  "textColor": "#000000",
  "textAlign": "left",
  "fill": {
    "type": "none",
    "color": "#ffffff",
    "alpha": 0
  },
  "stroke": {
    "width": 0,
    "color": "#000000",
    "alpha": 0
  }
}
```

Для `tile` применяются `rect.width`/`rect.height`, а `style` обычно не нужен.
Для `drawing`:

- `fontFamily` проходит через проверку зарегистрированных шрифтов;
- `fontSize` масштабируется вместе с раскладкой;
- `stroke.width` также масштабируется вместе с раскладкой (как `rect` и
  шрифт): тонкая линия `1` остаётся пропорциональной и на увеличенном
  виджете, и на спроецированных карточках конфликта; `0` всегда остаётся
  нулём;
- `fontWeight` и `textAlign` передаются также в ADT-флаги;
- `textColor` — цвет текста;
- `fill` и `stroke` позволяют описать рамку без отдельного специального типа.

Runtime-настройки модуля могут переопределять `fontFamily` и `textColor`, но
не должны менять JSON-файл.

### Повторяющиеся элементы

Для `drawing` со списком строк:

```json
"content": { "resolver": "@skillNames", "mode": "rows" },
"repeat": {
  "axis": "y",
  "pitch": 68,
  "itemHeight": 68
}
```

- каждый элемент массива resolver'а создаёт отдельный Drawing;
- `pitch` — расстояние между началами соседних экземпляров;
- `itemHeight` — высота Drawing одного экземпляра;
- если `itemHeight` не задан, используется `rect.height`.

Для `tileRow`:

```json
"content": { "resolver": "@fatePointTokens", "mode": "count" },
"repeat": {
  "axis": "x",
  "direction": "forward",
  "pitch": 20
}
```

`pitch` — расстояние между началами тайлов, а не свободный зазор между ними.
Например, при ширине тайла `70` и pitch `20` тайлы перекрываются на `50`
единиц. Это сохраняет семантику текущего поля `step`.

Допустимые направления: `forward`, `backward`. Для вертикальных рядов можно
использовать `axis: "y"`.

### Относительное позиционирование элементов

Элемент может быть привязан к другому элементу:

```json
"position": {
  "anchorTo": "fatePointsFrame",
  "anchorPoint": "leftCenter",
  "selfPoint": "leftCenter",
  "offset": { "x": 0, "y": 0 }
}
```

Сначала вычисляется `rect` элемента-источника, затем к нему прикладывается
`selfPoint` целевого элемента. `offset` задаётся в координатах раскладки и
масштабируется. Если `position` не задан, используются `rect.x`/`rect.y`.

`position.anchorTo` — legacy-совместимая опция для старых раскладок:
канонические встроенные раскладки позиционируют boxRow-элементы (стресс и
последствия) абсолютными `rect`/`repeat`, без `position`. Для boxRow,
привязанного `anchorTo` к элементу `rows`, legacy-геометрия выравнивает
каждый ряд боксов по измеренной ширине текста соответствующей строки —
встроенные раскладки так не делают.

Для динамической рамки:

```json
"sizing": {
  "growTo": "fatePointTokens",
  "padding": 7,
  "minimum": true
}
```

Рамка расширяется до bounds указанного элемента плюс padding, но не становится
меньше собственного `rect`. Это замена текущей пары `frameFor`/`pad`.

Для элемента, который должен занять всю ширину canvas:

```json
"sizing": {
  "width": "canvas"
}
```

Такой элемент получает фактическую ширину canvas после расчёта bounds. Это
замена текущего `matchBoundsWidth`.

### Layer

```json
"layer": {
  "elevation": 0,
  "sort": 0
}
```

`elevation` и `sort` определяют порядок отображения документов. Обычно:

- background — отрицательные значения;
- основной текст и тайлы — `0`;
- drag-box/frame — большие положительные значения.

## Фон и drag-box раскладки

Фон и drag-box относятся ко всему canvas и поэтому вынесены из `elements`.

### Background

```json
"background": {
  "enabled": true,
  "fill": {
    "color": "#ffffff",
    "alpha": 1
  },
  "texture": {
    "source": "@setting.backgroundTexture",
    "whenEmpty": "fill"
  },
  "layer": {
    "elevation": -10,
    "sort": -1000
  }
}
```

`source` может ссылаться на настройку модуля. Если текстура пустая, используется
`fill`. Background получает bounds canvas и не должен менять anchor.

### Bounds

```json
"bounds": {
  "enabled": true,
  "rect": "canvas",
  "stroke": {
    "width": 1,
    "color": "#000000",
    "alpha": 0.2
  },
  "layer": {
    "elevation": 10,
    "sort": 1000
  }
}
```

Bounds — прозрачный или почти прозрачный Drawing для перемещения всей группы.
Он получает тот же `widgetId`, что и элементы раскладки.

## Правила валидации

JSON loader должен отклонять раскладку, если:

- отсутствуют `format`, `version`, `id`, `name`, `canvas` или `elements`;
- `format` неизвестен или `version` не поддерживается;
- `id` элемента повторяется;
- `anchor.element` ссылается на несуществующий элемент;
- `position.anchorTo`, `sizing.growTo` или `frame` ссылаются на несуществующий
  элемент;
- `rect` не содержит числовых `x`, `y`, `width`, `height`;
- ширина/высота, pitch или font size отрицательны;
- `type` или `content.mode` не поддерживаются;
- resolver не зарегистрирован.

Неизвестные необязательные поля можно игнорировать с предупреждением, чтобы
новые версии формата могли добавлять возможности без поломки старых loader'ов.

## Референс: текущая раскладка `default`

> Канонический документ живёт в `layouts/default.json`; ниже — JSON-описание
> эффективной геометрии (может отставать от канона на деталях координат).
> `Default` показывает стресс: названия треков слева, кликабельные чекбоксы
> с тонкими границами (`stroke.width: 1`), поднятые над «хватательной»
> рамкой. Последствий в `Default` **нет**: ни секции `consequences`, ни
> `consequenceCostRows`/`consequenceBoxRows` в неё не входят. Чекбоксы стресса заданы абсолютным
> `rect`/`repeat`, без `position.anchorTo`.
>
> Это **нормализованное описание эффективной геометрии**:

- текущий `drawingOffset` уже преобразован в `canvas.origin`;
- координаты элементов переведены из anchor-relative в canvas-local;
- текущие `frameFor`, `pad`, `frameAnchor` и `matchBoundsWidth` представлены
  через `sizing`/`position`;
- `referenceSize.height = 849` соответствует четырём строкам компетенций, как
  на исходной картинке-примере;
- фактический canvas остаётся динамическим: список навыков и ряд FP могут
  расширить его по `sizePolicy`.

Минимальная статическая высота текущей раскладки — `568`: это canvas без строк
компетенций. При четырёх строках высота становится `849` (`4 × 68` добавляются
к нижней части таблицы). Минимальная ширина — `659`.

```json
{
  "format": "fate-on-the-table.layout",
  "version": 1,
  "id": "default",
  "name": "Default",
  "description": "Character sheet widget based on the current Fate Core layout.",
  "anchor": {
    "element": "portrait",
    "point": "topLeft"
  },
  "scale": 1,
  "canvas": {
    "origin": {
      "x": -150,
      "y": -200
    },
    "size": {
      "width": 659,
      "height": 849
    },
    "sizePolicy": {
      "mode": "content",
      "minimum": {
        "width": 659,
        "height": 568
      },
      "overflow": "expand"
    }
  },
  "background": {
    "enabled": true,
    "fill": {
      "color": "#ffffff",
      "alpha": 1
    },
    "texture": {
      "source": "@setting.backgroundTexture",
      "whenEmpty": "fill"
    },
    "layer": {
      "elevation": -10,
      "sort": -1000
    }
  },
  "bounds": {
    "enabled": true,
    "rect": "canvas",
    "stroke": {
      "width": 1,
      "color": "#000000",
      "alpha": 0.2
    },
    "layer": {
      "elevation": 10,
      "sort": 1000
    }
  },
  "elements": [
    {
      "id": "name",
      "type": "drawing",
      "rect": {
        "x": 0,
        "y": 0,
        "width": 659,
        "height": 28
      },
      "content": {
        "resolver": "@name",
        "mode": "value"
      },
      "style": {
        "fontFamily": "Montserrat",
        "fontSize": 26,
        "fontWeight": 800,
        "textColor": "#000000",
        "textAlign": "center"
      },
      "sizing": {
        "width": "canvas"
      }
    },
    {
      "id": "portrait",
      "type": "tile",
      "rect": {
        "x": 150,
        "y": 200,
        "width": 270,
        "height": 270
      },
      "content": {
        "resolver": "@portrait",
        "mode": "image"
      }
    },
    {
      "id": "aspectsHeader",
      "type": "drawing",
      "rect": {
        "x": 325,
        "y": 50,
        "width": 300,
        "height": 68
      },
      "content": {
        "resolver": "@headerAspects",
        "mode": "value"
      },
      "style": {
        "fontFamily": "Montserrat",
        "fontSize": 20,
        "fontWeight": 400,
        "textColor": "#000000",
        "textAlign": "center"
      }
    },
    {
      "id": "aspects",
      "type": "drawing",
      "rect": {
        "x": 315,
        "y": 118,
        "width": 333,
        "height": 450
      },
      "content": {
        "resolver": "@aspects",
        "mode": "value"
      },
      "style": {
        "fontFamily": "Montserrat",
        "fontSize": 20,
        "fontWeight": 400,
        "textColor": "#000000",
        "textAlign": "center"
      }
    },
    {
      "id": "fatePointsLabel",
      "type": "drawing",
      "rect": {
        "x": 48,
        "y": 353,
        "width": 200,
        "height": 17
      },
      "content": {
        "resolver": "@headerFatePoints",
        "mode": "value"
      },
      "style": {
        "fontFamily": "Montserrat",
        "fontSize": 18,
        "fontWeight": 400,
        "textColor": "#000000",
        "textAlign": "center"
      }
    },
    {
      "id": "fatePointsFrame",
      "type": "drawing",
      "rect": {
        "x": 0,
        "y": 386,
        "width": 307,
        "height": 97
      },
      "content": {
        "resolver": "@empty",
        "mode": "empty"
      },
      "style": {
        "fill": {
          "type": "none",
          "color": "#ffffff",
          "alpha": 0
        },
        "stroke": {
          "width": 2,
          "color": "#000000",
          "alpha": 1
        }
      },
      "sizing": {
        "growTo": "fatePointTokens",
        "padding": 7,
        "minimum": true
      }
    },
    {
      "id": "fatePointTokens",
      "type": "tileRow",
      "rect": {
        "x": 0,
        "y": 0,
        "width": 70,
        "height": 70
      },
      "content": {
        "resolver": "@fatePointTokens",
        "mode": "count"
      },
      "position": {
        "anchorTo": "fatePointsFrame",
        "anchorPoint": "leftCenter",
        "selfPoint": "leftCenter",
        "offset": {
          "x": 0,
          "y": 0
        }
      },
      "repeat": {
        "axis": "x",
        "direction": "forward",
        "pitch": 20
      }
    },
    {
      "id": "skillsHeader",
      "type": "drawing",
      "rect": {
        "x": 32,
        "y": 529,
        "width": 300,
        "height": 17
      },
      "content": {
        "resolver": "@headerSkills",
        "mode": "value"
      },
      "style": {
        "fontFamily": "Montserrat",
        "fontSize": 18,
        "fontWeight": 400,
        "textColor": "#000000",
        "textAlign": "center"
      }
    },
    {
      "id": "skillName",
      "type": "drawing",
      "rect": {
        "x": 8,
        "y": 577,
        "width": 583,
        "height": 68
      },
      "content": {
        "resolver": "@skillNames",
        "mode": "rows"
      },
      "repeat": {
        "axis": "y",
        "pitch": 68,
        "itemHeight": 68
      },
      "style": {
        "fontFamily": "Montserrat",
        "fontSize": 16,
        "fontWeight": 400,
        "textColor": "#000000",
        "textAlign": "center",
        "stroke": {
          "width": 2,
          "color": "#000000",
          "alpha": 1
        }
      }
    },
    {
      "id": "skillValue",
      "type": "drawing",
      "rect": {
        "x": 591,
        "y": 577,
        "width": 68,
        "height": 68
      },
      "content": {
        "resolver": "@skillValues",
        "mode": "rows"
      },
      "repeat": {
        "axis": "y",
        "pitch": 68,
        "itemHeight": 68
      },
      "style": {
        "fontFamily": "Bruno Ace",
        "fontSize": 30,
        "fontWeight": 400,
        "textColor": "#000000",
        "textAlign": "center",
        "stroke": {
          "width": 2,
          "color": "#000000",
          "alpha": 1
        }
      }
    },
    {
      "id": "stressTrackNames",
      "type": "drawing",
      "rect": {
        "x": 13,
        "y": 440,
        "width": 182,
        "height": 44
      },
      "content": {
        "resolver": "@stressTrackNames",
        "mode": "rows"
      },
      "repeat": {
        "axis": "y",
        "pitch": 44,
        "itemHeight": 44
      },
      "style": {
        "fontFamily": "Montserrat",
        "fontSize": 20,
        "fontWeight": 400,
        "textColor": "#000000",
        "textAlign": "left"
      }
    },
    {
      "id": "stressBoxRows",
      "type": "drawing",
      "rect": {
        "x": 195,
        "y": 440,
        "width": 20,
        "height": 20
      },
      "content": {
        "resolver": "@stressBoxRows",
        "mode": "boxRow"
      },
      "repeat": {
        "axis": "y",
        "pitch": 44,
        "itemHeight": 44
      },
      "layer": {
        "elevation": 20,
        "sort": 2000
      },
      "style": {
        "fontFamily": "Montserrat",
        "fontSize": 14,
        "fontWeight": 400,
        "textColor": "#000000",
        "textAlign": "center",
        "fill": {
          "type": "none",
          "color": "#ffffff",
          "alpha": 0
        },
        "stroke": {
          "width": 1,
          "color": "#000000",
          "alpha": 1
        }
      }
    }
  ]
}
```

## Соответствие текущему `layouts.js`

| Текущий JS-параметр | JSON-представление |
|---|---|
| `id`, `name`, `scale` | Верхнеуровневые поля `id`, `name`, `scale`. |
| `drawingOffset` | Развёрнут в `canvas.origin` и локальные `rect`. |
| `x`, `y`, `w`, `h` | `rect.x`, `rect.y`, `rect.width`, `rect.height`. |
| `content: "@name"` | `content: { "resolver": "@name", "mode": "value" }`. |
| `rows: "@skillNames"` | `content.mode: "rows"` + `repeat`. |
| `step` у `tileRow` | `repeat.pitch`. |
| `frameAnchor` | `position.anchorTo` и `position.anchorPoint`. |
| `frameFor` / `pad` | `sizing.growTo` / `sizing.padding`. |
| `matchBoundsWidth` | `sizing.width: "canvas"`. |
| `background` | Верхнеуровневый объект `background`. |
| `bounds` | Верхнеуровневый объект `bounds`. |
| `font`, `size`, `color`, `align`, `weight` | `style.fontFamily`, `fontSize`, `textColor`, `textAlign`, `fontWeight`. |

При реализации loader сначала следует преобразовать JSON в текущую внутреннюю
модель. После стабилизации формата `layouts.js` можно заменить статический
реестр загрузкой JSON, не меняя PlacementManager и WidgetSync.
