/// <reference lib="dom" />
// Shared setup for the external session scenarios. The DOM lib types the function run in the page.
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { T3_HOME } from "../e2e.config.ts";
import { run } from "./shell.ts";
import { makeState } from "./t3.ts";

const SettingsJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));
const decodeSettings = Schema.decodeEffect(SettingsJson);
const encodeSettings = Schema.encodeEffect(SettingsJson);
const DAY_MS = 86_400_000;

/**
 * A git folder outside the T3 home that no project holds. External sessions never offers folders
 * inside the T3 home, which is where `t3.project` makes its repositories. Removing it also removes
 * a project something made for it since.
 */
export const outsideFolder = Effect.fn("external.outsideFolder")(function* (title: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const parent = yield* fs.realPath(yield* fs.makeTempDirectory({ prefix: "t3-external-" }));
  const workspace = path.join(parent, title);
  yield* fs.makeDirectory(workspace, { recursive: true });
  yield* fs.writeFileString(path.join(workspace, "README.md"), "");
  const git = (args: ReadonlyArray<string>) => run("git", args, { cwd: workspace });
  const author = ["-c", "user.name=Scenario", "-c", "user.email=scenario@example.invalid"];
  yield* git(["init", "--quiet", "--initial-branch=main"]);
  yield* git(["add", "--all"]);
  yield* git([...author, "commit", "--quiet", "--message", "Initial commit"]);
  const { cli } = makeState(T3_HOME);
  return {
    workspace,
    addProject: cli(["project", "add", workspace, "--title", title]),
    remove: cli(["project", "remove", workspace, "--force"]).pipe(
      Effect.ignore,
      Effect.andThen(fs.remove(parent, { recursive: true, force: true })),
    ),
  };
});

/** A project folder outside the T3 home, added through the app's CLI. */
export const outsideProject = Effect.fn("external.outsideProject")(function* (title: string) {
  const folder = yield* outsideFolder(title);
  yield* folder.addProject;
  return folder;
});

/**
 * A Claude home only these scenarios read, writing sessions as if run outside T3 Code in
 * `workspace`, each last active `ageDays` ago.
 */
export const claudeSessions = Effect.fn("external.claudeSessions")(function* (workspace: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = path.join(T3_HOME, "external-claude");
  const folder = path.join(home, "projects", workspace.replaceAll(/[\\/]/g, "-"));
  yield* fs.makeDirectory(folder, { recursive: true });
  const write = Effect.fn("external.writeSession")(function* (input: {
    readonly sessionId: string;
    readonly request: string;
    readonly reply: string;
    readonly ageDays: number;
  }) {
    const atMs = (yield* Clock.currentTimeMillis) - input.ageDays * DAY_MS;
    const timestamp = DateTime.formatIso(DateTime.makeUnsafe(atMs));
    const { sessionId } = input;
    const records = [
      {
        type: "user",
        cwd: workspace,
        sessionId,
        timestamp,
        message: { role: "user", content: input.request },
      },
      {
        type: "assistant",
        sessionId,
        timestamp,
        message: { role: "assistant", content: [{ type: "text", text: input.reply }] },
      },
    ];
    const file = path.join(folder, `${sessionId}.jsonl`);
    yield* fs.writeFileString(
      file,
      records.map((record) => `${JSON.stringify(record)}\n`).join(""),
    );
    yield* fs.utimes(file, atMs / 1000, atMs / 1000);
    return file;
  });
  return { home, write };
});

/** Turns external sessions on with one Claude profile over `claudeHome`, and puts settings back. */
export const externalSettings = Effect.fn("external.settings")(function* (claudeHome: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const settingsPath = path.join(T3_HOME, "userdata/settings.json");
  const original = yield* fs.readFileString(settingsPath);
  const settings = yield* decodeSettings(original);
  const instances = settings.providerInstances as Record<string, unknown>;
  return {
    enable: fs.writeFileString(
      settingsPath,
      yield* encodeSettings({
        ...settings,
        externalSessions: true,
        providerInstances: {
          ...instances,
          // Its binary only fails, so nothing here can reach a model.
          claudeExternal: {
            driver: "claudeAgent",
            enabled: true,
            config: { homePath: claudeHome, binaryPath: path.join(T3_HOME, "bin/no-model") },
          },
        },
      }),
    ),
    restore: fs.writeFileString(settingsPath, original),
  };
});

/**
 * Waits for every animation and transition running now to finish, so a capture shows the page at
 * rest. Not an assertion: the behaviour is held by the checks before it.
 */
export async function atRest(browser: { evaluate: <A>(fn: () => Promise<A>) => Promise<A> }) {
  await browser.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        // A spinner runs for ever; only animations with an end are waited on.
        .filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity)
        .map((animation) => animation.finished.catch(() => undefined)),
    ).then(() => true),
  );
}
