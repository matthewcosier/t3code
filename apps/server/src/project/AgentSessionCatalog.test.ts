import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type AgentSessionCatalogResult,
  type OrchestrationProjectShell,
  type Project,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Scheduler from "effect/Scheduler";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";

import * as ServerConfig from "../config.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AgentSessionCatalog from "./AgentSessionCatalog.ts";
import * as AgentSessionImporter from "./AgentSessionImporter.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";
import * as ProjectService from "./ProjectService.ts";

const timestamp = "2026-09-01T10:00:00.000Z";
const nowMs = DateTime.toEpochMillis(DateTime.makeUnsafe(timestamp));
const DAY_MS = 24 * 60 * 60 * 1000;
const claude = ProviderInstanceId.make("claudeAgent");
const codex = ProviderInstanceId.make("codex");

const stores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);
const persistence = Layer.mergeAll(
  stores,
  EventSink.layer.pipe(Layer.provide(stores)),
  ProviderSessionRuntime.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
  IdAllocator.layer,
);

const claudeTranscript = (cwd: string, sessionId: string, request: string) =>
  [
    { type: "user", cwd, sessionId, timestamp, message: { role: "user", content: request } },
    {
      type: "assistant",
      sessionId,
      timestamp,
      message: { role: "assistant", content: [{ type: "text", text: "Done" }] },
    },
  ]
    .map((record) => JSON.stringify(record) + "\n")
    .join("");

const shell = (id: ProjectId, workspaceRoot: string): OrchestrationProjectShell => ({
  id,
  title: "Project",
  workspaceRoot,
  defaultModelSelection: null,
  scripts: [],
  createdAt: timestamp,
  updatedAt: timestamp,
});

const titles = (result: AgentSessionCatalogResult) => result.entries.map((entry) => entry.title);

const makeHarness = Effect.fn(function* (options?: {
  readonly externalSessions?: boolean;
  readonly projects?: ReadonlyArray<OrchestrationProjectShell>;
  /** Hydrate through the real importer into the test's event store, instead of recording calls. */
  readonly realImporter?: boolean;
  /** Runs before each of the real importer's write transactions. */
  readonly beforeImportTransaction?: Effect.Effect<void>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "t3-catalog-" }));
  const claudeHome = path.join(root, "claude");
  const codexHome = path.join(root, "codex");
  yield* fs.makeDirectory(path.join(claudeHome, "projects"), { recursive: true });
  yield* fs.makeDirectory(path.join(codexHome, "sessions"), { recursive: true });
  yield* TestClock.setTime(nowMs);

  const makeWorkspace = Effect.fn(function* (name: string) {
    const workspace = path.join(root, name);
    yield* fs.makeDirectory(path.join(workspace, ".git"), { recursive: true });
    yield* fs.writeFileString(path.join(workspace, ".git", "config"), "[core]\n");
    return workspace;
  });
  const writeClaude = Effect.fn(function* (input: {
    readonly cwd: string;
    readonly sessionId: string;
    readonly request: string;
    readonly ageDays: number;
  }) {
    const directory = path.join(claudeHome, "projects", input.cwd.replaceAll(/[\\/]/g, "-"));
    yield* fs.makeDirectory(directory, { recursive: true });
    const filePath = path.join(directory, `${input.sessionId}.jsonl`);
    yield* fs.writeFileString(
      filePath,
      claudeTranscript(input.cwd, input.sessionId, input.request),
    );
    const seconds = (nowMs - input.ageDays * DAY_MS) / 1000;
    yield* fs.utimes(filePath, seconds, seconds);
    return filePath;
  });

  // Built once and shared, so a settings change reaches the scanner and the catalog alike.
  const settingsService = Context.get(
    yield* Layer.build(
      ServerSettings.layerTest({
        externalSessions: options?.externalSessions ?? true,
        providerInstances: {
          [claude]: {
            driver: ProviderDriverKind.make("claudeAgent"),
            config: { homePath: claudeHome },
          },
          [codex]: { driver: ProviderDriverKind.make("codex"), config: { homePath: codexHome } },
          // Keeps the default Pi instance off the developer's real ~/.pi.
          [ProviderInstanceId.make("pi")]: {
            driver: ProviderDriverKind.make("pi"),
            enabled: false,
            config: {},
          },
        },
      }),
    ),
    ServerSettings.ServerSettingsService,
  );
  const settings = Layer.succeed(ServerSettings.ServerSettingsService, settingsService);
  // Built once, so the catalog and the assertions see the same state folder.
  const serverConfig = Context.get(
    yield* Layer.build(ServerConfig.layerTest(root, { prefix: "t3-catalog-state-" })),
    ServerConfig.ServerConfig,
  );
  const config = Layer.succeed(ServerConfig.ServerConfig, serverConfig);
  const runtimes = Layer.succeed(
    ProviderSessionRuntime.ProviderSessionRuntimeRepository,
    yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository,
  );
  const scannerContext = yield* Layer.build(
    AgentSessionScanner.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          config,
          settings,
          runtimes,
          Layer.mock(ProjectStore.ProjectStoreV2)({ listShells: () => Effect.succeed([]) }),
        ),
      ),
    ),
  );
  const scanner = Context.get(scannerContext, AgentSessionScanner.AgentSessionScanner);
  // Which transcripts each index pass opens, to tell an incremental pass from a full one.
  const reads: Array<string> = [];
  const bootstraps: Array<ProjectService.ProjectBootstrapInput> = [];
  const imports: Array<{
    readonly projectId: ProjectId;
    readonly chosen: ReadonlyArray<AgentSessionScanner.AgentSessionTranscriptFile> | undefined;
    readonly active: boolean | undefined;
  }> = [];
  const shells = [...(options?.projects ?? [])];
  const scannerLayer = Layer.succeed(AgentSessionScanner.AgentSessionScanner, {
    ...scanner,
    readCatalogMetadata: (file) =>
      Effect.suspend(() => {
        reads.push(file.filePath);
        return scanner.readCatalogMetadata(file);
      }),
  });
  const projectService = Layer.mock(ProjectService.ProjectService)({
    listShells: () => Effect.succeed(shells),
    getById: (projectId) =>
      Effect.sync(() => {
        const found = shells.find((item) => item.id === projectId);
        return found === undefined
          ? Option.none<Project>()
          : Option.some({ ...found, deletedAt: null });
      }),
    bootstrap: (input) =>
      Effect.sync(() => {
        bootstraps.push(input);
        const existing = shells.find((item) => item.workspaceRoot === input.workspaceRoot);
        const project = existing ?? shell(input.projectId, input.workspaceRoot);
        if (existing === undefined) shells.push(project);
        return { project: { ...project, deletedAt: null }, created: existing === undefined };
      }),
  });
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const sql = yield* SqlClient.SqlClient;
  const beforeTransaction = options?.beforeImportTransaction ?? Effect.void;
  const importSql = new Proxy(sql, {
    get: (target, key, receiver) =>
      key === "withTransaction"
        ? (((effect) =>
            beforeTransaction.pipe(
              Effect.andThen(sql.withTransaction(effect)),
            )) satisfies typeof sql.withTransaction)
        : Reflect.get(target, key, receiver),
  });
  const importSink = Layer.fresh(EventSink.layer).pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(SqlClient.SqlClient, importSql),
        Layer.succeed(ProjectionStore.ProjectionStoreV2, projections),
        Layer.succeed(EventStore.EventStoreV2, yield* EventStore.EventStoreV2),
      ),
    ),
  );
  const importer =
    options?.realImporter === true
      ? AgentSessionImporter.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              settings,
              runtimes,
              scannerLayer,
              projectService,
              importSink,
              Layer.succeed(IdAllocator.IdAllocatorV2, yield* IdAllocator.IdAllocatorV2),
              Layer.mock(Orchestrator.OrchestratorV2)({
                getThreadRecords: (threadId, fields) =>
                  projections
                    .getThreadRecords(threadId, fields)
                    .pipe(
                      Effect.mapError(
                        (cause) =>
                          new Orchestrator.OrchestratorProjectionError({ threadId, cause }),
                      ),
                    ),
              }),
              Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({}),
              Layer.succeed(
                ThreadCommandExecutor.ThreadCommandExecutor,
                yield* ThreadCommandExecutor.make,
              ),
            ),
          ),
        )
      : Layer.mock(AgentSessionImporter.AgentSessionImporter)({
          importRecentAgentThreads: (input, importOptions) =>
            Effect.sync(() => {
              imports.push({
                projectId: input.projectId,
                chosen: importOptions?.chosen,
                active: importOptions?.active,
              });
              return {
                importedCount: 1,
                skippedCount: 0,
                threadIds: [ThreadId.make(`import:${imports.length}`)],
              };
            }),
        });

  const context = yield* Layer.build(
    AgentSessionCatalog.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          config,
          settings,
          runtimes,
          Layer.succeed(SqlClient.SqlClient, yield* SqlClient.SqlClient),
          SecureRandom.layerWebCrypto,
          scannerLayer,
          projectService,
          importer,
        ),
      ),
    ),
  );
  const catalog = Context.get(context, AgentSessionCatalog.AgentSessionCatalog);
  return {
    root,
    claudeHome,
    codexHome,
    catalog,
    reads,
    bootstraps,
    imports,
    makeWorkspace,
    writeClaude,
    settingsService,
    projections,
    stateDir: serverConfig.stateDir,
  };
});

