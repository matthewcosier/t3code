import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "Setting a project owner enrols new threads automatically unless dismissed",
  WEB,
  async ({ t3, app, screen, browser }) => {
    const alpha = await t3.project("alpha");
    await t3.project("beta");
    const owner = await t3.thread({
      project: alpha,
      title: "Project Lead",
      messages: ["Track work for alpha"],
    });

    await t3.open(owner);
    await expect(screen.getByText("first fixture turn complete", { exact: false })).toBeVisible();

    // Open thread actions -> Set as owner of... -> Search projects...
    await screen.getByRole("button", "Thread actions for Project Lead").tap();
    await screen.getByRole("menuitem", "Set as owner of…").tap();
    await app.screenshot("owner-submenu");
    await screen.getByRole("menuitem", "Search projects…").tap();

    const searchInput = screen.getByRole("combobox", "Search projects");
    await expect(searchInput).toBeVisible();
    await searchInput.fill("alpha");
    const alphaOption = browser
      .locator('[data-testid="project-owner-picker"] [data-slot="command-item"]')
      .filter({ hasText: "alpha" });
    await expect(alphaOption).toBeVisible();
    await alphaOption.tap();
    await expect(alphaOption).toHaveAttribute("aria-checked", "true");
    await app.screenshot("owner-picker-selected");
    await screen.getByRole("button", "Done").tap();
    await expect(searchInput).toBeHidden();

    // Start a new draft in alpha and verify the enrolment banner persists across reload.
    await t3.open("/");
    await expect(screen.getByText("Managed by Project Lead")).toBeVisible();
    await app.screenshot("composer-enrolment-banner");

    // Send a prompt to create an automatically enrolled managed thread.
    const composer = screen.getByRole("textbox");
    await composer.fill("Investigate login timeout");
    await composer.press("Enter");
    await expect(screen.getByRole("button", "Fork from this response").first()).toBeVisible({
      timeout: 30_000,
    });

    // The new managed thread exposes "Detach from Project Lead" in its actions menu.
    const managedActions = browser.locator('button[aria-label^="Thread actions for "]');
    await managedActions.tap();
    await expect(screen.getByRole("menuitem", "Detach from Project Lead")).toBeVisible();
    await app.screenshot("managed-thread-detach-menu");
    await browser.keyboard.press("Escape");

    // Switching back to the owner thread shows automatic enrolment and completion notices.
    await t3.open(owner);
    await expect(
      screen.getByText("Investigate login timeout", { exact: false }).first(),
    ).toBeVisible({ timeout: 30_000 });
    await app.screenshot("owner-thread-enrolment-notice");

    // Start another new draft in alpha, dismiss the enrolment banner, and start unmanaged.
    await t3.open("/");
    await expect(screen.getByText("Managed by Project Lead")).toBeVisible();
    await screen.getByRole("button", "Start unmanaged").tap();
    await expect(screen.getByText("Managed by Project Lead")).toBeHidden();

    const unmanagedComposer = screen.getByRole("textbox");
    await unmanagedComposer.fill("Standalone quick check");
    await unmanagedComposer.press("Enter");
    await expect(screen.getByRole("button", "Fork from this response").first()).toBeVisible({
      timeout: 30_000,
    });
    await browser.locator('button[aria-label^="Thread actions for "]').tap();
    await expect(screen.getByRole("menuitem", "Detach from Project Lead")).toBeHidden();
    await browser.keyboard.press("Escape");
  },
);
