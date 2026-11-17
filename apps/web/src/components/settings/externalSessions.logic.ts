import {
  AGENT_SESSION_BANISH_MONTHS,
  AGENT_SESSION_CATALOG_MAX_PAGE_SIZE,
  type AgentSessionCatalogCursor,
  type AgentSessionCatalogEntry,
  type AgentSessionCatalogInput,
  type AgentSessionCatalogResult,
  type AgentSessionFilter,
  type AgentSessionRef,
  type AgentSessionSource,
  type AgentSessionWindow,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";

/** Rows a group lists when first opened, and how many each "Show more" adds. */
export const EXTERNAL_FIRST_PAGE_SIZE = 10;
export const EXTERNAL_PAGE_SIZE = 25;
/** The server's page cap; a bounded page that reaches it may have lost rows past its end. */
export const EXTERNAL_BOUNDED_PAGE_LIMIT = AGENT_SESSION_CATALOG_MAX_PAGE_SIZE;

/** A span of last activity the list groups sessions by, newest first. */
export interface ExternalGroup {
  readonly id: string;
  readonly label: string;
  /** At or after; the oldest group has none. */
  readonly activeFrom?: string;
  /** Before; the newest group has none. */
  readonly activeUntil?: string;
}

/** How many calendar months before the last 30 days get a group of their own. */
const MONTH_GROUPS = 12;

/**
 * The groups for `nowMinute` (UTC, to the minute) in this device's time zone: today, yesterday,
 * the 7 and 30 days before, each month before that for a year, then everything older. Each group
 * ends where the next one starts, so every session falls in exactly one.
 */
export function externalGroups(nowMinute: string): ReadonlyArray<ExternalGroup> {
  const now = new Date(`${nowMinute}:00.000Z`);
  const [year, month, date] = [now.getFullYear(), now.getMonth(), now.getDate()];
  const midnight = (daysBack: number) => new Date(year, month, date - daysBack).toISOString();
  const groups: Array<ExternalGroup> = [
    { id: "today", label: "Today", activeFrom: midnight(0) },
    { id: "yesterday", label: "Yesterday", activeFrom: midnight(1), activeUntil: midnight(0) },
    { id: "week", label: "Previous 7 days", activeFrom: midnight(7), activeUntil: midnight(1) },
    { id: "month", label: "Previous 30 days", activeFrom: midnight(30), activeUntil: midnight(7) },
  ];
  const monthName = new Intl.DateTimeFormat(undefined, { month: "long" });
  const monthAndYear = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });
  let until = new Date(year, month, date - 30);
  for (let back = 0; back < MONTH_GROUPS; back++) {
    const start = new Date(year, month - back, 1);
    // A month inside the last 30 days is already covered by the groups above.
    if (start >= until) continue;
    groups.push({
      id: `month:${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}`,
      label: (start.getFullYear() === year ? monthName : monthAndYear).format(start),
      activeFrom: start.toISOString(),
      activeUntil: until.toISOString(),
    });
    until = start;
  }
  groups.push({ id: "older", label: "Older", activeUntil: until.toISOString() });
  return groups;
}

/** Groups open until the person chooses otherwise, so a new session today never shuts them. */
const RECENT_GROUPS: ReadonlySet<string> = new Set(["today", "yesterday", "week"]);

/**
 * Which groups with sessions in them are open: what the person chose for each, else the recent
 * groups, else (when nothing is recent) the newest group.
 */
export function externalOpenGroups(
  groups: ReadonlyArray<ExternalGroup>,
  counts: ReadonlyArray<number>,
  chosen: Readonly<Record<string, boolean>>,
): ReadonlySet<string> {
  const filled = groups.filter((_, index) => (counts[index] ?? 0) > 0);
  const recent = filled.some((group) => RECENT_GROUPS.has(group.id));
  const newest = filled[0]?.id;
  return new Set(
    filled.flatMap((group) =>
      (chosen[group.id] ?? (RECENT_GROUPS.has(group.id) || (!recent && group.id === newest)))
        ? [group.id]
        : [],
    ),
  );
}

/**
 * The group open only because nothing recent has sessions, while the person has not chosen for
 * it. The list remembers it as opened, so a new session today does not shut the group being read.
 */
