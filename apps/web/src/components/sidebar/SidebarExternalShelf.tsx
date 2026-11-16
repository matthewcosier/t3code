import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import type {
  AgentSessionBanishInput,
  AgentSessionCatalogCursor,
  AgentSessionCatalogEntry,
  EnvironmentId,
  ProjectId,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import * as Schema from "effect/Schema";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  FolderIcon,
  GhostIcon,
  RotateCwIcon,
} from "lucide-react";
import { Fragment, useEffect, useEffectEvent, useState, useSyncExternalStore } from "react";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import {
  getDocumentActivity,
  subscribeDocumentActivity,
  subscribeDocumentReturn,
} from "../../lib/documentActivity";
import { cn } from "../../lib/utils";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import {
  agentSessionBanish,
  agentSessionBanishVersion,
  agentSessionCatalog,
  agentSessionCatalogPages,
  agentSessionCatalogPagesKey,
  agentSessionHydrate,
  agentSessionRestore,
} from "../../state/agentSessions";
import { useProjects } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import { ProjectFavicon } from "../ProjectFavicon";
import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuItemDetail,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  NO_EXTERNAL_SELECTION,
  createExternalOpenGate,
  externalBanishPresets,
  externalBanishTargets,
  externalCursorsAfterAnswer,
  externalCursorsAfterShowMore,
  externalEntryKey,
  externalEntryOrigin,
  externalEntryTitle,
  externalFallbackToRemember,
  externalFocusAfterBanish,
  externalGroupFooter,
  externalGroupPageInputs,
  externalGroups,
  externalLaggingPages,
  externalOpenFailureMessage,
  externalOpenGroups,
  externalProjectIds,
  externalRefreshDue,
  externalSelectionAfterClick,
  externalSettledAnswer,
  externalShelfMoving,
  externalShelfRequests,
  externalShelfStatus,
  externalShelfView,
  externalShownOpenGroups,
  externalShownView,
  externalSucceededAnswer,
  externalSummaryInput,
  externalViewCounts,
  type ExternalGroup,
  type ExternalSelection,
  type ExternalShelfView,
} from "./externalShelf.logic";
import { RelativeTimeLabel } from "./SidebarThreadRow";

const EXTERNAL_SHELF_EXPANDED_KEY = "t3code:sidebar:external-expanded";
const documentVisible = () => getDocumentActivity().visible;
/** Groups the person opened or closed, by id; the rest follow the default. */
const EXTERNAL_GROUPS_OPEN_KEY = "t3code:sidebar:external-groups-open";
const ChosenGroups = Schema.Record(Schema.String, Schema.Boolean);
const NO_CHOSEN_GROUPS: Readonly<Record<string, boolean>> = {};
const NO_GROUP_CURSORS: Readonly<Record<string, ReadonlyArray<AgentSessionCatalogCursor>>> = {};
const NO_GROUPS: ReadonlySet<string> = new Set();

/**
 * Sessions on this server's machine that T3 Code does not hold yet, from every provider home.
 * Opening one imports it as an active thread. Hidden while the Labs setting is off.
 */
export function SidebarExternalShelf(props: {
  readonly environmentId: EnvironmentId;
  readonly scopedProjectKeys: ReadonlySet<string> | null;
  /** How many threads this server holds; a change can take sessions into or out of the shelf. */
  readonly heldThreadCount: number;
  /** Opens a thread the way a sidebar row does, closing the drawer on narrow windows. */
  readonly onOpenThread: (threadRef: ScopedThreadRef) => Promise<unknown>;
}) {
  const enabled = useEnvironmentSettings(
    props.environmentId,
    (settings) => settings.externalSessions,
  );
  const projectIds = externalProjectIds(props.environmentId, props.scopedProjectKeys);
  if (!enabled || projectIds === null) return null;
  return (
    <ExternalShelf
      environmentId={props.environmentId}
      projectIds={projectIds}
      heldThreadCount={props.heldThreadCount}
      onOpenThread={props.onOpenThread}
    />
  );
}

