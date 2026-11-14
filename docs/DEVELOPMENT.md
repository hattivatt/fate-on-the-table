# Разработка

## Окружение

Зависимости фиксируются `devenv.nix` / `devenv.yaml` / `devenv.lock`.

```sh
devenv shell
```

С `direnv` достаточно один раз выполнить `direnv allow` в корне репозитория.
Проверить, что окружение поднялось:

```sh
node --version
npm --version
```

## Установка и тесты

```sh
npm ci
npm test
```

`npm test` запускает только Node-тесты чистой логики и не требует запущенного
Foundry. Перед коммитом также проверяйте синтаксис изменённых скриптов:

```sh
node --check scripts/module.js
```

## Живой запуск в Foundry

Скрипт линкует текущий checkout в данные Foundry, чтобы не держать второй клон.

```sh
export FOUNDRY_DATA="$HOME/.local/share/FoundryVTT/v14/Data"
npm run dev:link
```

По умолчанию используется `$HOME/.local/share/FoundryVTT/v14/Data`. Другой путь
можно передать через `FOUNDRY_DATA` или `--data`:

```sh
npm run dev:link -- --data /path/to/FoundryVTT/Data
```

Если по целевому пути уже лежит другой каталог (например, старый клон), скрипт
откажется его трогать. С `--force` существующий каталог переименовывается в
`fate-on-the-table.backup-<timestamp>`, после чего создаётся ссылка.

Удалить ссылку:

```sh
npm run dev:unlink
```

В Foundry должны быть установлены:

- система `fate-core-official` (минимум `4.7.14.12`);
- модуль `advanced-drawing-tools`, если проверяете выравнивание текста.

После включения модуля в тестовом мире изменения в рабочем дереве подхватываются
без пересборки.

## Паки компендиума

Человекочитаемый источник — `packs/challenge-contest.jsonl` и
`packs/challenge-contest.macro.js`. LevelDB-каталог
`packs/challenge-contest/` собирается командой:

```sh
npm run build:packs
```

Foundry пишет в LevelDB при работе с компендиумом, поэтому `git status` может
показывать изменения `CURRENT`, `MANIFEST-*` и `*.log`. Перед коммитом
пересоберите пак из JSONL. Служебные `LOCK`, `LOG` и `LOG.old` в репозиторий не
попадают.

## layout-editor

Визуальный редактор раскладок остаётся отдельным sibling-репозиторием и нужен
только для работы над форматом раскладок:

```sh
git clone git@github.com:hattivatt/layout-editor.git ../layout-editor
cd ../layout-editor
npm ci
npm run dev
```

`layout-editor` ожидает модуль по пути `../fate-on-the-table`, поэтому клоны
должны лежать рядом. Его тесты `tests/moduleCompatibility.test.ts` и
`tests/moduleGeometry.test.ts` читают `layouts/` и `scripts/` этого репозитория.

## Перед PR

```sh
npm test
```

## Деплой на сервер `thecomet`

На сервере `thecomet` модуль установлен git-клоном этого репозитория (ветка
`main`), поэтому деплой — это обычный `git pull` после пуша:

```sh
git push origin main
ssh thecomet 'cd /home/hattivatt/.local/share/FoundryVTT/v14/Data/modules/fate-on-the-table && git pull --ff-only'
```

После `git pull` перезагрузите страницу мира в браузере (F5). Перезапуск
Foundry нужен только при изменении `module.json` (манифест, паки, языки).

Foundry пишет в LevelDB-каталог `packs/challenge-contest/` на сервере, поэтому
там могут появляться неотслеживаемые или изменённые файлы пака. Если `git pull`
отказывается из-за них, сначала посмотрите `git status` на сервере и не
удаляйте чужие файлы вслепую.