it.effect(
  "lists every session on disk newest first, however old, except those a thread holds",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sql = yield* SqlClient.SqlClient;
      const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      const harness = yield* makeHarness();
      const workspace = yield* harness.makeWorkspace("app");
      yield* harness.writeClaude({
        cwd: workspace,
        sessionId: "0b6f1d5e-1111-4aaa-8bbb-000000000001",
        request: "Recent work",
        ageDays: 1,
      });
      yield* harness.writeClaude({
        cwd: workspace,
        sessionId: "0b6f1d5e-1111-4aaa-8bbb-000000000002",
        request: "Work from last year",
        ageDays: 400,
      });
      // Held by an imported thread, through its resume cursor.
      yield* harness.writeClaude({
        cwd: workspace,
        sessionId: "0b6f1d5e-1111-4aaa-8bbb-000000000003",
        request: "Already imported",
        ageDays: 2,
      });
      yield* runtimes.upsert({
        threadId: ThreadId.make("import:claudeAgent:0b6f1d5e-1111-4aaa-8bbb-000000000003"),
        providerName: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: claude,
        adapterKey: "claudeAgent",
        runtimeMode: "full-access",
        status: "stopped",
        lastSeenAt: timestamp,
        resumeCursor: { resume: "0b6f1d5e-1111-4aaa-8bbb-000000000003" },
        runtimePayload: null,
      });
      // Held by a thread started in T3 Code, through its provider thread's native ID.
      const codexDay = path.join(harness.codexHome, "sessions", "2026", "08", "30");
      yield* fs.makeDirectory(codexDay, { recursive: true });
      yield* fs.writeFileString(
        path.join(codexDay, "rollout-live.jsonl"),
        [
          { type: "session_meta", payload: { id: "codex-live", cwd: workspace } },
          // Longer than the catalog's prefix read, so no whole message is in it.
          { type: "event_msg", payload: { type: "user_message", message: "x".repeat(300_000) } },
        ]
          .map((record) => JSON.stringify(record) + "\n")
          .join(""),
      );
      yield* sql`
        INSERT INTO orchestration_v2_projection_provider_threads
          (provider_thread_id, thread_id, provider, status, updated_at, payload_json)
        VALUES (
          'provider-thread-live', 'thread-live', 'codex', 'idle', ${timestamp},
          ${JSON.stringify({ nativeThreadRef: { driver: "codex", nativeId: "codex-live" } })}
        )
      `;

      yield* harness.catalog.index;
      const result = yield* harness.catalog.list({});

      expect(titles(result)).toEqual(["Recent work", "Work from last year"]);
      expect(result.totalCount).toBe(2);
      expect(result.entries[0]?.projectRoot).toBe(workspace);
      expect(result.entries[0]?.projectId).toBeNull();
      expect(result.indexedAt).not.toBeNull();
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(persistence, NodeServices.layer))),
);

it.effect("re-reads only new and changed transcripts and drops deleted ones", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const harness = yield* makeHarness();
    const workspace = yield* harness.makeWorkspace("app");
    const kept = yield* harness.writeClaude({
      cwd: workspace,
      sessionId: "0b6f1d5e-2222-4aaa-8bbb-000000000001",
      request: "Kept",
      ageDays: 3,
    });
    const changed = yield* harness.writeClaude({
      cwd: workspace,
      sessionId: "0b6f1d5e-2222-4aaa-8bbb-000000000002",
      request: "Before the change",
      ageDays: 2,
    });
    const removed = yield* harness.writeClaude({
      cwd: workspace,
      sessionId: "0b6f1d5e-2222-4aaa-8bbb-000000000003",
      request: "Removed",
      ageDays: 1,
    });
    yield* harness.catalog.index;
    expect(harness.reads.toSorted()).toEqual([kept, changed, removed].toSorted());
    expect(titles(yield* harness.catalog.list({}))).toEqual([
      "Removed",
      "Before the change",
      "Kept",
    ]);

    harness.reads.length = 0;
    yield* harness.writeClaude({
      cwd: workspace,
      sessionId: "0b6f1d5e-2222-4aaa-8bbb-000000000002",
      request: "After the change",
      ageDays: 0,
    });
    yield* fs.remove(removed);
    const added = yield* harness.writeClaude({
      cwd: workspace,
      sessionId: "0b6f1d5e-2222-4aaa-8bbb-000000000004",
      request: "Added",
      ageDays: 1,
    });
    yield* harness.catalog.index;

    expect(harness.reads.toSorted()).toEqual([changed, added].toSorted());
    expect(titles(yield* harness.catalog.list({}))).toEqual(["After the change", "Added", "Kept"]);
  }).pipe(Effect.scoped, Effect.provide(Layer.merge(persistence, NodeServices.layer))),
);

it.effect("a list never reports a finished pass beside rows from before it", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const harness = yield* makeHarness();
    const workspace = yield* harness.makeWorkspace("app");
    const passes = 30;
    const sessions: Array<string> = [];
    for (let index = 0; index < passes; index++) {
      sessions.push(
        yield* harness.writeClaude({
          cwd: workspace,
          sessionId: `0b6f1d5e-4444-4aaa-8bbb-${String(index).padStart(12, "0")}`,
          request: `Session ${index}`,
          ageDays: 1,
        }),
      );
    }
    yield* harness.catalog.index;

    // Switching fibers as often as the runtime allows puts lists between a pass's writes.
    yield* Effect.gen(function* () {
      for (let pass = 0; pass < passes; pass++) {
        // Each pass drops one transcript, so its last write changes what the list shows.
        yield* fs.remove(sessions[pass]!);
        yield* TestClock.adjust(1_000);
        const stamp = DateTime.formatIso(yield* DateTime.now);
        const remaining = passes - pass - 1;
        const seen: Array<AgentSessionCatalogResult> = [];
        // A list still running when the pass ends is the one most likely to straddle its last
        // write, so each one is waited for, not cut off. Several readers widen the chance.
        const finished = yield* Deferred.make<void>();
        const reader = Effect.gen(function* () {
          while (!Deferred.isDoneUnsafe(finished)) seen.push(yield* harness.catalog.list({}));
        });
        const lists = yield* Effect.all([reader, reader, reader, reader], {
          concurrency: "unbounded",
        }).pipe(Effect.forkChild);
        yield* harness.catalog.index;
        yield* Deferred.succeed(finished, undefined);
        yield* Fiber.join(lists);

        const after = yield* harness.catalog.list({});
        expect({ pass, totalCount: after.totalCount, indexing: after.indexing }).toEqual({
          pass,
          totalCount: remaining,
          indexing: false,
        });
        // A list that names this pass as its source shows what this pass left.
        for (const result of seen.filter((item) => item.indexedAt === stamp)) {
          expect({ pass, totalCount: result.totalCount }).toEqual({ pass, totalCount: remaining });
        }
      }
    }).pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, 1));
  }).pipe(Effect.scoped, Effect.provide(Layer.merge(persistence, NodeServices.layer))),
);