function ExternalShelf(props: {
  readonly environmentId: EnvironmentId;
  readonly projectIds: ReadonlyArray<ProjectId> | undefined;
  readonly heldThreadCount: number;
  readonly onOpenThread: (threadRef: ScopedThreadRef) => Promise<unknown>;
}) {
  const { environmentId, projectIds } = props;
  const projects = useProjects();
  const hydrate = useAtomCommand(agentSessionHydrate, { reportFailure: false });
  const banishSessions = useAtomCommand(agentSessionBanish, { reportFailure: false });
  const restoreSessions = useAtomCommand(agentSessionRestore, { reportFailure: false });
  const [selection, setSelection] = useState<ExternalSelection>(NO_EXTERNAL_SELECTION);
  const [expanded, setExpanded] = useLocalStorage(
    EXTERNAL_SHELF_EXPANDED_KEY,
    false,
    Schema.Boolean,
  );
  const [chosenGroups, setChosenGroups] = useLocalStorage(
    EXTERNAL_GROUPS_OPEN_KEY,
    NO_CHOSEN_GROUPS,
    ChosenGroups,
  );
  const scopeKey = JSON.stringify([environmentId, projectIds ?? null]);
  const [pages, setPages] = useState({ scopeKey, cursors: NO_GROUP_CURSORS });
  const cursors = pages.scopeKey === scopeKey && expanded ? pages.cursors : NO_GROUP_CURSORS;
  const [openGate] = useState(createExternalOpenGate);
  const [openingKey, setOpeningKey] = useState<string | null>(null);

  // The view is rebuilt each render, so it is kept against the answers, which change only when an
  // answer lands. Until every answer agrees, the rows already on screen stay.
  const [kept, setKept] = useState<{
    readonly scopeKey: string;
    readonly pagesKey: string;
    readonly results: unknown;
    readonly view: ExternalShelfView;
  } | null>(null);
  const keptView = kept?.scopeKey === scopeKey ? kept.view : null;

  const nowMinute = useNowMinute();
  const groups = externalGroups(nowMinute);
  // The summary counts every group; which groups are open depends on those counts.
  const summary = AsyncResult.getOrElse(
    useAtomValue(
      agentSessionCatalog({ environmentId, input: externalSummaryInput(projectIds, groups) }),
    ),
    () => null,
  );
  // Until a new summary answers (a new scope, or new group bounds at midnight), the counts on
  // screen stand in, so open groups stay open.
  const openGroups = externalOpenGroups(
    groups,
    summary?.groupCounts ?? externalViewCounts(groups, keptView),
    chosenGroups,
  );
  const requests = externalShelfRequests({
    projectIds,
    groups,
    listed: expanded ? openGroups : NO_GROUPS,
    cursors,
  });
  const { inputs } = requests;
  const pagesKey = agentSessionCatalogPagesKey(environmentId, inputs);
  const results = useAtomValue(agentSessionCatalogPages(pagesKey));
  // Any answer a request holds tells loading from failed; only current answers build the view.
  const answers = results.map((result) => AsyncResult.getOrElse(result, () => null));
  const settled = results.map(externalSettledAnswer);
  const fresh = externalShelfView({ groups, requests, results: settled });
  if (fresh !== null && (kept?.scopeKey !== scopeKey || kept.results !== results)) {
    setKept({ scopeKey, pagesKey, results, view: fresh });
  }
  const view = externalShownView(kept, scopeKey, fresh);
  // Groups open as the rows on screen say, so rows stay until the answers agree again; the
  // requests follow the newest counts.
  const shownOpen = externalShownOpenGroups(view, chosenGroups);
  const nextCursors = externalCursorsAfterAnswer(fresh, pages.cursors);
  if (nextCursors !== pages.cursors) setPages({ scopeKey, cursors: nextCursors });

  // A request with no answer yet is loading; one whose read failed with nothing to fall back on
  // stops the shelf until a retry.
  const loading = results.some(
    (result, index) => answers[index] === null && (result._tag === "Initial" || result.waiting),
  );
  // A failed read stops the shelf when no view can be built without it; an older answer it still
  // holds may disagree with the rest for good.
  const failed =
    !loading &&
    fresh === null &&
    results.some((result) => !result.waiting && result._tag === "Failure");
  const moving = externalShelfMoving({
    fresh,
    settled,
    loading,
    shownCurrent: kept?.pagesKey === pagesKey,
    failed,
  });
  // The group opened for the person because nothing recent has sessions stays open once seen.
  const fallbackGroup = externalFallbackToRemember(view, expanded, chosenGroups);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- remembers the group opened for the person, so a new session today does not shut it
  useEffect(() => {
    if (fallbackGroup !== null) {
      setChosenGroups((chosen) => ({ ...chosen, [fallbackGroup]: true }));
    }
  }, [fallbackGroup, setChosenGroups]);

  // Sessions change outside the app: coming back to the window, each minute the shelf is open
  // and in view, a change to the threads this server holds and a finished open all re-read what
  // the shelf shows.
  const [refreshRequests, setRefreshRequests] = useState(0);
  const visible = useSyncExternalStore(subscribeDocumentActivity, documentVisible, () => true);
  // Banishing or restoring anywhere, the archive included, changes what the shelf lists.
  const banishVersion = useAtomValue(agentSessionBanishVersion);
  const current = { nowMinute, heldThreadCount: props.heldThreadCount, banishVersion };
  const [observed, setObserved] = useState(current);
  if (
    observed.nowMinute !== nowMinute ||
    observed.heldThreadCount !== props.heldThreadCount ||
    observed.banishVersion !== banishVersion
  ) {
    if (externalRefreshDue(observed, current, { expanded, visible })) {
      setRefreshRequests((count) => count + 1);
    }
    setObserved(current);
  }
  const refreshShownPages = useEffectEvent(() => {
    // The summary goes first, so a pass it starts is the one the groups read.
    for (const input of inputs) {
      appAtomRegistry.refresh(agentSessionCatalog({ environmentId, input }));
    }
    // Every group's first page stays cached for when the group next opens on it, closed or
    // paged; marking it stale means it never brings back a session that has left the shelf.
    const shown = new Set(inputs.map((input) => JSON.stringify(input)));
    for (const group of groups) {
      const [firstPage] = externalGroupPageInputs({ projectIds, group, cursors: [] });
      if (firstPage === undefined || shown.has(JSON.stringify(firstPage))) continue;
      appAtomRegistry.refresh(agentSessionCatalog({ environmentId, input: firstPage }));
    }
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- re-reads the requests shown now each time a re-read is requested
  useEffect(() => {
    if (refreshRequests > 0) refreshShownPages();
  }, [refreshRequests]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks for a re-read when the window comes back into view
  useEffect(() => subscribeDocumentReturn(() => setRefreshRequests((count) => count + 1)), []);
  // Answers left on an older pass are re-read so the shelf can join them again.
  const laggingKey = agentSessionCatalogPagesKey(
    environmentId,
    externalLaggingPages(results.map(externalSucceededAnswer)).map((index) => inputs[index]!),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- re-reads answers that came from an older index pass than the rest
  useEffect(() => {
    const lagging = JSON.parse(laggingKey) as {
      readonly environmentId: EnvironmentId;
      readonly inputs: ReadonlyArray<Parameters<typeof agentSessionCatalog>[0]["input"]>;
    };
    for (const input of lagging.inputs) {
      appAtomRegistry.refresh(agentSessionCatalog({ environmentId: lagging.environmentId, input }));
    }
  }, [laggingKey]);

  const projectById = new Map<string, EnvironmentProject>(
    projects.flatMap((project) =>
      project.environmentId === environmentId ? [[project.id, project] as const] : [],
    ),
  );

  const openSession = async (entry: AgentSessionCatalogEntry) => {
    const result = await hydrate({
      environmentId,
      input: { providerInstanceId: entry.providerInstanceId, filePath: entry.filePath },
    });
    // An opened session leaves the shelf; a refused one may be gone from disk.
    setRefreshRequests((count) => count + 1);
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: "Could not open session",
        description: externalOpenFailureMessage(result.cause),
      });
      return;
    }
    await props.onOpenThread(scopeThreadRef(environmentId, result.value.threadId));
  };
  const open = (entry: AgentSessionCatalogEntry) => {
    const key = externalEntryKey(entry);
    if (!openGate.tryEnter(key)) return;
    setOpeningKey(key);
    // Held until the window has moved, so a second click cannot race the first to land.
    const release = () => {
      openGate.leave();
      setOpeningKey(null);
    };
    void openSession(entry).then(release, release);
  };

  const banish = async (input: AgentSessionBanishInput) => {
    const result = await banishSessions({ environmentId, input });
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: "Could not banish sessions",
        description: "They are still in the sidebar. Try again.",
      });
      return;
    }
    setSelection(NO_EXTERNAL_SELECTION);
    const { batchId, count } = result.value;
    if (count === 0) return;
    const toastId = toastManager.add({
      type: "success",
      title: count === 1 ? "Banished 1 session" : `Banished ${count.toLocaleString()} sessions`,
      description: "Restore them from the archive in Settings.",
      actionProps: {
        children: "Undo",
        onClick: () => {
          toastManager.close(toastId);
          void restoreSessions({ environmentId, input: { kind: "batch", batchId } }).then(
            (restored) => {
              if (restored._tag === "Failure") {
                toastManager.add({
                  type: "error",
                  title: "Could not undo",
                  description:
                    "The sessions are still banished. Restore them from the archive in Settings.",
                });
              }
            },
          );
        },
      },
    });
  };
  const orderedKeys = view?.entries.map(externalEntryKey) ?? [];
  const sessionRefs = (entries: ReadonlyArray<AgentSessionCatalogEntry>) =>
    entries.map(({ providerInstanceId, filePath }) => ({ providerInstanceId, filePath }));
  const banishFrom = (entry: AgentSessionCatalogEntry, fromKeyboard: boolean) => {
    const targets = externalBanishTargets(selection, view?.entries ?? [], entry);
    if (fromKeyboard) {
      // Focus moves on before the rows leave, so the next Delete carries on down the list.
      const next = externalFocusAfterBanish(
        orderedKeys,
        new Set(targets.map(externalEntryKey)),
        externalEntryKey(entry),
      );
      if (next !== null) {
        document.querySelector<HTMLElement>(`[data-sidebar-row="${CSS.escape(next)}"]`)?.focus();
      }
    }
    void banish({ kind: "sessions", sessions: sessionRefs(targets) });
  };
  const selectedEntries =
    view?.entries.filter((entry) => selection.keys.has(externalEntryKey(entry))) ?? [];

  const toggleGroup = (group: ExternalGroup) => {
    const isOpen = shownOpen.has(group.id);
    setChosenGroups((chosen) => ({ ...chosen, [group.id]: !isOpen }));
    setSelection(NO_EXTERNAL_SELECTION);
    if (isOpen) {
      // A closed group drops its extra pages, so it opens again on its first page.
      setPages({ scopeKey, cursors: { ...cursors, [group.id]: [] } });
    }
  };

  const status = externalShelfStatus({ shown: view, failed });
  const reading = view?.indexing === true || settled.some((answer) => answer?.indexing === true);

  return (
    <>
      <li className="relative mx-0.5 flex h-8 list-none items-center gap-0.5">
        <div className="min-w-0 flex-1">
          <CollapsibleSectionHeader
            data-sidebar-row="shelf:external"
            data-testid="sidebar-external-shelf-toggle"
            onClick={() => {
              // Closing drops extra pages and the selection; a closed shelf reads only its counts.
              if (expanded) {
                setPages({ scopeKey, cursors: NO_GROUP_CURSORS });
                setSelection(NO_EXTERNAL_SELECTION);
              } else setRefreshRequests((count) => count + 1);
              setExpanded(!expanded);
            }}
            expanded={expanded}
            tone="muted"
            accessory={
              <span className="inline-flex items-center gap-1.5 font-normal tabular-nums">
                {reading ? (
                  <>
                    <Spinner aria-hidden size="xs" />
                    <span className="sr-only">Reading sessions</span>
                  </>
                ) : null}
                {view?.totalCount ?? ""}
              </span>
            }
          >
            External sessions
          </CollapsibleSectionHeader>
        </div>
        {view !== null && view.totalCount + selectedEntries.length > 0 ? (
          <ExternalBanishMenu
            presets={externalBanishPresets(view)}
            selectedCount={selectedEntries.length}
            onBanishOlderThan={(months) =>
              void banish({
                kind: "olderThan",
                months,
                ...(projectIds === undefined ? {} : { projectIds }),
              })
            }
            onBanishSelected={() =>
              void banish({ kind: "sessions", sessions: sessionRefs(selectedEntries) })
            }
          />
        ) : null}
      </li>
      {expanded ? (
        <>
          {view?.groups.map((groupView) => {
            const { group } = groupView;
            const groupRow = `external-group:${group.id}`;
            const isOpen = shownOpen.has(group.id);
            const footer = isOpen
              ? externalGroupFooter({
                  group: groupView,
                  moving,
                  opening: openingKey !== null,
                  failed,
                })
              : null;
            return (
              <Fragment key={group.id}>
                <ExternalGroupHeader
                  rowId={groupRow}
                  label={group.label}
                  count={groupView.count}
                  open={isOpen}
                  onToggle={() => toggleGroup(group)}
                />
                {isOpen
                  ? groupView.entries?.map((entry) => {
                      const key = externalEntryKey(entry);
                      return (
                        <ExternalRow
                          key={key}
                          entry={entry}
                          rowKey={key}
                          parentRow={groupRow}
                          project={
                            entry.projectId === null
                              ? null
                              : (projectById.get(entry.projectId) ?? null)
                          }
                          opening={openingKey === key}
                          waiting={openingKey !== null && openingKey !== key}
                          selected={selection.keys.has(key)}
                          onActivate={(modifiers) => {
                            if (modifiers.toggle || modifiers.range) {
                              setSelection((current) =>
                                externalSelectionAfterClick(current, {
                                  key,
                                  orderedKeys,
                                  ...modifiers,
                                }),
                              );
                              return;
                            }
                            setSelection(NO_EXTERNAL_SELECTION);
                            open(entry);
                          }}
                          onBanish={(fromKeyboard) => banishFrom(entry, fromKeyboard)}
                          onClearSelection={
                            selection.keys.size > 0
                              ? () => setSelection(NO_EXTERNAL_SELECTION)
                              : null
                          }
                        />
                      );
                    })
                  : null}
                {footer === null ? null : footer.kind === "loading" ? (
                  <ExternalStatusRow>Loading</ExternalStatusRow>
                ) : (
                  <li className="list-none">
                    <button
                      type="button"
                      data-sidebar-row={`external-more:${group.id}`}
                      data-sidebar-parent={groupRow}
                      data-testid="sidebar-external-more"
                      aria-disabled={footer.busy}
                      onClick={() => {
                        if (footer.busy) return;
                        setPages({
                          scopeKey,
                          cursors: {
                            ...cursors,
                            [group.id]: externalCursorsAfterShowMore(
                              groupView,
                              cursors[group.id] ?? [],
                            ),
                          },
                        });
                      }}
                      className="flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-left text-sm text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground aria-disabled:cursor-default"
                    >
                      <ChevronDownIcon aria-hidden className="size-4 shrink-0" />
                      {footer.busy ? "Loading" : `Show ${footer.count} more`}
                    </button>
                  </li>
                )}
              </Fragment>
            );
          })}
          {status === "empty" ? (
            <li className="flex h-9 list-none items-center px-2.5 text-sm text-sidebar-muted-foreground">
              No sessions to open
            </li>
          ) : status === "reading" ? (
            <ExternalStatusRow>Reading sessions on this machine</ExternalStatusRow>
          ) : status === "loading" ? (
            <ExternalStatusRow>Loading</ExternalStatusRow>
          ) : status === "retry" ? (
            <li className="list-none">
              <button
                type="button"
                data-sidebar-row="external:retry"
                data-sidebar-parent="shelf:external"
                onClick={() => setRefreshRequests((count) => count + 1)}
                className="flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-left text-sm text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
              >
                <RotateCwIcon aria-hidden className="size-4 shrink-0" />
                Could not load sessions. Retry
              </button>
            </li>
          ) : null}
        </>
      ) : null}
    </>
  );
}

