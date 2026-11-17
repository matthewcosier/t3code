import { useAtomValue } from "@effect/atom-react";
import {
  AGENT_SESSION_CATALOG_MAX_PAGE_SIZE,
  type AgentSessionBanishedEntry,
  type AgentSessionBanishedInput,
  type AgentSessionCatalogCursor,
  type AgentSessionFilter,
  type EnvironmentId,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { ArchiveRestoreIcon, GhostIcon } from "lucide-react";
import { useEffect, useEffectEvent, useState } from "react";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import {
  agentSessionBanished,
  agentSessionBanishedPages,
  agentSessionBanishedPagesKey,
  agentSessionRestore,
} from "../../state/agentSessions";
import { useAtomCommand } from "../../state/use-atom-command";
import { RelativeTime } from "../RelativeTime";
import {
  externalBanishedCursors,
  externalEntryKey,
  externalEntryOrigin,
  externalEntryPlace,
  externalEntryTitle,
  externalSameCursors,
} from "./externalSessions.logic";
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
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsRow, SettingsSection } from "./settingsLayout";

/** How many more rows "Show more" reveals; pages of the server's largest size are read behind it. */
const BANISHED_PAGE_SIZE = 50;
const NO_CURSORS: ReadonlyArray<AgentSessionCatalogCursor> = [];

/** The pages of banished sessions to read: the first, then one after each cursor, under the filter. */
function banishedPageInputs(
  cursors: ReadonlyArray<AgentSessionCatalogCursor>,
  filter: AgentSessionFilter | undefined,
): ReadonlyArray<AgentSessionBanishedInput> {
  const scope = {
    limit: AGENT_SESSION_CATALOG_MAX_PAGE_SIZE,
    ...(filter === undefined ? {} : { filter }),
  };
  return [scope, ...cursors.map((before) => ({ ...scope, before }))];
}

/**
 * Sessions banished from the External sessions list on this machine's server, shown below it
 * while any are banished. Restoring one puts it back in the list.
 */
