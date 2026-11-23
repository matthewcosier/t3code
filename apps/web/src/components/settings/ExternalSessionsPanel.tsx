import { useAtomValue } from "@effect/atom-react";
import type {
  AgentSessionBanishInput,
  AgentSessionImportExternalInput,
  AgentSessionCatalogCursor,
  AgentSessionCatalogEntry,
  AgentSessionSource,
  EnvironmentId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import * as Schema from "effect/Schema";
import { ChevronDownIcon, ChevronRightIcon, EyeIcon, GhostIcon, SearchIcon } from "lucide-react";
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
  agentSessionImportExternal,
  agentSessionPreview,
  agentSessionRestore,
} from "../../state/agentSessions";
import { useQuietThreadShells } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
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
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
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
import { Toggle, ToggleGroup } from "../ui/toggle-group";
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
  externalEntrySourceName,
  externalEntryTitle,
  externalFallbackToRemember,
  externalFilter,
  externalGroupCheck,
  externalGroupFooter,
  externalGroupPageInputs,
  externalGroups,
  externalImportWindow,
  externalIsSelected,
  externalLaggingPages,
  externalListMoving,
  externalListRequests,
  externalListStatus,
  externalListView,
  externalOpenFailureMessage,
  externalOpenGroups,
  externalRefreshDue,
  externalSelectionAfterClick,
  externalSelectionAfterGroupClick,
  externalSelectionChoice,
  externalSelectionTakesAny,
  externalSelectionWithout,
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
import { useSearchableSetting } from "./settingsSearch";

const documentVisible = () => getDocumentActivity().visible;
/** Groups the person opened or closed, by id; the rest follow the default. */
const EXTERNAL_GROUPS_OPEN_KEY = "t3code:settings:external-groups-open";
const ChosenGroups = Schema.Record(Schema.String, Schema.Boolean);
const NO_CHOSEN_GROUPS: Readonly<Record<string, boolean>> = {};
const NO_GROUP_CURSORS: Readonly<Record<string, ReadonlyArray<AgentSessionCatalogCursor>>> = {};