it.effect("pages with a cursor without gaps or repeats, and filters by project", () =>
  Effect.gen(function* () {
    const appProject = ProjectId.make("project-app");
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "t3-paging-" }));
    const app = path.join(root, "app");
    const harness = yield* makeHarness({ projects: [shell(appProject, app)] });
    yield* fs.makeDirectory(path.join(app, ".git"), { recursive: true });
    yield* fs.writeFileString(path.join(app, ".git", "config"), "[core]\n");
    const other = yield* harness.makeWorkspace("other");
    // Two sessions share a modification time, so paging must break the tie the same way each time.
    for (const [index, cwd, ageDays] of [
      [1, app, 1],
      [2, other, 2],
      [3, app, 2],
      [4, other, 5],
      [5, app, 9],
    ] as const) {
      yield* harness.writeClaude({
        cwd,
        sessionId: `0b6f1d5e-3333-4aaa-8bbb-00000000000${index}`,
        request: `Session ${index}`,
        ageDays,
      });
    }
    yield* harness.catalog.index;

    const seen: Array<string | null> = [];
    let page = yield* harness.catalog.list({ limit: 2 });
    for (;;) {
      expect(page.totalCount).toBe(5);
      seen.push(...titles(page));
      const last = page.entries.at(-1);
      if (last === undefined) break;
      page = yield* harness.catalog.list({
        limit: 2,
        before: {
          lastActiveAt: last.lastActiveAt,
          providerInstanceId: last.providerInstanceId,
          filePath: last.filePath,
        },
      });
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    expect(seen[0]).toBe("Session 1");
    expect(seen.slice(3)).toEqual(["Session 4", "Session 5"]);

    // A page bounded on both sides keeps its rows when a newer session lands inside it.
    const first = yield* harness.catalog.list({ limit: 2 });
    const edge = first.entries.at(-1)!;
    const edgeCursor = {
      lastActiveAt: edge.lastActiveAt,
      providerInstanceId: edge.providerInstanceId,
      filePath: edge.filePath,
    };
    yield* harness.writeClaude({
      cwd: other,
      sessionId: "0b6f1d5e-3333-4aaa-8bbb-000000000006",
      request: "Session 6",
      ageDays: 1.5,
    });
    yield* harness.catalog.index;
    const bounded = yield* harness.catalog.list({ through: edgeCursor, limit: 200 });
    const next = yield* harness.catalog.list({ before: edgeCursor, limit: 2 });
    expect([...titles(bounded), ...titles(next)]).toEqual([
      "Session 1",
      "Session 6",
      titles(first)[1],
      ...seen.slice(2, 4),
    ]);

    const filtered = yield* harness.catalog.list({ projectIds: [appProject] });
    expect(filtered.totalCount).toBe(3);
    expect(filtered.entries.map((entry) => entry.projectId)).toEqual([
      appProject,
      appProject,
      appProject,
    ]);
  }).pipe(Effect.scoped, Effect.provide(Layer.merge(persistence, NodeServices.layer))),
);

it.effect("opens an old session as an active thread, creating its project once", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const harness = yield* makeHarness();
    const repo = yield* harness.makeWorkspace("repo");
    // A linked worktree of the repo; its sessions open in the repo's project.
    const worktree = path.join(harness.root, "feature");
    const worktreeGitDir = path.join(repo, ".git", "worktrees", "feature");
    yield* fs.makeDirectory(worktreeGitDir, { recursive: true });
    yield* fs.makeDirectory(worktree);
    yield* fs.writeFileString(path.join(worktreeGitDir, "commondir"), "../..\n");
    yield* fs.writeFileString(path.join(worktreeGitDir, "HEAD"), "ref: refs/heads/feature\n");
    yield* fs.writeFileString(path.join(worktree, ".git"), `gitdir: ${worktreeGitDir}\n`);
    const old = yield* harness.writeClaude({
      cwd: repo,
      sessionId: "0b6f1d5e-4444-4aaa-8bbb-000000000001",
      request: "Old work",
      ageDays: 400,
    });
    const branch = yield* harness.writeClaude({
      cwd: worktree,
      sessionId: "0b6f1d5e-4444-4aaa-8bbb-000000000002",
      request: "Branch work",
      ageDays: 30,
    });
    yield* harness.catalog.index;

    const before = (yield* harness.catalog.list({ limit: 0 })).revision;
    const first = yield* harness.catalog.hydrate({ providerInstanceId: claude, filePath: old });
    // A thread now holds it, so answers read before the open never join answers read after.
    expect((yield* harness.catalog.list({ limit: 0 })).revision).toBeGreaterThan(before);
    const second = yield* harness.catalog.hydrate({
      providerInstanceId: claude,
      filePath: branch,
    });

    // The second session finds the project the first one created.
    expect(harness.bootstraps.map((input) => input.workspaceRoot)).toEqual([repo]);
    expect(second.projectId).toBe(first.projectId);
    expect(harness.imports).toEqual([
      {
        projectId: first.projectId,
        chosen: [expect.objectContaining({ filePath: old, source: "claudeAgent" })],
        active: true,
      },
      {
        projectId: first.projectId,
        chosen: [expect.objectContaining({ filePath: branch, source: "claudeAgent" })],
        active: true,
      },
    ]);
    expect(first.threadId).toBe(ThreadId.make("import:1"));
  }).pipe(Effect.scoped, Effect.provide(Layer.merge(persistence, NodeServices.layer))),
);

it.effect("refuses sessions whose transcript or folder is gone", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const harness = yield* makeHarness();
    const workspace = yield* harness.makeWorkspace("app");
    const deleted = yield* harness.writeClaude({
      cwd: workspace,
      sessionId: "0b6f1d5e-5555-4aaa-8bbb-000000000001",
      request: "Transcript deleted",
      ageDays: 1,
    });
    yield* harness.catalog.index;
    yield* fs.remove(deleted);

    const missing = yield* harness.catalog
      .hydrate({ providerInstanceId: claude, filePath: deleted })
      .pipe(Effect.flip);
    expect(missing).toMatchObject({ _tag: "AgentSessionHydrateError", reason: "not-found" });
    expect(titles(yield* harness.catalog.list({}))).toEqual([]);

    const orphan = yield* harness.writeClaude({
      cwd: workspace,
      sessionId: "0b6f1d5e-5555-4aaa-8bbb-000000000002",
      request: "Folder deleted",
      ageDays: 1,
    });
    yield* harness.catalog.index;
    expect(titles(yield* harness.catalog.list({}))).toEqual(["Folder deleted"]);
    yield* fs.remove(workspace, { recursive: true });
    const folderGone = yield* harness.catalog
      .hydrate({ providerInstanceId: claude, filePath: orphan })
      .pipe(Effect.flip);
    expect(folderGone).toMatchObject({ _tag: "AgentSessionHydrateError", reason: "no-project" });
    // The next pass notices the folder is gone although the transcript did not change.
    yield* harness.catalog.index;
    expect(titles(yield* harness.catalog.list({}))).toEqual([]);
    expect(harness.imports).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(Layer.merge(persistence, NodeServices.layer))),
);

