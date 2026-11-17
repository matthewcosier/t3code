import * as NodeSqlite from "node:sqlite";

import {
  AGENT_SESSION_BANISH_MONTHS,
  AGENT_SESSION_CATALOG_MAX_PAGE_SIZE,
  AGENT_SESSION_PREVIEW_CHARACTERS,
  AGENT_SESSION_PREVIEW_MESSAGES,
  AgentSessionHydrateError,
  AgentSessionImportProjectChangedError,
  AgentSessionImportProjectNotFoundError,
  AgentSessionScanError,
  AgentSessionSource,
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type AgentSessionBanishedEntry,
  type AgentSessionBanishedInput,
  type AgentSessionBanishedResult,
  type AgentSessionBanishInput,
  type AgentSessionBanishResult,
  type AgentSessionCatalogCursor,
  type AgentSessionCatalogEntry,
  type AgentSessionCatalogInput,
  type AgentSessionCatalogResult,
  type AgentSessionHydrateInput,
  type AgentSessionHydrateResult,
  type AgentSessionFilter,
  type AgentSessionImportExternalInput,
  type AgentSessionImportExternalResult,
  type AgentSessionPreviewInput,
  type AgentSessionPreviewResult,
  type AgentSessionWindow,
  type AgentSessionRef,
  type AgentSessionRestoreInput,
  type AgentSessionRestoreResult,
  type ServerSettings as ServerSettingsValue,
} from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Hash from "effect/Hash";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AgentSessionImporter from "./AgentSessionImporter.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";
import * as ProjectService from "./ProjectService.ts";

/** The catalog is derived from transcripts on disk, so a newer layout simply rebuilds it. */
const CATALOG_SCHEMA_VERSION = 3;
const CATALOG_FILE_NAME = "agent-session-catalog.sqlite";
/**
 * A refresh request within this long of the last finished pass is skipped. Short enough that a
 * session finished in a terminal shows up when the person comes back to the window.
 */
const REFRESH_INTERVAL_MS = 15_000;
const DEFAULT_PAGE_SIZE = 50;
const INDEX_BATCH_SIZE = 200;
const INDEX_READ_CONCURRENCY = 8;
/** Sessions per importer call during a bulk import: small, so progress and the list move often. */
const IMPORT_BATCH_SIZE = 20;

interface CatalogRow {
  readonly provider_instance_id: string;
  readonly file_path: string;
  readonly source: string;
  readonly home_path: string;
  readonly mtime_ms: number;
  readonly size: number;
  readonly project_roots: string | null;
  readonly cwd: string | null;
  readonly project_root: string | null;
  readonly title: string | null;
  readonly provider_session_id: string | null;
  /** 1 when the whole transcript holds no conversation. */
  readonly empty: number;
}

const isAgentSessionSource = Schema.is(AgentSessionSource);
const decodeProjectRoots = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(Schema.String)),
);

const rowKey = (providerInstanceId: string, filePath: string) =>
  `${providerInstanceId}\0${filePath}`;

/** Newest first; ties break on instance then path, so paging never skips or repeats a row. */
const compareRows = (
  left: Pick<CatalogRow, "mtime_ms" | "provider_instance_id" | "file_path">,
  right: Pick<CatalogRow, "mtime_ms" | "provider_instance_id" | "file_path">,
) => {
  if (left.mtime_ms !== right.mtime_ms) return right.mtime_ms - left.mtime_ms;
  if (left.provider_instance_id !== right.provider_instance_id) {
    return left.provider_instance_id < right.provider_instance_id ? -1 : 1;
  }
  if (left.file_path !== right.file_path) return left.file_path < right.file_path ? -1 : 1;
  return 0;
};

