import { useAtomValue } from "@effect/atom-react";
import type {
  AgentSessionBanishInput,
  AgentSessionCatalogCursor,
  AgentSessionCatalogEntry,
  EnvironmentId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import * as Schema from "effect/Schema";
import { ChevronDownIcon, ChevronRightIcon, GhostIcon } from "lucide-react";
import { useEffect, useEffectEvent, useState, useSyncExternalStore, type ReactNode } from "react";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
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
  agentSessionImportRecent,
  agentSessionRestore,
} from "../../state/agentSessions";
import { useQuietThreadShells } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { RelativeTime } from "../RelativeTime";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuItemDetail,
  MenuPopup,
  MenuTrigger,
} from "../ui/menu";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { BanishedSessions } from "./BanishedSessions";
import {
  NO_EXTERNAL_SELECTION,
  createExternalOpenGate,
  externalBanishPresets,
  externalCursorsAfterAnswer,
  externalCursorsAfterShowMore,
  externalEntryKey,
  externalEntryOrigin,
  externalEntryPlace,
  externalEntryTitle,
  externalFallbackToRemember,
  externalGroupFooter,
  externalGroupPageInputs,
  externalGroups,
  externalImportWindow,
  externalLaggingPages,
  externalListMoving,
  externalListRequests,
  externalListStatus,
  externalListView,
  externalOpenFailureMessage,
  externalOpenGroups,
  externalRefreshDue,
  externalSelectionAfterClick,
  externalSettledAnswer,
  externalShownOpenGroups,
  externalShownView,
  externalSucceededAnswer,
  externalSummaryInput,
  externalViewCounts,
  type ExternalGroup,
  type ExternalGroupView,
  type ExternalListView,
  type ExternalSelection,
} from "./externalSessions.logic";
import { SettingsGroup } from "./SettingsGroup";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const documentVisible = () => getDocumentActivity().visible;
/** Groups the person opened or closed, by id; the rest follow the default. */
const EXTERNAL_GROUPS_OPEN_KEY = "t3code:settings:external-groups-open";
const ChosenGroups = Schema.Record(Schema.String, Schema.Boolean);
const NO_CHOSEN_GROUPS: Readonly<Record<string, boolean>> = {};
const NO_GROUP_CURSORS: Readonly<Record<string, ReadonlyArray<AgentSessionCatalogCursor>>> = {};

const sessionCount = (count: number) =>
  count === 1 ? "1 session" : `${count.toLocaleString()} sessions`;

/**
 * Sessions run outside T3 Code on this machine: listed by when they were last active, opened as
 * threads one at a time or the last 30 days at once, or banished out of the way.
 */
export function ExternalSessionsPanel() {
  const environmentId = usePrimaryEnvironmentId();
  return (
    <SettingsPageContainer>
      {environmentId === null ? (
        <SettingsSection title="External sessions">
          <SettingsRow
            title="External sessions"
            description="Sessions are read on the machine T3 Code runs on. Open this page in the desktop app or from the server's own address."
          />
        </SettingsSection>
      ) : (
        <ExternalSessions environmentId={environmentId} />
      )}
    </SettingsPageContainer>
  );
}

function ExternalSessions(props: { readonly environmentId: EnvironmentId }) {
  const { environmentId } = props;
  const enabled = useEnvironmentSettings(environmentId, (settings) => settings.externalSessions);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const showRow = (
    <SettingsRow
      {...searchableSetting("external-sessions")}
      description="List the Claude Code, Codex and Pi sessions run outside T3 Code on this machine, so you can carry them on here. Nothing is read until this is on."
      control={
        <Switch
          checked={enabled}
          onCheckedChange={(checked) => updateSettings({ externalSessions: Boolean(checked) })}
          aria-label="Show external sessions"
          data-testid="external-sessions-enable"
        />
      }
    />
  );
  if (!enabled) {
    return <SettingsSection title="External sessions">{showRow}</SettingsSection>;
  }
  return <ExternalSessionList environmentId={environmentId} showRow={showRow} />;
}