export function externalFallbackGroup(
  groups: ReadonlyArray<ExternalGroup>,
  counts: ReadonlyArray<number>,
  chosen: Readonly<Record<string, boolean>>,
): string | null {
  const filled = groups.filter((_, index) => (counts[index] ?? 0) > 0);
  if (filled.some((group) => RECENT_GROUPS.has(group.id))) return null;
  const newest = filled[0];
  return newest !== undefined && chosen[newest.id] === undefined ? newest.id : null;
}

/**
 * The groups drawn open: worked out from the groups in the view on screen, with their counts, so
 * rows stay until the answers agree again, even when a new day or month has changed the groups the
 * requests use.
 */
export function externalShownOpenGroups(
  view: ExternalListView | null,
  chosen: Readonly<Record<string, boolean>>,
): ReadonlySet<string> {
  if (view === null) return new Set();
  return externalOpenGroups(
    view.groups.map(({ group }) => group),
    view.groups.map(({ count }) => count),
    chosen,
  );
}

/**
 * The fallback group to remember as opened, once the person has seen it open: the first pass has
 * finished, so a half-read first pass never opens groups for good.
 */
export function externalFallbackToRemember(
  view: ExternalListView | null,
  chosen: Readonly<Record<string, boolean>>,
): string | null {
  if (view === null || view.firstIndex) return null;
  return externalFallbackGroup(
    view.groups.map(({ group }) => group),
    view.groups.map(({ count }) => count),
    chosen,
  );
}

/** Each group's count in the view on screen, in group order; zero for a group it does not show. */
export function externalViewCounts(
  groups: ReadonlyArray<ExternalGroup>,
  view: ExternalListView | null,
): ReadonlyArray<number> {
  return groups.map(
    (group) => view?.groups.find((shown) => shown.group.id === group.id)?.count ?? 0,
  );
}

type PageScope = Pick<AgentSessionCatalogInput, "activeFrom" | "activeUntil" | "filter">;

/**
 * The filter the list asks with: the search text trimmed and the tools chosen, or none when both
 * are empty, so an empty search reads the same pages as no search.
 */
export function externalFilter(
  search: string,
  sources: ReadonlyArray<AgentSessionSource>,
): AgentSessionFilter | undefined {
  const text = search.trim();
  if (text === "" && sources.length === 0) return undefined;
  return {
    ...(text === "" ? {} : { search: text }),
    ...(sources.length === 0 ? {} : { sources: [...sources].toSorted() }),
  };
}

/** The request that counts every group and the banish presets; it alone starts index passes. */
export function externalSummaryInput(
  groups: ReadonlyArray<ExternalGroup>,
  filter?: AgentSessionFilter,
): AgentSessionCatalogInput {
  return {
    ...(filter === undefined ? {} : { filter }),
    limit: 0,
    refresh: true,
    groupBounds: groups.flatMap((group, index) =>
      index < groups.length - 1 && group.activeFrom !== undefined ? [group.activeFrom] : [],
    ),
  };
}

/**
 * The request for each page an open group shows. Every page but the last ends at the row "Show
 * more" was pressed after, so a session that lands inside a page stays in it instead of pushing a
 * row out of view.
 */
export function externalGroupPageInputs(input: {
  readonly group: ExternalGroup;
  readonly cursors: ReadonlyArray<AgentSessionCatalogCursor>;
  readonly filter?: AgentSessionFilter | undefined;
}): ReadonlyArray<AgentSessionCatalogInput> {
  const { group, cursors } = input;
  const scope: PageScope = {
    ...(input.filter === undefined ? {} : { filter: input.filter }),
    ...(group.activeFrom === undefined ? {} : { activeFrom: group.activeFrom }),
    ...(group.activeUntil === undefined ? {} : { activeUntil: group.activeUntil }),
  };
  const last = cursors.at(-1);
  if (last === undefined) return [{ ...scope, limit: EXTERNAL_FIRST_PAGE_SIZE }];
  return [
    ...cursors.map((through, index) => {
      const before = cursors[index - 1];
      return {
        ...scope,
        ...(before === undefined ? {} : { before }),
        through,
        limit: EXTERNAL_BOUNDED_PAGE_LIMIT,
      };
    }),
    { ...scope, before: last, limit: EXTERNAL_PAGE_SIZE },
  ];
}