const cursorRow = (cursor: AgentSessionCatalogCursor) => ({
  mtime_ms: Date.parse(cursor.lastActiveAt),
  provider_instance_id: cursor.providerInstanceId,
  file_path: cursor.filePath,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS transcripts (
    provider_instance_id TEXT NOT NULL,
    file_path TEXT NOT NULL,
    source TEXT NOT NULL,
    home_path TEXT NOT NULL,
    mtime_ms INTEGER NOT NULL,
    size INTEGER NOT NULL,
    project_roots TEXT,
    cwd TEXT,
    project_root TEXT,
    title TEXT,
    provider_session_id TEXT,
    empty INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (provider_instance_id, file_path)
  );
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

/**
 * What the person sent to the archive. Kept apart from the tables a newer layout rebuilds, since it
 * is their choice, not something read back from disk. `mtime_ms` is the transcript's last activity
 * when it was banished: activity after that brings the session back.
 */
const BANISHED_SQL = `
  CREATE TABLE IF NOT EXISTS banished (
    provider_instance_id TEXT NOT NULL,
    file_path TEXT NOT NULL,
    mtime_ms INTEGER NOT NULL,
    banished_at TEXT NOT NULL,
    batch_id TEXT NOT NULL,
    PRIMARY KEY (provider_instance_id, file_path)
  );
  CREATE INDEX IF NOT EXISTS banished_batch ON banished (batch_id);
`;

interface BanishedRow {
  readonly provider_instance_id: string;
  readonly file_path: string;
  readonly mtime_ms: number;
  readonly banished_at: string;
  readonly batch_id: string;
}

/** Opens the catalog file, rebuilding its tables when they are from another layout. */
export const openCatalogDatabase = (filename: string) => {
  const database = new NodeSqlite.DatabaseSync(filename);
  try {
    database.exec("PRAGMA journal_mode = WAL");
    const version = (database.prepare("PRAGMA user_version").get() as { user_version: number })
      .user_version;
    if (version !== CATALOG_SCHEMA_VERSION) {
      database.exec("DROP TABLE IF EXISTS transcripts; DROP TABLE IF EXISTS meta;");
      database.exec(SCHEMA_SQL);
      database.exec(`PRAGMA user_version = ${CATALOG_SCHEMA_VERSION}`);
    }
    database.exec(BANISHED_SQL);
    return database;
  } catch (cause) {
    database.close();
    throw cause;
  }
};

export class AgentSessionCatalog extends Context.Service<
  AgentSessionCatalog,
  {
    /** Sessions on disk that no thread holds yet, newest first. Empty while the flag is off. */
    readonly list: (
      input: AgentSessionCatalogInput,
    ) => Effect.Effect<AgentSessionCatalogResult, AgentSessionScanError>;
    /** Imports one catalogued session as an active thread, creating its project when needed. */
    readonly hydrate: (
      input: AgentSessionHydrateInput,
    ) => Effect.Effect<
      AgentSessionHydrateResult,
      | AgentSessionHydrateError
      | AgentSessionImportProjectChangedError
      | AgentSessionImportProjectNotFoundError
      | AgentSessionScanError
    >;
    /**
     * Imports listed sessions as settled threads, every one last active since a time or the chosen
     * ones, creating projects for folders that have none. Sessions that cannot be opened are
     * skipped.
     */
    readonly importSessions: (
      input: AgentSessionImportExternalInput,
    ) => Effect.Effect<AgentSessionImportExternalResult, AgentSessionScanError>;
    /** The start of a session's conversation, read without importing it. */
    readonly preview: (
      input: AgentSessionPreviewInput,
    ) => Effect.Effect<AgentSessionPreviewResult, AgentSessionHydrateError | AgentSessionScanError>;
    /** Indexes new and changed transcripts now and waits for it; refresh requests do this in the background. */
    readonly index: Effect.Effect<void, AgentSessionScanError>;
    /** Sends sessions to the archive; they leave the External shelf until restored or active again. */
    readonly banish: (
      input: AgentSessionBanishInput,
    ) => Effect.Effect<AgentSessionBanishResult, AgentSessionScanError>;
    /** Brings banished sessions back to the External shelf. */
    readonly restore: (
      input: AgentSessionRestoreInput,
    ) => Effect.Effect<AgentSessionRestoreResult, AgentSessionScanError>;
    /** Banished sessions still on disk, for the archive. */
    readonly banished: (
      input: AgentSessionBanishedInput,
    ) => Effect.Effect<AgentSessionBanishedResult, AgentSessionScanError>;
  }
>()("t3/project/AgentSessionCatalog") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const scanner = yield* AgentSessionScanner.AgentSessionScanner;
  const importer = yield* AgentSessionImporter.AgentSessionImporter;
  const projects = yield* ProjectService.ProjectService;
  const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
  const sql = yield* SqlClient.SqlClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const random = yield* SecureRandom.SecureRandom;
  const layerScope = yield* Effect.scope;
  const indexLock = yield* Semaphore.make(1);
  const hydrateLock = yield* Semaphore.make(1);
  const importLock = yield* Semaphore.make(1);

  const catalogError = (cause: unknown) =>
    new AgentSessionScanError({ operation: "read-catalog", cause });

  // Opened on first use, so a server that never turns the flag on never creates the file.
  const catalogPath = path.join(config.stateDir, CATALOG_FILE_NAME);
  let database: NodeSqlite.DatabaseSync | null = null;
  const openDatabase = Effect.gen(function* () {
    if (database !== null) return database;
    const open = Effect.try({ try: () => openCatalogDatabase(catalogPath), catch: catalogError });
    // The catalog mostly mirrors transcripts on disk, so an unreadable file is rebuilt from scratch;
    // what was banished in it is lost with it.
    database = yield* open.pipe(
      Effect.catch(() =>
        Effect.forEach(["", "-wal", "-shm"], (suffix) =>
          fileSystem.remove(`${catalogPath}${suffix}`, { force: true }).pipe(Effect.ignore),
        ).pipe(Effect.andThen(open)),
      ),
    );
    return database;
  });
  const withDatabase = <A>(use: (database: NodeSqlite.DatabaseSync) => A) =>
    openDatabase.pipe(
      Effect.flatMap((db) => Effect.try({ try: () => use(db), catch: catalogError })),
    );
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      database?.close();
      database = null;
    }),
  );

  let indexing = false;
  /**
   * Moves each time what the catalog lists changes, in the same synchronous step as the write, so
   * answers read from the same rows share it. It starts at the server's start time, so it keeps
   * growing across restarts.
   */
  let revision = DateTime.toEpochMillis(yield* DateTime.now);
  /**
   * The placed rows newest first, what is banished, the pass that wrote them and the revision they
   * were read at; every write that changes them clears it.
   */
  let snapshot: {
    readonly rows: ReadonlyArray<CatalogRow>;
    readonly banished: ReadonlyMap<string, BanishedRow>;
    readonly indexedAt: string | null;
    readonly revision: number;
  } | null = null;
  /** How far the running import has got; read into every list answer. */
  let importProgress: { done: number; total: number } | null = null;
  /** Call right after a committed write that changes what the catalog lists. */
  const listedChanged = () => {
    revision += 1;
    snapshot = null;
  };

  const readSettings = serverSettings.getSettings.pipe(
    Effect.mapError((cause) => new AgentSessionScanError({ operation: "read-settings", cause })),
  );

  const readIndexedAt = (db: NodeSqlite.DatabaseSync) =>
    (
      db.prepare("SELECT value FROM meta WHERE key = 'indexed_at'").get() as
        | { value: string }
        | undefined
    )?.value ?? null;
  const indexedAt = withDatabase(readIndexedAt);

  const indexNow = Effect.gen(function* () {
    const files = yield* scanner.catalogTranscripts;
    const known = new Map(
      (yield* withDatabase(
        (db) =>
          db
            .prepare("SELECT provider_instance_id, file_path, mtime_ms, size FROM transcripts")
            .all() as unknown as ReadonlyArray<
            Pick<CatalogRow, "provider_instance_id" | "file_path" | "mtime_ms" | "size">
          >,
      )).map((row) => [rowKey(row.provider_instance_id, row.file_path), row]),
    );
    const present = new Set<string>();
    const changed: Array<AgentSessionScanner.AgentSessionTranscriptFile> = [];
    for (const file of files) {
      const key = rowKey(file.providerInstanceId, file.filePath);
      present.add(key);
      const row = known.get(key);
      if (
        row === undefined ||
        row.mtime_ms !== Math.floor(file.mtimeMs) ||
        row.size !== file.size
      ) {
        changed.push(file);
      }
    }

    const projectRoots = new Map<string, string | null>();
    for (let start = 0; start < changed.length; start += INDEX_BATCH_SIZE) {
      const batch = changed.slice(start, start + INDEX_BATCH_SIZE);
      const rows = yield* Effect.forEach(
        batch,
        (file) =>
          Effect.gen(function* () {
            const metadata = Option.getOrNull(yield* scanner.readCatalogMetadata(file));
            const cwd = metadata?.cwd ?? null;
            let projectRoot: string | null = null;
            if (cwd !== null) {
              if (!projectRoots.has(cwd)) {
                projectRoots.set(cwd, Option.getOrNull(yield* scanner.resolveProjectRoot(cwd)));
              }
              projectRoot = projectRoots.get(cwd) ?? null;
            }
            return {
              file,
              cwd,
              projectRoot,
              title: metadata?.title ?? null,
              providerSessionId: metadata?.providerSessionId ?? null,
              empty: metadata?.empty === true,
            };
          }),
        { concurrency: INDEX_READ_CONCURRENCY },
      );
      // One short transaction per batch keeps list reads responsive during a first index.
      yield* withDatabase((db) => {
        const upsert = db.prepare(`
          INSERT INTO transcripts (
            provider_instance_id, file_path, source, home_path, mtime_ms, size,
            project_roots, cwd, project_root, title, provider_session_id, empty
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (provider_instance_id, file_path) DO UPDATE SET
            source = excluded.source,
            home_path = excluded.home_path,
            mtime_ms = excluded.mtime_ms,
            size = excluded.size,
            project_roots = excluded.project_roots,
            cwd = excluded.cwd,
            project_root = excluded.project_root,
            title = excluded.title,
            provider_session_id = excluded.provider_session_id,
            empty = excluded.empty
        `);
        db.exec("BEGIN");
        try {
          for (const row of rows) {
            upsert.run(
              row.file.providerInstanceId,
              row.file.filePath,
              row.file.source,
              row.file.homePath,
              Math.floor(row.file.mtimeMs),
              row.file.size,
              row.file.projectRoots === undefined ? null : JSON.stringify(row.file.projectRoots),
              row.cwd,
              row.projectRoot,
              row.title,
              row.providerSessionId,
              row.empty ? 1 : 0,
            );
          }
          db.exec("COMMIT");
          listedChanged();
        } catch (cause) {
          db.exec("ROLLBACK");
          throw cause;
        }
      });
    }

    // Folders come and go without their transcripts changing, so every pass re-checks each one.
    const placed = yield* withDatabase(
      (db) =>
        db
          .prepare(
            "SELECT provider_instance_id, file_path, cwd, project_root FROM transcripts WHERE cwd IS NOT NULL",
          )
          .all() as unknown as ReadonlyArray<
          Pick<CatalogRow, "provider_instance_id" | "file_path" | "cwd" | "project_root">
        >,
    );
    const moved: Array<{
      readonly row: (typeof placed)[number];
      readonly projectRoot: string | null;
    }> = [];
    for (const row of placed) {
      const cwd = row.cwd ?? "";
      if (!projectRoots.has(cwd)) {
        projectRoots.set(cwd, Option.getOrNull(yield* scanner.resolveProjectRoot(cwd)));
      }
      const projectRoot = projectRoots.get(cwd) ?? null;
      if (projectRoot !== row.project_root) moved.push({ row, projectRoot });
    }

    const now = DateTime.formatIso(yield* DateTime.now);
    yield* withDatabase((db) => {
      const remove = db.prepare(
        "DELETE FROM transcripts WHERE provider_instance_id = ? AND file_path = ?",
      );
      const place = db.prepare(
        "UPDATE transcripts SET project_root = ? WHERE provider_instance_id = ? AND file_path = ?",
      );
      db.exec("BEGIN");
      try {
        // Transcripts deleted from disk, or in a home no longer enabled, leave the catalog.
        let removed = 0;
        for (const [key, row] of known) {
          if (present.has(key)) continue;
          remove.run(row.provider_instance_id, row.file_path);
          removed += 1;
        }
        for (const { row, projectRoot } of moved) {
          place.run(projectRoot, row.provider_instance_id, row.file_path);
        }
        db.prepare(
          "INSERT INTO meta (key, value) VALUES ('indexed_at', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        ).run(now);
        db.exec("COMMIT");
        // A pass that changed nothing keeps the revision, so answers taken during it still join.
        if (removed > 0 || moved.length > 0) listedChanged();
        else if (snapshot !== null) snapshot = { ...snapshot, indexedAt: now };
      } catch (cause) {
        db.exec("ROLLBACK");
        throw cause;
      }
    });
  });

  const index: AgentSessionCatalog["Service"]["index"] = indexLock.withPermits(1)(
    Effect.gen(function* () {
      indexing = true;
      yield* indexNow;
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          indexing = false;
        }),
      ),
    ),
  );

  /** Starts a background index unless one is running or the last one is fresh. */
  const requestRefresh = Effect.gen(function* () {
    if (indexing) return;
    const last = yield* indexedAt;
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    if (last !== null && nowMs - Date.parse(last) < REFRESH_INTERVAL_MS) return;
    indexing = true;
    yield* index.pipe(
      Effect.catchCause((cause) => Effect.logWarning("Session catalog index failed", cause)),
      Effect.forkIn(layerScope),
    );
  });

  /** Native session IDs and transcript paths that a thread already holds. */
  const heldSessions = Effect.gen(function* () {
    const nativeIds = new Set<string>();
    const filePaths = new Set<string>();
    const runtimeRows = yield* runtimes
      .list()
      .pipe(
        Effect.mapError(
          (cause) => new AgentSessionScanError({ operation: "read-projects", cause }),
        ),
      );
    for (const runtime of runtimeRows) {
      // Claude resumes by `resume`; Codex and Pi by `threadId` (Pi's is the session file path).
      if (isRecord(runtime.resumeCursor)) {
        for (const value of [runtime.resumeCursor.resume, runtime.resumeCursor.threadId]) {
          if (typeof value === "string") nativeIds.add(value);
        }
      }
      const payload = AgentSessionScanner.decodeImportedTranscriptPayload(runtime.runtimePayload);
      if (Option.isSome(payload)) {
        for (const source of payload.value.importedTranscripts ?? []) {
          filePaths.add(source.filePath);
          nativeIds.add(source.providerSessionId);
        }
      }
    }
    // Threads started in T3 Code record the provider's own session ID on their provider thread.
    const providerThreads = yield* sql<{ readonly native: string | null }>`
      SELECT json_extract(payload_json, '$.nativeThreadRef.nativeId') AS native
      FROM orchestration_v2_projection_provider_threads
    `.pipe(Effect.mapError(catalogError));
    for (const row of providerThreads) {
      if (typeof row.native === "string") nativeIds.add(row.native);
    }
    return { nativeIds, filePaths };
  });

  const isHeld = (
    held: { readonly nativeIds: ReadonlySet<string>; readonly filePaths: ReadonlySet<string> },
    row: CatalogRow,
  ) =>
    held.filePaths.has(row.file_path) ||
    held.nativeIds.has(row.file_path) ||
    (row.provider_session_id !== null && held.nativeIds.has(row.provider_session_id));

  /** `${source}\0${instance}` for every instance whose home the catalog may offer sessions from. */
  const enabledInstanceKeys = (settings: Pick<ServerSettingsValue, "providerInstances">) =>
    new Set(
      (["claudeAgent", "codex", "pi"] as const).flatMap((source) =>
        AgentSessionScanner.enabledTranscriptInstances(source, settings.providerInstances).map(
          ({ instanceId }) => `${source}\0${instanceId}`,
        ),
      ),
    );

  // Project folders compare by real path, so a project added through a symlink still matches.
  const realRoots = new Map<string, string>();
  const realRoot = Effect.fn("AgentSessionCatalog.realRoot")(function* (workspaceRoot: string) {
    const known = realRoots.get(workspaceRoot);
    if (known !== undefined) return known;
    const resolved = yield* fileSystem
      .realPath(workspaceRoot)
      .pipe(Effect.orElseSucceed(() => workspaceRoot));
    realRoots.set(workspaceRoot, resolved);
    return resolved;
  });
  const readShells = projects
    .listShells()
    .pipe(
      Effect.mapError((cause) => new AgentSessionScanError({ operation: "read-projects", cause })),
    );
  const projectsByRealRoot = Effect.gen(function* () {
    const byRoot = new Map<string, ProjectId>();
    for (const shell of yield* readShells) {
      const root = normalizeProjectPathForComparison(yield* realRoot(shell.workspaceRoot));
      if (!byRoot.has(root)) byRoot.set(root, shell.id);
    }
    return byRoot;
  });

  // Sorted once per change to the catalog, not once per page: a home can hold tens of thousands.
  // The rows, the pass that wrote them and whether a pass is running are all taken in one
  // synchronous step, so an index write landing between them cannot leave older rows kept as
  // current, or report a finished pass beside rows from before it.
  const placedRows = Effect.suspend(() =>
    snapshot !== null
      ? Effect.succeed({ ...snapshot, indexing })
      : withDatabase((db) => {
          // A row with no project folder is a subagent, has no cwd, or ran in a folder that is gone;
          // an empty one holds no conversation to open.
          const rows = (
            db
              .prepare("SELECT * FROM transcripts WHERE project_root IS NOT NULL AND empty = 0")
              .all() as unknown as Array<CatalogRow>
          ).sort(compareRows);
          const banished = new Map(
            (db.prepare("SELECT * FROM banished").all() as unknown as Array<BanishedRow>).map(
              (row) => [rowKey(row.provider_instance_id, row.file_path), row] as const,
            ),
          );
          snapshot = { rows, banished, indexedAt: readIndexedAt(db), revision };
          return { ...snapshot, indexing };
        }),
  );

  const toEntry = (row: CatalogRow, projectId: ProjectId | null): AgentSessionCatalogEntry => ({
    providerInstanceId: ProviderInstanceId.make(row.provider_instance_id),
    source: row.source as AgentSessionCatalogEntry["source"],
    filePath: row.file_path,
    title: row.title,
    cwd: row.cwd,
    projectRoot: row.project_root ?? "",
    projectId,
    lastActiveAt: DateTime.formatIso(DateTime.makeUnsafe(row.mtime_ms)),
    sizeBytes: row.size,
  });

  /**
   * Every session the External shelf could show, newest first: one per session (a rewound Codex conversation
   * leaves older rollouts; only the newest continues it), from enabled homes, not held by a
   * thread, in scope. Each says whether it is banished, so the shelf and the archive split one list.
   */
  /** A short fingerprint of everything outside the catalog's rows that decides what is listed. */
  const listingFingerprint = (
    held: { readonly nativeIds: ReadonlySet<string>; readonly filePaths: ReadonlySet<string> },
    projectByRoot: ReadonlyMap<string, ProjectId>,
    enabled: ReadonlySet<string>,
  ) => {
    return [
      [...held.nativeIds],
      [...held.filePaths],
      [...enabled],
      [...projectByRoot].map(([root, projectId]) => `${root}\0${projectId}`),
    ]
      .map((part) => `${part.length}.${Hash.string(part.toSorted().join("\n")) >>> 0}`)
      .join(":");
  };

  /** Whether a session matches the filter: one of its tools, and the text in its title or folder. */
  const matchesFilter = (row: CatalogRow, filter: AgentSessionFilter | undefined) => {
    if (filter === undefined) return true;
    if (filter.sources !== undefined && filter.sources.length > 0) {
      if (!filter.sources.some((source) => source === row.source)) return false;
    }
    const search = filter.search?.trim().toLocaleLowerCase() ?? "";
    if (search === "") return true;
    return [row.title, row.cwd, row.project_root].some(
      (text) => text !== null && text.toLocaleLowerCase().includes(search),
    );
  };

  /** The rows a choice picks: the chosen ones and every one in its windows, less the excluded. */
  const chosenRows = (
    rows: ReadonlyArray<CatalogRow>,
    choice: {
      readonly sessions: ReadonlyArray<AgentSessionRef>;
      readonly windows?: ReadonlyArray<AgentSessionWindow> | undefined;
      readonly exclude?: ReadonlyArray<AgentSessionRef> | undefined;
    },
  ) => {
    const keyOf = (ref: AgentSessionRef) => rowKey(ref.providerInstanceId, ref.filePath);
    const chosen = new Set(choice.sessions.map(keyOf));
    const excluded = new Set((choice.exclude ?? []).map(keyOf));
    const windows = (choice.windows ?? []).map((window) => ({
      fromMs: window.activeFrom === undefined ? null : epochMillis(window.activeFrom),
      untilMs: window.activeUntil === undefined ? null : epochMillis(window.activeUntil),
    }));
    return rows.filter((row) => {
      const key = rowKey(row.provider_instance_id, row.file_path);
      if (excluded.has(key)) return false;
      if (chosen.has(key)) return true;
      return windows.some(
        (window) =>
          (window.fromMs === null || row.mtime_ms >= window.fromMs) &&
          (window.untilMs === null || row.mtime_ms < window.untilMs),
      );
    });
  };

  const placedSessions = Effect.fn("AgentSessionCatalog.placedSessions")(function* (
    settings: ServerSettingsValue,
    projectIds: ReadonlyArray<ProjectId> | undefined,
    filter?: AgentSessionFilter,
  ) {
    const held = yield* heldSessions;
    const projectByRoot = yield* projectsByRealRoot;
    const enabled = enabledInstanceKeys(settings);
    const placed = yield* placedRows;
    const wanted = projectIds === undefined ? null : new Set(projectIds);
    const listedSessions = new Set<string>();
    const sessions: Array<{
      readonly row: CatalogRow;
      readonly projectId: ProjectId | null;
      readonly banished: BanishedRow | null;
    }> = [];
    for (const row of placed.rows) {
      if (!isAgentSessionSource(row.source)) continue;
      if (!enabled.has(`${row.source}\0${row.provider_instance_id}`)) continue;
      if (row.provider_session_id !== null) {
        const session = `${row.provider_instance_id}\0${row.provider_session_id}`;
        if (listedSessions.has(session)) continue;
        listedSessions.add(session);
      }
      if (isHeld(held, row)) continue;
      // After the newest rollout of each session is taken, so a filter never brings up an older one.
      if (!matchesFilter(row, filter)) continue;
      const projectId =
        projectByRoot.get(normalizeProjectPathForComparison(row.project_root ?? "")) ?? null;
      if (wanted !== null && (projectId === null || !wanted.has(projectId))) continue;
      // Activity since the banish brings the session back: its transcript is newer than the mark.
      const mark = placed.banished.get(rowKey(row.provider_instance_id, row.file_path));
      sessions.push({
        row,
        projectId,
        banished: mark !== undefined && mark.mtime_ms >= row.mtime_ms ? mark : null,
      });
    }
    return {
      sessions,
      indexedAt: placed.indexedAt,
      indexing: placed.indexing,
      revision: placed.revision,
      listing: listingFingerprint(held, projectByRoot, enabled),
    };
  });

  const epochMillis = (iso: string) => DateTime.toEpochMillis(DateTime.makeUnsafe(iso));

  /** Epoch milliseconds `months` calendar months before now. */
  const monthsAgo = Effect.fn("AgentSessionCatalog.monthsAgo")(function* (months: number) {
    return DateTime.toEpochMillis(DateTime.subtract(yield* DateTime.now, { months }));
  });

  const list: AgentSessionCatalog["Service"]["list"] = Effect.fn("AgentSessionCatalog.list")(
    function* (input) {
      const settings = yield* readSettings;
      if (!settings.externalSessions) {
        return {
          entries: [],
          totalCount: 0,
          indexing: false,
          indexedAt: null,
          olderThan: [],
          groupCounts: [],
          revision: 0,
          listing: "",
          importing: null,
        };
      }
      if (input.refresh === true) yield* requestRefresh;
      const placed = yield* placedSessions(settings, input.projectIds, input.filter);
      const after = input.before === undefined ? null : cursorRow(input.before);
      const through = input.through === undefined ? null : cursorRow(input.through);
      const limit = Math.min(input.limit ?? DEFAULT_PAGE_SIZE, AGENT_SESSION_CATALOG_MAX_PAGE_SIZE);
      const cutoffs = yield* Effect.forEach(AGENT_SESSION_BANISH_MONTHS, (months) =>
        Effect.map(monthsAgo(months), (cutoffMs) => ({ months, cutoffMs, count: 0 })),
      );
      const fromMs = input.activeFrom === undefined ? null : epochMillis(input.activeFrom);
      const untilMs = input.activeUntil === undefined ? null : epochMillis(input.activeUntil);
      const bounds = (input.groupBounds ?? []).map(epochMillis);
      const groupCounts = input.groupBounds === undefined ? [] : bounds.map(() => 0).concat(0);
      const entries: Array<AgentSessionCatalogEntry> = [];
      let totalCount = 0;
      for (const { row, projectId, banished } of placed.sessions) {
        if (banished !== null) continue;
        if (fromMs !== null && row.mtime_ms < fromMs) continue;
        if (untilMs !== null && row.mtime_ms >= untilMs) continue;
        totalCount += 1;
        for (const cutoff of cutoffs) if (row.mtime_ms < cutoff.cutoffMs) cutoff.count += 1;
        if (groupCounts.length > 0) {
          const span = bounds.findIndex((bound) => row.mtime_ms >= bound);
          groupCounts[span === -1 ? bounds.length : span]! += 1;
        }
        if (
          entries.length >= limit ||
          (after !== null && compareRows(row, after) <= 0) ||
          (through !== null && compareRows(row, through) > 0)
        ) {
          continue;
        }
        entries.push(toEntry(row, projectId));
      }
      return {
        entries,
        totalCount,
        indexing: placed.indexing,
        indexedAt: placed.indexedAt,
        olderThan: cutoffs.map(({ months, count }) => ({ months, count })),
        groupCounts,
        revision: placed.revision,
        listing: placed.listing,
        importing: importProgress === null ? null : { ...importProgress },
      };
    },
  );

  const banished: AgentSessionCatalog["Service"]["banished"] = Effect.fn(
    "AgentSessionCatalog.banished",
  )(function* (input) {
    const settings = yield* readSettings;
    if (!settings.externalSessions) return { entries: [], totalCount: 0 };
    const placed = yield* placedSessions(settings, input.projectIds, input.filter);
    const after = input.before === undefined ? null : cursorRow(input.before);
    const limit = Math.min(input.limit ?? DEFAULT_PAGE_SIZE, AGENT_SESSION_CATALOG_MAX_PAGE_SIZE);
    const entries: Array<AgentSessionBanishedEntry> = [];
    let totalCount = 0;
    for (const { row, projectId, banished } of placed.sessions) {
      if (banished === null) continue;
      totalCount += 1;
      if (entries.length >= limit || (after !== null && compareRows(row, after) <= 0)) continue;
      entries.push({ ...toEntry(row, projectId), banishedAt: banished.banished_at });
    }
    return { entries, totalCount };
  });

  const banish: AgentSessionCatalog["Service"]["banish"] = Effect.fn("AgentSessionCatalog.banish")(
    function* (input) {
      const batchId = yield* random.uuidV4();
      const settings = yield* readSettings;
      if (!settings.externalSessions) return { batchId, count: 0 };
      const placed = yield* placedSessions(
        settings,
        input.kind === "olderThan" ? input.projectIds : undefined,
        input.filter,
      );
      // Only sessions the list shows can be banished: what the person saw, not what a stale page held.
      const listed = placed.sessions.flatMap(({ row, banished }) =>
        banished === null ? [row] : [],
      );
      let targets: ReadonlyArray<CatalogRow>;
      if (input.kind === "olderThan") {
        const cutoffMs = yield* monthsAgo(input.months);
        targets = listed.filter((row) => row.mtime_ms < cutoffMs);
      } else {
        targets = chosenRows(listed, input);
      }
      const banishedAt = DateTime.formatIso(yield* DateTime.now);
      yield* withDatabase((db) => {
        const insert = db.prepare(`
        INSERT INTO banished (provider_instance_id, file_path, mtime_ms, banished_at, batch_id)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (provider_instance_id, file_path) DO UPDATE SET
          mtime_ms = excluded.mtime_ms,
          banished_at = excluded.banished_at,
          batch_id = excluded.batch_id
      `);
        db.exec("BEGIN");
        try {
          for (const row of targets) {
            insert.run(row.provider_instance_id, row.file_path, row.mtime_ms, banishedAt, batchId);
          }
          db.exec("COMMIT");
          if (targets.length > 0) listedChanged();
        } catch (cause) {
          db.exec("ROLLBACK");
          throw cause;
        }
      });
      return { batchId, count: targets.length };
    },
  );

  const restore: AgentSessionCatalog["Service"]["restore"] = Effect.fn(
    "AgentSessionCatalog.restore",
  )(function* (input) {
    const settings = yield* readSettings;
    if (!settings.externalSessions) return { count: 0 };
    // Restoring every banished session takes the ones listed as banished, under the filter.
    const sessions: ReadonlyArray<AgentSessionRef> =
      input.kind === "banished"
        ? (yield* placedSessions(settings, undefined, input.filter)).sessions.flatMap(
            ({ row, banished }) =>
              banished === null
                ? []
                : [
                    {
                      providerInstanceId: ProviderInstanceId.make(row.provider_instance_id),
                      filePath: row.file_path,
                    },
                  ],
          )
        : input.kind === "sessions"
          ? input.sessions
          : [];
    const count = yield* withDatabase((db) => {
      let changes = 0;
      db.exec("BEGIN");
      try {
        if (input.kind === "batch") {
          changes = Number(
            db.prepare("DELETE FROM banished WHERE batch_id = ?").run(input.batchId).changes,
          );
        } else {
          const remove = db.prepare(
            "DELETE FROM banished WHERE provider_instance_id = ? AND file_path = ?",
          );
          for (const session of sessions) {
            changes += Number(remove.run(session.providerInstanceId, session.filePath).changes);
          }
        }
        db.exec("COMMIT");
        if (changes > 0) listedChanged();
      } catch (cause) {
        db.exec("ROLLBACK");
        throw cause;
      }
      return changes;
    });
    return { count };
  });

  /** The transcript an import or a preview reads, as the file is on disk now. */
  const transcriptFile = (
    row: CatalogRow,
    source: AgentSessionSource,
    stats: FileSystem.File.Info,
  ): AgentSessionScanner.AgentSessionTranscriptFile => ({
    source,
    providerInstanceId: ProviderInstanceId.make(row.provider_instance_id),
    homePath: row.home_path,
    filePath: row.file_path,
    mtimeMs: Option.match(stats.mtime, {
      onNone: () => row.mtime_ms,
      onSome: (mtime) => mtime.getTime(),
    }),
    size: Number(stats.size),
    projectRoots: Option.getOrUndefined(decodeProjectRoots(row.project_roots ?? "null")),
  });

  /**
   * The project a catalogued session opens in and its transcript as it is on disk now, creating the
   * project when its folder has none; or why it cannot be opened. A transcript gone from disk
   * leaves the catalog.
   */
  const prepareSession = Effect.fn("AgentSessionCatalog.prepareSession")(function* (
    settings: ServerSettingsValue,
    row: CatalogRow,
  ) {
    const fail = (reason: AgentSessionHydrateError["reason"]) =>
      new AgentSessionHydrateError({ reason, filePath: row.file_path });
    if (!isAgentSessionSource(row.source)) return yield* fail("not-found");
    // A thread bound to a profile that is off could never continue the session.
    if (!enabledInstanceKeys(settings).has(`${row.source}\0${row.provider_instance_id}`)) {
      return yield* fail("provider-disabled");
    }
    const stats = yield* fileSystem.stat(row.file_path).pipe(Effect.option);
    if (Option.isNone(stats) || stats.value.type !== "File") {
      yield* withDatabase((db) => {
        db.prepare("DELETE FROM transcripts WHERE provider_instance_id = ? AND file_path = ?").run(
          row.provider_instance_id,
          row.file_path,
        );
        listedChanged();
      });
      return yield* fail("not-found");
    }
    if (row.cwd === null) return yield* fail("not-importable");
    const projectRoot = yield* scanner.resolveProjectRoot(row.cwd);
    if (Option.isNone(projectRoot)) return yield* fail("no-project");

    const existing = (yield* projectsByRealRoot).get(
      normalizeProjectPathForComparison(projectRoot.value),
    );
    // bootstrap returns the project that already owns the folder, so repeats reuse it.
    const id = yield* random.uuidV4();
    const projectId =
      existing ??
      (yield* projects
        .bootstrap({
          commandId: CommandId.make(`agent-session-catalog-project:${id}`),
          projectId: ProjectId.make(id),
          title: path.basename(projectRoot.value) || projectRoot.value,
          workspaceRoot: projectRoot.value,
        })
        .pipe(
          Effect.map(({ project }) => project.id),
          // bootstrap reads before locking; racing creates return the winner in a conflict.
          Effect.catchTags({
            ProjectConflictError: (conflict) => Effect.succeed(conflict.conflictingProjectId),
          }),
          Effect.mapError(() => fail("no-project")),
        ));

    return { projectId, transcript: transcriptFile(row, row.source, stats.value) };
  });

  const hydrateSession = Effect.fn("AgentSessionCatalog.hydrateSession")(function* (
    input: AgentSessionHydrateInput,
  ) {
    const fail = (reason: AgentSessionHydrateError["reason"]) =>
      new AgentSessionHydrateError({ reason, filePath: input.filePath });
    const settings = yield* readSettings;
    if (!settings.externalSessions) return yield* fail("disabled");
    const row = yield* withDatabase(
      (db) =>
        db
          .prepare("SELECT * FROM transcripts WHERE provider_instance_id = ? AND file_path = ?")
          .get(input.providerInstanceId, input.filePath) as CatalogRow | undefined,
    );
    if (row === undefined) return yield* fail("not-found");
    const { projectId, transcript } = yield* prepareSession(settings, row);
    const result = yield* importer.importRecentAgentThreads(
      { projectId },
      { chosen: [transcript], active: true },
    );
    const threadId = result.threadIds?.[0];
    if (threadId === undefined) return yield* fail("not-importable");
    // A thread now holds the session, so the list no longer shows it.
    yield* Effect.sync(listedChanged);
    return { threadId, projectId };
  });

  // One at a time: a second open of the same session (a double click, another window) then finds
  // the thread the first one made instead of racing it and reporting a failure.
  const hydrate: AgentSessionCatalog["Service"]["hydrate"] = (input) =>
    hydrateLock.withPermits(1)(hydrateSession(input));

  /** Whether a thread holds the session in this transcript, imported or started from it. */
  const holdsTranscript = (
    held: { readonly nativeIds: ReadonlySet<string>; readonly filePaths: ReadonlySet<string> },
    transcript: AgentSessionScanner.AgentSessionTranscriptFile,
  ) => held.filePaths.has(transcript.filePath) || held.nativeIds.has(transcript.filePath);

  const importRun = Effect.fn("AgentSessionCatalog.importRun")(function* (
    input: AgentSessionImportExternalInput,
  ) {
    const settings = yield* readSettings;
    if (!settings.externalSessions) return { importedCount: 0, skippedCount: 0, threadIds: [] };
    // Only what the list shows now, under the filter: not held, not banished.
    const placed = yield* placedSessions(settings, undefined, input.filter);
    const listed = placed.sessions.flatMap(({ row, banished }) => (banished === null ? [row] : []));
    const rows = chosenRows(listed, input);
    const progress = { done: 0, total: rows.length };
    importProgress = progress;
    let skippedCount = 0;
    const byProject = new Map<ProjectId, Array<AgentSessionScanner.AgentSessionTranscriptFile>>();
    for (const row of rows) {
      const prepared = yield* prepareSession(settings, row).pipe(
        Effect.asSome,
        // Gone from disk, no folder to open, unreadable or its provider off: skipped.
        Effect.catchTags({ AgentSessionHydrateError: () => Effect.succeedNone }),
      );
      if (Option.isNone(prepared)) {
        skippedCount += 1;
        progress.done += 1;
        continue;
      }
      const { projectId, transcript } = prepared.value;
      const chosen = byProject.get(projectId);
      if (chosen === undefined) byProject.set(projectId, [transcript]);
      else chosen.push(transcript);
    }
    // Shares the open lock, so an open of the same session finds the thread made here.
    const importBatch = (
      projectId: ProjectId,
      batch: ReadonlyArray<AgentSessionScanner.AgentSessionTranscriptFile>,
    ) =>
      hydrateLock
        .withPermits(1)(importer.importRecentAgentThreads({ projectId }, { chosen: batch }))
        .pipe(
          Effect.asSome,
          // The project was removed or moved since it was found; its sessions stay listed.
          Effect.catchTags({
            AgentSessionImportProjectNotFoundError: () => Effect.succeedNone,
            AgentSessionImportProjectChangedError: () => Effect.succeedNone,
          }),
        );
    let importedCount = 0;
    const threadIds = new Set<ThreadId>();
    const prepared: Array<AgentSessionScanner.AgentSessionTranscriptFile> = [];
    for (const [projectId, chosen] of byProject) {
      prepared.push(...chosen);
      // Small batches, so the list empties and the progress moves as the import goes. One call
      // shares a byte budget across its batch, so the sessions a batch skips go through again one
      // at a time: a skip then means that session could not be imported.
      for (let start = 0; start < chosen.length; start += IMPORT_BATCH_SIZE) {
        const batch = chosen.slice(start, start + IMPORT_BATCH_SIZE);
        const result = yield* importBatch(projectId, batch);
        if (Option.isSome(result)) {
          importedCount += result.value.importedCount;
          for (const threadId of result.value.threadIds ?? []) threadIds.add(threadId);
          if (result.value.skippedCount > 0 && batch.length > 1) {
            // Only the sessions no thread holds yet go through again: one the batch imported may
            // have moved on since, and would read as a skip.
            const held = yield* heldSessions;
            for (const transcript of batch.filter((each) => !holdsTranscript(held, each))) {
              const single = yield* importBatch(projectId, [transcript]);
              if (Option.isNone(single)) continue;
              importedCount += single.value.importedCount;
              for (const threadId of single.value.threadIds ?? []) threadIds.add(threadId);
            }
          }
        }
        progress.done += batch.length;
        // The sessions just imported leave the list now.
        yield* Effect.sync(listedChanged);
      }
    }
    // What no thread holds at the end was not imported: refused, unreadable or with nothing in it.
    const held = yield* heldSessions;
    skippedCount += prepared.filter((transcript) => !holdsTranscript(held, transcript)).length;
    return { importedCount, skippedCount, threadIds: [...threadIds] };
  });

  // One import at a time; its progress shows in every list answer until it ends.
  const importSessions: AgentSessionCatalog["Service"]["importSessions"] = (input) =>
    importLock.withPermits(1)(
      importRun(input).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            importProgress = null;
          }),
        ),
      ),
    );

  const preview: AgentSessionCatalog["Service"]["preview"] = Effect.fn(
    "AgentSessionCatalog.preview",
  )(function* (input) {
    const fail = (reason: AgentSessionHydrateError["reason"]) =>
      new AgentSessionHydrateError({ reason, filePath: input.filePath });
    const settings = yield* readSettings;
    if (!settings.externalSessions) return yield* fail("disabled");
    const row = yield* withDatabase(
      (db) =>
        db
          .prepare("SELECT * FROM transcripts WHERE provider_instance_id = ? AND file_path = ?")
          .get(input.providerInstanceId, input.filePath) as CatalogRow | undefined,
    );
    if (row === undefined || !isAgentSessionSource(row.source)) return yield* fail("not-found");
    const stats = yield* fileSystem.stat(row.file_path).pipe(Effect.option);
    if (Option.isNone(stats) || stats.value.type !== "File") return yield* fail("not-found");
    if (row.cwd === null) return yield* fail("not-importable");
    // Reads the conversation the way an import would, without making a project or a thread.
    const projectRoot = yield* scanner.resolveProjectRoot(row.cwd);
    if (Option.isNone(projectRoot)) return yield* fail("no-project");
    const outcomes = yield* Stream.runCollect(
      scanner.recentThreads(projectRoot.value, [], [transcriptFile(row, row.source, stats.value)]),
    );
    const thread = [...outcomes].flatMap((outcome) =>
      outcome._tag === "Importable" ? [outcome.thread] : [],
    )[0];
    if (thread === undefined) return yield* fail("not-importable");
    // A long conversation is held as its opening request and its latest messages, with the middle
    // left out: its start stops at the opening request.
    const held =
      thread.omittedMessageCount > 0 &&
      thread.messages.length >= AgentSessionScanner.MAX_IMPORTED_MESSAGES
        ? thread.messages.slice(0, 1)
        : thread.messages;
    const messages = held.slice(0, AGENT_SESSION_PREVIEW_MESSAGES).map((message) => ({
      role: message.role,
      text:
        message.text.length > AGENT_SESSION_PREVIEW_CHARACTERS
          ? `${message.text.slice(0, AGENT_SESSION_PREVIEW_CHARACTERS).trimEnd()}…`
          : message.text,
    }));
    return { messages, more: thread.messages.length > messages.length };
  });

  return AgentSessionCatalog.of({
    list,
    hydrate,
    importSessions,
    preview,
    index,
    banish,
    restore,
    banished,
  });
});

export const layer = Layer.effect(AgentSessionCatalog, make);
