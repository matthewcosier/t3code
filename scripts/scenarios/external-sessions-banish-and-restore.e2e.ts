/// <reference lib="dom" />
// The DOM lib types the function this scenario runs in the page.
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

const sessionId = (index: number) => `0b6f1d5e-7777-4aaa-8bbb-00000000000${index}`;

const writeSessions = Effect.fn("external.writeBanishSessions")(function* (workspace: string) {
  const { home, write } = yield* claudeSessions(workspace);
  for (const [index, session] of SESSIONS.entries()) {
    yield* write({
      sessionId: sessionId(index),
      request: session.request,
      reply: "Done.",
      ageDays: session.ageDays,
    });
  }
  return {
    home,
    /** The session at `index` used again outside T3 Code, just now. */
    useAgain: (index: number) =>
      write({
        sessionId: sessionId(index),
        request: SESSIONS[index]!.request,
        reply: "Done again.",
        ageDays: 0,
      }),
  };
});

test(
  "Old external sessions banish by age, one at a time or as a selection, and restore",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await runPromise(outsideProject("ledger"));
    const sessions = await runPromise(writeSessions(project.workspace));
    const settings = await runPromise(externalSettings(sessions.home));
    await runPromise(settings.enable);
    try {
      await t3.open("/settings/external-sessions");
      const externalRows = screen.getByTestId("external-session-row");
      const row = (request: string) => externalRows.filter({ hasText: request });
      await expect(row("Rotate the API keys")).toBeVisible({ timeout: 60_000 });
      // The older groups start closed; opening them lists every session.
      await screen.getByRole("button", /^Previous 30 days,/).tap();
      await screen.getByRole("button", /^Older,/).tap();
      await expect(externalRows).toHaveCount(SESSIONS.length);
      await atRest(browser);
      await app.screenshot("external-sessions-page");

      // Given everything last active more than three months ago is banished from the menu,
      await screen.getByTestId("external-sessions-banish").tap();
      await atRest(browser);
      await app.screenshot("banish-menu");
      await screen.getByRole("menuitem", /Older than 3 months/).tap();
      // then those two leave the list and the rest stay.
      await expect(row("Upgrade the build tooling")).toHaveCount(0);
      await expect(row("Port the old importer")).toHaveCount(0);
      await expect(externalRows).toHaveCount(3);

      // And Undo brings exactly them back.
      await screen.getByRole("button", "Undo").tap();
      await expect(externalRows).toHaveCount(SESSIONS.length);

      // When one session is banished from its row,
      await screen.getByRole("button", "Banish Tidy the README").tap();
      await expect(row("Tidy the README")).toHaveCount(0);

      // and two more are ticked and banished together,
      await screen.getByRole("checkbox", "Select Rotate the API keys").tap();
      await screen.getByRole("checkbox", "Select Draft the changelog").tap();
      await atRest(browser);
      await app.screenshot("two-selected");
      await screen.getByTestId("external-sessions-banish-selected").tap();
      await expect(row("Rotate the API keys")).toHaveCount(0);
      await expect(row("Draft the changelog")).toHaveCount(0);
      await expect(externalRows).toHaveCount(2);

      // then Banished sessions below lists the three, and restoring one puts it back in the list.
      const restore = screen.getByTestId("banished-session-restore");
      await expect(restore).toHaveCount(3, { timeout: 30_000 });
      await restore.first().scrollIntoView();
      await atRest(browser);
      await app.screenshot("banished-listed");
      await screen.getByRole("button", "Restore Tidy the README").tap();
      await expect(restore).toHaveCount(2);
      await expect(row("Tidy the README")).toBeVisible({ timeout: 30_000 });

      // And it all holds after a reload.
      await browser.reload();
      await expect(row("Tidy the README")).toBeVisible({ timeout: 30_000 });
      await expect(row("Rotate the API keys")).toHaveCount(0);
      await expect(restore).toHaveCount(2, { timeout: 30_000 });

      // And a banished session used again outside T3 Code comes back to the list, and leaves
      // Banished sessions, once the window comes back to the page. The server walks the homes
      // again only once its last pass is fifteen seconds old.
      await runPromise(sessions.useAgain(1));
      await runPromise(Effect.sleep("16 seconds"));
      await browser.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect(row("Draft the changelog")).toBeVisible({ timeout: 30_000 });
      await expect(restore).toHaveCount(1, { timeout: 30_000 });
    } finally {
      await runPromise(settings.restore);
      await runPromise(project.remove);
    }
  },
);