it.effect("counts the sessions in each span, and lists one span at a time", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    const workspace = yield* harness.makeWorkspace("app");
    for (const [index, request, ageDays] of [
      [1, "This morning", 0.25],
      [2, "Three days ago", 3],
      [3, "Last fortnight", 14],
      [4, "Six weeks ago", 42],
      [5, "Last year", 400],
    ] as const) {
      yield* harness.writeClaude({
        cwd: workspace,
        sessionId: `0b6f1d5e-4444-4aaa-8bbb-00000000000${index}`,
        request,
        ageDays,
      });
    }
    yield* harness.catalog.index;
    const daysAgo = (days: number) =>
      DateTime.formatIso(DateTime.makeUnsafe(nowMs - days * DAY_MS));

    // Only the counts: one per span, the newest first, with the oldest span open-ended.
    const summary = yield* harness.catalog.list({
      limit: 0,
      groupBounds: [daysAgo(1), daysAgo(7), daysAgo(30)],
    });
    expect(summary.entries).toEqual([]);
    expect(summary.totalCount).toBe(5);
    expect(summary.groupCounts).toEqual([1, 1, 1, 2]);

    // A span lists only its own sessions and counts only them, so it pages on its own.
    const middle = yield* harness.catalog.list({
      activeFrom: daysAgo(30),
      activeUntil: daysAgo(7),
    });
    expect(titles(middle)).toEqual(["Last fortnight"]);
    expect(middle.totalCount).toBe(1);
    const oldest = yield* harness.catalog.list({ activeUntil: daysAgo(30), limit: 1 });
    expect(titles(oldest)).toEqual(["Six weeks ago"]);
    expect(oldest.totalCount).toBe(2);
    const rest = yield* harness.catalog.list({
      activeUntil: daysAgo(30),
      before: {
        lastActiveAt: oldest.entries[0]!.lastActiveAt,
        providerInstanceId: oldest.entries[0]!.providerInstanceId,
        filePath: oldest.entries[0]!.filePath,
      },
    });
    expect(titles(rest)).toEqual(["Last year"]);
    // A session exactly on a bound belongs to the newer span, counted and listed alike.
    const onBound = middle.entries[0]!.lastActiveAt;
    expect(titles(yield* harness.catalog.list({ activeFrom: onBound }))).toEqual([
      "This morning",
      "Three days ago",
      "Last fortnight",
    ]);
    expect(titles(yield* harness.catalog.list({ activeUntil: onBound }))).toEqual([
      "Six weeks ago",
      "Last year",
    ]);
    expect((yield* harness.catalog.list({ limit: 0, groupBounds: [onBound] })).groupCounts).toEqual(
      [3, 2],
    );
  }).pipe(Effect.scoped, Effect.provide(Layer.merge(persistence, NodeServices.layer))),
);

it.effect("a refresh starts a pass only once the last one is fifteen seconds old", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    const workspace = yield* harness.makeWorkspace("app");
    yield* harness.writeClaude({
      cwd: workspace,
      sessionId: "0b6f1d5e-7777-4aaa-8bbb-000000000001",
      request: "First",
      ageDays: 1,
    });
    yield* harness.catalog.index;

    // Asked again straight after a pass, the catalog does not walk every home again.
    expect((yield* harness.catalog.list({ refresh: true })).indexing).toBe(false);

    yield* harness.writeClaude({
      cwd: workspace,
      sessionId: "0b6f1d5e-7777-4aaa-8bbb-000000000002",
      request: "Finished in a terminal",
      ageDays: 0,
    });
    yield* TestClock.adjust(14_999);
    expect((yield* harness.catalog.list({ refresh: true })).indexing).toBe(false);
    yield* TestClock.adjust(1);
    expect((yield* harness.catalog.list({ refresh: true })).indexing).toBe(true);
    // Waits for the pass the refresh started.
    yield* harness.catalog.index;
    expect(titles(yield* harness.catalog.list({}))).toEqual(["Finished in a terminal", "First"]);
  }).pipe(Effect.scoped, Effect.provide(Layer.merge(persistence, NodeServices.layer))),
);

it.effect("lists, opens and imports nothing and keeps no index while the setting is off", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const harness = yield* makeHarness({ externalSessions: false });
    const workspace = yield* harness.makeWorkspace("app");
    const filePath = yield* harness.writeClaude({
      cwd: workspace,
      sessionId: "0b6f1d5e-6666-4aaa-8bbb-000000000001",
      request: "Hidden",
      ageDays: 1,
    });

    expect(yield* harness.catalog.list({ refresh: true })).toEqual({
      entries: [],
      totalCount: 0,
      indexing: false,
      indexedAt: null,
      olderThan: [],
      groupCounts: [],
      revision: 0,
      listing: "",
      importing: null,
    });
    expect((yield* harness.catalog.banish({ kind: "olderThan", months: 1 })).count).toBe(0);
    const refused = yield* harness.catalog
      .hydrate({ providerInstanceId: claude, filePath })
      .pipe(Effect.flip);
    expect(refused).toMatchObject({ _tag: "AgentSessionHydrateError", reason: "disabled" });
    expect(
      yield* harness.catalog.importSessions({
        sessions: [],
        windows: [{ activeFrom: "2026-01-01T00:00:00.000Z" }],
      }),
    ).toMatchObject({ importedCount: 0, skippedCount: 0 });
    expect(harness.imports).toEqual([]);
    expect(yield* fs.exists(path.join(harness.stateDir, "agent-session-catalog.sqlite"))).toBe(
      false,
    );
  }).pipe(Effect.scoped, Effect.provide(Layer.merge(persistence, NodeServices.layer))),
);

it.effect("banishes sessions by age or by choice into the archive, and restores them", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    const workspace = yield* harness.makeWorkspace("app");
    const write = (index: number, request: string, ageDays: number) =>
      harness.writeClaude({
        cwd: workspace,
        sessionId: `0b6f1d5e-8888-4aaa-8bbb-00000000000${index}`,
        request,
        ageDays,
      });
    yield* write(1, "Recent", 1);
    const weeksOld = yield* write(2, "Weeks old", 40);
    yield* write(3, "Months old", 100);
    yield* write(4, "Year old", 400);
    yield* harness.catalog.index;

    // Each preset counts what it would take, so the menu can say so before anything goes.
    expect((yield* harness.catalog.list({})).olderThan).toEqual([
      { months: 1, count: 3 },
      { months: 2, count: 2 },
      { months: 3, count: 2 },
      { months: 6, count: 1 },
      { months: 12, count: 1 },
    ]);

    // Everything last active more than three months ago goes to the archive.
    const old = yield* harness.catalog.banish({ kind: "olderThan", months: 3 });
    expect(old.count).toBe(2);
    const afterAge = yield* harness.catalog.list({});
    expect(titles(afterAge)).toEqual(["Recent", "Weeks old"]);
    expect(afterAge.totalCount).toBe(2);
    expect(afterAge.olderThan.find((preset) => preset.months === 1)?.count).toBe(1);
    const archive = yield* harness.catalog.banished({});
    expect(archive.entries.map((entry) => entry.title)).toEqual(["Months old", "Year old"]);
    expect(archive.entries.every((entry) => entry.banishedAt.length > 0)).toBe(true);

    // A chosen session joins them.
    yield* harness.catalog.banish({
      kind: "sessions",
      sessions: [{ providerInstanceId: claude, filePath: weeksOld }],
    });
    expect(titles(yield* harness.catalog.list({}))).toEqual(["Recent"]);
    expect((yield* harness.catalog.banished({})).totalCount).toBe(3);

    // Undo brings back exactly the batch it banished.
    expect((yield* harness.catalog.restore({ kind: "batch", batchId: old.batchId })).count).toBe(2);
    expect(titles(yield* harness.catalog.list({}))).toEqual(["Recent", "Months old", "Year old"]);
    // And the archive restores one session by itself.
    yield* harness.catalog.restore({
      kind: "sessions",
      sessions: [{ providerInstanceId: claude, filePath: weeksOld }],
    });
    expect(titles(yield* harness.catalog.list({}))).toEqual([
      "Recent",
      "Weeks old",
      "Months old",
      "Year old",
    ]);
    expect((yield* harness.catalog.banished({})).totalCount).toBe(0);
  }).pipe(Effect.scoped, Effect.provide(Layer.merge(persistence, NodeServices.layer))),
);

