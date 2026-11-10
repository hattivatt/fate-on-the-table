# Релиз

`module.json` хранит placeholders `#{URL}#`, `#{MANIFEST}#` и `#{DOWNLOAD}#`.
Перед созданием тега подставьте в них реальные URL с версией.

1. Обновите `version` в `module.json`.
2. Подставьте версию в `manifest` и `download`.
3. Создайте и запушьте тег:

   ```sh
   git tag v1.2.3
   git push origin v1.2.3
   ```

`.github/workflows/release.yml` проверит, что `version` совпадает с тегом, а
`manifest` и `download` содержат эту версию. Затем он соберёт `module.zip`
только из runtime-файлов:

```text
module.json LICENSE README.md scripts/ styles/ layouts/ languages/ packs/
```

`tests/`, `docs/`, `tools/`, `devenv.*`, `package*.json`, `AGENTS.md`,
`PLAN.md`, `LAYOUT-FORMAT.md` и `.github/` в архив не попадают. Список задан
явным allowlist в workflow: новые dev-файлы не нужно добавлять в исключения.

Готовый `module.zip` и `module.json` прикрепляются к GitHub Release.