function ExternalStatusRow(props: { readonly children: string }) {
  return (
    <li
      role="status"
      className="flex h-9 list-none items-center gap-2.5 px-2.5 text-sm text-sidebar-muted-foreground"
    >
      <Spinner aria-hidden size="md" tone="muted" />
      {props.children}
    </li>
  );
}

/**
 * A group's separator: quieter than the shelf header above it, with its disclosure in the column
 * the rows' icons use and its count in the column their ages use.
 */
function ExternalGroupHeader(props: {
  readonly rowId: string;
  readonly label: string;
  readonly count: number;
  readonly open: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <li className="list-none">
      <button
        type="button"
        data-sidebar-row={props.rowId}
        data-sidebar-parent="shelf:external"
        data-testid="sidebar-external-group"
        aria-expanded={props.open}
        aria-label={`${props.label}, ${props.count.toLocaleString()} ${props.count === 1 ? "session" : "sessions"}`}
        onClick={props.onToggle}
        className="mt-1 flex h-7 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-left text-xs text-sidebar-muted-foreground hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:outline-none focus-visible:ring-inset"
      >
        <span className="flex size-4 shrink-0 items-center justify-center">
          <ChevronRightIcon
            aria-hidden
            className={cn(
              "size-3 transition-transform motion-reduce:transition-none",
              props.open && "rotate-90",
            )}
          />
        </span>
        <span className="min-w-0 flex-1 truncate">{props.label}</span>
        <span className="min-w-8 shrink-0 text-right tabular-nums">
          {props.count.toLocaleString()}
        </span>
      </button>
    </li>
  );
}