/** Every request the list makes, the summary first, and which of them belong to each group. */
export interface ExternalListRequests {
  readonly inputs: ReadonlyArray<AgentSessionCatalogInput>;
  readonly groupPages: ReadonlyArray<{
    readonly groupId: string;
    readonly start: number;
    readonly end: number;
  }>;
}

export function externalListRequests(input: {
  readonly groups: ReadonlyArray<ExternalGroup>;
  /** Groups whose rows are read: the open ones. */
  readonly listed: ReadonlySet<string>;
  readonly cursors: Readonly<Record<string, ReadonlyArray<AgentSessionCatalogCursor>>>;
  readonly filter?: AgentSessionFilter | undefined;
}): ExternalListRequests {
  const inputs: Array<AgentSessionCatalogInput> = [
    externalSummaryInput(input.groups, input.filter),
  ];
  const groupPages: Array<{ groupId: string; start: number; end: number }> = [];
  for (const group of input.groups) {
    if (!input.listed.has(group.id)) continue;
    const start = inputs.length;
    inputs.push(
      ...externalGroupPageInputs({
        group,
        cursors: input.cursors[group.id] ?? [],
        filter: input.filter,
      }),
    );
    groupPages.push({ groupId: group.id, start, end: inputs.length });
  }
  return { inputs, groupPages };
}

/** Where the next page starts: just after the last row shown. */
export function externalCursorAfter(entry: AgentSessionCatalogEntry): AgentSessionCatalogCursor {
  return {
    lastActiveAt: entry.lastActiveAt,
    providerInstanceId: entry.providerInstanceId,
    filePath: entry.filePath,
  };
}

const sameCursor = (left: AgentSessionCatalogCursor, right: AgentSessionCatalogCursor) =>
  left.lastActiveAt === right.lastActiveAt &&
  left.providerInstanceId === right.providerInstanceId &&
  left.filePath === right.filePath;

/**
 * Where each banished page after the first is read from: right after the last row of the page
 * before it as read now, so no session falls between pages, until `shown` rows are loaded.
 * `answers` holds the first page's answer, then one per cursor in `cursors`.
 */
export function externalBanishedCursors(input: {
  readonly answers: ReadonlyArray<{
    readonly entries: ReadonlyArray<AgentSessionCatalogEntry>;
    readonly totalCount: number;
  }>;
  readonly cursors: ReadonlyArray<AgentSessionCatalogCursor>;
  readonly shown: number;
}): ReadonlyArray<AgentSessionCatalogCursor> {
  const totalCount = input.answers[0]?.totalCount ?? 0;
  const cursors: Array<AgentSessionCatalogCursor> = [];
  let loaded = 0;
  for (const [index, answer] of input.answers.entries()) {
    loaded += answer.entries.length;
    const last = answer.entries.at(-1);
    if (last === undefined || loaded >= input.shown || loaded >= totalCount) break;
    const cursor = externalCursorAfter(last);
    cursors.push(cursor);
    const readFrom = input.cursors[index];
    // The next page was read from elsewhere, or not yet: it is read again from here.
    if (readFrom === undefined || !sameCursor(readFrom, cursor)) break;
  }
  return cursors;
}

/** Whether two lists of cursors read the same pages. */
export function externalSameCursors(
  left: ReadonlyArray<AgentSessionCatalogCursor>,
  right: ReadonlyArray<AgentSessionCatalogCursor>,
): boolean {
  return (
    left.length === right.length && left.every((cursor, index) => sameCursor(cursor, right[index]!))
  );
}

export interface ExternalGroupView {
  readonly group: ExternalGroup;
  readonly count: number;
  /** The group's rows, or null when its pages were not part of this answer. */
  readonly entries: ReadonlyArray<AgentSessionCatalogEntry> | null;
  /** How many the group's "Show more" adds; zero hides it. */
  readonly showMoreCount: number;
  /** A bounded page came back at the cap and may hide rows: start the group again. */
  readonly overflowed: boolean;
}