/** How long typing pauses before the search reaches the list. */
const SEARCH_PAUSE_MS = 300;
/** The settings page's own scroll area. */
const SETTINGS_SCROLL_SELECTOR = "[data-settings-page-scroll]";
/** Where the list was scrolled when a session was opened from it, for when the person comes back. */
const returnScroll: { top: number | null } = { top: null };
/** Remembers the page's scroll before leaving it for a thread. */
function rememberReturnScroll() {
  returnScroll.top =
    document.querySelector<HTMLElement>(SETTINGS_SCROLL_SELECTOR)?.scrollTop ?? null;
}
/** Puts the page's scroll back where it was left, once. */
function restoreReturnScroll() {
  const top = returnScroll.top;
  returnScroll.top = null;
  const container = document.querySelector<HTMLElement>(SETTINGS_SCROLL_SELECTOR);
  if (top !== null && container !== null) container.scrollTop = top;
}

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
  const searchableSetting = useSearchableSetting();
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
  const importSessions = useAtomCommand(agentSessionImportExternal, { reportFailure: false });
  const banishSessions = useAtomCommand(agentSessionBanish, { reportFailure: false });
  const restoreSessions = useAtomCommand(agentSessionRestore, { reportFailure: false });
  const [selection, setSelection] = useState<ExternalSelection>(NO_EXTERNAL_SELECTION);
  const [chosenGroups, setChosenGroups] = useLocalStorage(
    EXTERNAL_GROUPS_OPEN_KEY,
    NO_CHOSEN_GROUPS,
    ChosenGroups,
  );
  const [search, setSearch] = useState("");
  const [sources, setSources] = useState<ReadonlyArray<AgentSessionSource>>([]);
  // The list asks again once typing pauses, not on every key.
  const [askedSearch, setAskedSearch] = useState("");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- waits for a pause in typing before the search reaches the requests
  useEffect(() => {
    const timer = setTimeout(() => setAskedSearch(search), SEARCH_PAUSE_MS);
    return () => clearTimeout(timer);
  }, [search]);
  const filter = externalFilter(askedSearch, sources);
  // A new filter is a new list: its own pages, its own rows on screen and no ticks carried over.
  const scopeKey = JSON.stringify([environmentId, filter ?? null]);
  const [selectionScope, setSelectionScope] = useState(scopeKey);
  if (selectionScope !== scopeKey) {
    setSelectionScope(scopeKey);
    setSelection(NO_EXTERNAL_SELECTION);
  }
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
    useAtomValue(
      agentSessionCatalog({ environmentId, input: externalSummaryInput(groups, filter) }),
    ),
    () => null,
  );
  // Until a new summary answers (new group bounds at midnight), the counts on screen stand in, so
  // open groups stay open.
  const openGroups = externalOpenGroups(
    groups,
    summary?.groupCounts ?? externalViewCounts(groups, keptView),
    chosenGroups,
  );
  const requests = externalListRequests({ groups, listed: openGroups, cursors, filter });
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

  // Back from a session opened here, the list scrolls to where it was once its rows are on screen.
  const rowsShown = view !== null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- puts the page scroll back where it was before a session was opened from it
  useEffect(() => {
    if (rowsShown) restoreReturnScroll();
  }, [rowsShown]);

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
      const [firstPage] = externalGroupPageInputs({ group, cursors: [], filter });
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
    // Coming back to the page after the thread puts the list where it was.
    rememberReturnScroll();
    setOpeningKey(key);
    // Held until the window has moved, so a second click cannot race the first to land.
    const release = () => {
      openGate.leave();
      setOpeningKey(null);
    };
    void openSession(entry).then(release, release);
  };

  const importWindow = externalImportWindow(groups, view);
  const importNow = async (input: AgentSessionImportExternalInput, fromSelection: boolean) => {
    setImporting(true);
    const result = await importSessions({ environmentId, input });
    setImporting(false);
    // Imported sessions leave the list.
    setRefreshRequests((count) => count + 1);
    if (result._tag === "Success" && fromSelection) setSelection(NO_EXTERNAL_SELECTION);
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: "Import stopped",
        description: "Sessions still listed here were not imported. Try again.",
      });
      return;
    }
    const { importedCount, skippedCount, threadIds } = result.value;
    const where =
      importedCount === 0
        ? null
        : importedCount === 1
          ? "It is in the sidebar under Settled."
          : "They are in the sidebar under Settled.";
    const skipped =
      skippedCount === 0
        ? null
        : `${sessionCount(skippedCount)} could not be imported: gone from disk, empty, or no folder to open them in.`;
    const description = [where, skipped].filter((part) => part !== null).join(" ");
    const onlyThread = importedCount === 1 && threadIds.length === 1 ? threadIds[0] : undefined;
    const toastId = toastManager.add({
      type: importedCount === 0 && skippedCount > 0 ? "error" : "success",
      title:
        importedCount > 0
          ? `Imported ${sessionCount(importedCount)}`
          : skippedCount > 0
            ? "Could not import sessions"
            : "Nothing to import",
      ...(description === "" ? {} : { description }),
      ...(onlyThread === undefined
        ? {}
        : {
            actionProps: {
              children: "Open",
              onClick: () => {
                toastManager.close(toastId);
                rememberReturnScroll();
                void navigate({
                  to: "/$environmentId/$threadId",
                  params: { environmentId, threadId: onlyThread },
                });
              },
            },
          }),
    });
  };
  // One import or open at a time, held until it lands, so a second press cannot start another.
  const runImport = (input: AgentSessionImportExternalInput, fromSelection: boolean) => {
    setConfirmingImport(false);
    if (!openGate.tryEnter("import")) return;
    const release = () => openGate.leave();
    void importNow(input, fromSelection).then(release, release);
  };

  /** `leaving` names the rows the banish takes, to untick just them; null clears every tick. */
  const banish = async (input: AgentSessionBanishInput, leaving: ReadonlySet<string> | null) => {
    const result = await banishSessions({ environmentId, input });
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: "Could not banish sessions",
        description: "They are still listed. Try again.",
      });
      return;
    }
    setSelection((current) =>
      leaving === null ? NO_EXTERNAL_SELECTION : externalSelectionWithout(current, leaving),
    );
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
  const orderedKeys = view?.entries.map(externalEntryKey) ?? [];
  const groupOfKey = new Map(
    (view?.groups ?? []).flatMap((groupView) =>
      (groupView.entries ?? []).map(
        (entry) => [externalEntryKey(entry), groupView.group.id] as const,
      ),
    ),
  );
  const groupOf = (key: string) => groupOfKey.get(key);
  const refOfKey = new Map(
    (view?.entries ?? []).map(
      (entry) =>
        [
          externalEntryKey(entry),
          { providerInstanceId: entry.providerInstanceId, filePath: entry.filePath },
        ] as const,
    ),
  );
  const refOf = (key: string) => refOfKey.get(key);
  const choice = externalSelectionChoice(selection, view);
  const choiceInput = {
    sessions: choice.sessions,
    windows: choice.windows,
    exclude: choice.exclude,
    ...(filter === undefined ? {} : { filter }),
  };

  const toggleGroup = (group: ExternalGroup) => {
    const isOpen = shownOpen.has(group.id);
    setChosenGroups((chosen) => ({ ...chosen, [group.id]: !isOpen }));
    if (isOpen) {
      // A closed group drops its extra pages, so it opens again on its first page.
      setPages({ scopeKey, cursors: { ...cursors, [group.id]: [] } });
    }
  };

  const status = externalListStatus({ shown: view, failed });
  const reading = view?.indexing === true || settled.some((answer) => answer?.indexing === true);
  const presets = externalBanishPresets(view);
  // An import from another window holds this one's actions too, and shows how far it has got.
  const progress = summary?.importing ?? null;
  const busy = importing || openingKey !== null || progress !== null;
  const importLabel =
    progress !== null
      ? `Importing ${progress.done.toLocaleString()} of ${progress.total.toLocaleString()}`
      : importing
        ? "Importing"
        : null;

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
              {importLabel !== null ? <Spinner aria-hidden size="xs" /> : null}
              {importLabel ??
                (importWindow === null || importWindow.count === 0
                  ? "Import"
                  : `Import ${importWindow.count.toLocaleString()}`)}
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
              onBanishOlderThan={(months) =>
                void banish(
                  { kind: "olderThan", months, ...(filter === undefined ? {} : { filter }) },
                  null,
                )
              }
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
                if (importWindow !== null) {
                  runImport(
                    {
                      sessions: [],
                      windows: [{ activeFrom: importWindow.activeFrom }],
                      ...(filter === undefined ? {} : { filter }),
                    },
                    false,
                  );
                }
              }}
            >
              Import
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>

      <section aria-label="Sessions" className="flex flex-col gap-4">
        <ExternalFilterBar
          search={search}
          sources={sources}
          onSearch={setSearch}
          onSources={setSources}
        />

        {externalSelectionTakesAny(selection) ? (
          <div
            role="region"
            aria-label="Selected sessions"
            className="sticky top-2 z-10 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/60 bg-popover px-3 py-2 shadow-sm sm:px-4"
          >
            <span
              className="text-sm text-foreground"
              data-testid="external-sessions-selected-count"
            >
              {choice.count.toLocaleString()} selected
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
                data-testid="external-sessions-import-selected"
                disabled={busy}
                onClick={() => runImport(choiceInput, true)}
              >
                {importing ? <Spinner aria-hidden size="xs" /> : null}
                Import {choice.count.toLocaleString()}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid="external-sessions-banish-selected"
                disabled={busy}
                onClick={() => void banish({ kind: "sessions", ...choiceInput }, null)}
              >
                <GhostIcon aria-hidden className="size-3.5" />
                Banish {choice.count.toLocaleString()}
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
              check={externalGroupCheck(selection, group.id, view)}
              onCheck={() =>
                setSelection((current) => externalSelectionAfterGroupClick(current, group.id, view))
              }
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
                    environmentId={environmentId}
                    entry={entry}
                    opening={openingKey === key}
                    waiting={busy && openingKey !== key}
                    selected={externalIsSelected(selection, key, group.id)}
                    onSelect={(range) =>
                      setSelection((selected) =>
                        externalSelectionAfterClick(selected, {
                          key,
                          orderedKeys,
                          groupOf,
                          refOf,
                          range,
                        }),
                      )
                    }
                    onOpen={() => {
                      setSelection(NO_EXTERNAL_SELECTION);
                      open(entry);
                    }}
                    onBanish={() =>
                      void banish(
                        {
                          kind: "sessions",
                          sessions: [
                            {
                              providerInstanceId: entry.providerInstanceId,
                              filePath: entry.filePath,
                            },
                          ],
                        },
                        new Set([key]),
                      )
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
              filter === undefined ? (
                <SettingsRow
                  title="No external sessions"
                  description="Sessions you run in Claude Code, Codex or Pi outside T3 Code show up here."
                />
              ) : (
                <SettingsRow
                  data-testid="external-sessions-none-match"
                  title="No sessions match"
                  description="Try other words, or all tools."
                />
              )
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

      <BanishedSessions
        environmentId={environmentId}
        revision={summary?.revision ?? null}
        filter={filter}
      />
    </>
  );
}

/** A span of last activity: a header that opens and closes it, then its rows and "Show more". */
function ExternalGroupBlock(props: {
  readonly group: ExternalGroupView;
  readonly open: boolean;
  readonly onToggle: () => void;
  /** Whether the whole group, part of it or none of it is ticked. */
  readonly check: "all" | "some" | "none";
  readonly onCheck: () => void;
  readonly footer: ReturnType<typeof externalGroupFooter>;
  readonly onShowMore: () => void;
  readonly children: ReactNode;
}) {
  const { group, footer } = props;
  const { label } = group.group;
  return (
    <div className="space-y-2">
      <h2 className="flex items-center gap-3 px-3 sm:px-4">
        <Checkbox
          checked={props.check === "all"}
          indeterminate={props.check === "some"}
          aria-label={`Select all of ${label}`}
          data-testid="external-sessions-group-select"
          onCheckedChange={() => props.onCheck()}
        />
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
  readonly environmentId: EnvironmentId;
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
  const [previewOpen, setPreviewOpen] = useState(false);
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
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    data-testid="external-session-preview"
                    aria-label={`Preview ${title}`}
                    aria-expanded={previewOpen}
                    onClick={() => setPreviewOpen((open) => !open)}
                  />
                }
              >
                <EyeIcon aria-hidden className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup>{previewOpen ? "Hide preview" : "Preview"}</TooltipPopup>
            </Tooltip>
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
      {previewOpen ? (
        <ExternalSessionPreview environmentId={props.environmentId} entry={entry} />
      ) : null}
    </div>
  );
}

