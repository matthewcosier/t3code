/// <reference lib="dom" />
// The DOM lib types the functions this scenario runs in the page.
import { expect } from "e2e";
import * as Effect from "effect/Effect";

import {
  claudeSessions,
  externalSettings,
  outsideFolder,
  outsideProject,
  atRest,
} from "./external.ts";
import { runPromise, test, WEB } from "./t3.ts";

const SESSIONS = {
  recent: {
    sessionId: "0b6f1d5e-3333-4aaa-8bbb-000000000001",
    request: "Reconcile the March statements",
    reply: "The March statements balance.",
    ageDays: 2,
  },
  weeks: {
    sessionId: "0b6f1d5e-3333-4aaa-8bbb-000000000002",
    request: "Fix the rounding report",
    reply: "The report rounds per line now.",
    ageDays: 12,
  },
  /** Outside the last 30 days; imported on its own, ticked. */
  old: {
    sessionId: "0b6f1d5e-3333-4aaa-8bbb-000000000003",
    request: "Archive the 2023 ledgers",
    reply: "Archived.",
    ageDays: 45,
  },
  /** Outside the last 30 days and never chosen; it stays listed. */
  older: {
    sessionId: "0b6f1d5e-3333-4aaa-8bbb-000000000005",
    request: "Close the third quarter",
    reply: "Closed.",
    ageDays: 60,
  },
  /** Run in a folder no project holds yet; importing it makes the project. */
  unheld: {
    sessionId: "0b6f1d5e-3333-4aaa-8bbb-000000000004",
    request: "Write the export script",
    reply: "The export script is in place.",
    ageDays: 20,
  },
} as const;

/** The thread an imported Claude session becomes, under the scenarios' Claude profile. */
const importedThread = (sessionId: string) => ({ threadId: `import:claudeExternal:${sessionId}` });

test(
  "External sessions import as threads: a group less one row, one ticked row, then the last 30 days",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await runPromise(outsideProject("ledger"));
    const folder = await runPromise(outsideFolder("export-tools"));
    const { home } = await runPromise(
      Effect.gen(function* () {
        const inProject = yield* claudeSessions(project.workspace);
        yield* inProject.write(SESSIONS.recent);
        yield* inProject.write(SESSIONS.weeks);
        yield* inProject.write(SESSIONS.old);
        yield* inProject.write(SESSIONS.older);
        // Never listed: nothing was said in it.
        yield* inProject.writeEmpty("0b6f1d5e-3333-4aaa-8bbb-000000000099");
        const inFolder = yield* claudeSessions(folder.workspace);
        yield* inFolder.write(SESSIONS.unheld);
        return inProject;
      }),
    );
    const settings = await runPromise(externalSettings(home));
    await runPromise(settings.enable);
    try {
      await t3.open("/settings/external-sessions");
      const externalRows = screen.getByTestId("external-session-row");
      const row = (request: string) => externalRows.filter({ hasText: request });
      await expect(row(SESSIONS.recent.request)).toBeVisible({ timeout: 60_000 });
      // Every group opened, so every session is on screen; the empty one is not among them.
      await browser.evaluate(() => {
        for (const group of document.querySelectorAll<HTMLElement>(
          '[data-testid="external-sessions-group"][aria-expanded="false"]',
        )) {
          group.click();
        }
        return true;
      });
      await expect(externalRows).toHaveCount(5);

      // Given the whole "Previous 30 days" group is ticked from its header, one of its sessions
      // unticked, and the group closed before importing,
      await screen.getByRole("checkbox", "Select all of Previous 30 days").tap();
      await expect(screen.getByTestId("external-sessions-selected-count")).toContainText("2");
      await screen.getByRole("checkbox", `Select ${SESSIONS.unheld.request}`).tap();
      await expect(screen.getByTestId("external-sessions-selected-count")).toContainText("1");
      await atRest(browser);
      await app.screenshot("group-less-one");
      const month = screen.getByRole("button", /^Previous 30 days,/);
      await month.tap();
      await expect(row(SESSIONS.weeks.request)).toHaveCount(0);
      await expect(screen.getByTestId("external-sessions-selected-count")).toContainText("1");
      await screen.getByTestId("external-sessions-import-selected").tap();
      // then only the ticked one is imported: the unticked one is still listed once the group opens.
      await expect(month).toHaveAttribute("aria-label", /^Previous 30 days, 1 /, {
        timeout: 60_000,
      });
      await month.tap();
      await expect(row(SESSIONS.unheld.request)).toBeVisible();
      await expect(row(SESSIONS.weeks.request)).toHaveCount(0);
      await expect(externalRows).toHaveCount(4);
      // Its toast is gone before the next import, so the next toast is the only one.
      await expect(browser.locator('[data-type="success"]')).toHaveCount(0, { timeout: 30_000 });

      // When a session from before the last 30 days is ticked and imported on its own, its toast
      // opens the thread it became.
      await screen.getByRole("checkbox", `Select ${SESSIONS.old.request}`).tap();
      await screen.getByTestId("external-sessions-import-selected").tap();
      await expect(row(SESSIONS.old.request)).toHaveCount(0, { timeout: 60_000 });
      const openFromToast = browser.locator('[data-type="success"] [data-slot="toast-action"]');
      await expect(openFromToast).toBeVisible();
      await atRest(browser);
      await app.screenshot("imported-one");
      await openFromToast.tap();
      await expect(browser).toHaveURL(new RegExp(SESSIONS.old.sessionId), { timeout: 30_000 });
      await expect(screen.getByText(SESSIONS.old.reply)).toBeVisible({ timeout: 30_000 });

      // And when the last 30 days' import is asked for and then cancelled, nothing is imported.
      await t3.open("/settings/external-sessions");
      await expect(row(SESSIONS.recent.request)).toBeVisible({ timeout: 30_000 });
      await expect(externalRows).toHaveCount(3);
      const importButton = screen.getByTestId("external-sessions-import");
      await importButton.tap();
      await expect(screen.getByTestId("external-sessions-import-confirm")).toBeVisible();
      await atRest(browser);
      await app.screenshot("import-confirm");
      await screen.getByRole("button", "Cancel").tap();
      await expect(screen.getByTestId("external-sessions-import-confirm")).toHaveCount(0);
      await expect(externalRows).toHaveCount(3);

      // And when it is confirmed, the recent sessions leave, the one from a folder with no project
      // as well, and the older one stays.
      await importButton.tap();
      await screen.getByTestId("external-sessions-import-confirm").tap();
      await expect(row(SESSIONS.recent.request)).toHaveCount(0, { timeout: 60_000 });
      await expect(row(SESSIONS.unheld.request)).toHaveCount(0);
      await expect(row(SESSIONS.older.request)).toBeVisible();
      await expect(externalRows).toHaveCount(1);

      // And it holds after a reload.
      await browser.reload();
      await expect(row(SESSIONS.older.request)).toBeVisible({ timeout: 30_000 });
      await expect(externalRows).toHaveCount(1);

      // And each imported session is a thread holding its conversation.
      await t3.open(importedThread(SESSIONS.unheld.sessionId));
      await expect(screen.getByText(SESSIONS.unheld.reply)).toBeVisible({ timeout: 30_000 });
      await atRest(browser);
      await app.screenshot("imported-thread");
      await t3.open(importedThread(SESSIONS.recent.sessionId));
      await expect(screen.getByText(SESSIONS.recent.reply)).toBeVisible({ timeout: 30_000 });
    } finally {
      await runPromise(settings.restore);
      await runPromise(folder.remove);
      await runPromise(project.remove);
    }
  },
);
