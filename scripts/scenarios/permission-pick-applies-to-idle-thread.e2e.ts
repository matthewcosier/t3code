import { expect } from "e2e";

import { T3_HOME } from "../e2e.config.ts";
import { makeState, runPromise, test, WEB } from "./t3.ts";

test(
  "A permission mode picked on an idle thread is the thread's mode before any message is sent",
  WEB,
  async ({ t3, app, screen, browser }) => {
    const project = await t3.project("demo");
    const thread = await t3.thread({ project, title: "Permission pick", messages: ["hello"] });
    const { cli } = makeState(T3_HOME);
    const storedMode = async () => {
      const shown = await runPromise(cli(["thread", "show", thread.threadId, "--json"]));
      return (JSON.parse(shown.stdout) as { thread: { runtimeMode: string } }).thread.runtimeMode;
    };
    expect(await storedMode()).toBe("full-access");

    await t3.open(thread);
    // The model picker's footer always offers the mode; the composer chip hides the default one.
    await browser.locator("[data-chat-provider-model-picker-label]").first().tap();
    await screen.getByRole("button", "Permissions: Full access").tap();
    await screen.getByRole("menuitemradio", "Supervised").tap();
    await browser.keyboard.press("Escape");
    // Shown once the pick has landed, so the reload below does not cut it off.
    await screen.getByRole("button", "Permissions: Supervised").first().waitFor();
    await t3.open(thread);
    await screen.getByRole("button", "Permissions: Supervised").first().waitFor();
    await app.screenshot("after-reload");

    await expect.poll(storedMode).toBe("approval-required");
  },
);