/** The start of a session's conversation, read from its transcript when the preview opens. */
function ExternalSessionPreview(props: {
  readonly environmentId: EnvironmentId;
  readonly entry: AgentSessionCatalogEntry;
}) {
  const { entry } = props;
  const preview = useEnvironmentQuery(
    agentSessionPreview({
      environmentId: props.environmentId,
      input: { providerInstanceId: entry.providerInstanceId, filePath: entry.filePath },
    }),
  );
  const agent = externalEntrySourceName(entry);
  return (
    <div
      data-testid="external-session-preview-panel"
      className="mt-3 ml-7.5 space-y-2 border-l-2 border-border/60 ps-3"
    >
      {preview.data !== null ? (
        <>
          {preview.data.messages
            .map((message, position) => ({ message, key: `${position}` }))
            .map(({ message, key }) => (
              <div key={key} className="text-xs leading-normal">
                <span className="font-medium text-foreground">
                  {message.role === "user" ? "You" : agent}
                </span>
                <p className="line-clamp-4 whitespace-pre-wrap text-muted-foreground">
                  {message.text}
                </p>
              </div>
            ))}
          {preview.data.more ? (
            <p className="text-xs text-muted-foreground">The conversation goes on from here.</p>
          ) : null}
        </>
      ) : preview.failure !== null ? (
        <p className="text-xs text-muted-foreground">
          {"message" in preview.failure && typeof preview.failure.message === "string"
            ? preview.failure.message
            : "The conversation could not be read."}
        </p>
      ) : (
        <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
          <Spinner aria-hidden size="xs" tone="muted" />
          Reading the conversation
        </p>
      )}
    </div>
  );
}