it.effect(
  "imports the sessions listed for the last 30 days as settled threads, and nothing else",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const harness = yield* makeHarness({ realImporter: true });
      const app = yield* harness.makeWorkspace("app");
      // A folder no project holds yet; importing its session makes one.
      const lib = yield* harness.makeWorkspace("lib");
      const write = (index: number, cwd: string, request: string, ageDays: number) =>
        harness.writeClaude({
          cwd,
          sessionId: `0b6f1d5e-9999-4aaa-8bbb-00000000000${index}`,
          request,
          ageDays,
        });
      yield* write(1, app, "Yesterday", 1);
      yield* write(2, lib, "Three weeks ago", 21);
      yield* write(7, lib, "Two weeks ago", 14);
      yield* write(3, app, "Six weeks ago", 42);
      const banished = yield* write(4, app, "Banished last week", 5);
      const opened = yield* write(5, app, "Opened earlier", 10);
      const deleted = yield* write(6, app, "Deleted since", 3);
      yield* harness.catalog.index;
      yield* harness.catalog.banish({
        kind: "sessions",
        sessions: [{ providerInstanceId: claude, filePath: banished }],
      });
      const held = yield* harness.catalog.hydrate({ providerInstanceId: claude, filePath: opened });
      yield* fs.remove(deleted);

      const activeFrom = DateTime.formatIso(DateTime.makeUnsafe(nowMs - 30 * DAY_MS));
      const result = yield* harness.catalog.importSessions({
        sessions: [],
        windows: [{ activeFrom }],
      });

      // The three listed sessions inside the window become threads; the deleted one is skipped.
      expect(result).toMatchObject({ importedCount: 3, skippedCount: 1 });
      for (const index of [1, 2, 7]) {
        const threadId = ThreadId.make(
          `import:${claude}:0b6f1d5e-9999-4aaa-8bbb-00000000000${index}`,
        );
        const records = yield* harness.projections.getThreadRecords(threadId, ["messages"]);
        // Settled, as the onboarding import makes them: history to look back on, not open work.
        expect(records.thread.settledOverride).toBe("settled");
      }
      // `app` got its project when a session was opened; `lib` gets exactly one for its two.
      expect(harness.bootstraps.map((bootstrap) => bootstrap.workspaceRoot).toSorted()).toEqual(
        [app, lib].toSorted(),
      );
      // The session opened earlier stays active and is not imported again.
      const heldRecords = yield* harness.projections.getThreadRecords(held.threadId, []);
      expect(heldRecords.thread.settledOverride).toBe("active");
      // What is left listed is outside the window, and the banished session stays banished.
      expect(titles(yield* harness.catalog.list({}))).toEqual(["Six weeks ago"]);
      expect((yield* harness.catalog.banished({})).entries.map((entry) => entry.title)).toEqual([
        "Banished last week",
      ]);

      // A second import finds nothing left to take.
      expect(
        yield* harness.catalog.importSessions({ sessions: [], windows: [{ activeFrom }] }),
      ).toMatchObject({
        importedCount: 0,
        skippedCount: 0,
      });
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(persistence, NodeServices.layer))),
);

it.effect("imports the chosen sessions the list shows, whatever their age, and nothing else", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({ realImporter: true });
    const app = yield* harness.makeWorkspace("app");
    const write = (index: number, request: string, ageDays: number) =>
      harness.writeClaude({
        cwd: app,
        sessionId: `0b6f1d5e-cccc-4aaa-8bbb-00000000000${index}`,
        request,
        ageDays,
      });
    const recent = yield* write(1, "Chosen yesterday", 1);
    const old = yield* write(2, "Chosen last year", 400);
    yield* write(3, "Not chosen", 5);
    const banished = yield* write(4, "Chosen but banished", 10);
    const opened = yield* write(5, "Chosen but opened", 20);
    yield* harness.catalog.index;
    yield* harness.catalog.banish({
      kind: "sessions",
      sessions: [{ providerInstanceId: claude, filePath: banished }],
    });
    yield* harness.catalog.hydrate({ providerInstanceId: claude, filePath: opened });

    const chosen = [recent, old, banished, opened].map((filePath) => ({
      providerInstanceId: claude,
      filePath,
    }));
    // A banished session and one a thread holds are not on the list, so choosing them takes nothing.
    expect(yield* harness.catalog.importSessions({ sessions: chosen })).toMatchObject({
      importedCount: 2,
      skippedCount: 0,
    });
    for (const index of [1, 2]) {
      const threadId = ThreadId.make(
        `import:${claude}:0b6f1d5e-cccc-4aaa-8bbb-00000000000${index}`,
      );
      const records = yield* harness.projections.getThreadRecords(threadId, []);
      expect(records.thread.settledOverride).toBe("settled");
    }
    expect(titles(yield* harness.catalog.list({}))).toEqual(["Not chosen"]);
    expect((yield* harness.catalog.banished({})).entries.map((entry) => entry.title)).toEqual([
      "Chosen but banished",
    ]);
  }).pipe(Effect.scoped, Effect.provide(Layer.merge(persistence, NodeServices.layer))),
);

it.effect("narrows the list, its counts, banishing, importing and restoring to a filter", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({ realImporter: true });
    const billing = yield* harness.makeWorkspace("billing");
    const docs = yield* harness.makeWorkspace("docs");
    const write = (index: number, cwd: string, request: string, ageDays: number) =>
      harness.writeClaude({
        cwd,
        sessionId: `0b6f1d5e-dddd-4aaa-8bbb-00000000000${index}`,
        request,
        ageDays,
      });
    yield* write(1, billing, "Fix the refund rounding", 2);
    yield* write(2, docs, "Rewrite the README", 3);
    yield* write(3, billing, "Old invoice export", 200);
    yield* write(4, docs, "Old style guide", 300);
    yield* harness.catalog.index;

    // The text matches a title or the folder, whatever its case; the tool narrows too.
    const billingOnly = { search: "BILLING" };
    expect(titles(yield* harness.catalog.list({ filter: billingOnly }))).toEqual([
      "Fix the refund rounding",
      "Old invoice export",
    ]);
    expect(titles(yield* harness.catalog.list({ filter: { search: "readme" } }))).toEqual([
      "Rewrite the README",
    ]);
    expect(
      (yield* harness.catalog.list({ filter: { sources: ["codex"] }, limit: 0 })).totalCount,
    ).toBe(0);
    // The presets count, and banish, only what the filter shows.
    const filtered = yield* harness.catalog.list({ filter: billingOnly, limit: 0 });
    expect(filtered.olderThan.find((preset) => preset.months === 3)?.count).toBe(1);
    expect(
      (yield* harness.catalog.banish({ kind: "olderThan", months: 3, filter: billingOnly })).count,
    ).toBe(1);
    expect(titles(yield* harness.catalog.list({}))).toEqual([
      "Fix the refund rounding",
      "Rewrite the README",
      "Old style guide",
    ]);
    // An import of a window takes only what the filter shows in it.
    const activeFrom = DateTime.formatIso(DateTime.makeUnsafe(nowMs - 30 * DAY_MS));
    expect(
      yield* harness.catalog.importSessions({
        sessions: [],
        windows: [{ activeFrom }],
        filter: billingOnly,
      }),
    ).toMatchObject({ importedCount: 1, skippedCount: 0 });
    expect(titles(yield* harness.catalog.list({}))).toEqual([
      "Rewrite the README",
      "Old style guide",
    ]);
    // Restoring every banished session under a filter leaves the others banished.
    yield* harness.catalog.banish({ kind: "olderThan", months: 3 });
    expect((yield* harness.catalog.banished({ filter: billingOnly })).totalCount).toBe(1);
    expect(
      (yield* harness.catalog.restore({ kind: "banished", filter: { search: "style" } })).count,
    ).toBe(1);
    expect((yield* harness.catalog.banished({})).entries.map((entry) => entry.title)).toEqual([
      "Old invoice export",
    ]);
    expect((yield* harness.catalog.restore({ kind: "banished" })).count).toBe(1);
    expect((yield* harness.catalog.banished({})).totalCount).toBe(0);
  }).pipe(Effect.scoped, Effect.provide(Layer.merge(persistence, NodeServices.layer))),
);

