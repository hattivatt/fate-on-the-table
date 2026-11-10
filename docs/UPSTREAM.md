# Внешние зависимости

## fate-core-official

Система Foundry, с которой работает модуль. Устанавливается через Foundry в
`Data/systems`, в репозиторий не входит. Минимальная версия указана в
`module.json`.

- Upstream: <https://github.com/Sk1mble/fate-core-official>
- Используемые флаги: `fate-core-official.gmfatepoints`,
  `fate-core-official.situation_aspects`, `fate-core-official.hasActed`.

## layout-editor

Отдельное standalone-приложение для визуального редактирования раскладок.
Разработка ведётся в sibling-репозитории `../layout-editor`; модуль и редактор
сверяют контракт `layoutSchema` / `layoutGeometry` в кросс-тестах редактора.

- Upstream: <https://github.com/hattivatt/layout-editor>

## token-mold

Источник генерации имён токенов. В репозиторий не входит; адаптированные
словари лежат в `scripts/dict/`.

- Upstream: <https://github.com/Moerill/token-mold>
- Лицензия: MIT, © 2020 Moerill. Полный текст — в
  [THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md).

## foundry_macro

Старые standalone-макросы, из которых выросли виджет персонажа и
challenge/contest. В сборку не входят. Историческая ссылка остаётся в
комментарии `scripts/challengeContest.js`.