export interface ExternalListView {
  /** Sessions the list could show in all, shown or not. */
  readonly totalCount: number;
  readonly indexing: boolean;
  /** No index pass has finished yet, so rows still arrive in no particular order. */
  readonly firstIndex: boolean;
  /** For each banish preset, how many listed sessions it would take. */
  readonly olderThan: AgentSessionCatalogResult["olderThan"];
  /** Groups with sessions in them, newest first. */
  readonly groups: ReadonlyArray<ExternalGroupView>;
  /** Every row shown, in order, across the open groups. */
  readonly entries: ReadonlyArray<AgentSessionCatalogEntry>;
}

/**
 * Answers join only when read from the same revision and listing, so no session shows twice or not
 * at all; a running pass does not matter. Until the first pass ends each answer stands alone.
 */
function externalAnswersAgree(results: ReadonlyArray<AgentSessionCatalogResult>): boolean {
  const summary = results[0];
  if (summary === undefined) return false;
  if (summary.indexedAt === null) return true;
  return results.every(
    (result) => result.revision === summary.revision && result.listing === summary.listing,
  );
}

/**
 * Answers to read again, by position, once all have answered: those on an older revision, else
 * every one when they share a revision but list different things. None before the first pass ends.
 */
export function externalLaggingPages(
  results: ReadonlyArray<AgentSessionCatalogResult | null>,
): ReadonlyArray<number> {
  const answered = results.filter((result) => result !== null);
  if (results.length < 2 || answered.length < results.length) return [];
  if (answered[0]!.indexedAt === null) return [];
  const newest = Math.max(...answered.map((result) => result.revision));
  const older = answered.flatMap((result, index) => (result.revision === newest ? [] : [index]));
  if (older.length > 0) return older;
  const listing = answered[0]!.listing;
  return answered.every((result) => result.listing === listing)
    ? []
    : answered.map((_, index) => index);
}

/** The list once every request has a current answer and they agree. */
export function externalListView(input: {
  readonly groups: ReadonlyArray<ExternalGroup>;
  readonly requests: ExternalListRequests;
  readonly results: ReadonlyArray<AgentSessionCatalogResult | null>;
}): ExternalListView | null {
  const { groups, requests } = input;
  const results = input.results.flatMap((result) => (result === null ? [] : [result]));
  const summary = results[0];
  if (summary === undefined || results.length < requests.inputs.length) return null;
  if (!externalAnswersAgree(results)) return null;
  const firstIndex = summary.indexedAt === null;
  // Bounded pages and spans do not overlap; a repeat could only come from a race, and one row per
  // key keeps the list a valid React list either way.
  const seen = new Set<string>();
  const unseen = (entry: AgentSessionCatalogEntry) => {
    const key = externalEntryKey(entry);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };
  const groupViews = groups.flatMap((group, index): Array<ExternalGroupView> => {
    const count = summary.groupCounts[index] ?? 0;
    if (count === 0) return [];
    const span = requests.groupPages.find((pages) => pages.groupId === group.id);
    if (span === undefined) {
      return [{ group, count, entries: null, showMoreCount: 0, overflowed: false }];
    }
    const pages = requests.inputs.slice(span.start, span.end).map((pageInput, offset) => ({
      input: pageInput,
      result: results[span.start + offset]!,
    }));
    const entries = pages.flatMap((page) => page.result.entries).filter(unseen);
    const last = pages.at(-1)!;
    const lastFull = last.result.entries.length >= (last.input.limit ?? EXTERNAL_PAGE_SIZE);
    const total = pages[0]!.result.totalCount;
    return [
      {
        group,
        count,
        entries,
        showMoreCount:
          !firstIndex && lastFull
            ? Math.min(Math.max(0, total - entries.length), EXTERNAL_PAGE_SIZE)
            : 0,
        overflowed: pages.some(
          (page) =>
            page.input.through !== undefined &&
            page.result.entries.length >= (page.input.limit ?? EXTERNAL_BOUNDED_PAGE_LIMIT),
        ),
      },
    ];
  });
  return {
    totalCount: summary.totalCount,
    indexing: summary.indexing,
    firstIndex,
    olderThan: summary.olderThan,
    groups: groupViews,
    entries: groupViews.flatMap((group) => group.entries ?? []),
  };
}

export function externalEntryKey(entry: AgentSessionCatalogEntry): string {
  return `external:${entry.providerInstanceId}:${entry.filePath}`;
}

/**
 * An answer once it is current. A request being re-read still carries its previous answer, which
 * can hold a session opened since; it does not count until the new answer lands.
 */
