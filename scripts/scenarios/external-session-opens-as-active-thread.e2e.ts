/// <reference lib="dom" />
// The DOM lib types the functions this scenario runs in the page.
import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { claudeSessions, externalSettings, outsideProject, atRest } from "./external.ts";
import { runPromise, test, WEB } from "./t3.ts";

const OLD_REQUEST = "Fix the invoice rounding on refunds";
const OLD_REPLY = "Refunds now round to the nearest cent.";
const GONE_REQUEST = "Draft the release notes";
const LATER_REQUEST = "Rename the payout job";
const RETURN_REQUEST = "Archive the old ledgers";
/** Over a year old, one more than a group's first page of ten. */
const OLDER_SESSIONS = 11;

/**
 * Sessions run outside T3 Code in the project's folder: one from days ago whose transcript is later
 * deleted, and twelve from over a year ago, the newest of them the one opened, enough to page.
 */
const writeSessions = Effect.fn("external.writeSessions")(function* (workspace: string) {
  const fs = yield* FileSystem.FileSystem;
  const { home, write } = yield* claudeSessions(workspace);
  yield* write({
    sessionId: "0b6f1d5e-5555-4aaa-8bbb-000000000001",
    request: OLD_REQUEST,
    reply: OLD_REPLY,
    ageDays: 399,
  });
  const gone = yield* write({
    sessionId: "0b6f1d5e-5555-4aaa-8bbb-000000000002",
    request: GONE_REQUEST,
    reply: "Here is a draft.",
    ageDays: 3,
  });
  for (let index = 0; index < OLDER_SESSIONS; index++) {
    yield* write({
      sessionId: `0b6f1d5e-5555-4aaa-8bbb-1000000000${String(index).padStart(2, "0")}`,
      request: `Older session ${index + 1}`,
      reply: "Done.",
      // A second apart, so they always share the Older group.
      ageDays: 400 + index / 86_400,
    });
  }
  return {
    home,
    removeGone: fs.remove(gone),
    /** A session finished outside T3 Code while the app is open, last active today. */
    writeLater: (input: { readonly sessionId: string; readonly request: string }) =>
      write({ ...input, reply: "Done.", ageDays: 0 }),
  };
});

