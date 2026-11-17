import { expect } from "e2e";
import * as Effect from "effect/Effect";

import { claudeSessions, externalSettings, outsideProject, atRest } from "./external.ts";
import { runPromise, test, WEB } from "./t3.ts";

/** More banished sessions than the server returns in one page of 200. */
const OLD_SESSIONS = 230;
const RECENT_REQUEST = "Rotate the API keys";

const writeSessions = Effect.fn("external.writeBanishedPageSessions")(function* (
  workspace: string,
) {
  const { home, write } = yield* claudeSessions(workspace);
  yield* write({
    sessionId: "0b6f1d5e-8888-4aaa-8bbb-000000000001",
    request: RECENT_REQUEST,
    reply: "Done.",
    ageDays: 2,
  });
  for (let index = 0; index < OLD_SESSIONS; index++) {
    yield* write({
      sessionId: `0b6f1d5e-8888-4aaa-8bbb-1000000${String(index).padStart(5, "0")}`,
      request: `Older session ${index + 1}`,
      reply: "Done.",
      // A minute apart, newest first, all over a year old.
      ageDays: 400 + index / 1_440,
    });
  }
  return home;
});

test(
  "Banished sessions page past the server's page size and keep every row when more are banished or restored",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await runPromise(outsideProject("ledger"));
    const home = await runPromise(writeSessions(project.workspace));
    const settings = await runPromise(externalSettings(home));
    await runPromise(settings.enable);
    try {
      await t3.open("/settings/external-sessions");
      const recentRow = screen
        .getByTestId("external-session-row")
        .filter({ hasText: RECENT_REQUEST });
      await expect(recentRow).toBeVisible({ timeout: 60_000 });
      // Every old session is listed before any is banished.
      await expect(screen.getByRole("button", /^Older,/)).toHaveAttribute(
        "aria-label",
        new RegExp(`^Older, ${OLD_SESSIONS} `),
        { timeout: 60_000 },
      );

      // Given every old session is banished from the menu,
      await screen.getByTestId("external-sessions-banish").tap();
      await screen.getByRole("menuitem", /Older than 3 months/).tap();
      const restore = screen.getByTestId("banished-session-restore");
      // then Banished sessions shows them 50 at a time, reading a second page past the first 200.
      await expect(restore).toHaveCount(50, { timeout: 60_000 });
      for (const shown of [100, 150, 200, OLD_SESSIONS]) {
        await screen.getByTestId("banished-show-more").tap();
        await expect(restore).toHaveCount(shown, { timeout: 30_000 });
      }
      await expect(screen.getByTestId("banished-show-more")).toHaveCount(0);

      // When a newer session is banished with both pages open, none falls between the pages.
      await screen.getByRole("button", `Banish ${RECENT_REQUEST}`).tap();
      await expect(restore).toHaveCount(OLD_SESSIONS + 1, { timeout: 30_000 });
      await screen.getByRole("button", `Restore Older session 200`).scrollIntoView();
      await atRest(browser);
      await app.screenshot("banished-pages");

      // And when it is restored, no row shows twice.
      await screen.getByRole("button", `Restore ${RECENT_REQUEST}`).tap();
      await expect(recentRow).toBeVisible({ timeout: 30_000 });
      await expect(restore).toHaveCount(OLD_SESSIONS, { timeout: 30_000 });
      await expect(screen.getByRole("button", "Restore Older session 200")).toHaveCount(1);
    } finally {
      await runPromise(settings.restore);
      await runPromise(project.remove);
    }
  },
);