export function externalSettledAnswer<A>(result: AsyncResult.AsyncResult<A, unknown>): A | null {
  return result.waiting ? null : AsyncResult.getOrElse(result, () => null);
}

/**
 * A request's answer only when its last read succeeded and is not being redone. A failed read can
 * still carry an older answer; re-reading it for being old would fail again and again.
 */
export function externalSucceededAnswer<A>(result: AsyncResult.AsyncResult<A, unknown>): A | null {
  return result._tag === "Success" && !result.waiting ? result.value : null;
}

/** What the list shows: the fresh view, else the last one of this scope while answers load. */
export function externalShownView(
  kept: { readonly scopeKey: string; readonly view: ExternalListView } | null,
  scopeKey: string,
  fresh: ExternalListView | null,
): ExternalListView | null {
  return fresh ?? (kept?.scopeKey === scopeKey ? kept.view : null);
}

/** The list's own status row: why it shows nothing, or that it is still reading. */
export type ExternalListStatus = "retry" | "loading" | "reading" | "empty" | null;

/**
 * Whether the rows on screen are about to change: a request has no answer yet, the answers have
 * all arrived but from different passes (the lagging ones re-read), or the rows were built for
 * other requests (a group just opened or paged). A re-read of the same requests is not: paging
 * from the rows shown is right whichever pass they came from.
 */
export function externalListMoving(input: {
  readonly fresh: ExternalListView | null;
  readonly settled: ReadonlyArray<AgentSessionCatalogResult | null>;
  readonly loading: boolean;
  /** The rows on screen were built from the requests made now. */
  readonly shownCurrent: boolean;
  /** A read failed: the list offers a retry, and nothing is on its way. */
  readonly failed: boolean;
}): boolean {
  if (input.fresh !== null || input.failed) return false;
  return input.loading || !input.shownCurrent || input.settled.every((answer) => answer !== null);
}

export function externalListStatus(input: {
  readonly shown: ExternalListView | null;
  readonly failed: boolean;
}): ExternalListStatus {
  const { shown } = input;
  if (input.failed) return "retry";
  // Nothing on screen and nothing failed: something is still on its way.
  if (shown === null) return "loading";
  if (shown.firstIndex && shown.indexing) return "reading";
  return shown.totalCount === 0 && !shown.indexing ? "empty" : null;
}

/** An open group's last row: loading its rows, or "Show more" (held while anything moves). */
export type ExternalGroupFooter =
  | { readonly kind: "loading" }
  | { readonly kind: "more"; readonly count: number; readonly busy: boolean }
  | null;

export function externalGroupFooter(input: {
  readonly group: ExternalGroupView;
  readonly moving: boolean;
  readonly opening: boolean;
  /** The list offers a retry; a group waiting on the failed read shows nothing more. */
  readonly failed: boolean;
}): ExternalGroupFooter {
  const { group } = input;
  if (group.entries === null) return input.failed ? null : { kind: "loading" };
  if (group.showMoreCount === 0) return null;
  return { kind: "more", count: group.showMoreCount, busy: input.moving || input.opening };
}

/** What the list last saw of the things that change what it shows from outside it. */
export interface ExternalObserved {
  readonly nowMinute: string;
  readonly heldThreadCount: number;
  readonly banishVersion: number;
}

/**
 * Whether a change since the last look calls for a re-read. A change to the threads held or to
 * what is banished always does; a new minute only while the window is in view, so a window left
 * in the background does not walk every home once a minute.
 */
export function externalRefreshDue(
  observed: ExternalObserved,
  current: ExternalObserved,
  visible: boolean,
): boolean {
  if (
    observed.heldThreadCount !== current.heldThreadCount ||
    observed.banishVersion !== current.banishVersion
  ) {
    return true;
  }
  return observed.nowMinute !== current.nowMinute && visible;
}

/**
 * "Show more" adds a page to the group that starts after its last row shown. Pressed again before
 * that page shows, it adds nothing: the page after the same row is already asked for.
 */