it.effect(
  "takes whole groups less the excluded sessions, names the threads made and shows progress",
  () =>
    Effect.gen(function* () {
      // Lists between import write transactions, to see the progress an import reports.
      let duringImport: Effect.Effect<void> = Effect.void;
      const harness = yield* makeHarness({
        realImporter: true,
        beforeImportTransaction: Effect.suspend(() => duringImport),
      });
      const app = yield* harness.makeWorkspace("app");
      const sessionId = (index: number) => `0b6f1d5e-eeee-4aaa-8bbb-00000000000${index}`;
      const write = (index: number, request: string, ageDays: number) =>
        harness.writeClaude({ cwd: app, sessionId: sessionId(index), request, ageDays });
      yield* write(1, "In the week", 2);
      const excluded = yield* write(2, "In the week, left out", 3);
      yield* write(3, "Before the week", 20);
      yield* harness.catalog.index;
      const seen: Array<{ readonly done: number; readonly total: number } | null> = [];
      duringImport = harness.catalog.list({ limit: 0 }).pipe(
        Effect.map((answer) => seen.push(answer.importing)),
        Effect.asVoid,
        Effect.orDie,
      );

      const week = DateTime.formatIso(DateTime.makeUnsafe(nowMs - 7 * DAY_MS));
      const result = yield* harness.catalog.importSessions({
        sessions: [],
        windows: [{ activeFrom: week }],
        exclude: [{ providerInstanceId: claude, filePath: excluded }],
      });
      expect(result).toEqual({
        importedCount: 1,
        skippedCount: 0,
        threadIds: [ThreadId.make(`import:${claude}:${sessionId(1)}`)],
      });
      expect(titles(yield* harness.catalog.list({}))).toEqual([
        "In the week, left out",
        "Before the week",
      ]);
      // While it ran, every answer said how far it had got; afterwards none does.
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((progress) => progress !== null && progress.total === 1)).toBe(true);
      expect((yield* harness.catalog.list({ limit: 0 })).importing).toBeNull();

      // Banishing takes a window less the excluded in the same way.
      expect(
        (yield* harness.catalog.banish({
          kind: "sessions",
          sessions: [],
          windows: [{ activeUntil: week }],
          exclude: [],
        })).count,
      ).toBe(1);
      expect(titles(yield* harness.catalog.list({}))).toEqual(["In the week, left out"]);
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(persistence, NodeServices.layer))),
);

it.effect("does not list a session with no conversation until one starts in it", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const harness = yield* makeHarness();
    const app = yield* harness.makeWorkspace("app");
    const sessionId = "0b6f1d5e-ffff-4aaa-8bbb-000000000001";
    const filePath = yield* harness.writeClaude({
      cwd: app,
      sessionId,
      request: "Talk",
      ageDays: 1,
    });
    // Only a record that names the session and its folder: nothing was said in it.
    yield* fs.writeFileString(
      filePath,
      JSON.stringify({ type: "system", cwd: app, sessionId, timestamp }) + "\n",
    );
    yield* harness.catalog.index;
    expect((yield* harness.catalog.list({ limit: 0 })).totalCount).toBe(0);

    // Once a conversation is in it, the next pass lists it.
    yield* fs.writeFileString(filePath, claudeTranscript(app, sessionId, "Now it talks"));
    yield* harness.catalog.index;
    expect(titles(yield* harness.catalog.list({}))).toEqual(["Now it talks"]);
  }).pipe(Effect.scoped, Effect.provide(Layer.merge(persistence, NodeServices.layer))),
);

it.effect("previews the start of a conversation without making a project or a thread", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const harness = yield* makeHarness({ realImporter: true });
    const app = yield* harness.makeWorkspace("app");
    const filePath = yield* harness.writeClaude({
      cwd: app,
      sessionId: "0b6f1d5e-9191-4aaa-8bbb-000000000001",
      request: "What does the payout job do?",
      ageDays: 1,
    });
    yield* harness.catalog.index;

    const preview = yield* harness.catalog.preview({ providerInstanceId: claude, filePath });
    expect(preview).toEqual({
      messages: [
        { role: "user", text: "What does the payout job do?" },
        { role: "assistant", text: "Done" },
      ],
      more: false,
    });
    expect(harness.bootstraps).toEqual([]);
    // Still listed: a preview opens nothing.
    expect(titles(yield* harness.catalog.list({}))).toEqual(["What does the payout job do?"]);

    // A conversation too long to hold whole shows only its opening request, never its opening
    // request followed by its latest messages as if they came next.
    const longSession = "0b6f1d5e-9191-4aaa-8bbb-000000000002";
    const longPath = yield* harness.writeClaude({
      cwd: app,
      sessionId: longSession,
      request: "Start the ledger rewrite",
      ageDays: 2,
    });
    const turns = Array.from({ length: 400 }, (_, index) =>
      index % 2 === 0
        ? {
            type: "assistant",
            sessionId: longSession,
            timestamp,
            message: { role: "assistant", content: [{ type: "text", text: `Reply ${index}` }] },
          }
        : {
            type: "user",
            cwd: app,
            sessionId: longSession,
            timestamp,
            message: { role: "user", content: `Request ${index}` },
          },
    );
    yield* fs.writeFileString(
      longPath,
      (yield* fs.readFileString(longPath)) +
        turns.map((record) => JSON.stringify(record) + "\n").join(""),
    );
    yield* harness.catalog.index;
    const long = yield* harness.catalog.preview({ providerInstanceId: claude, filePath: longPath });
    expect(long).toEqual({
      messages: [{ role: "user", text: "Start the ledger rewrite" }],
      more: true,
    });

    yield* fs.remove(filePath);
    const refused = yield* harness.catalog
      .preview({ providerInstanceId: claude, filePath })
      .pipe(Effect.flip);
    expect(refused).toMatchObject({ _tag: "AgentSessionHydrateError", reason: "not-found" });
  }).pipe(Effect.scoped, Effect.provide(Layer.merge(persistence, NodeServices.layer))),
);

it.effect(
  "imports more recent sessions than one importer call takes, and counts only real skips",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ realImporter: true });
      const app = yield* harness.makeWorkspace("app");
      const sessions = AgentSessionScanner.MAX_IMPORT_TRANSCRIPTS + 1;
      for (let index = 0; index < sessions; index++) {
        yield* harness.writeClaude({
          cwd: app,
          sessionId: `0b6f1d5e-aaaa-4aaa-8bbb-${String(index).padStart(12, "0")}`,
          request: `Session ${index}`,
          ageDays: 1 + index / 100,
        });
      }
      // Claude cannot resume a session without a proper id, so the importer skips it.
      yield* harness.writeClaude({
        cwd: app,
        sessionId: "not-a-session-id",
        request: "Cannot resume",
        ageDays: 1.5,
      });
      yield* harness.catalog.index;
      expect((yield* harness.catalog.list({ limit: 0 })).totalCount).toBe(sessions + 1);

      const activeFrom = DateTime.formatIso(DateTime.makeUnsafe(nowMs - 30 * DAY_MS));
      expect(
        yield* harness.catalog.importSessions({ sessions: [], windows: [{ activeFrom }] }),
      ).toMatchObject({
        importedCount: sessions,
        skippedCount: 1,
      });
      expect(titles(yield* harness.catalog.list({}))).toEqual(["Cannot resume"]);
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(persistence, NodeServices.layer))),
);

it.effect(
  "goes through again only the sessions a batch skipped, not ones it imported that moved on",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      // Set once the sessions are written: the second write transaction of the import, which
      // comes after the first session's thread is committed, adds a message to that session.
      let duringImport: Effect.Effect<void> = Effect.void;
      const harness = yield* makeHarness({
        realImporter: true,
        beforeImportTransaction: Effect.suspend(() => duringImport),
      });
      const app = yield* harness.makeWorkspace("app");
      const write = (sessionId: string, request: string, ageDays: number) =>
        harness.writeClaude({ cwd: app, sessionId, request, ageDays });
      const first = yield* write("0b6f1d5e-bbbb-4aaa-8bbb-000000000001", "First", 1);
      yield* write("0b6f1d5e-bbbb-4aaa-8bbb-000000000002", "Second", 2);
      // Claude cannot resume a session without a proper id, so the importer skips it.
      yield* write("not-a-session-id", "Cannot resume", 3);
      yield* harness.catalog.index;
      let transactions = 0;
      duringImport = Effect.suspend(() => {
        transactions += 1;
        return transactions === 2
          ? fs.writeFileString(
              first,
              claudeTranscript(app, "0b6f1d5e-bbbb-4aaa-8bbb-000000000001", "First") +
                claudeTranscript(app, "0b6f1d5e-bbbb-4aaa-8bbb-000000000001", "Then more"),
            )
          : Effect.void;
      }).pipe(Effect.orDie);

      const activeFrom = DateTime.formatIso(DateTime.makeUnsafe(nowMs - 30 * DAY_MS));
      expect(
        yield* harness.catalog.importSessions({ sessions: [], windows: [{ activeFrom }] }),
      ).toMatchObject({
        importedCount: 2,
        skippedCount: 1,
      });
      expect(transactions).toBeGreaterThanOrEqual(2);
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(persistence, NodeServices.layer))),
);