test(
  "A Claude Code session run outside T3 Code opens from the External shelf as an active thread",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await runPromise(outsideProject("billing"));
    const sessions = await runPromise(writeSessions(project.workspace));
    const settings = await runPromise(externalSettings(sessions.home));
    await runPromise(settings.enable);
    try {
      await t3.open();

      // Given the External shelf opens on the recent sessions, with older groups closed.
      await screen.getByTestId("sidebar-external-shelf-toggle").tap();
      const externalRows = screen.getByTestId("sidebar-external-row");
      const oldRow = externalRows.filter({ hasText: OLD_REQUEST });
      const goneRow = externalRows.filter({ hasText: GONE_REQUEST });
      await expect(goneRow).toBeVisible({ timeout: 60_000 });
      await expect(externalRows).toHaveCount(1);
      // When the Older group is opened, it lists its first ten,
      await screen.getByRole("button", /^Older,/).tap();
      await expect(oldRow).toBeVisible({ timeout: 30_000 });
      await expect(externalRows).toHaveCount(11);
      // and the rest of a group is a "Show more" away.
      await screen.getByTestId("sidebar-external-more").tap();
      await expect(externalRows).toHaveCount(2 + OLDER_SESSIONS);
      await expect(screen.getByTestId("sidebar-external-more")).toHaveCount(0);
      await atRest(browser);
      await app.screenshot("external-lists-sessions");

      // When the year-old one is opened from the paged group, with another row pressed straight
      // after it, only the first opens: it becomes an active thread holding its conversation.
      const otherRow = externalRows.filter({ hasText: "Older session 2" });
      await browser.evaluate(
        (titles: ReadonlyArray<string>) => {
          const rows = [...document.querySelectorAll('[data-testid="sidebar-external-row"]')];
          for (const title of titles) {
            const row = rows.find((candidate) => candidate.textContent?.includes(title));
            if (row instanceof HTMLElement) row.click();
          }
          return true;
        },
        [OLD_REQUEST, "Older session 2"],
      );
      await expect(browser).toHaveURL(/0b6f1d5e-5555-4aaa-8bbb-000000000001/, { timeout: 30_000 });
      await expect(screen.getByText(OLD_REPLY)).toBeVisible({ timeout: 30_000 });
      const activeRow = screen.getByTestId("sidebar-row-card").filter({ hasText: OLD_REQUEST });
      await expect(activeRow).toBeVisible();
      await expect(oldRow).toHaveCount(0);
      await screen.getByText(OLD_REPLY).hover();
      await atRest(browser);
      await app.screenshot("opened-as-active-thread");

      // And closing and reopening the shelf never brings it back, not even for one request: a watcher
      // in the page records every change from here.
      await browser.evaluate(
        (watch: { readonly title: string; readonly staleCount: string }) => {
          const flash = { row: false, count: false };
          (window as unknown as { externalFlash: typeof flash }).externalFlash = flash;
          const check = () => {
            for (const row of document.querySelectorAll('[data-testid="sidebar-external-row"]')) {
              if (row.textContent?.includes(watch.title)) flash.row = true;
            }
            const toggle = document.querySelector('[data-testid="sidebar-external-shelf-toggle"]');
            if (toggle?.textContent?.includes(watch.staleCount)) flash.count = true;
          };
          new MutationObserver(check).observe(document.body, {
            subtree: true,
            childList: true,
            characterData: true,
          });
          return true;
        },
        { title: OLD_REQUEST, staleCount: String(2 + OLDER_SESSIONS) },
      );
      const toggle = screen.getByTestId("sidebar-external-shelf-toggle");
      await toggle.tap();
      await expect(toggle).toContainText(String(1 + OLDER_SESSIONS), { timeout: 3_000 });
      await toggle.tap();
      await expect(goneRow).toBeVisible();
      await expect(otherRow).toBeVisible();
      await expect(oldRow).toHaveCount(0, { timeout: 3_000 });
      expect(
        await browser.evaluate(
          () =>
            (window as unknown as { externalFlash: { row: boolean; count: boolean } })
              .externalFlash,
        ),
      ).toEqual({ row: false, count: false });

      // Then it holds after a reload: still active, still off the shelf, and the group opened
      // earlier is still open.
      await browser.reload();
      await expect(screen.getByText(OLD_REPLY)).toBeVisible({ timeout: 30_000 });
      await expect(activeRow).toBeVisible();
      await expect(otherRow).toBeVisible({ timeout: 30_000 });
      await expect(oldRow).toHaveCount(0);

      // And a session finished elsewhere while the shelf is open shows up without a reload. The
      // shelf re-reads each minute while open, and the server walks the homes again once its last
      // pass is fifteen seconds old.
      await runPromise(
        sessions.writeLater({
          sessionId: "0b6f1d5e-5555-4aaa-8bbb-200000000001",
          request: LATER_REQUEST,
        }),
      );
      await expect(externalRows.filter({ hasText: LATER_REQUEST })).toBeVisible({
        timeout: 120_000,
      });

      // And a session whose transcript was deleted is refused on screen, and leaves the shelf.
      await runPromise(sessions.removeGone);
      await goneRow.tap();
      await expect(browser.locator('[data-type="error"] [data-slot="toast-title"]')).toBeVisible({
        timeout: 30_000,
      });
      await expect(browser).toHaveURL(/0b6f1d5e-5555-4aaa-8bbb-000000000001/);
      await expect(goneRow).toHaveCount(0, { timeout: 30_000 });
      await atRest(browser);
      await app.screenshot("deleted-session-refused");

      // And one finished elsewhere while the shelf is closed is counted once the window comes back.
      await toggle.tap();
      await expect(toggle).toContainText(String(1 + OLDER_SESSIONS));
      // Lets the closed shelf's own read finish first, so only the return can find the new one.
      await runPromise(Effect.sleep("3 seconds"));
      await runPromise(
        sessions.writeLater({
          sessionId: "0b6f1d5e-5555-4aaa-8bbb-200000000002",
          request: RETURN_REQUEST,
        }),
      );
      // The server walks the homes again only once its last pass is fifteen seconds old.
      await runPromise(Effect.sleep("16 seconds"));
      await browser.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect(toggle).toContainText(String(2 + OLDER_SESSIONS), { timeout: 20_000 });
    } finally {
      await runPromise(settings.restore);
      await runPromise(project.remove);
    }
  },
);