function ExternalBanishMenu(props: {
  readonly presets: ReturnType<typeof externalBanishPresets>;
  readonly selectedCount: number;
  readonly onBanishOlderThan: (months: number) => void;
  readonly onBanishSelected: () => void;
}) {
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <button
                  type="button"
                  aria-label="Banish sessions"
                  data-testid="sidebar-external-banish"
                  className="inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:outline-none focus-visible:ring-inset"
                />
              }
            />
          }
        >
          <GhostIcon aria-hidden className="size-3.5" />
        </TooltipTrigger>
        <TooltipPopup>Banish sessions</TooltipPopup>
      </Tooltip>
      <MenuPopup side="bottom" align="end">
        {props.selectedCount > 0 ? (
          <>
            <MenuItem onClick={props.onBanishSelected}>
              {props.selectedCount === 1
                ? "Banish the selected session"
                : `Banish ${props.selectedCount} selected sessions`}
            </MenuItem>
            <MenuSeparator />
          </>
        ) : null}
        <MenuGroup>
          <MenuGroupLabel>Banish sessions last active</MenuGroupLabel>
          {props.presets.map((preset) => (
            <MenuItem
              key={preset.months}
              disabled={preset.count === 0}
              onClick={() => props.onBanishOlderThan(preset.months)}
            >
              {preset.label}
              <MenuItemDetail>{preset.count.toLocaleString()}</MenuItemDetail>
            </MenuItem>
          ))}
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}