it.effect("an age banish from a project scope takes only that scope's sessions", () =>
  Effect.gen(function* () {
    const appProject = ProjectId.make("project-app");
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "t3-scoped-" }));
    const app = path.join(root, "app");
    const harness = yield* makeHarness({ projects: [shell(appProject, app)] });
    yield* fs.makeDirectory(path.join(app, ".git"), { recursive: true });
    yield* fs.writeFileString(path.join(app, ".git", "config"), "[core]\n");
    const other = yield* harness.makeWorkspace("other");
    for (const [index, cwd, request] of [
      [1, app, "Old in app"],
      [2, other, "Old elsewhere"],
    ] as const) {
      yield* harness.writeClaude({
        cwd,
        sessionId: `0b6f1d5e-6666-4aaa-8bbb-00000000000${index}`,
        request,
        ageDays: 100,
      });
    }
    yield* harness.catalog.index;

    const scoped = yield* harness.catalog.list({ projectIds: [appProject] });
    expect(scoped.olderThan.find((preset) => preset.months === 3)?.count).toBe(1);
    const result = yield* harness.catalog.banish({
      kind: "olderThan",
      months: 3,
      projectIds: [appProject],
    });
    expect(result.count).toBe(1);
    expect(titles(yield* harness.catalog.list({}))).toEqual(["Old elsewhere"]);

    // The archive follows the same scope.
    expect((yield* harness.catalog.banished({ projectIds: [appProject] })).totalCount).toBe(1);
    expect(
      (yield* harness.catalog.banished({ projectIds: [ProjectId.make("project-other")] }))
        .totalCount,
    ).toBe(0);
  }).pipe(Effect.scoped, Effect.provide(Layer.merge(persistence, NodeServices.layer))),
);

it.effect("banishes only what the shelf lists, so a stale window cannot take more", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    const workspace = yield* harness.makeWorkspace("app");
    const listed = yield* harness.writeClaude({
      cwd: workspace,
      sessionId: "0b6f1d5e-3333-4aaa-8bbb-000000000001",
      request: "Listed",
      ageDays: 5,
    });
    yield* harness.catalog.index;
    const first = yield* harness.catalog.banish({
      kind: "sessions",
      sessions: [{ providerInstanceId: claude, filePath: listed }],
    });
    expect(first.count).toBe(1);

    // Already banished, or never in the catalog: nothing is taken, and the first Undo still holds.
    const again = yield* harness.catalog.banish({
      kind: "sessions",
      sessions: [
        { providerInstanceId: claude, filePath: listed },
        { providerInstanceId: claude, filePath: `${workspace}/not-a-session.jsonl` },
      ],
    });
    expect(again.count).toBe(0);
    expect((yield* harness.catalog.banished({})).totalCount).toBe(1);
    expect((yield* harness.catalog.restore({ kind: "batch", batchId: first.batchId })).count).toBe(
      1,
    );
  }).pipe(Effect.scoped, Effect.provide(Layer.merge(persistence, NodeServices.layer))),
);

it.effect("changes its listing fingerprint when a thread elsewhere takes a session", () =>
  Effect.gen(function* () {
    const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
    const harness = yield* makeHarness();
    const workspace = yield* harness.makeWorkspace("app");
    for (const index of [1, 2]) {
      yield* harness.writeClaude({
        cwd: workspace,
        sessionId: `0b6f1d5e-1212-4aaa-8bbb-00000000000${index}`,
        request: `Session ${index}`,
        ageDays: index,
      });
    }
    yield* harness.catalog.index;
    const before = yield* harness.catalog.list({});
    const again = yield* harness.catalog.list({ limit: 0 });
    expect(again.listing).toBe(before.listing);

    // Another window imports one: the catalog's rows are unchanged, but what it lists is not.
    yield* runtimes.upsert({
      threadId: ThreadId.make("import:claudeAgent:0b6f1d5e-1212-4aaa-8bbb-000000000001"),
      providerName: ProviderDriverKind.make("claudeAgent"),
      providerInstanceId: claude,
      adapterKey: "claudeAgent",
      runtimeMode: "full-access",
      status: "stopped",
      lastSeenAt: timestamp,
      resumeCursor: { resume: "0b6f1d5e-1212-4aaa-8bbb-000000000001" },
      runtimePayload: null,
    });
    const after = yield* harness.catalog.list({});
    expect(titles(after)).toEqual(["Session 2"]);
    expect(after.listing).not.toBe(before.listing);
  }).pipe(Effect.scoped, Effect.provide(Layer.merge(persistence, NodeServices.layer))),
);

it.effect("moves its revision only when what it lists changes", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    const workspace = yield* harness.makeWorkspace("app");
    const write = (index: number, ageDays: number) =>
      harness.writeClaude({
        cwd: workspace,
        sessionId: `0b6f1d5e-2222-4aaa-8bbb-00000000000${index}`,
        request: `Session ${index}`,
        ageDays,
      });
    const filePath = yield* write(1, 5);
    yield* harness.catalog.index;
    const revision = () =>
      Effect.map(harness.catalog.list({ limit: 0 }), (result) => result.revision);
    const start = yield* revision();

    // A pass that finds nothing new keeps it, so answers taken while it ran still join.
    yield* harness.catalog.index;
    expect(yield* revision()).toBe(start);
    // A banish that takes nothing keeps it too.
    yield* harness.catalog.banish({ kind: "olderThan", months: 12 });
    expect(yield* revision()).toBe(start);

    // A new session, a banish and a restore each move it on.
    yield* write(2, 1);
    yield* harness.catalog.index;
    const found = yield* revision();
    expect(found).toBeGreaterThan(start);
    const banished = yield* harness.catalog.banish({
      kind: "sessions",
      sessions: [{ providerInstanceId: claude, filePath }],
    });
    const afterBanish = yield* revision();
    expect(afterBanish).toBeGreaterThan(found);
    yield* harness.catalog.restore({ kind: "batch", batchId: banished.batchId });
    expect(yield* revision()).toBeGreaterThan(afterBanish);
  }).pipe(Effect.scoped, Effect.provide(Layer.merge(persistence, NodeServices.layer))),
);

it.effect("a banished session comes back once it sees new activity", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    const workspace = yield* harness.makeWorkspace("app");
    const session = {
      cwd: workspace,
      sessionId: "0b6f1d5e-9999-4aaa-8bbb-000000000001",
      request: "Picked up again",
    };
    const filePath = yield* harness.writeClaude({ ...session, ageDays: 50 });
    yield* harness.catalog.index;
    yield* harness.catalog.banish({
      kind: "sessions",
      sessions: [{ providerInstanceId: claude, filePath }],
    });
    expect(titles(yield* harness.catalog.list({}))).toEqual([]);

    // The person carries on with it in a terminal.
    yield* harness.writeClaude({ ...session, ageDays: 0 });
    yield* harness.catalog.index;
    expect(titles(yield* harness.catalog.list({}))).toEqual(["Picked up again"]);
    expect((yield* harness.catalog.banished({})).totalCount).toBe(0);
  }).pipe(Effect.scoped, Effect.provide(Layer.merge(persistence, NodeServices.layer))),
);

