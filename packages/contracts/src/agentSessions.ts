import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const AgentSessionSource = Schema.Literals(["claudeAgent", "codex", "pi"]);
export type AgentSessionSource = typeof AgentSessionSource.Type;

export const AgentSessionImportSource = Schema.Struct({
  provider: AgentSessionSource,
  providerInstanceId: ProviderInstanceId,
  providerSessionId: TrimmedNonEmptyString,
  filePath: TrimmedNonEmptyString,
  size: NonNegativeInt,
  mtimeMs: Schema.NullOr(Schema.Number),
  device: Schema.Number,
  // A decimal string keeps file IDs above 2^53 (common on NTFS) exact. Older
  // records stored a number.
  inode: Schema.NullOr(Schema.Union([Schema.String, Schema.Number])),
  birthtimeMs: Schema.NullOr(Schema.Number),
});
export type AgentSessionImportSource = typeof AgentSessionImportSource.Type;

export const AgentSessionScanInput = Schema.Struct({});
export type AgentSessionScanInput = typeof AgentSessionScanInput.Type;

export const AgentSessionProjectGit = Schema.Struct({
  remoteKey: Schema.NullOr(Schema.String),
  repository: Schema.NullOr(Schema.String),
});
export type AgentSessionProjectGit = typeof AgentSessionProjectGit.Type;

export const AgentSessionProjectCandidate = Schema.Struct({
  path: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  projectId: Schema.optional(ProjectId),
  sources: Schema.Array(AgentSessionSource),
  threadCount: NonNegativeInt,
  lastActiveAt: Schema.NullOr(IsoDateTime),
  alreadyImported: Schema.Boolean,
  git: Schema.optionalKey(Schema.NullOr(AgentSessionProjectGit)),
});
export type AgentSessionProjectCandidate = typeof AgentSessionProjectCandidate.Type;

export const AgentSessionScanResult = Schema.Struct({
  candidates: Schema.Array(AgentSessionProjectCandidate),
  scannedAt: IsoDateTime,
  truncated: Schema.optional(Schema.Boolean),
});
export type AgentSessionScanResult = typeof AgentSessionScanResult.Type;

export const AgentSessionImportInput = Schema.Struct({
  projectId: ProjectId,
  expectedWorkspaceRoot: Schema.optional(TrimmedNonEmptyString),
});
export type AgentSessionImportInput = typeof AgentSessionImportInput.Type;

export class AgentSessionImportProjectNotFoundError extends Schema.TaggedError<AgentSessionImportProjectNotFoundError>()(
  "AgentSessionImportProjectNotFoundError",
  { projectId: ProjectId },
) {
  override get message(): string {
    return `Project '${this.projectId}' does not exist.`;
  }
}

export class AgentSessionImportProjectChangedError extends Schema.TaggedError<AgentSessionImportProjectChangedError>()(
  "AgentSessionImportProjectChangedError",
  { projectId: ProjectId },
) {
  override get message(): string {
    return `Project '${this.projectId}' changed directories. Scan for projects again before importing history.`;
  }
}

export const AgentSessionImportResult = Schema.Struct({
  importedCount: NonNegativeInt,
  skippedCount: NonNegativeInt,
  /** Threads that now hold the imported sessions, including ones imported earlier. */
  threadIds: Schema.optional(Schema.Array(ThreadId)),
});
export type AgentSessionImportResult = typeof AgentSessionImportResult.Type;

/** One native transcript the catalog knows about but no thread holds yet. */
export const AgentSessionCatalogEntry = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  source: AgentSessionSource,
  filePath: TrimmedNonEmptyString,
  title: Schema.NullOr(Schema.String),
  cwd: Schema.NullOr(Schema.String),
  /** The folder opening the session uses as its project: the main checkout for a linked worktree. */
  projectRoot: Schema.String,
  /** The existing project that folder belongs to; opening the session creates one when null. */
  projectId: Schema.NullOr(ProjectId),
  lastActiveAt: IsoDateTime,
  sizeBytes: NonNegativeInt,
});
export type AgentSessionCatalogEntry = typeof AgentSessionCatalogEntry.Type;

export const AgentSessionCatalogCursor = Schema.Struct({
  lastActiveAt: IsoDateTime,
  providerInstanceId: ProviderInstanceId,
  filePath: TrimmedNonEmptyString,
});
export type AgentSessionCatalogCursor = typeof AgentSessionCatalogCursor.Type;

/** Narrows every list, banish, import and restore to the sessions that match it. */
export const AgentSessionFilter = Schema.Struct({
  /** Text found, whatever its case, in the session's title or the folder it ran in. */
  search: Schema.optional(Schema.String),
  /** Only sessions these tools ran. */
  sources: Schema.optional(Schema.Array(AgentSessionSource)),
});
export type AgentSessionFilter = typeof AgentSessionFilter.Type;