function ExternalSessionList(props: {
  readonly environmentId: EnvironmentId;
  readonly showRow: ReactNode;
}) {
  const { environmentId } = props;
  const navigate = useNavigate();
  const hydrate = useAtomCommand(agentSessionHydrate, { reportFailure: false });
  const importRecent = useAtomCommand(agentSessionImportRecent, { reportFailure: false });
  const banishSessions = useAtomCommand(agentSessionBanish, { reportFailure: false });
  const restoreSessions = useAtomCommand(agentSessionRestore, { reportFailure: false });
  const [selection, setSelection] = useState<ExternalSelection>(NO_EXTERNAL_SELECTION);
  const [chosenGroups, setChosenGroups] = useLocalStorage(
    EXTERNAL_GROUPS_OPEN_KEY,
    NO_CHOSEN_GROUPS,
    ChosenGroups,
  );
  const scopeKey = environmentId;
  const [pages, setPages] = useState({ scopeKey, cursors: NO_GROUP_CURSORS });
  const cursors = pages.scopeKey === scopeKey ? pages.cursors : NO_GROUP_CURSORS;
  const [openGate] = useState(createExternalOpenGate);
  const [openingKey, setOpeningKey] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [confirmingImport, setConfirmingImport] = useState(false);

  // The view is rebuilt each render, so it is kept against the answers, which change only when an
  // answer lands. Until every answer agrees, the rows already on screen stay.
  const [kept, setKept] = useState<{
    readonly scopeKey: string;
    readonly pagesKey: string;
    readonly results: unknown;
    readonly view: ExternalListView;
  } | null>(null);
  const keptView = kept?.scopeKey === scopeKey ? kept.view : null;

  const nowMinute = useNowMinute();
  const groups = externalGroups(nowMinute);
  // The summary counts every group; which groups are open depends on those counts.
  const summary = AsyncResult.getOrElse(
    useAtomValue(agentSessionCatalog({ environmentId, input: externalSummaryInput(groups) })),
    () => null,
  );
  // Until a new summary answers (new group bounds at midnight), the counts on screen stand in, so
  // open groups stay open.
  const openGroups = externalOpenGroups(
    groups,
    summary?.groupCounts ?? externalViewCounts(groups, keptView),
    chosenGroups,
  );
  const requests = externalListRequests({ groups, listed: openGroups, cursors });
  const { inputs } = requests;
  const pagesKey = agentSessionCatalogPagesKey(environmentId, inputs);
  const results = useAtomValue(agentSessionCatalogPages(pagesKey));
  // Any answer a request holds tells loading from failed; only current answers build the view.
  const answers = results.map((result) => AsyncResult.getOrElse(result, () => null));
  const settled = results.map(externalSettledAnswer);
  const fresh = externalListView({ groups, requests, results: settled });
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
  // stops the list until a retry.
  const loading = results.some(
    (result, index) => answers[index] === null && (result._tag === "Initial" || result.waiting),
  );
  // A failed read stops the list when no view can be built without it; an older answer it still
  // holds may disagree with the rest for good.
  const failed =
    !loading &&
    fresh === null &&
    results.some((result) => !result.waiting && result._tag === "Failure");
  const moving = externalListMoving({
    fresh,
    settled,
    loading,
    shownCurrent: kept?.pagesKey === pagesKey,
    failed,
  });
  // The group opened for the person because nothing recent has sessions stays open once seen.
  const fallbackGroup = externalFallbackToRemember(view, chosenGroups);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- remembers the group opened for the person, so a new session today does not shut it
  useEffect(() => {
    if (fallbackGroup !== null) {
      setChosenGroups((chosen) => ({ ...chosen, [fallbackGroup]: true }));
    }
  }, [fallbackGroup, setChosenGroups]);

  // Sessions change outside the app: coming back to the window, each minute the page is in view,
  // a change to the threads this server holds and a finished open or import all re-read what the
  // list shows.
  const [refreshRequests, setRefreshRequests] = useState(0);
  const visible = useSyncExternalStore(subscribeDocumentActivity, documentVisible, () => true);
  const threads = useQuietThreadShells();
  const heldThreadCount = threads.reduce(
    (count, thread) => (thread.environmentId === environmentId ? count + 1 : count),
    0,
  );
  // Banishing or restoring, here or in another window, changes what the list shows.
  const banishVersion = useAtomValue(agentSessionBanishVersion);
  const current = { nowMinute, heldThreadCount, banishVersion };
  const [observed, setObserved] = useState(current);
  if (
    observed.nowMinute !== nowMinute ||
    observed.heldThreadCount !== heldThreadCount ||
    observed.banishVersion !== banishVersion
  ) {
    if (externalRefreshDue(observed, current, visible)) {
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
    // paged; marking it stale means it never brings back a session that has left the list.
    const shown = new Set(inputs.map((input) => JSON.stringify(input)));
    for (const group of groups) {
      const [firstPage] = externalGroupPageInputs({ group, cursors: [] });
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
  // Answers left on an older pass are re-read so the list can join them again.
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

  const openSession = async (entry: AgentSessionCatalogEntry) => {
    const result = await hydrate({
      environmentId,
      input: { providerInstanceId: entry.providerInstanceId, filePath: entry.filePath },
    });
    // An opened session leaves the list; a refused one may be gone from disk.
    setRefreshRequests((count) => count + 1);
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: "Could not open session",
        description: externalOpenFailureMessage(result.cause),
      });
      return;
    }
    await navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId: result.value.threadId },
    });
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

  const importWindow = externalImportWindow(groups, view);
  const runImport = async (activeFrom: string) => {
    setConfirmingImport(false);
    setImporting(true);
    const result = await importRecent({ environmentId, input: { activeFrom } });
    setImporting(false);
    // Imported sessions leave the list.
    setRefreshRequests((count) => count + 1);
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: "Import stopped",
        description: "Sessions still listed here were not imported. Try again.",
      });
      return;
    }
    const { importedCount, skippedCount } = result.value;
    toastManager.add({
      type: importedCount === 0 && skippedCount > 0 ? "error" : "success",
      title:
        importedCount > 0
          ? `Imported ${sessionCount(importedCount)}`
          : skippedCount > 0
            ? "Could not import sessions"
            : "Nothing to import",
      ...(skippedCount > 0
        ? {
            description: `${sessionCount(skippedCount)} could not be imported: gone from disk, or no folder to open them in.`,
          }
        : {}),
    });
  };

  const banish = async (input: AgentSessionBanishInput) => {
    const result = await banishSessions({ environmentId, input });
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: "Could not banish sessions",
        description: "They are still listed. Try again.",
      });
      return;
    }
    setSelection(NO_EXTERNAL_SELECTION);
    const { batchId, count } = result.value;
    if (count === 0) return;
    const toastId = toastManager.add({
      type: "success",
      title: `Banished ${sessionCount(count)}`,
      description:
        count === 1
          ? "Restore it from Banished sessions at the bottom of this page."
          : "Restore them from Banished sessions at the bottom of this page.",
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
                    "The sessions are still banished. Restore them from Banished sessions.",
                });
              }
            },
          );
        },
      },
    });
  };
  const sessionRefs = (entries: ReadonlyArray<AgentSessionCatalogEntry>) =>
    entries.map(({ providerInstanceId, filePath }) => ({ providerInstanceId, filePath }));
  const orderedKeys = view?.entries.map(externalEntryKey) ?? [];
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

  const status = externalListStatus({ shown: view, failed });
  const reading = view?.indexing === true || settled.some((answer) => answer?.indexing === true);
  const presets = externalBanishPresets(view);
  const busy = importing || openingKey !== null;

  return (
    <>
      <SettingsSection
        title="External sessions"
        headerAction={
          reading ? (
            <span role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
              <Spinner aria-hidden size="xs" tone="muted" />
              Reading sessions
            </span>
          ) : null
        }
      >
        {props.showRow}
        <SettingsRow
          title="Import the last 30 days"
          description="Make every session below that was last active in the last 30 days a thread in its project. Folders without a project get one."
          control={
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="external-sessions-import"
              disabled={busy || importWindow === null || importWindow.count === 0}
              onClick={() => setConfirmingImport(true)}
            >
              {importing ? <Spinner aria-hidden size="xs" /> : null}
              {importing
                ? "Importing"
                : importWindow === null || importWindow.count === 0
                  ? "Import"
                  : `Import ${importWindow.count.toLocaleString()}`}
            </Button>
          }
        />
        <SettingsRow
          title="Banish old sessions"
          description="Move every session last active before a cutoff to Banished sessions, below. A banished session comes back by itself if it is used again."
          control={
            <BanishMenu
              presets={presets}
              disabled={busy || presets.every((preset) => preset.count === 0)}
              onBanishOlderThan={(months) => void banish({ kind: "olderThan", months })}
            />
          }
        />
      </SettingsSection>

      <AlertDialog open={confirmingImport} onOpenChange={setConfirmingImport}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Import {sessionCount(importWindow?.count ?? 0)}?</AlertDialogTitle>
            <AlertDialogDescription>
              Each becomes a thread in its project and leaves this list. Folders without a project
              get one.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              data-testid="external-sessions-import-confirm"
              onClick={() => {
                if (importWindow !== null) void runImport(importWindow.activeFrom);
              }}
            >
              Import
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>

      <section aria-label="Sessions" className="flex flex-col gap-4">
        {selectedEntries.length > 0 ? (
          <div
            role="region"
            aria-label="Selected sessions"
            className="sticky top-2 z-10 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/60 bg-popover px-3 py-2 shadow-sm sm:px-4"
          >
            <span className="text-sm text-foreground">
              {selectedEntries.length.toLocaleString()} selected
            </span>
            <span className="flex items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setSelection(NO_EXTERNAL_SELECTION)}
              >
                Clear
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid="external-sessions-banish-selected"
                disabled={busy}
                onClick={() =>
                  void banish({ kind: "sessions", sessions: sessionRefs(selectedEntries) })
                }
              >
                <GhostIcon aria-hidden className="size-3.5" />
                Banish {selectedEntries.length.toLocaleString()}
              </Button>
            </span>
          </div>
        ) : null}

        {view?.groups.map((groupView) => {
          const { group } = groupView;
          const isOpen = shownOpen.has(group.id);
          return (
            <ExternalGroupBlock
              key={group.id}
              group={groupView}
              open={isOpen}
              onToggle={() => toggleGroup(group)}
              footer={
                isOpen
                  ? externalGroupFooter({
                      group: groupView,
                      moving,
                      opening: openingKey !== null,
                      failed,
                    })
                  : null
              }
              onShowMore={() =>
                setPages({
                  scopeKey,
                  cursors: {
                    ...cursors,
                    [group.id]: externalCursorsAfterShowMore(groupView, cursors[group.id] ?? []),
                  },
                })
              }
            >
              {groupView.entries?.map((entry) => {
                const key = externalEntryKey(entry);
                return (
                  <ExternalSessionRow
                    key={key}
                    entry={entry}
                    opening={openingKey === key}
                    waiting={busy && openingKey !== key}
                    selected={selection.keys.has(key)}
                    onSelect={(range) =>
                      setSelection((selected) =>
                        externalSelectionAfterClick(selected, { key, orderedKeys, range }),
                      )
                    }
                    onOpen={() => {
                      setSelection(NO_EXTERNAL_SELECTION);
                      open(entry);
                    }}
                    onBanish={() =>
                      void banish({ kind: "sessions", sessions: sessionRefs([entry]) })
                    }
                  />
                );
              })}
            </ExternalGroupBlock>
          );
        })}

        {status === null ? null : (
          <SettingsGroup>
            {status === "retry" ? (
              <SettingsRow
                title="Could not load sessions"
                description="Reading the sessions on this machine failed."
                control={
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setRefreshRequests((count) => count + 1)}
                  >
                    Retry
                  </Button>
                }
              />
            ) : status === "empty" ? (
              <SettingsRow
                title="No external sessions"
                description="Sessions you run in Claude Code, Codex or Pi outside T3 Code show up here."
              />
            ) : (
              <SettingsRow
                role="status"
                title={
                  <span className="inline-flex items-center gap-2">
                    <Spinner aria-hidden size="sm" tone="muted" />
                    {status === "reading" ? "Reading sessions on this machine" : "Loading"}
                  </span>
                }
              />
            )}
          </SettingsGroup>
        )}
      </section>

      <BanishedSessions environmentId={environmentId} revision={summary?.revision ?? null} />
    </>
  );
}

