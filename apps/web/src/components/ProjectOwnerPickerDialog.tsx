import { useAtomValue } from "@effect/atom-react";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { recentProjectsForOwnerMenu } from "@t3tools/client-runtime/state/project-owner";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ProjectId } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { CheckIcon } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

import { m } from "../i18n/messages";
import { useProjects, useThreadShells } from "../state/entities";
import { projectEnvironment } from "../state/projects";
import { primaryServerKeybindingsAtom } from "../state/server";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import type { CommandPaletteActionItem } from "./CommandPalette.logic";
import { CommandPaletteContent } from "./CommandPaletteContent";
import { CommandPaletteResults } from "./CommandPaletteResults";
import { ProjectFavicon } from "./ProjectFavicon";
import {
  closeProjectOwnerPicker,
  type ProjectOwnerPickerRequest,
  useProjectOwnerPickerRequest,
} from "./projectOwnerPickerState";
import { CommandDialog, CommandDialogPopup, CommandFooterAction } from "./ui/command";
import { stackedThreadToast, toastManager } from "./ui/toast";

export function ProjectOwnerPickerDialogHost() {
  const request = useProjectOwnerPickerRequest((state) => state.request);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- resolves any pending picker promise when the dialog host unmounts
  useEffect(() => () => closeProjectOwnerPicker(), []);
  return request ? <ProjectOwnerPickerDialog request={request} /> : null;
}

function ProjectOwnerRowIcon(props: {
  readonly isSelected: boolean;
  readonly children: ReactNode;
}) {
  return (
    <span className="relative flex shrink-0">
      {props.children}
      {props.isSelected ? (
        <span className="pointer-events-none absolute -right-1 -bottom-1 grid size-3 place-items-center rounded-full bg-primary ring-2 ring-popover">
          <CheckIcon className="size-2 text-primary-foreground" strokeWidth={4} aria-hidden />
        </span>
      ) : null}
    </span>
  );
}

function ProjectOwnerPickerDialog({ request }: { readonly request: ProjectOwnerPickerRequest }) {
  const gt = useGT();
  const projects = useProjects();
  const threads = useThreadShells();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const [query, setQuery] = useState("");
  const [highlightedItemValue, setHighlightedItemValue] = useState<string | null>(null);
  const [pendingProjectId, setPendingProjectId] = useState<ProjectId | null>(null);
  const updateProject = useOrchestrationCommand(projectEnvironment.update, {
    reportFailure: false,
  });

  const { all } = recentProjectsForOwnerMenu({
    projects,
    threads,
    environmentId: request.environmentId,
  });

  const normalizedQuery = query.trim().toLowerCase();
  const filtered =
    normalizedQuery.length === 0
      ? all
      : all.filter(
          (project) =>
            project.title.toLowerCase().includes(normalizedQuery) ||
            project.workspaceRoot.toLowerCase().includes(normalizedQuery),
        );

  const threadTitleById = new Map(
    threads
      .filter((thread) => thread.environmentId === request.environmentId)
      .map((thread) => [thread.id, thread.title] as const),
  );

  const handleToggleProject = async (projectId: ProjectId, currentlyOwned: boolean) => {
    if (pendingProjectId !== null) return;
    setPendingProjectId(projectId);
    const result = await updateProject({
      environmentId: request.environmentId,
      input: {
        projectId,
        ownerThreadId: currentlyOwned ? null : request.threadId,
      },
    });
    setPendingProjectId(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: gt("Failed to update project owner"),
          description: thrownErrorMessage(error, m) ?? gt("An error occurred."),
        }),
      );
    }
  };

  const items: CommandPaletteActionItem[] = filtered.map((project) => {
    const isOwned = project.ownerThreadId === request.threadId;
    const otherOwnerTitle =
      !isOwned && project.ownerThreadId != null
        ? (threadTitleById.get(project.ownerThreadId) ?? null)
        : null;
    return {
      kind: "action",
      value: `project-owner:${project.id}`,
      searchTerms: [project.title, project.workspaceRoot],
      title: project.title,
      ...(otherOwnerTitle
        ? { description: gt("Currently owned by {owner}", { owner: otherOwnerTitle }) }
        : {}),
      checked: isOwned,
      disabled: pendingProjectId === project.id,
      keepOpen: true,
      icon: (
        <ProjectOwnerRowIcon isSelected={isOwned}>
          <ProjectFavicon project={project} className="size-4 shrink-0" />
        </ProjectOwnerRowIcon>
      ),
      titleTrailingContent: isOwned ? (
        <CheckIcon className="ms-auto size-4 shrink-0 text-primary" aria-hidden />
      ) : undefined,
      run: () => handleToggleProject(project.id, isOwned),
    };
  });

  const activeHighlight =
    highlightedItemValue !== null && items.some((item) => item.value === highlightedItemValue)
      ? highlightedItemValue
      : (items[0]?.value ?? null);

  return (
    <CommandDialog
      open
      onOpenChange={(open) => {
        if (!open) closeProjectOwnerPicker();
      }}
    >
      <CommandDialogPopup
        aria-label={gt("Set as project owner")}
        className="overflow-hidden"
        onBackdropPointerDown={closeProjectOwnerPicker}
      >
        <CommandPaletteContent
          aria-label={gt("Set as project owner")}
          autoHighlight="always"
          escapeLabel={gt("Done")}
          footerActionLabel={gt("Toggle owner")}
          footerTrailing={
            <CommandFooterAction onClick={closeProjectOwnerPicker}>
              <T>Done</T>
            </CommandFooterAction>
          }
          inputProps={{
            "aria-label": gt("Search projects"),
            placeholder: gt("Search projects..."),
            onKeyDown: (event) => {
              if (
                event.defaultPrevented ||
                event.nativeEvent.isComposing ||
                event.key !== "Enter" ||
                event.metaKey ||
                event.ctrlKey ||
                event.altKey ||
                event.shiftKey
              ) {
                return;
              }
              const target = items.find((item) => item.value === activeHighlight && !item.disabled);
              if (!target) return;
              event.preventDefault();
              void target.run();
            },
          }}
          mode="none"
          onItemHighlighted={(value) => {
            setHighlightedItemValue(typeof value === "string" ? value : null);
          }}
          onValueChange={(value) => {
            setHighlightedItemValue(null);
            setQuery(value);
          }}
          panelSize="tall-list"
          testId="project-owner-picker"
          value={query}
        >
          <CommandPaletteResults
            groups={
              items.length > 0
                ? [
                    {
                      value: "project-owner-projects",
                      label: gt('Projects owned by "{thread}"', { thread: request.threadTitle }),
                      items,
                    },
                  ]
                : []
            }
            highlightedItemValue={activeHighlight}
            isActionsOnly={false}
            keybindings={keybindings}
            onExecuteItem={(item) => {
              if (item.kind !== "action") return;
              void item.run();
            }}
            emptyStateMessage={gt("No matching projects.")}
          />
        </CommandPaletteContent>
      </CommandDialogPopup>
    </CommandDialog>
  );
}
