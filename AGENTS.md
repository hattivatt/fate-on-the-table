# AGENTS.md

Guidelines for AI agents working in this repository.

## Commit convention

- Use [Conventional Commits](https://www.conventionalcommits.org/) format:
  `<type>: <short description>` (e.g. `feat: ...`, `fix: ...`, `refactor: ...`).
- Keep the message short and in English.
- Commit only when the user explicitly asks for it.

## Architecture

- **Pure modules vs Foundry glue:** pure logic lives in Foundry-free modules
  importable from Node (`layoutSchema`, `layoutGeometry`, `conflictBoardSchema`,
  `conflictBoardGeometry`, `situationAspect*`, `utils.js`, `nameGenerator.js`,
  etc.). They never touch top-level `foundry`/`game`/`canvas`/`CONFIG` at
  import time. Thin glue (`module.js`, `WidgetSync`, `ConflictBoardSync`, …)
  wires hooks, `ApplicationV2`, `Drawing`/`Tile` I/O.
- **Lazy `ApplicationV2` guard:** UI managers must use the lazy guard pattern
  from `ConflictManager.js` — reference `foundry.applications.api.ApplicationV2`
  only inside a getter / init function so the module imports cleanly in Node
  tests. Pure rendering / actions are extracted to testable modules.
- **Resolver catalog:** JSON layouts are declarative; runtime logic is only
  via an allow-listed resolver catalog (`WidgetBuilder.js`). No code in JSON.
- **Pure extract:** domain logic that can be pure must be extracted:
  `situationAspectNames` / `Zones` / `Consequences`, `utils.js`
  (`escapeHtml`, `dialogField`, `canvasWorldPosition`, `toArray`), `chatSpeaker.js`,
  `turnMarkerQol.js`, `nameGenerator.js`.

## Sync conventions

- Every own write that creates/updates/deletes `EmbeddedDocuments` or the
  `conflictBoard` scene flag must be marked `{ fateOnTheTableSync: true }`.
  The opposite hook branch bails on that marker — no recursion.
- A repeated sync with identical input must be strictly no-op (asserted by tests).
- Debounces are per-scene `Map<sceneId, timer>` (e.g. `saSyncTimers`,
  `conflictTokenTimers`, `conflictActorTimers` in `module.js`), not a single
  global timer — otherwise cross-scene updates are lost.

## Schema versioning

- Persisted schemas are versioned (`conflictBoard` v2, layout v1) with pure
  migrators (`migrateConflictBoard`). Unknown fields are preserved via
  `{ ...raw }` spread so forward data is not stripped. Structural errors are
  never silently repaired — `normalized` is `null` on error.

## i18n

- Keys are added to **both** `languages/ru.json` **and** `languages/en.json`
  symmetrically. Parity is enforced by `tests/i18nContract.test.js`.

## Tests

- `npm test` (`node --test tests/*.test.js`, no external deps). Keep the run
  green before reporting done. Also run `node --check` on changed scripts.
- New pure logic needs Node tests; new Foundry glue needs a pure extract
  where feasible (see Architecture).

## Commands

- Use bare names from `PATH` (`node` / `npm` / `jq` / `git` — provided by
  `devenv`). Never hard-code absolute binary paths.

## Git

- Commits in English, `feat:` / `fix:` / `refactor:` / `chore:` + short body.
- Commit only on explicit user request. Never touch the user's unstaged
  changes. Forbidden: `stash` / `checkout` / `restore` / `clean` of foreign
  edits.

## External references

- `fate-core-official` — read-only reference (separate repo, do not modify).
- `layout-editor` — separate repo with its own tests and drift-guard
  contracts. Text metric constants are synced between the module and the editor;
  `tests/moduleCompatibility` asserts parity.

## Release

- Pushing a `v*` tag triggers `.github/workflows/release.yml`: it validates
  that `module.json` `version` / `manifest` / `download` contain the tag,
  builds `module.zip` (excludes `tests`, `PLAN.md`, `AGENTS.md`, `package.json`,
  etc.) and creates the GitHub release. `module.json` placeholders are part of
  the user's release cycle.