/** A span of last activity: a header that opens and closes it, then its rows and "Show more". */
function ExternalGroupBlock(props: {
  readonly group: ExternalGroupView;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly footer: ReturnType<typeof externalGroupFooter>;
  readonly onShowMore: () => void;
  readonly children: ReactNode;
}) {
  const { group, footer } = props;
  const { label } = group.group;
  return (
    <div className="space-y-2">
      <h2 className="px-3 sm:px-4">
        <button
          type="button"
          data-testid="external-sessions-group"
          aria-expanded={props.open}
          aria-label={`${label}, ${sessionCount(group.count)}`}
          onClick={props.onToggle}
          className="flex min-h-7 w-full cursor-pointer items-center gap-2 rounded-md text-left text-sm text-foreground/70 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <ChevronRightIcon
            aria-hidden
            className={cn(
              "size-4 shrink-0 transition-transform duration-150 motion-reduce:transition-none",
              props.open && "rotate-90",
            )}
          />
          <span className="font-medium text-foreground">{label}</span>
          <span className="tabular-nums text-muted-foreground">{group.count.toLocaleString()}</span>
        </button>
      </h2>
      {props.open ? (
        <SettingsGroup>
          {props.children}
          {footer === null ? null : footer.kind === "loading" ? (
            <SettingsRow
              role="status"
              title={
                <span className="inline-flex items-center gap-2">
                  <Spinner aria-hidden size="sm" tone="muted" />
                  Loading
                </span>
              }
            />
          ) : (
            <div data-slot="settings-row" className="px-3 py-2 sm:px-4">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                data-testid="external-sessions-more"
                aria-disabled={footer.busy}
                onClick={() => {
                  if (!footer.busy) props.onShowMore();
                }}
              >
                <ChevronDownIcon aria-hidden className="size-4" />
                {footer.busy ? "Loading" : `Show ${footer.count.toLocaleString()} more`}
              </Button>
            </div>
          )}
        </SettingsGroup>
      ) : null}
    </div>
  );
}

