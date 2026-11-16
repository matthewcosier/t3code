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
  old: {
    sessionId: "0b6f1d5e-3333-4aaa-8bbb-000000000003",
    request: "Archive the 2023 ledgers",
    reply: "Archived.",
    ageDays: 45,
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
  "Import the last 30 days makes each recent external session a thread and leaves older ones",
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
      // Every group opened, so every session is on screen.
      await browser.evaluate(() => {
        for (const group of document.querySelectorAll<HTMLElement>(
          '[data-testid="external-sessions-group"][aria-expanded="false"]',
        )) {
          group.click();
        }
        return true;
      });
      await expect(externalRows).toHaveCount(4);

      // Given the import is asked for and then cancelled, nothing is imported.
      const importButton = screen.getByTestId("external-sessions-import");
      await importButton.tap();
      await expect(screen.getByTestId("external-sessions-import-confirm")).toBeVisible();
      await atRest(browser);
      await app.screenshot("import-confirm");
      await screen.getByRole("button", "Cancel").tap();
      await expect(screen.getByTestId("external-sessions-import-confirm")).toHaveCount(0);
      await expect(externalRows).toHaveCount(4);

      // When it is confirmed,
      await importButton.tap();
      await screen.getByTestId("external-sessions-import-confirm").tap();
      // then the three sessions of the last 30 days leave the list, and the older one stays.
      await expect(row(SESSIONS.recent.request)).toHaveCount(0, { timeout: 60_000 });
      await expect(row(SESSIONS.weeks.request)).toHaveCount(0);
      await expect(row(SESSIONS.unheld.request)).toHaveCount(0);
      await expect(row(SESSIONS.old.request)).toBeVisible();
      await expect(externalRows).toHaveCount(1);
      await expect(
        browser.locator('[data-type="success"] [data-slot="toast-title"]'),
      ).toBeVisible();
      await atRest(browser);
      await app.screenshot("imported");

      // And it holds after a reload.
      await browser.reload();
      await expect(row(SESSIONS.old.request)).toBeVisible({ timeout: 30_000 });
      await expect(externalRows).toHaveCount(1);

      // And each imported session is a thread holding its conversation, the one from a folder
      // with no project as well.
      await t3.open(importedThread(SESSIONS.unheld.sessionId));
      await expect(screen.getByText(SESSIONS.unheld.reply)).toBeVisible({ timeout: 30_000 });
      await atRest(browser);
      await app.screenshot("imported-thread");
      await t3.open(importedThread(SESSIONS.weeks.sessionId));
      await expect(screen.getByText(SESSIONS.weeks.reply)).toBeVisible({ timeout: 30_000 });
    } finally {
      await runPromise(settings.restore);
      await runPromise(folder.remove);
      await runPromise(project.remove);
    }
  },
);