/** Search by title or folder, and which tools' sessions to show. */
function ExternalFilterBar(props: {
  readonly search: string;
  readonly sources: ReadonlyArray<AgentSessionSource>;
  readonly onSearch: (search: string) => void;
  readonly onSources: (sources: ReadonlyArray<AgentSessionSource>) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 px-3 sm:px-4">
      <InputGroup className="min-w-48 flex-1">
        <InputGroupAddon>
          <SearchIcon aria-hidden className="size-3.5 text-muted-foreground" />
        </InputGroupAddon>
        <InputGroupInput
          type="search"
          size="sm"
          value={props.search}
          onChange={(event) => props.onSearch(event.target.value)}
          placeholder="Search titles and folders"
          aria-label="Search external sessions"
          data-testid="external-sessions-search"
          spellCheck={false}
          autoComplete="off"
        />
      </InputGroup>
      <ToggleGroup
        aria-label="Tools"
        variant="segmented"
        value={[props.sources[0] ?? "all"]}
        onValueChange={(next) => {
          const value = next[0];
          props.onSources(
            value === "claudeAgent" || value === "codex" || value === "pi" ? [value] : [],
          );
        }}
      >
        <Toggle value="all">All</Toggle>
        <Toggle value="claudeAgent">Claude Code</Toggle>
        <Toggle value="codex">Codex</Toggle>
        <Toggle value="pi">Pi</Toggle>
      </ToggleGroup>
    </div>
  );
}