function BanishMenu(props: {
  readonly presets: ReturnType<typeof externalBanishPresets>;
  readonly disabled: boolean;
  readonly onBanishOlderThan: (months: number) => void;
}) {
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="external-sessions-banish"
            disabled={props.disabled}
          />
        }
      >
        <GhostIcon aria-hidden className="size-3.5" />
        Banish
        <ChevronDownIcon aria-hidden className="size-3.5 opacity-64" />
      </MenuTrigger>
      <MenuPopup side="bottom" align="end">
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

/** One session, laid out as a settings row with a checkbox in front for banishing several. */
function ExternalSessionRow(props: {
  readonly entry: AgentSessionCatalogEntry;
  readonly opening: boolean;
  /** Something else is opening or importing; this row waits. */
  readonly waiting: boolean;
  readonly selected: boolean;
  /** `range` is true for a Shift-click, which selects every row from the last one picked. */
  readonly onSelect: (range: boolean) => void;
  readonly onOpen: () => void;
  readonly onBanish: () => void;
}) {
  const { entry } = props;
  const title = externalEntryTitle(entry);
  return (
    <div
      data-slot="settings-row"
      data-testid="external-session-row"
      aria-busy={props.opening || undefined}
      className="@container/settings-row rounded-xl px-3 py-3 [contain-intrinsic-size:auto_--spacing(16)] [content-visibility:auto] sm:px-4"
    >
      <div className="flex items-start gap-3 @min-[32rem]/settings-row:items-center">
        <Checkbox
          checked={props.selected}
          aria-label={`Select ${title}`}
          className="mt-0.5 @min-[32rem]/settings-row:mt-0"
          onCheckedChange={(_checked, details) =>
            props.onSelect(
              (details.event instanceof MouseEvent || details.event instanceof KeyboardEvent) &&
                details.event.shiftKey,
            )
          }
        />
        <div className="flex min-w-0 flex-1 flex-col gap-3 @min-[32rem]/settings-row:flex-row @min-[32rem]/settings-row:items-center @min-[32rem]/settings-row:gap-8">
          <div className="min-w-0 flex-1 space-y-1">
            <Tooltip>
              <TooltipTrigger
                render={<h3 className="truncate text-sm font-medium text-foreground" />}
              >
                {title}
              </TooltipTrigger>
              <TooltipPopup side="top" className="max-w-96">
                <span className="block font-medium break-words whitespace-normal">{title}</span>
                <span className="block break-all text-muted-foreground">
                  {externalEntryOrigin(entry)}
                </span>
              </TooltipPopup>
            </Tooltip>
            <p className="truncate text-xs leading-normal text-muted-foreground">
              {externalEntryPlace(entry)}, last active{" "}
              <RelativeTime timestamp={entry.lastActiveAt} />
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="external-session-open"
              aria-label={`Open ${title}`}
              disabled={props.waiting}
              onClick={() => {
                if (!props.opening) props.onOpen();
              }}
            >
              {props.opening ? <Spinner aria-hidden size="xs" /> : null}
              {props.opening ? "Opening" : "Open"}
            </Button>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="outline"
                    size="icon-sm"
                    data-testid="external-session-banish"
                    aria-label={`Banish ${title}`}
                    disabled={props.waiting || props.opening}
                    onClick={props.onBanish}
                  />
                }
              >
                <GhostIcon aria-hidden className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup>Banish</TooltipPopup>
            </Tooltip>
          </div>
        </div>
      </div>
    </div>
  );
}