export function BanishedSessions(props: {
  readonly environmentId: EnvironmentId;
  /** The revision of the catalog the list above was read from; it moves when its rows change. */
  readonly revision: number | null;
  /** The list's filter: the banished sessions shown are the ones it matches. */
  readonly filter: AgentSessionFilter | undefined;
}) {
  const { environmentId, filter } = props;
  // Pages of the most the server returns; "Show more" reveals them 50 at a time and the next page is
  // read once the ones read run out, so the list never empties while a page loads.
  const filterKey = JSON.stringify(filter ?? null);
  const [paging, setPaging] = useState({
    filterKey,
    cursors: NO_CURSORS,
    shown: BANISHED_PAGE_SIZE,
  });
  const current =
    paging.filterKey === filterKey
      ? paging
      : { filterKey, cursors: NO_CURSORS, shown: BANISHED_PAGE_SIZE };
  const inputs = banishedPageInputs(current.cursors, filter);
  const results = useAtomValue(
    agentSessionBanishedPages(agentSessionBanishedPagesKey(environmentId, inputs)),
  );
  const answers = results.map((result) => AsyncResult.getOrElse(result, () => null));
  // Each page starts right after the row the page before it now ends on: a session banished or
  // restored while pages are open moves every boundary, and the pages after it are read again.
  const settled = answers.every((answer) => answer !== null) ? answers : null;
  const wanted =
    settled === null
      ? current.cursors
      : externalBanishedCursors({
          answers: settled,
          cursors: current.cursors,
          shown: current.shown,
        });
  if (!externalSameCursors(wanted, current.cursors)) {
    setPaging({ filterKey, shown: current.shown, cursors: wanted });
  }
  // A session used again outside T3 Code comes back to the list above; reading again whenever the
  // catalog changes takes it off this one at the same time.
  const refreshBanished = useEffectEvent(() => {
    for (const input of inputs) {
      appAtomRegistry.refresh(agentSessionBanished({ environmentId, input }));
    }
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- re-reads the banished sessions each time the catalog the list reads from changes
  useEffect(() => {
    if (props.revision !== null) refreshBanished();
  }, [props.revision]);
  const restore = useAtomCommand(agentSessionRestore, { reportFailure: false });
  const [restoring, setRestoring] = useState<ReadonlySet<string>>(() => new Set());
  const [confirmingRestoreAll, setConfirmingRestoreAll] = useState(false);
  const [restoringAll, setRestoringAll] = useState(false);

  const first = answers[0] ?? null;
  if (first === null || first.totalCount === 0) return null;
  const totalCount = first.totalCount;
  // Pages read so far, in order, up to the first that has not answered yet.
  const loaded: Array<AgentSessionBanishedEntry> = [];
  for (const answer of answers) {
    if (answer === null) break;
    loaded.push(...answer.entries);
  }

  const restoreAll = async () => {
    setConfirmingRestoreAll(false);
    setRestoringAll(true);
    const result = await restore({
      environmentId,
      input: { kind: "banished", ...(filter === undefined ? {} : { filter }) },
    });
    setRestoringAll(false);
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: "Could not restore sessions",
        description: "They are still banished. Try again.",
      });
      return;
    }
    toastManager.add({
      type: "success",
      title:
        result.value.count === 1
          ? "Restored 1 session"
          : `Restored ${result.value.count.toLocaleString()} sessions`,
    });
  };

  const restoreOne = async (entry: AgentSessionBanishedEntry) => {
    const key = externalEntryKey(entry);
    if (restoring.has(key)) return;
    setRestoring((current) => new Set(current).add(key));
    const result = await restore({
      environmentId,
      input: {
        kind: "sessions",
        sessions: [{ providerInstanceId: entry.providerInstanceId, filePath: entry.filePath }],
      },
    });
    setRestoring((current) => {
      const next = new Set(current);
      next.delete(key);
      return next;
    });
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: "Could not restore session",
        description: "It is still banished. Try again.",
      });
    }
  };

  const shown = loaded.slice(0, current.shown);
  const hidden = totalCount - shown.length;
  const showMore = () =>
    setPaging({ filterKey, cursors: current.cursors, shown: current.shown + BANISHED_PAGE_SIZE });
  return (
    <SettingsSection
      title="Banished sessions"
      icon={<GhostIcon className="size-3.5 text-muted-foreground" />}
      headerAction={
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="banished-restore-all"
          disabled={restoringAll}
          onClick={() => setConfirmingRestoreAll(true)}
        >
          Restore all
        </Button>
      }
    >
      <AlertDialog open={confirmingRestoreAll} onOpenChange={setConfirmingRestoreAll}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Restore {totalCount === 1 ? "1 session" : `${totalCount.toLocaleString()} sessions`}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {filter === undefined
                ? "Every banished session goes back to the list above."
                : "Every banished session that matches the search goes back to the list above."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button data-testid="banished-restore-all-confirm" onClick={() => void restoreAll()}>
              Restore all
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
      {shown.map((entry) => {
        const title = externalEntryTitle(entry);
        return (
          <SettingsRow
            key={externalEntryKey(entry)}
            title={title}
            description={
              <span className="block truncate">
                <Tooltip>
                  <TooltipTrigger render={<span />}>{externalEntryPlace(entry)}</TooltipTrigger>
                  <TooltipPopup>{externalEntryOrigin(entry)}</TooltipPopup>
                </Tooltip>
                , last active <RelativeTime timestamp={entry.lastActiveAt} />, banished{" "}
                <RelativeTime timestamp={entry.banishedAt} />
              </span>
            }
            control={
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      variant="outline"
                      size="icon-sm"
                      aria-label={`Restore ${title}`}
                      data-testid="banished-session-restore"
                      disabled={restoring.has(externalEntryKey(entry))}
                      onClick={() => void restoreOne(entry)}
                    />
                  }
                >
                  <ArchiveRestoreIcon className="size-3.5" />
                </TooltipTrigger>
                <TooltipPopup>Restore</TooltipPopup>
              </Tooltip>
            }
          />
        );
      })}
      {hidden > 0 ? (
        <SettingsRow
          title={`${hidden.toLocaleString()} more banished`}
          control={
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="banished-show-more"
              disabled={answers.some((answer) => answer === null)}
              onClick={showMore}
            >
              Show more
            </Button>
          }
        />
      ) : null}
    </SettingsSection>
  );
}