export function externalCursorsAfterShowMore(
  group: ExternalGroupView,
  cursors: ReadonlyArray<AgentSessionCatalogCursor>,
): ReadonlyArray<AgentSessionCatalogCursor> {
  const last = group.entries?.at(-1);
  if (last === undefined || group.showMoreCount === 0) return cursors;
  const next = externalCursorAfter(last);
  const previous = cursors.at(-1);
  return previous !== undefined &&
    previous.lastActiveAt === next.lastActiveAt &&
    previous.providerInstanceId === next.providerInstanceId &&
    previous.filePath === next.filePath
    ? cursors
    : [...cursors, next];
}

/** A group whose bounded page reached the cap may hide rows, so it pages again from its top. */
export function externalCursorsAfterAnswer(
  view: ExternalListView | null,
  cursors: Readonly<Record<string, ReadonlyArray<AgentSessionCatalogCursor>>>,
): Readonly<Record<string, ReadonlyArray<AgentSessionCatalogCursor>>> {
  const reset = (view?.groups ?? []).filter(
    (group) => group.overflowed && (cursors[group.group.id]?.length ?? 0) > 0,
  );
  if (reset.length === 0) return cursors;
  const next = { ...cursors };
  for (const group of reset) delete next[group.group.id];
  return next;
}

/**
 * One open at a time: a second click, on any row, while an import runs would start a second import
 * and race the first for where the window lands.
 */
export function createExternalOpenGate() {
  let opening: string | null = null;
  return {
    tryEnter: (key: string): boolean => {
      if (opening !== null) return false;
      opening = key;
      return true;
    },
    leave: (): void => {
      opening = null;
    },
  };
}

function folderName(path: string): string {
  const parts = path.split(/[\\/]/).filter((part) => part.length > 0);
  return parts.at(-1) ?? path;
}

/** A session with no first request is named after the folder it ran in. */
export function externalEntryTitle(entry: AgentSessionCatalogEntry): string {
  const title = entry.title?.trim();
  return title !== undefined && title.length > 0
    ? title
    : folderName(entry.cwd ?? entry.projectRoot);
}

const SOURCE_NAMES: Record<AgentSessionSource, string> = {
  claudeAgent: "Claude Code",
  codex: "Codex",
  pi: "Pi",
};

/** The name of the tool that ran the session. */
export function externalEntrySourceName(entry: AgentSessionCatalogEntry): string {
  return SOURCE_NAMES[entry.source];
}

/** Which tool ran the session and where, for the row's tooltip. */
export function externalEntryOrigin(entry: AgentSessionCatalogEntry): string {
  return `${SOURCE_NAMES[entry.source]} in ${entry.cwd ?? entry.projectRoot}`;
}

/** Which tool ran the session and in which folder, short enough for one line. */
export function externalEntryPlace(entry: AgentSessionCatalogEntry): string {
  return `${SOURCE_NAMES[entry.source]} in ${folderName(entry.cwd ?? entry.projectRoot)}`;
}

/** The groups "Import the last 30 days" takes, newest first. */
const IMPORT_GROUPS: ReadonlySet<string> = new Set(["today", "yesterday", "week", "month"]);

/**
 * What "Import the last 30 days" takes: every session listed since the "Previous 30 days" group
 * starts, so the count on the button and what the server imports cover the same days.
 */
export function externalImportWindow(
  groups: ReadonlyArray<ExternalGroup>,
  view: ExternalListView | null,
): { readonly activeFrom: string; readonly count: number } | null {
  const activeFrom = groups.find((group) => group.id === "month")?.activeFrom;
  if (activeFrom === undefined || view === null) return null;
  const count = view.groups.reduce(
    (sum, shown) => (IMPORT_GROUPS.has(shown.group.id) ? sum + shown.count : sum),
    0,
  );
  return { activeFrom, count };
}

/** The banish menu: each age preset with how many listed sessions it would take. */
export function externalBanishPresets(
  view: ExternalListView | null,
): ReadonlyArray<{ readonly months: number; readonly label: string; readonly count: number }> {
  return AGENT_SESSION_BANISH_MONTHS.map((months) => ({
    months,
    label: months === 1 ? "Older than 1 month" : `Older than ${months} months`,
    count: view?.olderThan.find((preset) => preset.months === months)?.count ?? 0,
  }));
}

/** A row ticked or unticked by hand: its session, and the group it sat in when clicked. */
export interface ExternalSelectedRow {
  readonly ref: AgentSessionRef;
  readonly groupId: string | undefined;
}

