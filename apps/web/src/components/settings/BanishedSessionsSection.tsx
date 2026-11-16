import {
  AGENT_SESSION_CATALOG_MAX_PAGE_SIZE,
  ProjectId,
  type AgentSessionBanishedEntry,
  type EnvironmentId,
} from "@t3tools/contracts";
import { ArchiveRestoreIcon, GhostIcon } from "lucide-react";
import { useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { agentSessionBanished, agentSessionRestore } from "../../state/agentSessions";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { RelativeTime } from "../RelativeTime";
import {
  externalEntryKey,
  externalEntryOrigin,
  externalEntryPlace,
  externalEntryTitle,
} from "../sidebar/externalShelf.logic";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const BANISHED_PAGE_SIZE = 50;

/**
 * Sessions banished from the External shelf, on this machine's server. Shown while external
 * sessions are on and something is banished; restoring one puts it back in the sidebar.
 */
export function BanishedSessionsSection() {
  const environmentId = usePrimaryEnvironmentId();
  return environmentId === null ? null : <BanishedSessions environmentId={environmentId} />;
}

function BanishedSessions(props: { readonly environmentId: EnvironmentId }) {
  const { environmentId } = props;
  const { scope } = useSettingsScope();
  const enabled = useEnvironmentSettings(environmentId, (settings) => settings.externalSessions);
  // The archive follows the settings scope: a project scope shows only its projects' sessions.
  const projectIds =
    scope.kind === "project" || scope.kind === "checkout"
      ? scope.members.flatMap((member) =>
          member.environmentId === environmentId ? [ProjectId.make(member.id)] : [],
        )
      : undefined;
  const inScope =
    projectIds === undefined ? scope.environmentIds.includes(environmentId) : projectIds.length > 0;
  // One read of the most the server returns; "Show more" reveals it 50 at a time, so the list
  // never empties while a larger read loads.
  const [shownCount, setShownCount] = useState(BANISHED_PAGE_SIZE);
  const banished = useEnvironmentQuery(
    enabled && inScope
      ? agentSessionBanished({
          environmentId,
          input: {
            limit: AGENT_SESSION_CATALOG_MAX_PAGE_SIZE,
            ...(projectIds === undefined ? {} : { projectIds }),
          },
        })
      : null,
  );
  const restore = useAtomCommand(agentSessionRestore, { reportFailure: false });
  const [restoring, setRestoring] = useState<ReadonlySet<string>>(() => new Set());

  const data = banished.data;
  if (!enabled || !inScope || data === null || data.totalCount === 0) return null;

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
                Last active <RelativeTime timestamp={entry.lastActiveAt} />, banished{" "}
                <RelativeTime timestamp={entry.banishedAt} />.{" "}
                <Tooltip>
                  <TooltipTrigger render={<span />}>{externalEntryPlace(entry)}</TooltipTrigger>
                  <TooltipPopup>{externalEntryOrigin(entry)}</TooltipPopup>
                </Tooltip>
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
                      aria-label={`Restore ${title} to the sidebar`}
                      data-testid="archive-restore-session"
                      disabled={restoring.has(externalEntryKey(entry))}
                      onClick={() => void restoreOne(entry)}
                    />
                  }
                >
                  <ArchiveRestoreIcon className="size-3.5" />
                </TooltipTrigger>
                <TooltipPopup>Restore to the sidebar</TooltipPopup>
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