/** A span of last activity: at or after `activeFrom` and before `activeUntil`, either open. */
export const AgentSessionWindow = Schema.Struct({
  activeFrom: Schema.optional(IsoDateTime),
  activeUntil: Schema.optional(IsoDateTime),
});
export type AgentSessionWindow = typeof AgentSessionWindow.Type;

/** The most entries one catalog page returns, whatever `limit` asks for. */
export const AGENT_SESSION_CATALOG_MAX_PAGE_SIZE = 200;
/** The most spans one catalog read counts sessions in. */
const AGENT_SESSION_CATALOG_MAX_GROUP_BOUNDS = 32;

export const AgentSessionCatalogInput = Schema.Struct({
  /** Only entries whose folder belongs to one of these projects. */
  projectIds: Schema.optional(Schema.Array(ProjectId)),
  before: Schema.optional(AgentSessionCatalogCursor),
  /**
   * Only entries at or newer than this one. A page bounded on both sides keeps its rows when a
   * session lands inside it, instead of pushing its last row past the next page's start.
   */
  through: Schema.optional(AgentSessionCatalogCursor),
  /** Only entries last active at or after this time. */
  activeFrom: Schema.optional(IsoDateTime),
  /** Only entries last active before this time. */
  activeUntil: Schema.optional(IsoDateTime),
  /**
   * Times, newest first, that split the listed sessions into spans: at or after the first, between
   * each pair, and before the last. The answer counts each span, so collapsed groups can show
   * their size without listing their rows.
   */
  groupBounds: Schema.optional(
    Schema.Array(IsoDateTime).check(Schema.isMaxLength(AGENT_SESSION_CATALOG_MAX_GROUP_BOUNDS)),
  ),
  /** Zero asks only for the counts. */
  limit: Schema.optional(NonNegativeInt),
  /** Start indexing new and changed transcripts when the last pass is stale. */
  refresh: Schema.optional(Schema.Boolean),
  filter: Schema.optional(AgentSessionFilter),
});
export type AgentSessionCatalogInput = typeof AgentSessionCatalogInput.Type;

/** The ages External sessions offers to banish everything older than, in months. */
export const AGENT_SESSION_BANISH_MONTHS = [1, 2, 3, 6, 12] as const;

export const AgentSessionCatalogResult = Schema.Struct({
  entries: Schema.Array(AgentSessionCatalogEntry),
  totalCount: NonNegativeInt,
  indexing: Schema.Boolean,
  indexedAt: Schema.NullOr(IsoDateTime),
  /** For each banish preset, how many of the listed sessions were last active before it. */
  olderThan: Schema.Array(Schema.Struct({ months: PositiveInt, count: NonNegativeInt })),
  /** How many listed sessions fall in each span `groupBounds` marks out; empty without them. */
  groupCounts: Schema.Array(NonNegativeInt),
  /**
   * Which catalog rows the answer was read from, even while a pass runs; a larger one is newer. It
   * moves only when the rows change. With the same `listing` too, answers list the same sessions.
   */
  revision: NonNegativeInt,
  /**
   * A fingerprint of what else decides which sessions are listed: the threads holding sessions,
   * the providers turned on and the projects. Answers with the same revision and fingerprint list
   * the same sessions.
   */
  listing: Schema.String,
  /** How far an import running on this server has got, from any window; null when none runs. */
  importing: Schema.NullOr(Schema.Struct({ done: NonNegativeInt, total: NonNegativeInt })),
});
export type AgentSessionCatalogResult = typeof AgentSessionCatalogResult.Type;

/** One session in the catalog, named by the transcript it lives in. */
export const AgentSessionRef = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  filePath: TrimmedNonEmptyString,
});
export type AgentSessionRef = typeof AgentSessionRef.Type;

/** The most windows one choice can name: one per group the list shows. */
const AGENT_SESSION_MAX_WINDOWS = AGENT_SESSION_CATALOG_MAX_GROUP_BOUNDS + 1;

/**
 * Sessions picked on the list: the chosen ones and every one in the windows (whole groups), less
 * the excluded, among those matching the filter. Only sessions the list shows are taken: none a
 * thread holds, none banished.
 */
const AgentSessionChoiceFields = {
  sessions: Schema.Array(AgentSessionRef),
  windows: Schema.optional(
    Schema.Array(AgentSessionWindow).check(Schema.isMaxLength(AGENT_SESSION_MAX_WINDOWS)),
  ),
  exclude: Schema.optional(Schema.Array(AgentSessionRef)),
  filter: Schema.optional(AgentSessionFilter),
};

/**
 * Takes sessions out of the External sessions list into its banished list: a choice, or every
 * listed session last active more than `months` ago. A banished session comes back by itself once
 * it sees new activity.
 */