/**
 * What is ticked. The server takes a session when it is ticked by hand or inside a whole group's
 * span, and not unticked, so every ticked and unticked row is sent as itself wherever it sits now.
 */
export interface ExternalSelection {
  /** Rows ticked one by one. */
  readonly keys: ReadonlySet<string>;
  /** Whole groups, by id: every session in the group's span, shown on screen or not. */
  readonly groups: ReadonlySet<string>;
  /** Rows unticked inside a whole group. */
  readonly excluded: ReadonlySet<string>;
  /** Each row clicked: the session it is, and the group it was in, for counts while off screen. */
  readonly rows: ReadonlyMap<string, ExternalSelectedRow>;
  /** Where a shift-click range starts: the last row clicked. */
  readonly anchor: string | null;
}

export const NO_EXTERNAL_SELECTION: ExternalSelection = {
  keys: new Set(),
  groups: new Set(),
  excluded: new Set(),
  rows: new Map(),
  anchor: null,
};

export function externalIsSelected(
  selection: ExternalSelection,
  key: string,
  groupId: string | undefined,
): boolean {
  if (selection.excluded.has(key)) return false;
  return selection.keys.has(key) || (groupId !== undefined && selection.groups.has(groupId));
}

/** Whether the selection takes anything: a row ticked by hand or a whole group. */
export function externalSelectionTakesAny(selection: ExternalSelection): boolean {
  return selection.keys.size > 0 || selection.groups.size > 0;
}

/**
 * A row's checkbox toggles that row; with Shift it selects every row between the anchor and this
 * one, in the order shown. Inside a whole group, unticking a row leaves it out of the group.
 */
export function externalSelectionAfterClick(
  selection: ExternalSelection,
  click: {
    readonly key: string;
    readonly orderedKeys: ReadonlyArray<string>;
    /** The group each row on screen sits in. */
    readonly groupOf: (key: string) => string | undefined;
    /** The session each row on screen is. */
    readonly refOf: (key: string) => AgentSessionRef | undefined;
    readonly range: boolean;
  },
): ExternalSelection {
  const keys = new Set(selection.keys);
  const excluded = new Set(selection.excluded);
  const rows = new Map(selection.rows);
  const remember = (key: string) => {
    const ref = click.refOf(key);
    if (ref !== undefined) rows.set(key, { ref, groupId: click.groupOf(key) });
  };
  // Ticking a row always takes it out of the unticked, wherever it was unticked.
  const select = (key: string) => {
    remember(key);
    excluded.delete(key);
    const groupId = click.groupOf(key);
    if (groupId === undefined || !selection.groups.has(groupId)) keys.add(key);
  };
  const unselect = (key: string) => {
    remember(key);
    keys.delete(key);
    const groupId = click.groupOf(key);
    if (groupId !== undefined && selection.groups.has(groupId)) excluded.add(key);
  };
  if (click.range && selection.anchor !== null) {
    const from = click.orderedKeys.indexOf(selection.anchor);
    const to = click.orderedKeys.indexOf(click.key);
    if (from >= 0 && to >= 0) {
      const [start, end] = from <= to ? [from, to] : [to, from];
      for (const key of click.orderedKeys.slice(start, end + 1)) select(key);
      return { keys, groups: selection.groups, excluded, rows, anchor: selection.anchor };
    }
  }
  if (externalIsSelected(selection, click.key, click.groupOf(click.key))) unselect(click.key);
  else select(click.key);
  return { keys, groups: selection.groups, excluded, rows, anchor: click.key };
}

/**
 * The group a ticked or unticked row is in as far as the screen knows: the group it shows in, else
 * the one it was clicked in. Only counts and header boxes read it; what is sent never does.
 */
function externalKnownGroup(
  selection: ExternalSelection,
  view: ExternalListView | null,
): (key: string) => string | undefined {
  const shownIn = new Map<string, string>();
  for (const groupView of view?.groups ?? []) {
    for (const entry of groupView.entries ?? []) {
      shownIn.set(externalEntryKey(entry), groupView.group.id);
    }
  }
  return (key) => shownIn.get(key) ?? selection.rows.get(key)?.groupId;
}

/**
 * A group header's checkbox: the whole group, part of it, or none of it, counting the rows ticked
 * or left out in it whether or not they are on screen.
 */
