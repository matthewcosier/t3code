import {
  AgentSessionHydrateError,
  ProviderInstanceId,
  type AgentSessionCatalogEntry,
  type AgentSessionCatalogResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import {
  EXTERNAL_BOUNDED_PAGE_LIMIT,
  EXTERNAL_FIRST_PAGE_SIZE,
  EXTERNAL_PAGE_SIZE,
  NO_EXTERNAL_SELECTION,
  createExternalOpenGate,
  externalBanishPresets,
  externalCursorAfter,
  externalCursorsAfterAnswer,
  externalCursorsAfterShowMore,
  externalEntryKey,
  externalEntryTitle,
  externalFallbackGroup,
  externalFallbackToRemember,
  externalGroupFooter,
  externalGroupPageInputs,
  externalGroups,
  externalImportWindow,
  externalLaggingPages,
  externalOpenFailureMessage,
  externalOpenGroups,
  externalRefreshDue,
  externalSelectionAfterClick,
  externalSettledAnswer,
  externalListMoving,
  externalListRequests,
  externalListStatus,
  externalListView,
  externalShownOpenGroups,
  externalShownView,
  externalSucceededAnswer,
  externalSummaryInput,
  externalViewCounts,
  type ExternalGroup,
} from "./externalSessions.logic";

const claude = ProviderInstanceId.make("claudeAgent");

function entry(index: number, overrides: Partial<AgentSessionCatalogEntry> = {}) {
  return {
    providerInstanceId: claude,
    source: "claudeAgent",
    filePath: `/home/dev/.claude/projects/-work-app/session-${index}.jsonl`,
    title: `Session ${index}`,
    cwd: "/work/app",
    projectRoot: "/work/app",
    projectId: null,
    lastActiveAt: new Date(Date.UTC(2026, 10, 16) - index * 60_000).toISOString(),
    sizeBytes: 100,
    ...overrides,
  } satisfies AgentSessionCatalogEntry;
}

function page(
  entries: ReadonlyArray<AgentSessionCatalogEntry>,
  overrides: Partial<AgentSessionCatalogResult> = {},
): AgentSessionCatalogResult {
  return {
    entries,
    totalCount: 100,
    indexing: false,
    indexedAt: "2026-11-16T00:00:00.000Z",
    revision: 1,
    listing: "a",
    olderThan: [],
    groupCounts: [],
    ...overrides,
  };
}

const range = (from: number, count: number) =>
  Array.from({ length: count }, (_, offset) => entry(from + offset));

/** Where a moment falls: the id of the one group whose span holds it. */
const groupOf = (groups: ReadonlyArray<ExternalGroup>, iso: string) =>
  groups
    .filter(
      (group) =>
        (group.activeFrom === undefined || iso >= group.activeFrom) &&
        (group.activeUntil === undefined || iso < group.activeUntil),
    )
    .map((group) => group.id);

const NOW = "2026-11-16T12:00";
const nowMs = Date.parse(`${NOW}:00.000Z`);
const daysAgo = (days: number) => new Date(nowMs - days * 86_400_000).toISOString();

describe("externalGroups", () => {
  it("puts every moment in exactly one group, newest first, ending where the next starts", () => {
    const groups = externalGroups(NOW);
    expect(groups[0]!.activeUntil).toBeUndefined();
    expect(groups.at(-1)!.activeFrom).toBeUndefined();
    for (const [index, group] of groups.entries()) {
      if (index > 0) expect(group.activeUntil).toBe(groups[index - 1]!.activeFrom);
      if (group.activeFrom !== undefined && group.activeUntil !== undefined) {
        expect(group.activeFrom < group.activeUntil).toBe(true);
      }
    }
    for (const days of [0, 0.4, 1, 3, 6, 8, 29, 31, 45, 100, 300, 364, 400, 3000]) {
      expect(groupOf(groups, daysAgo(days))).toHaveLength(1);
    }
  });

  it("groups by today, yesterday, the 7 and 30 days before, then month, then older", () => {
    const groups = externalGroups(NOW);
    const now = new Date(nowMs);
    const midnight = (back: number) =>
      new Date(now.getFullYear(), now.getMonth(), now.getDate() - back).toISOString();
    expect(groupOf(groups, new Date(nowMs).toISOString())).toEqual(["today"]);
    expect(groupOf(groups, midnight(0))).toEqual(["today"]);
    expect(groupOf(groups, new Date(Date.parse(midnight(0)) - 1).toISOString())).toEqual([
      "yesterday",
    ]);
    expect(groupOf(groups, midnight(5))).toEqual(["week"]);
    expect(groupOf(groups, midnight(20))).toEqual(["month"]);
    const old = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 45);
    expect(groupOf(groups, old.toISOString())).toEqual([
      `month:${old.getFullYear()}-${String(old.getMonth() + 1).padStart(2, "0")}`,
    ]);
    expect(groupOf(groups, daysAgo(500))).toEqual(["older"]);
    // A month the last 30 days already cover gets no group of its own.
    const thisMonth = `month:${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    expect(groups.map((group) => group.id)).not.toContain(thisMonth);
  });
});

describe("externalOpenGroups", () => {
  const groups = externalGroups(NOW);
  const counts = (byGroup: Record<string, number>) => groups.map((group) => byGroup[group.id] ?? 0);

  it("opens the recent groups with sessions, so a new one today shuts nothing", () => {
    expect([...externalOpenGroups(groups, counts({ week: 2, older: 4 }), {})]).toEqual(["week"]);
    expect([...externalOpenGroups(groups, counts({ today: 1, week: 2, older: 4 }), {})]).toEqual([
      "today",
      "week",
    ]);
  });

  it("opens the newest group when nothing is recent", () => {
    expect([...externalOpenGroups(groups, counts({ month: 3, older: 4 }), {})]).toEqual(["month"]);
  });

  it("keeps what the person chose, and never opens an empty group", () => {
    expect([
      ...externalOpenGroups(groups, counts({ week: 2, older: 4 }), { week: false, older: true }),
    ]).toEqual(["older"]);
    expect([...externalOpenGroups(groups, counts({ older: 4 }), { yesterday: true })]).toEqual([
      "older",
    ]);
  });
});

describe("requests", () => {
  const groups = externalGroups(NOW);
  const week = groups.find((group) => group.id === "week")!;

  it("counts every group in one summary that alone picks up new sessions", () => {
    const summary = externalSummaryInput(groups);
    expect(summary.limit).toBe(0);
    expect(summary.refresh).toBe(true);
    // A bound where each group but the oldest starts.
    expect(summary.groupBounds).toEqual(groups.slice(0, -1).map((group) => group.activeFrom));
  });

  it("reads one short first page of a group's span, without starting a pass", () => {
    expect(externalGroupPageInputs({ group: week, cursors: [] })).toEqual([
      {
        activeFrom: week.activeFrom,
        activeUntil: week.activeUntil,
        limit: EXTERNAL_FIRST_PAGE_SIZE,
      },
    ]);
  });

  it("bounds every page of a group but the last at the row it ended on", () => {
    const cursors = [externalCursorAfter(entry(9)), externalCursorAfter(entry(34))];
    const span = { activeFrom: week.activeFrom, activeUntil: week.activeUntil };
    expect(externalGroupPageInputs({ group: week, cursors })).toEqual([
      { ...span, through: cursors[0], limit: EXTERNAL_BOUNDED_PAGE_LIMIT },
      { ...span, before: cursors[0], through: cursors[1], limit: EXTERNAL_BOUNDED_PAGE_LIMIT },
      { ...span, before: cursors[1], limit: EXTERNAL_PAGE_SIZE },
    ]);
  });

  it("reads rows only for the groups listed, after the summary", () => {
    const requests = externalListRequests({
      groups,
      listed: new Set(["week", "older"]),
      cursors: { older: [externalCursorAfter(entry(9))] },
    });
    expect(requests.inputs[0]!.groupBounds).toBeDefined();
    expect(requests.groupPages).toEqual([
      { groupId: "week", start: 1, end: 2 },
      { groupId: "older", start: 2, end: 4 },
    ]);
  });
});

describe("externalListView", () => {
  const groups = externalGroups(NOW);
  const index = (id: string) => groups.findIndex((group) => group.id === id);
  const counts = (byGroup: Record<string, number>) => groups.map((group) => byGroup[group.id] ?? 0);
  const summary = (
    byGroup: Record<string, number>,
    overrides: Partial<AgentSessionCatalogResult> = {},
  ) => {
    const groupCounts = counts(byGroup);
    return page([], {
      totalCount: groupCounts.reduce((sum, count) => sum + count, 0),
      groupCounts,
      ...overrides,
    });
  };
  const listing = (listed: ReadonlyArray<string>, cursors = {}) =>
    externalListRequests({ groups, listed: new Set(listed), cursors });

  it("lists each open group's rows under it, and only counts for the closed and the empty", () => {
    const requests = listing(["week"]);
    const view = externalListView({
      groups,
      requests,
      results: [summary({ week: 3, older: 40 }), page(range(0, 3), { totalCount: 3 })],
    })!;
    expect(view.groups.map((group) => [group.group.id, group.count])).toEqual([
      ["week", 3],
      ["older", 40],
    ]);
    expect(view.groups[0]!.entries).toEqual(range(0, 3));
    expect(view.groups[1]!.entries).toBeNull();
    expect(view.entries).toEqual(range(0, 3));
    expect(view.totalCount).toBe(43);
    expect(index("older")).toBe(groups.length - 1);
  });

  it("offers more in a group while its last page came back full, and none once short", () => {
    const full = externalListView({
      groups,
      requests: listing(["older"]),
      results: [summary({ older: 40 }), page(range(0, 10), { totalCount: 40 })],
    })!;
    expect(full.groups[0]!.showMoreCount).toBe(EXTERNAL_PAGE_SIZE);
    expect(externalCursorsAfterShowMore(full.groups[0]!, [])).toEqual([
      externalCursorAfter(entry(9)),
    ]);
    const short = externalListView({
      groups,
      requests: listing(["older"]),
      // The total says more, but the page came back short: the group has no more to show.
      results: [summary({ older: 40 }), page(range(0, 4), { totalCount: 40 })],
    })!;
    expect(short.groups[0]!.showMoreCount).toBe(0);
    const none: ReadonlyArray<ReturnType<typeof externalCursorAfter>> = [];
    expect(externalCursorsAfterShowMore(short.groups[0]!, none)).toBe(none);
  });

  it("does not join answers read from different revisions of the catalog", () => {
    const requests = listing(["week"]);
    expect(
      externalListView({
        groups,
        requests,
        results: [summary({ week: 3 }, { revision: 2 }), page(range(0, 3))],
      }),
    ).toBeNull();
  });

  it("does not join answers on one revision that list different things", () => {
    // Another window opened a session between the two reads: the rows are the same revision, but
    // the threads holding sessions are not.
    expect(
      externalListView({
        groups,
        requests: listing(["week"]),
        results: [summary({ week: 2 }, { listing: "b" }), page(range(0, 3))],
      }),
    ).toBeNull();
  });

  it("joins answers taken while a pass runs, when they were read from the same revision", () => {
    // Coming back to the page, banishing or opening starts a pass; the rows it already has stand.
    const view = externalListView({
      groups,
      requests: listing(["week"]),
      results: [summary({ week: 3 }, { indexing: true }), page(range(0, 3), { indexing: true })],
    });
    expect(view?.groups[0]!.entries).toEqual(range(0, 3));
  });

  it("fills in as the first pass goes, without offering more until it has finished", () => {
    const first = { indexedAt: null, indexing: true };
    const view = externalListView({
      groups,
      requests: listing(["older"]),
      results: [summary({ older: 40 }, first), page(range(0, 10), { ...first, totalCount: 12 })],
    })!;
    expect(view.firstIndex).toBe(true);
    expect(view.groups[0]!.entries).toHaveLength(10);
    expect(view.groups[0]!.showMoreCount).toBe(0);
  });

  it("lists a session once even if two groups both return it", () => {
    const view = externalListView({
      groups,
      requests: listing(["week", "month"]),
      results: [summary({ week: 2, month: 2 }), page(range(0, 2)), page(range(1, 2))],
    })!;
    expect(view.entries.map(externalEntryKey)).toEqual(range(0, 3).map(externalEntryKey));
  });

  it("has no view until every request has a current answer", () => {
    const requests = listing(["week"]);
    expect(
      externalListView({ groups, requests, results: [summary({ week: 3 }), null] }),
    ).toBeNull();
    expect(externalListView({ groups, requests, results: [null, page(range(0, 3))] })).toBeNull();
  });

  it("starts a group again from its first page when one of its bounded pages reaches the cap", () => {
    const cursors = { older: [externalCursorAfter(entry(9))] };
    const capped = externalListView({
      groups,
      requests: listing(["week", "older"], cursors),
      results: [
        summary({ week: 1, older: 400 }),
        page(range(500, 1)),
        page(range(0, EXTERNAL_BOUNDED_PAGE_LIMIT)),
        page(range(EXTERNAL_BOUNDED_PAGE_LIMIT, 3)),
      ],
    });
    expect(externalCursorsAfterAnswer(capped, cursors)).toEqual({});
    const fine = externalListView({
      groups,
      requests: listing(["older"], cursors),
      results: [summary({ older: 13 }), page(range(0, 10)), page(range(10, 3))],
    });
    expect(externalCursorsAfterAnswer(fine, cursors)).toBe(cursors);
  });

  it("keeps the rows on screen while a re-read loads, never another scope's", () => {
    const view = externalListView({
      groups,
      requests: listing(["week"]),
      results: [summary({ week: 3 }), page(range(0, 3))],
    })!;
    expect(externalShownView({ scopeKey: "all", view }, "all", null)).toBe(view);
    expect(externalShownView({ scopeKey: "all", view }, "project-a", null)).toBeNull();
  });
});

describe("externalLaggingPages", () => {
  it("re-reads the answers read from an older revision, even while a pass runs", () => {
    expect(
      externalLaggingPages([
        page([], { revision: 3 }),
        page([], { revision: 2, indexing: true }),
        page([], { revision: 3 }),
      ]),
    ).toEqual([1]);
    // The summary can be the one behind, when another window changed the catalog.
    expect(externalLaggingPages([page([], { revision: 2 }), page([], { revision: 3 })])).toEqual([
      0,
    ]);
  });

  it("waits for every answer, and lets the first pass fill in without re-reads", () => {
    expect(externalLaggingPages([page([], { revision: 3 }), null])).toEqual([]);
    expect(
      externalLaggingPages([page([], { indexedAt: null, revision: 3 }), page([], { revision: 2 })]),
    ).toEqual([]);
  });

  it("never re-reads a request whose last read failed, however old the answer it still holds", () => {
    // A server restart failed the page's re-read; it still carries its answer from revision 1.
    const failedPage = AsyncResult.failure<AgentSessionCatalogResult, string>(Cause.fail("down"), {
      previousSuccess: Option.some(AsyncResult.success(page([], { revision: 1 }))),
    });
    const results = [AsyncResult.success(page([], { revision: 2 })), failedPage];
    expect(externalLaggingPages(results.map(externalSucceededAnswer))).toEqual([]);
    // The list offers a retry instead, with nothing shown as on its way.
    expect(
      externalListMoving({
        fresh: null,
        settled: results.map(externalSettledAnswer),
        loading: false,
        shownCurrent: true,
        failed: true,
      }),
    ).toBe(false);
  });

  it("re-reads every answer when all share a revision but list different things", () => {
    expect(
      externalLaggingPages([page([], { listing: "b" }), page([]), page([], { listing: "b" })]),
    ).toEqual([0, 1, 2]);
  });

  it("leaves answers from the same revision alone", () => {
    expect(externalLaggingPages([page([]), page([])])).toEqual([]);
  });
});

describe("externalSettledAnswer", () => {
  it("does not count a page's previous answer while it is being re-read", () => {
    // The previous answer can still list a session opened since; it must not stand for the page.
    const previous = page(range(0, 10), { totalCount: 13 });
    expect(externalSettledAnswer(AsyncResult.success(previous, { waiting: true }))).toBeNull();
    expect(externalSettledAnswer(AsyncResult.success(previous))).toBe(previous);
    expect(externalSettledAnswer(AsyncResult.initial(true))).toBeNull();
  });
});

describe("status", () => {
  const groups = externalGroups(NOW);
  const requests = externalListRequests({
    groups,
    listed: new Set(["older"]),
    cursors: { older: [externalCursorAfter(entry(9))] },
  });
  const olderCounts = groups.map((group) => (group.id === "older" ? 40 : 0));
  const summary = page([], { totalCount: 40, groupCounts: olderCounts });
  const shown = externalListView({
    groups,
    requests: externalListRequests({
      groups,
      listed: new Set(["older"]),
      cursors: {},
    }),
    results: [summary, page(range(0, 10), { totalCount: 40 })],
  })!;
  const olderGroup = shown.groups[0]!;
  const idle = { moving: false, opening: false, failed: false };

  it("holds Show more while answers that all arrived still disagree", () => {
    // A pass found a new session: the summary answered from the newer revision, the pages not yet.
    const settled = [{ ...summary, revision: 2 }, page(range(0, 10)), page(range(10, 25))];
    const fresh = externalListView({ groups, requests, results: settled });
    expect(fresh).toBeNull();
    const moving = externalListMoving({
      fresh,
      settled,
      loading: false,
      shownCurrent: true,
      failed: false,
    });
    expect(moving).toBe(true);
    expect(externalGroupFooter({ ...idle, group: olderGroup, moving })).toEqual({
      kind: "more",
      count: EXTERNAL_PAGE_SIZE,
      busy: true,
    });
  });

  it("holds Show more while the rows on screen were built for other requests", () => {
    // "Show more" was just pressed: the rows shown are from before, the new page has no answer.
    const settled = [summary, null, null];
    expect(
      externalListMoving({
        fresh: null,
        settled,
        loading: false,
        shownCurrent: false,
        failed: false,
      }),
    ).toBe(true);
  });

  it("keeps Show more while the same requests are re-read", () => {
    // Paging from the rows shown is right whichever pass they came from, so a re-read of the
    // same requests does not hold it, and the button does not flicker each minute.
    const settled = [summary, null, page(range(10, 25))];
    expect(
      externalListMoving({
        fresh: null,
        settled,
        loading: false,
        shownCurrent: true,
        failed: false,
      }),
    ).toBe(false);
    expect(
      externalListMoving({
        fresh: shown,
        settled: [],
        loading: false,
        shownCurrent: false,
        failed: false,
      }),
    ).toBe(false);
  });

  it("holds Show more while a session opens", () => {
    expect(externalGroupFooter({ ...idle, group: olderGroup })).toEqual({
      kind: "more",
      count: EXTERNAL_PAGE_SIZE,
      busy: false,
    });
    expect(externalGroupFooter({ ...idle, opening: true, group: olderGroup })).toMatchObject({
      busy: true,
    });
  });

  it("shows a group just opened as loading until its rows arrive, unless the read failed", () => {
    const closed = { ...olderGroup, entries: null };
    expect(externalGroupFooter({ ...idle, group: closed })).toEqual({ kind: "loading" });
    // The list's retry row stands for it; the group shows no spinner above it.
    expect(externalGroupFooter({ ...idle, failed: true, group: closed })).toBeNull();
  });

  it("says why the list shows nothing: failed, on its way, still reading, or no sessions", () => {
    expect(externalListStatus({ shown: null, failed: true })).toBe("retry");
    expect(externalListStatus({ shown: null, failed: false })).toBe("loading");
    expect(
      externalListStatus({ shown: { ...shown, firstIndex: true, indexing: true }, failed: false }),
    ).toBe("reading");
    expect(
      externalListStatus({
        shown: { ...shown, totalCount: 0, groups: [], entries: [] },
        failed: false,
      }),
    ).toBe("empty");
    expect(externalListStatus({ shown, failed: false })).toBeNull();
  });

  it("asks for the page after a row once, however often Show more is pressed before it shows", () => {
    const once = externalCursorsAfterShowMore(olderGroup, []);
    expect(once).toEqual([externalCursorAfter(entry(9))]);
    expect(externalCursorsAfterShowMore(olderGroup, once)).toBe(once);
  });
});

describe("which groups stay open", () => {
  const groups = externalGroups(NOW);
  const counts = (byGroup: Record<string, number>) => groups.map((group) => byGroup[group.id] ?? 0);

  it("remembers the group opened only because nothing recent has sessions", () => {
    expect(externalFallbackGroup(groups, counts({ month: 3, older: 4 }), {})).toBe("month");
    // Once remembered, or when something recent has sessions, there is nothing to remember.
    expect(externalFallbackGroup(groups, counts({ month: 3 }), { month: true })).toBeNull();
    expect(externalFallbackGroup(groups, counts({ week: 1, month: 3 }), {})).toBeNull();
    // Remembered, it stays open when a session lands today.
    expect([
      ...externalOpenGroups(groups, counts({ today: 1, month: 3 }), { month: true }),
    ]).toEqual(["today", "month"]);
  });

  it("remembers the fallback group only once the person has seen it open", () => {
    const view = externalListView({
      groups,
      requests: externalListRequests({
        groups,
        listed: new Set(),
        cursors: {},
      }),
      results: [page([], { totalCount: 4, groupCounts: counts({ month: 3, older: 1 }) })],
    });
    expect(externalFallbackToRemember(view, {})).toBe("month");
    // Not while the first pass is still reading.
    expect(externalFallbackToRemember({ ...view!, firstIndex: true }, {})).toBeNull();
  });

  it("keeps a month open over the month's end until the new answers land", () => {
    // Opened on the last day of a month, the oldest named month leaves the groups the next day;
    // the rows on screen still hold it, so it stays open with its rows.
    const lastDay = externalGroups("2026-11-30T12:00");
    const oldest = lastDay.filter((group) => group.id.startsWith("month:")).at(-1)!;
    const view = externalListView({
      groups: lastDay,
      requests: externalListRequests({
        groups: lastDay,
        listed: new Set([oldest.id]),
        cursors: {},
      }),
      results: [
        page([], {
          totalCount: 1,
          groupCounts: lastDay.map((group) => (group.id === oldest.id ? 1 : 0)),
        }),
        page(range(0, 1)),
      ],
    });
    const nextDay = externalGroups("2026-12-01T12:00");
    expect(nextDay.map((group) => group.id)).not.toContain(oldest.id);
    expect([...externalShownOpenGroups(view, { [oldest.id]: true })]).toEqual([oldest.id]);
  });

  it("keeps a group open while the rows on screen still hold it", () => {
    // The newest counts moved the group's last session to Today, but the answers do not agree
    // yet: the rows on screen still list the group, so it stays open with them.
    const view = externalListView({
      groups,
      requests: externalListRequests({
        groups,
        listed: new Set(["week"]),
        cursors: {},
      }),
      results: [page([], { totalCount: 1, groupCounts: counts({ week: 1 }) }), page(range(0, 1))],
    });
    expect([...externalOpenGroups(groups, externalViewCounts(groups, view), {})]).toEqual(["week"]);
    expect([...externalOpenGroups(groups, counts({ today: 1 }), {})]).toEqual(["today"]);
  });
});

describe("externalRefreshDue", () => {
  const before = { nowMinute: "2026-11-16T10:00", heldThreadCount: 4, banishVersion: 0 };
  const nextMinute = { ...before, nowMinute: "2026-11-16T10:01" };

  it("re-reads each minute only while the window is in view", () => {
    expect(externalRefreshDue(before, nextMinute, true)).toBe(true);
    expect(externalRefreshDue(before, nextMinute, false)).toBe(false);
  });

  it("re-reads whenever the held threads or what is banished change, in view or not", () => {
    expect(externalRefreshDue(before, { ...before, heldThreadCount: 5 }, false)).toBe(true);
    expect(externalRefreshDue(before, { ...before, banishVersion: 1 }, false)).toBe(true);
    expect(externalRefreshDue(before, before, true)).toBe(false);
  });
});

describe("createExternalOpenGate", () => {
  it("lets one session open at a time", () => {
    const gate = createExternalOpenGate();
    expect(gate.tryEnter("a")).toBe(true);
    // A second click on the same row, or on another row, waits for the first to finish.
    expect(gate.tryEnter("a")).toBe(false);
    expect(gate.tryEnter("b")).toBe(false);
    gate.leave();
    expect(gate.tryEnter("b")).toBe(true);
  });
});

describe("banishing", () => {
  it("offers each age preset with how many sessions it would take", () => {
    const groups = externalGroups(NOW);
    const view = externalListView({
      groups,
      requests: externalListRequests({
        groups,
        listed: new Set(),
        cursors: {},
      }),
      results: [
        page([], {
          olderThan: [
            { months: 1, count: 40 },
            { months: 3, count: 12 },
          ],
        }),
      ],
    });
    expect(externalBanishPresets(view).map(({ months, count }) => ({ months, count }))).toEqual([
      { months: 1, count: 40 },
      { months: 2, count: 0 },
      { months: 3, count: 12 },
      { months: 6, count: 0 },
      { months: 12, count: 0 },
    ]);
  });

  it("toggles one row's checkbox and takes a range with Shift, in the order shown", () => {
    const orderedKeys = ["a", "b", "c", "d", "e"];
    const click = (key: string, modifiers: { range?: boolean } = {}) => ({
      key,
      orderedKeys,
      range: modifiers.range ?? false,
    });
    let selection = externalSelectionAfterClick(NO_EXTERNAL_SELECTION, click("b"));
    expect([...selection.keys]).toEqual(["b"]);
    selection = externalSelectionAfterClick(selection, click("e", { range: true }));
    expect([...selection.keys].toSorted()).toEqual(["b", "c", "d", "e"]);
    // Upwards from the same anchor adds the rows above it.
    selection = externalSelectionAfterClick(selection, click("a", { range: true }));
    expect([...selection.keys].toSorted()).toEqual(["a", "b", "c", "d", "e"]);
    selection = externalSelectionAfterClick(selection, click("c"));
    expect(selection.keys.has("c")).toBe(false);
    // Shift with nothing to start from selects just that row.
    expect([
      ...externalSelectionAfterClick(NO_EXTERNAL_SELECTION, click("d", { range: true })).keys,
    ]).toEqual(["d"]);
  });
});

describe("externalImportWindow", () => {
  it("takes the sessions since the Previous 30 days group starts, as the groups count them", () => {
    const groups = externalGroups(NOW);
    const counts = (byGroup: Record<string, number>) =>
      groups.map((group) => byGroup[group.id] ?? 0);
    const view = externalListView({
      groups,
      requests: externalListRequests({ groups, listed: new Set(), cursors: {} }),
      results: [
        page([], {
          totalCount: 19,
          groupCounts: counts({ today: 1, yesterday: 2, week: 3, month: 4, older: 9 }),
        }),
      ],
    });
    expect(externalImportWindow(groups, view)).toEqual({
      activeFrom: groups.find((group) => group.id === "month")!.activeFrom,
      count: 10,
    });
    // Nothing to offer until the counts are in.
    expect(externalImportWindow(groups, null)).toBeNull();
  });
});

describe("externalEntryTitle", () => {
  it("names a session with no request after the folder it ran in", () => {
    expect(externalEntryTitle(entry(1, { title: null, cwd: "/work/billing-api/" }))).toBe(
      "billing-api",
    );
    expect(externalEntryTitle(entry(1, { title: "  ", cwd: null, projectRoot: "/work/web" }))).toBe(
      "web",
    );
  });
});

describe("externalOpenFailureMessage", () => {
  it("passes the server's refusal through, and nothing else", () => {
    const refusal = new AgentSessionHydrateError({ reason: "not-found", filePath: "/x.jsonl" });
    expect(externalOpenFailureMessage(Cause.fail(refusal))).toBe(refusal.message);
    const internal = new Error("database is locked");
    expect(externalOpenFailureMessage(Cause.fail(internal))).not.toBe(internal.message);
    expect(externalOpenFailureMessage(Cause.die("boom"))).not.toContain("boom");
  });
});