export const AgentSessionBanishInput = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("sessions"), ...AgentSessionChoiceFields }),
  Schema.Struct({
    kind: Schema.Literal("olderThan"),
    months: PositiveInt,
    projectIds: Schema.optional(Schema.Array(ProjectId)),
    filter: Schema.optional(AgentSessionFilter),
  }),
]);
export type AgentSessionBanishInput = typeof AgentSessionBanishInput.Type;

export const AgentSessionBanishResult = Schema.Struct({
  /** Restoring this batch undoes the banish in one step. */
  batchId: TrimmedNonEmptyString,
  count: NonNegativeInt,
});
export type AgentSessionBanishResult = typeof AgentSessionBanishResult.Type;

export const AgentSessionRestoreInput = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("batch"), batchId: TrimmedNonEmptyString }),
  Schema.Struct({ kind: Schema.Literal("sessions"), sessions: Schema.Array(AgentSessionRef) }),
  /** Every banished session that matches the filter. */
  Schema.Struct({ kind: Schema.Literal("banished"), filter: Schema.optional(AgentSessionFilter) }),
]);
export type AgentSessionRestoreInput = typeof AgentSessionRestoreInput.Type;

export const AgentSessionRestoreResult = Schema.Struct({ count: NonNegativeInt });
export type AgentSessionRestoreResult = typeof AgentSessionRestoreResult.Type;

export const AgentSessionBanishedInput = Schema.Struct({
  projectIds: Schema.optional(Schema.Array(ProjectId)),
  before: Schema.optional(AgentSessionCatalogCursor),
  limit: Schema.optional(PositiveInt),
  filter: Schema.optional(AgentSessionFilter),
});
export type AgentSessionBanishedInput = typeof AgentSessionBanishedInput.Type;

export const AgentSessionBanishedEntry = Schema.Struct({
  ...AgentSessionCatalogEntry.fields,
  banishedAt: IsoDateTime,
});
export type AgentSessionBanishedEntry = typeof AgentSessionBanishedEntry.Type;

/** Banished sessions still on disk, newest activity first. */
export const AgentSessionBanishedResult = Schema.Struct({
  entries: Schema.Array(AgentSessionBanishedEntry),
  totalCount: NonNegativeInt,
});
export type AgentSessionBanishedResult = typeof AgentSessionBanishedResult.Type;

/** Imports a choice of listed sessions as settled threads; the last 30 days is one window. */
export const AgentSessionImportExternalInput = Schema.Struct(AgentSessionChoiceFields);
export type AgentSessionImportExternalInput = typeof AgentSessionImportExternalInput.Type;

export const AgentSessionImportExternalResult = Schema.Struct({
  importedCount: NonNegativeInt,
  /** Sessions that could not be imported: gone from disk, no folder to open, or unreadable. */
  skippedCount: NonNegativeInt,
  /** The threads that now hold the imported sessions. */
  threadIds: Schema.Array(ThreadId),
});
export type AgentSessionImportExternalResult = typeof AgentSessionImportExternalResult.Type;

/** The start of a session's conversation, to see what it was before opening it. */
export const AgentSessionPreviewInput = AgentSessionRef;
export type AgentSessionPreviewInput = typeof AgentSessionPreviewInput.Type;

/** How many messages a preview shows, and how much of each. */
export const AGENT_SESSION_PREVIEW_MESSAGES = 4;
export const AGENT_SESSION_PREVIEW_CHARACTERS = 600;

export const AgentSessionPreviewResult = Schema.Struct({
  messages: Schema.Array(
    Schema.Struct({ role: Schema.Literals(["user", "assistant"]), text: Schema.String }),
  ),
  /** The conversation goes on past the messages shown. */
  more: Schema.Boolean,
});
export type AgentSessionPreviewResult = typeof AgentSessionPreviewResult.Type;

export const AgentSessionHydrateInput = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  filePath: TrimmedNonEmptyString,
});
export type AgentSessionHydrateInput = typeof AgentSessionHydrateInput.Type;

export const AgentSessionHydrateResult = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
});
export type AgentSessionHydrateResult = typeof AgentSessionHydrateResult.Type;

export class AgentSessionHydrateError extends Schema.TaggedError<AgentSessionHydrateError>()(
  "AgentSessionHydrateError",
  {
    reason: Schema.Literals([
      "disabled",
      "not-found",
      "provider-disabled",
      "no-project",
      "not-importable",
    ]),
    filePath: Schema.String,
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "disabled":
        return "External sessions are turned off in Settings.";
      case "not-found":
        return "That session's transcript is no longer on disk.";
      case "provider-disabled":
        return "Turn the provider that ran this session back on to open it.";
      case "no-project":
        return "That session's folder is missing or cannot be opened as a project.";
      case "not-importable":
        return "That session has no conversation T3 Code can open.";
    }
  }
}

export class AgentSessionScanError extends Schema.TaggedError<AgentSessionScanError>()(
  "AgentSessionScanError",
  {
    operation: Schema.Literals(["read-settings", "read-projects", "read-catalog"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to scan agent sessions during ${this.operation}.`;
  }
}
