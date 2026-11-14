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
  import time. Thin glue (`module.js` + `scripts/hooks/*`, `WidgetSync`,
  `ConflictBoardSync`, …) wires hooks, `ApplicationV2`, `Drawing`/`Tile` I/O.
- **Lazy `ApplicationV2` guard:** UI managers must use the lazy guard pattern
  from `ConflictManager.js` — reference `foundry.applications.api.ApplicationV2`
  only inside a getter / init function so the module imports cleanly in Node
  tests. Pure rendering / actions are extracted to testable modules.
- **Resolver catalog:** JSON layouts are declarative; runtime logic is only
  via an allow-listed resolver catalog (`WidgetBuilder.js`). No code in JSON.
- **Method wrapping:** never assign to a Foundry/system prototype directly.
  Use `wrapMethod` (`scripts/patchMethod.js`): libWrapper (recommended
  dependency) when present, otherwise an idempotent direct patch with the same
  `(wrapped, ...args)` signature. "WRAPPER" if the original is always called,
  "MIXED" if the wrapper may consume the call. Widget canvas wraps and the DOM
  click fallback live in `widgetCanvasPatches.js`.
- **Pure extract:** domain logic that can be pure must be extracted:
  `situationAspectNames` / `Zones` / `Consequences`, `utils.js`
  (`escapeHtml`, `dialogField`, `canvasWorldPosition`, `toArray`), `chatSpeaker.js`,
  `turnMarkerQol.js`, `nameGenerator.js`.

## Sync conventions

- Every own write that creates/updates/deletes `EmbeddedDocuments` or the
  `conflictBoard` scene flag must be marked `{ fateOnTheTableSync: true }`.
  The opposite hook branch bails on that marker — no recursion.
- Sync authority: automatic, hook-driven writes run only on the active GM's
  client (`isSyncAuthority()` / `canRunSync()` in `syncAuthority.js`), never
  on a bare `game.user.isGM` check — Assistant GMs are GMs too, and two
  writers duplicate documents. Sync calls triggered by the acting user's own
  UI pass `{ manual: true }`.
- A repeated sync with identical input must be strictly no-op (asserted by tests).
- Debounces are per-scene `Map<sceneId, timer>` (e.g. `saSyncTimers` in
  `hooks/situationAspects.js`, `conflictTokenTimers` / `conflictActorTimers`
  in `hooks/conflict.js`), not a single global timer — otherwise cross-scene
  updates are lost. A Combat being deleted is tracked by id between
  `preDeleteCombat` and `deleteCombat` (`hooks/combatDeletion.js`) so its
  board is never auto-cleaned when the combat ends.
- A sync collects its whole diff into one plan and flushes it once, one batch
  per document type in `delete → update → create` order (`flushPlan` in
  `ConflictBoardSync.js`, `syncWidget` in `WidgetSync.js`, the single write
  block in `SituationAspectSync.js`). Widget parts match by `part#index` and
  are updated in place — never delete-and-recreate a whole group for a rename.
- Hooks that re-project the conflict board go through `scheduleConflictSync`
  (`scripts/hooks/conflict.js`): one game event fires several
  `updateCombatant` hooks, and the per-scene debounce collapses the burst into one sync. Only flows that must
  stay ordered against a pending projection call `syncConflictBoard` directly
  (`canvasReady`, `ConflictManager.afterChange`, settings sync).

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
- `devenv shell` from the repository root; the environment is defined by
  `devenv.nix` / `devenv.yaml` / `devenv.lock`.
- `npm run build:packs` rebuilds `packs/challenge-contest/` from the JSONL
  source. Foundry mutates the LevelDB directory at runtime, so rebuild before
  committing pack changes. `LOCK`, `LOG` and `LOG.old` are ignored.
- `npm run dev:link` / `npm run dev:unlink` manage the symlink in the Foundry
  data directory (`FOUNDRY_DATA`, default v14 path). See
  `docs/DEVELOPMENT.md`.

## Git

- Commits in English, `feat:` / `fix:` / `refactor:` / `chore:` + short body.
- Commit only on explicit user request. Never touch the user's unstaged
  changes. Forbidden: `stash` / `checkout` / `restore` / `clean` of foreign
  edits.

## External references

- `fate-core-official` — read-only reference (separate repo, do not modify).
  System install and versions are documented in `docs/UPSTREAM.md`.
- `layout-editor` — separate sibling repo (`../layout-editor`), needed only for
  layout-format work. Its `tests/moduleCompatibility.test.ts` and
  `tests/moduleGeometry.test.ts` read this checkout through
  `../fate-on-the-table`; text metric constants are kept in sync.

## Deploy

- Server `thecomet` runs the module from a git clone of `main` at
  `/home/hattivatt/.local/share/FoundryVTT/v14/Data/modules/fate-on-the-table`.
  Deploy = commit, `git push origin main`, then
  `ssh thecomet 'cd <that path> && git pull --ff-only'`. See
  `docs/DEVELOPMENT.md`.

## Release

- Pushing a `v*` tag triggers `.github/workflows/release.yml`: it validates
  that `module.json` `version` / `manifest` / `download` contain the tag,
  builds `module.zip` from an explicit runtime allowlist
  (`module.json`, `LICENSE`, `README.md`, `scripts/`, `styles/`, `layouts/`,
  `languages/`, `packs/`) and creates the GitHub release. `module.json`
  placeholders are part of the user's release cycle; see `docs/RELEASE.md`.
