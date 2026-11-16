import { expect } from "e2e";
import * as Effect from "effect/Effect";

import { claudeSessions, externalSettings, outsideProject, atRest } from "./external.ts";
import { runPromise, test, WEB } from "./t3.ts";

/** Sessions run outside T3 Code, newest first, with how many days ago each was last active. */
const SESSIONS = [
  { request: "Rotate the API keys", ageDays: 2 },
  { request: "Draft the changelog", ageDays: 5 },
  { request: "Tidy the README", ageDays: 20 },
  { request: "Upgrade the build tooling", ageDays: 400 },
  { request: "Port the old importer", ageDays: 500 },
] as const;

const writeSessions = Effect.fn("external.writeBanishSessions")(function* (workspace: string) {
  const { home, write } = yield* claudeSessions(workspace);
  for (const [index, session] of SESSIONS.entries()) {
    yield* write({
      sessionId: `0b6f1d5e-7777-4aaa-8bbb-00000000000${index}`,
      request: session.request,
      reply: "Done.",
      ageDays: session.ageDays,
    });
  }
  return home;
});

test(
  "Old external sessions banish to the archive by age, one at a time or as a selection, and restore",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await runPromise(outsideProject("ledger"));
    const home = await runPromise(writeSessions(project.workspace));
    const settings = await runPromise(externalSettings(home));
    await runPromise(settings.enable);
    try {
      await t3.open();
      await screen.getByTestId("sidebar-external-shelf-toggle").tap();
      const externalRows = screen.getByTestId("sidebar-external-row");
      const row = (request: string) => externalRows.filter({ hasText: request });
      await expect(row("Rotate the API keys")).toBeVisible({ timeout: 60_000 });
      // The older groups start closed; opening them lists every session.
      await screen.getByRole("button", /^Previous 30 days,/).tap();
      await screen.getByRole("button", /^Older,/).tap();
      await expect(externalRows).toHaveCount(SESSIONS.length);

      // Given everything last active more than three months ago is banished from the menu,
      await screen.getByTestId("sidebar-external-banish").tap();
      await atRest(browser);
      await app.screenshot("banish-menu");
      await screen.getByRole("menuitem", /Older than 3 months/).tap();
      // then those two leave the shelf and the rest stay.
      await expect(row("Upgrade the build tooling")).toHaveCount(0);
      await expect(row("Port the old importer")).toHaveCount(0);
      await expect(externalRows).toHaveCount(3);
      await atRest(browser);
      await app.screenshot("banished-by-age");

      // And Undo brings exactly them back.
      await screen.getByRole("button", "Undo").tap();
      await expect(externalRows).toHaveCount(SESSIONS.length);

      // When one session is banished from its row,
      await row("Tidy the README").hover();
      await screen.getByRole("button", "Banish Tidy the README").tap();
      await expect(row("Tidy the README")).toHaveCount(0);

      // and two more are selected and banished together with the Delete key,
      await row("Rotate the API keys").tap({ modifiers: ["ControlOrMeta"] });
      await row("Draft the changelog").tap({ modifiers: ["ControlOrMeta"] });
      await row("Draft the changelog").press("Delete");
      await expect(row("Rotate the API keys")).toHaveCount(0);
      await expect(row("Draft the changelog")).toHaveCount(0);
      // and keyboard focus carries on to the next row that stayed, so Delete can go again.
      await expect(row("Upgrade the build tooling")).toBeFocused();
      await expect(externalRows).toHaveCount(2);

      // then the archive lists the three, and restoring one puts it back on the shelf.
      await t3.open("/settings/archived");
      const restore = screen.getByTestId("archive-restore-session");
      await expect(restore).toHaveCount(3, { timeout: 30_000 });
      await atRest(browser);
      await app.screenshot("archive-lists-banished");
      await screen.getByRole("button", "Restore Tidy the README to the sidebar").tap();
      await expect(restore).toHaveCount(2);

      await t3.open("/");
      await expect(row("Tidy the README")).toBeVisible({ timeout: 30_000 });
      await expect(row("Rotate the API keys")).toHaveCount(0);
      await expect(externalRows).toHaveCount(3);
    } finally {
      await runPromise(settings.restore);
      await runPromise(project.remove);
    }
  },
);
