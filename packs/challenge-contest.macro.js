/**
 * Challenge / Contest (Fate on the Table) — thin launcher.
 *
 * Foundry snapshots a hotbar macro into the world, so the whole flow lives in
 * the module now: every dragged copy calls `module.api.challengeContest.run()`
 * and therefore always executes the live module code (no time-capsule drift).
 */
const MODULE_ID = "fate-on-the-table";
const api = game.modules.get(MODULE_ID)?.api?.challengeContest;
if (!api) {
  ui.notifications.error(
    game.i18n.localize(`${MODULE_ID}.challenge.moduleNotActive`),
  );
} else {
  await api.run();
}