function ExternalRow(props: {
  readonly entry: AgentSessionCatalogEntry;
  readonly rowKey: string;
  /** The group separator the row sits under, for keyboard navigation. */
  readonly parentRow: string;
  readonly project: EnvironmentProject | null;
  readonly opening: boolean;
  /** Another session is opening; this one waits. */
  readonly waiting: boolean;
  readonly selected: boolean;
  /** A plain click opens; Cmd, Ctrl or Shift selects. */
  readonly onActivate: (modifiers: { readonly toggle: boolean; readonly range: boolean }) => void;
  readonly onBanish: (fromKeyboard: boolean) => void;
  readonly onClearSelection: (() => void) | null;
}) {
  const { entry } = props;
  const title = externalEntryTitle(entry);
  return (
    <li className="group/external-row relative list-none [content-visibility:auto] [contain-intrinsic-size:auto_--spacing(9)]">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              data-sidebar-row={props.rowKey}
              data-sidebar-parent={props.parentRow}
              data-testid="sidebar-external-row"
              aria-busy={props.opening || undefined}
              aria-disabled={props.waiting || undefined}
              onClick={(event) =>
                props.onActivate({
                  toggle: event.metaKey || event.ctrlKey,
                  range: event.shiftKey,
                })
              }
              onKeyDown={(event) => {
                if (event.key === "Delete" || event.key === "Backspace") {
                  event.preventDefault();
                  // A held key repeats; one press banishes once.
                  if (!event.repeat && !props.waiting && !props.opening) props.onBanish(true);
                } else if (event.key === "Escape" && props.onClearSelection !== null) {
                  event.preventDefault();
                  event.stopPropagation();
                  props.onClearSelection();
                }
              }}
              className={cn(
                "group/sidebar-row relative flex h-9 w-full cursor-pointer items-center gap-2.5 overflow-hidden rounded-md px-2.5 text-left outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring aria-disabled:cursor-default",
                props.selected
                  ? "bg-sidebar-row-selected text-sidebar-foreground light:ring-1 light:ring-inset light:ring-sidebar-border/70"
                  : "hover:bg-sidebar-row-hover",
              )}
            />
          }
        >
          <span className="flex shrink-0 items-center opacity-40 grayscale transition-opacity group-focus-within/external-row:opacity-100 group-focus-within/external-row:grayscale-0 group-hover/external-row:opacity-100 group-hover/external-row:grayscale-0">
            {props.project ? (
              <ProjectFavicon project={props.project} className="size-4" />
            ) : (
              <FolderIcon aria-hidden className="size-4 text-sidebar-muted-foreground" />
            )}
          </span>
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-start text-sm font-normal group-focus-within/external-row:text-foreground group-hover/external-row:text-foreground",
              props.selected ? "text-foreground" : "text-secondary-label/70",
            )}
          >
            {title}
          </span>
          {props.selected ? <span className="sr-only">Selected</span> : null}
          <span className="relative ml-auto flex h-6 min-w-8 shrink-0 items-center justify-end text-xs tabular-nums text-secondary-label">
            {props.opening ? (
              <>
                <Spinner aria-hidden size="sm" tone="muted" />
                <span className="sr-only">Opening</span>
              </>
            ) : (
              <span className="transition-opacity group-focus-within/external-row:opacity-0 group-any-hover/external-row:opacity-0">
                <RelativeTimeLabel timestamp={entry.lastActiveAt} />
              </span>
            )}
          </span>
        </TooltipTrigger>
        <TooltipPopup side="right" className="max-w-80">
          <span className="block font-medium break-words whitespace-normal">{title}</span>
          <span className="block break-all text-muted-foreground">
            {externalEntryOrigin(entry)}
          </span>
        </TooltipPopup>
      </Tooltip>
      {props.opening ? null : (
        <button
          type="button"
          data-testid="sidebar-external-banish-row"
          data-sidebar-action-for={props.rowKey}
          aria-label={props.selected ? "Banish the selected sessions" : `Banish ${title}`}
          disabled={props.waiting}
          onClick={() => props.onBanish(false)}
          className="absolute top-1/2 right-1.5 inline-flex size-6 -translate-y-1/2 cursor-pointer items-center justify-center rounded-md text-sidebar-muted-foreground pointer-events-none opacity-0 transition-opacity group-focus-within/external-row:pointer-events-auto group-focus-within/external-row:opacity-100 group-any-hover/external-row:pointer-events-auto group-any-hover/external-row:opacity-100 hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:outline-none focus-visible:ring-inset disabled:pointer-events-none"
        >
          <GhostIcon aria-hidden className="size-3.5" />
        </button>
      )}
    </li>
  );
}