export function externalGroupCheck(
  selection: ExternalSelection,
  groupId: string,
  view: ExternalListView | null,
): "all" | "some" | "none" {
  const count = view?.groups.find((groupView) => groupView.group.id === groupId)?.count ?? 0;
  const groupOf = externalKnownGroup(selection, view);
  const inGroup = (keys: ReadonlySet<string>) =>
    [...keys].filter((key) => groupOf(key) === groupId).length;
  if (selection.groups.has(groupId)) {
    const left = inGroup(selection.excluded);
    if (left === 0) return "all";
    return left >= count ? "none" : "some";
  }
  const ticked = [...selection.keys].filter(
    (key) => groupOf(key) === groupId && !selection.excluded.has(key),
  ).length;
  if (ticked === 0) return "none";
  return ticked >= count ? "all" : "some";
}

/** Ticking a group header takes the whole group, shown or not; unticking a whole one clears it. */
export function externalSelectionAfterGroupClick(
  selection: ExternalSelection,
  groupId: string,
  view: ExternalListView | null,
): ExternalSelection {
  const whole = externalGroupCheck(selection, groupId, view) === "all";
  const groupOf = externalKnownGroup(selection, view);
  const outside = (key: string) => groupOf(key) !== groupId;
  const groups = new Set(selection.groups);
  if (whole) groups.delete(groupId);
  else groups.add(groupId);
  return {
    keys: new Set([...selection.keys].filter(outside)),
    groups,
    excluded: new Set([...selection.excluded].filter(outside)),
    rows: selection.rows,
    anchor: selection.anchor,
  };
}

/** The selection with these rows taken out, as when they leave the list; the rest stays ticked. */
export function externalSelectionWithout(
  selection: ExternalSelection,
  leaving: ReadonlySet<string>,
): ExternalSelection {
  return {
    keys: new Set([...selection.keys].filter((key) => !leaving.has(key))),
    groups: selection.groups,
    excluded: new Set([...selection.excluded].filter((key) => !leaving.has(key))),
    rows: new Map([...selection.rows].filter(([key]) => !leaving.has(key))),
    anchor: selection.anchor !== null && leaving.has(selection.anchor) ? null : selection.anchor,
  };
}

/**
 * What the selection takes, as the server reads it: every row ticked by hand and every row
 * unticked, as themselves wherever they are now, and each whole group the list shows by its span.
 * `count` is how many that is as far as the screen knows; the server's answer is the real one.
 */
export function externalSelectionChoice(
  selection: ExternalSelection,
  view: ExternalListView | null,
): {
  readonly sessions: ReadonlyArray<AgentSessionRef>;
  readonly windows: ReadonlyArray<AgentSessionWindow>;
  readonly exclude: ReadonlyArray<AgentSessionRef>;
  readonly count: number;
} {
  const refs = (keys: Iterable<string>) =>
    [...keys].flatMap((key) => {
      const row = selection.rows.get(key);
      return row === undefined ? [] : [row.ref];
    });
  const groupOf = externalKnownGroup(selection, view);
  const sessions = refs([...selection.keys].filter((key) => !selection.excluded.has(key)));
  const exclude = refs(selection.excluded);
  const windows: Array<AgentSessionWindow> = [];
  let count = 0;
  for (const groupView of view?.groups ?? []) {
    const { group } = groupView;
    if (!selection.groups.has(group.id)) continue;
    windows.push({
      ...(group.activeFrom === undefined ? {} : { activeFrom: group.activeFrom }),
      ...(group.activeUntil === undefined ? {} : { activeUntil: group.activeUntil }),
    });
    const left = [...selection.excluded].filter((key) => groupOf(key) === group.id).length;
    count += Math.max(0, groupView.count - left);
  }
  for (const key of selection.keys) {
    if (selection.excluded.has(key)) continue;
    const groupId = groupOf(key);
    if (groupId === undefined || !selection.groups.has(groupId)) count += 1;
  }
  return { sessions, windows, exclude, count };
}

/** The server's own reason when it refused the open, else a plain failure. */
export function externalOpenFailureMessage(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  return error instanceof Error &&
    "_tag" in error &&
    error._tag === "AgentSessionHydrateError" &&
    error.message.length > 0
    ? error.message
    : "The session could not be opened. Try again.";
}
