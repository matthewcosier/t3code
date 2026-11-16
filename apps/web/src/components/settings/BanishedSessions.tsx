import {
  AGENT_SESSION_CATALOG_MAX_PAGE_SIZE,
  type AgentSessionBanishedEntry,
  type EnvironmentId,
} from "@t3tools/contracts";
import { ArchiveRestoreIcon, GhostIcon } from "lucide-react";
import { useEffect, useEffectEvent, useState } from "react";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { agentSessionBanished, agentSessionRestore } from "../../state/agentSessions";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { RelativeTime } from "../RelativeTime";
import {
  externalEntryKey,
  externalEntryOrigin,
  externalEntryPlace,
  externalEntryTitle,
} from "./externalSessions.logic";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const BANISHED_PAGE_SIZE = 50;

/**
 * Sessions banished from the External sessions list on this machine's server, shown below it
 * while any are banished. Restoring one puts it back in the list.
 */
export function BanishedSessions(props: {
  readonly environmentId: EnvironmentId;
  /** The revision of the catalog the list above was read from; it moves when its rows change. */
  readonly revision: number | null;
}) {
  const { environmentId } = props;
  // One read of the most the server returns; "Show more" reveals it 50 at a time, so the list
  // never empties while a larger read loads.
  const [shownCount, setShownCount] = useState(BANISHED_PAGE_SIZE);
  const query = agentSessionBanished({
    environmentId,
    input: { limit: AGENT_SESSION_CATALOG_MAX_PAGE_SIZE },
  });
  const banished = useEnvironmentQuery(query);
  // A session used again outside T3 Code comes back to the list above; reading again whenever the
  // catalog changes takes it off this one at the same time.
  const refreshBanished = useEffectEvent(() => appAtomRegistry.refresh(query));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- re-reads the banished sessions each time the catalog the list reads from changes
  useEffect(() => {
    if (props.revision !== null) refreshBanished();
  }, [props.revision]);
  const restore = useAtomCommand(agentSessionRestore, { reportFailure: false });
  const [restoring, setRestoring] = useState<ReadonlySet<string>>(() => new Set());

  const data = banished.data;
  if (data === null || data.totalCount === 0) return null;

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

  const shown = data.entries.slice(0, shownCount);
  const moreRead = data.entries.length - shown.length;
  const hidden = data.totalCount - shown.length;
  return (
    <SettingsSection
      title="Banished sessions"
      icon={<GhostIcon className="size-3.5 text-muted-foreground" />}
    >
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
          title={
            moreRead > 0
              ? `${hidden.toLocaleString()} more banished`
              : `Showing the ${shown.length} most recently active of ${data.totalCount.toLocaleString()}`
          }
          control={
            moreRead > 0 ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setShownCount((current) => current + BANISHED_PAGE_SIZE)}
              >
                Show more
              </Button>
            ) : null
          }
        />
      ) : null}
    </SettingsSection>
  );
}