it.effect("keeps what was banished when the catalog's tables are rebuilt for a new layout", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-catalog-layout-" });
    const file = path.join(directory, "catalog.sqlite");
    yield* Effect.sync(() => {
      const first = AgentSessionCatalog.openCatalogDatabase(file);
      first.exec(`
        INSERT INTO transcripts (provider_instance_id, file_path, source, home_path, mtime_ms, size)
        VALUES ('claudeAgent', '/home/dev/a.jsonl', 'claudeAgent', '/home/dev', 1, 1);
        INSERT INTO banished (provider_instance_id, file_path, mtime_ms, banished_at, batch_id)
        VALUES ('claudeAgent', '/home/dev/a.jsonl', 1, '2026-11-16T00:00:00.000Z', 'batch');
        PRAGMA user_version = 1;
      `);
      first.close();
    });
    const counts = yield* Effect.sync(() => {
      const reopened = AgentSessionCatalog.openCatalogDatabase(file);
      const count = (table: string) =>
        (reopened.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
      const result = { transcripts: count("transcripts"), banished: count("banished") };
      reopened.close();
      return result;
    });
    // The rows read from disk are rebuilt; the person's choices are not.
    expect(counts).toEqual({ transcripts: 0, banished: 1 });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

const codexRecord = (record: unknown) => JSON.stringify(record) + "\n";
const codexPrompt = (message: string) =>
  codexRecord({ type: "event_msg", payload: { type: "user_message", message } });
const codexReply = (text: string) =>
  codexRecord({
    type: "response_item",
    payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
  });

it.effect(
  "opens only the newest rollout of a rewound Codex session, with its inherited history, once",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const harness = yield* makeHarness({ realImporter: true });
      const repo = yield* harness.makeWorkspace("repo");
      const threadId = "019a0000-0000-7000-8000-0000000000a1";
      const rolloutId = "019a0000-0000-7000-8000-0000000000a2";
      const day = path.join(harness.codexHome, "sessions", "2025", "07", "01");
      yield* fs.makeDirectory(day, { recursive: true });
      const kept =
        codexRecord({
          type: "session_meta",
          payload: { id: threadId, cwd: repo, history_mode: "paginated" },
        }) +
        codexPrompt("Keep the first request") +
        codexReply("First reply");
      // The rollout the user rewound away from, then the one that continues the session.
      const older = path.join(day, `rollout-2025-07-01T10-00-00-${threadId}.jsonl`);
      yield* fs.writeFileString(
        older,
        kept + codexPrompt("Rewound request") + codexReply("Rewound reply"),
      );
      const newer = path.join(day, `rollout-2025-07-01T11-00-00-${threadId}_${rolloutId}.jsonl`);
      yield* fs.writeFileString(
        newer,
        codexRecord({
          type: "session_meta",
          payload: {
            id: threadId,
            cwd: repo,
            history_mode: "paginated",
            history_base: {
              thread_id: threadId,
              end_ordinal_exclusive: 3,
              end_byte_offset: Buffer.byteLength(kept),
            },
          },
        }) +
          codexPrompt("Ask again") +
          codexReply("Final reply"),
      );
      // Far outside the onboarding import's 30-day window.
      const oldSeconds = (nowMs - 400 * DAY_MS) / 1000;
      yield* fs.utimes(older, oldSeconds - 60, oldSeconds - 60);
      yield* fs.utimes(newer, oldSeconds, oldSeconds);
      yield* harness.catalog.index;

      const listed = yield* harness.catalog.list({});
      expect(listed.entries.map((entry) => entry.filePath)).toEqual([newer]);

      // Banishing the session takes the whole conversation out: the rollout it was rewound away
      // from does not stand in for it.
      const sent = yield* harness.catalog.banish({
        kind: "sessions",
        sessions: [{ providerInstanceId: codex, filePath: newer }],
      });
      expect((yield* harness.catalog.list({})).entries).toEqual([]);
      expect((yield* harness.catalog.banished({})).entries.map((entry) => entry.filePath)).toEqual([
        newer,
      ]);
      yield* harness.catalog.restore({ kind: "batch", batchId: sent.batchId });
      expect((yield* harness.catalog.list({})).entries.map((entry) => entry.filePath)).toEqual([
        newer,
      ]);

      // Two opens at once, as from a double click or two windows.
      const opened = yield* Effect.all(
        [
          harness.catalog.hydrate({ providerInstanceId: codex, filePath: newer }),
          harness.catalog.hydrate({ providerInstanceId: codex, filePath: newer }),
        ],
        { concurrency: 2 },
      );
      const expected = ThreadId.make(`import:codex:${threadId}`);
      expect(opened.map((result) => result.threadId)).toEqual([expected, expected]);
      const records = yield* harness.projections.getThreadRecords(expected, ["messages"]);
      expect(records.thread.settledOverride).toBe("active");
      expect(records.messages.map((message) => message.text)).toEqual([
        "Keep the first request",
        "First reply",
        "Ask again",
        "Final reply",
      ]);
      // The session is held now, so the catalog no longer offers it.
      expect((yield* harness.catalog.list({})).entries).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(persistence, NodeServices.layer))),
);

it.effect("stops offering sessions of a provider that is turned off", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    const workspace = yield* harness.makeWorkspace("app");
    const filePath = yield* harness.writeClaude({
      cwd: workspace,
      sessionId: "0b6f1d5e-7777-4aaa-8bbb-000000000001",
      request: "Profile work",
      ageDays: 1,
    });
    yield* harness.catalog.index;
    expect(titles(yield* harness.catalog.list({}))).toEqual(["Profile work"]);

    const current = yield* harness.settingsService.getSettings;
    yield* harness.settingsService.updateSettings({
      providerInstances: {
        ...current.providerInstances,
        [claude]: { ...current.providerInstances[claude]!, enabled: false },
      },
    });

    expect(titles(yield* harness.catalog.list({}))).toEqual([]);
    const refused = yield* harness.catalog
      .hydrate({ providerInstanceId: claude, filePath })
      .pipe(Effect.flip);
    expect(refused).toMatchObject({
      _tag: "AgentSessionHydrateError",
      reason: "provider-disabled",
    });
    expect(harness.imports).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(Layer.merge(persistence, NodeServices.layer))),
);

it.effect("matches a project added through a symlink to sessions run in the real folder", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "t3-alias-" }));
    const real = path.join(root, "real-app");
    const alias = path.join(root, "linked-app");
    yield* fs.makeDirectory(path.join(real, ".git"), { recursive: true });
    yield* fs.writeFileString(path.join(real, ".git", "config"), "[core]\n");
    yield* fs.symlink(real, alias);
    const projectId = ProjectId.make("project-linked");
    const harness = yield* makeHarness({ projects: [shell(projectId, alias)] });
    const filePath = yield* harness.writeClaude({
      cwd: real,
      sessionId: "0b6f1d5e-8888-4aaa-8bbb-000000000001",
      request: "Real folder work",
      ageDays: 1,
    });
    yield* harness.catalog.index;

    const listed = yield* harness.catalog.list({ projectIds: [projectId] });
    expect(titles(listed)).toEqual(["Real folder work"]);
    const opened = yield* harness.catalog.hydrate({ providerInstanceId: claude, filePath });
    expect(opened.projectId).toBe(projectId);
    expect(harness.bootstraps).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(Layer.merge(persistence, NodeServices.layer))),
);

it.effect("a second open while the first is committing returns the same thread", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const firstAtCommit = yield* Deferred.make<void>();
    const releaseFirst = yield* Deferred.make<void>();
    let transactions = 0;
    // Holds the first open at its commit, after every read that decides what to import.
    const beforeImportTransaction = Effect.suspend(() => {
      transactions += 1;
      return transactions === 1
        ? Deferred.succeed(firstAtCommit, undefined).pipe(
            Effect.andThen(Deferred.await(releaseFirst)),
          )
        : Effect.void;
    });
    const harness = yield* makeHarness({ realImporter: true, beforeImportTransaction });
    const repo = yield* harness.makeWorkspace("repo");
    const sessionId = "019a0000-0000-7000-8000-0000000000b1";
    const day = path.join(harness.codexHome, "sessions", "2025", "08", "01");
    yield* fs.makeDirectory(day, { recursive: true });
    const filePath = path.join(day, `rollout-2025-08-01T10-00-00-${sessionId}.jsonl`);
    yield* fs.writeFileString(
      filePath,
      codexRecord({ type: "session_meta", payload: { id: sessionId, cwd: repo } }) +
        codexPrompt("Pick this up again") +
        codexReply("Picked up"),
    );
    yield* harness.catalog.index;
    const open = harness.catalog.hydrate({ providerInstanceId: codex, filePath });

    const first = yield* Effect.forkScoped(open);
    yield* Deferred.await(firstAtCommit);
    // The second open, as from a double click; it may finish before the first commits.
    const second = yield* Effect.forkScoped(open);
    yield* Fiber.await(second).pipe(
      Effect.timeoutOrElse({ duration: "1 second", orElse: () => Effect.void }),
      TestClock.withLive,
    );
    yield* Deferred.succeed(releaseFirst, undefined);

    const expected = ThreadId.make(`import:codex:${sessionId}`);
    expect((yield* Fiber.join(first)).threadId).toBe(expected);
    expect((yield* Fiber.join(second)).threadId).toBe(expected);
  }).pipe(Effect.scoped, Effect.provide(Layer.merge(persistence, NodeServices.layer))),
);
