import {
  type ApplicationStoredEvent,
  CommandId,
  MessageId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
  ProviderRequestKind,
  type ProjectId,
  type RuntimeRequestId,
  type ThreadId,
} from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import { formatThreadLink } from "@t3tools/shared/threadLinks";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { forkParked } from "../serverActivation.ts";
import { exceededDispatchModeLimit } from "./DispatchModeLimit.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const FIRST_MESSAGE_PREVIEW_MAX_CHARS = 4_000;
const REPLY_PREVIEW_MAX_CHARS = 1_200;
const isApprovalRequestKind = Schema.is(ProviderRequestKind);

function truncatePreview(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars - 1)}…`;
}

function isActiveThread(
  thread: Pick<OrchestrationV2AppThread, "deletedAt" | "archivedAt" | "settledOverride">,
): boolean {
  return (
    thread.deletedAt === null && thread.archivedAt === null && thread.settledOverride !== "settled"
  );
}

function modeCeilingNotice(
  owner: Pick<OrchestrationV2AppThread, "runtimeMode" | "interactionMode">,
  managed: Pick<OrchestrationV2AppThread, "runtimeMode" | "interactionMode">,
): string {
  const exceeded = exceededDispatchModeLimit(owner, managed);
  if (exceeded === undefined) return "";
  return (
    ` Note: this thread runs in broader modes (${managed.runtimeMode}/${managed.interactionMode}) ` +
    `than yours (${owner.runtimeMode}/${owner.interactionMode}), so it is read-only to you ` +
    `(t3_thread_read works; writes and answering questions remain blocked by mode ceilings).`
  );
}

function threadMarkdownLink(thread: Pick<OrchestrationV2AppThread, "id" | "title">): string {
  return formatThreadLink({ environmentId: null, threadId: thread.id }, thread.title);
}

export class ProjectOwnerReactor extends Context.Service<
  ProjectOwnerReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly handle: (event: ApplicationStoredEvent) => Effect.Effect<void>;
  }
>()("t3/orchestration-v2/ProjectOwnerReactor") {}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projectStore = yield* ProjectStore.ProjectStoreV2;
  const projectService = yield* ProjectService.ProjectService;
  const eventStore = yield* OrchestrationEventStore.OrchestrationEventStore;

  const ownerByProjectId = new Map<ProjectId, ThreadId | null>();

  const seedProjectOwners = Effect.fn("ProjectOwnerReactor.seedProjectOwners")(function* () {
    const rows = yield* projectStore.list().pipe(Effect.orElseSucceed(() => []));
    ownerByProjectId.clear();
    for (const row of rows) {
      ownerByProjectId.set(row.projectId, row.ownerThreadId ?? null);
    }
  });

  const dispatchOwnerNotice = Effect.fnUntraced(function* (input: {
    readonly ownerThreadId: ThreadId;
    readonly managedThreadId: ThreadId;
    readonly projectId: ProjectId;
    readonly reason:
      | "enrolled"
      | "question"
      | "approval"
      | "run_completed"
      | "owner_assigned"
      | "owner_replaced";
    readonly commandId: CommandId;
    readonly messageId: MessageId;
    readonly text: string;
    readonly summary: string;
    readonly outcome?: "completed" | "failed" | "updated";
  }) {
    const owner = yield* projections.getThread(input.ownerThreadId).pipe(Effect.option);
    if (Option.isNone(owner) || !isActiveThread(owner.value)) return;
    yield* engine.dispatch({
      type: "message.dispatch",
      commandId: input.commandId,
      threadId: input.ownerThreadId,
      messageId: input.messageId,
      text: input.text,
      notification: {
        source: {
          kind: "managed_thread",
          managedThreadId: input.managedThreadId,
          projectId: input.projectId,
          reason: input.reason,
        },
        outcome: input.outcome ?? "updated",
        summary: input.summary,
      },
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "agent",
      creationSource: "server",
    });
  });

  const cancelQueuedWake = Effect.fnUntraced(function* (
    ownerThreadId: ThreadId,
    messageId: MessageId,
    cancelCommandId: CommandId,
  ) {
    const owner = yield* projections.getThreadRecords(ownerThreadId, ["runs"]).pipe(Effect.option);
    if (Option.isNone(owner)) return;
    const queued = owner.value.runs.find(
      (run) => run.status === "queued" && run.userMessageId === messageId,
    );
    if (queued === undefined) return;
    yield* engine
      .dispatch({
        type: "queued-run.cancel",
        commandId: cancelCommandId,
        threadId: ownerThreadId,
        runId: queued.id,
      })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("cancelling a project owner wake failed", {
            ownerThreadId,
            messageId,
            cause,
          }),
        ),
      );
  });

  const handleProjectOwnerChanged = Effect.fnUntraced(function* (
    projectId: ProjectId,
    nextOwnerId: ThreadId | null,
    eventSequence: number,
  ) {
    const activeManaged = yield* projections
      .listActiveManagedThreadsForProject(projectId)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<OrchestrationV2AppThread> => []));
    const cachedPreviousOwnerId = ownerByProjectId.get(projectId);
    const previousOwnerId =
      cachedPreviousOwnerId !== undefined
        ? cachedPreviousOwnerId
        : (activeManaged.find(
            (thread) =>
              thread.managedByThreadId != null && thread.managedByThreadId !== nextOwnerId,
          )?.managedByThreadId ?? null);
    ownerByProjectId.set(projectId, nextOwnerId);
    if (
      previousOwnerId === nextOwnerId &&
      activeManaged.every((t) => t.managedByThreadId === nextOwnerId)
    ) {
      return;
    }

    const projectOption = yield* projectStore
      .get(projectId)
      .pipe(Effect.orElseSucceed(() => Option.none()));
    const projectTitle = Option.isSome(projectOption) ? projectOption.value.title : projectId;

    const transferred: Array<OrchestrationV2AppThread> = [];
    for (const thread of activeManaged) {
      if (thread.managedByThreadId === nextOwnerId) continue;
      const targetOwnerId = nextOwnerId !== null && thread.id === nextOwnerId ? null : nextOwnerId;
      yield* engine
        .dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make(
            `server:project-owner-transfer:${projectId}:${eventSequence}:${thread.id}`,
          ),
          threadId: thread.id,
          managedByThreadId: targetOwnerId,
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("updating managedByThreadId after project owner change failed", {
              projectId,
              threadId: thread.id,
              targetOwnerId,
              cause,
            }),
          ),
        );
      if (targetOwnerId !== null) {
        transferred.push(thread);
      }
    }

    if (previousOwnerId !== null && nextOwnerId !== null && previousOwnerId !== nextOwnerId) {
      const nextOwnerOption = yield* projections.getThread(nextOwnerId).pipe(Effect.option);
      const nextOwnerLink = Option.isSome(nextOwnerOption)
        ? threadMarkdownLink(nextOwnerOption.value)
        : nextOwnerId;
      yield* dispatchOwnerNotice({
        ownerThreadId: previousOwnerId,
        managedThreadId: nextOwnerId,
        projectId,
        reason: "owner_replaced",
        commandId: CommandId.make(
          `server:project-owner-replaced:${projectId}:${eventSequence}:${previousOwnerId}`,
        ),
        messageId: MessageId.make(
          `message:project-owner-replaced:${projectId}:${eventSequence}:${previousOwnerId}`,
        ),
        summary: `Replaced as owner of "${projectTitle}"`,
        text: `You are no longer the owner of project "${projectTitle}". ${nextOwnerLink} is now its owner and will receive future notices for active managed threads.`,
      });
    }

    if (nextOwnerId !== null && transferred.length > 0) {
      const nextOwnerOption = yield* projections.getThread(nextOwnerId).pipe(Effect.option);
      if (Option.isSome(nextOwnerOption) && isActiveThread(nextOwnerOption.value)) {
        const list = transferred
          .map(
            (thread) =>
              `- ${threadMarkdownLink(thread)} (threadId: ${thread.id})${modeCeilingNotice(nextOwnerOption.value, thread)}`,
          )
          .join("\n");
        yield* dispatchOwnerNotice({
          ownerThreadId: nextOwnerId,
          managedThreadId: transferred[0]!.id,
          projectId,
          reason: "owner_assigned",
          commandId: CommandId.make(
            `server:project-owner-assigned:${projectId}:${eventSequence}:${nextOwnerId}`,
          ),
          messageId: MessageId.make(
            `message:project-owner-assigned:${projectId}:${eventSequence}:${nextOwnerId}`,
          ),
          summary: `Inherited ${transferred.length} managed ${transferred.length === 1 ? "thread" : "threads"} in "${projectTitle}"`,
          text:
            `You are now the owner of project "${projectTitle}" and inherited ${transferred.length} active managed ` +
            `${transferred.length === 1 ? "thread" : "threads"}:\n${list}\n` +
            `Use t3_thread_read, t3_thread_send, or t3_pending_request as needed.`,
        });
      }
    }
  });

  const handleOwnerRetired = Effect.fnUntraced(function* (
    retiredThreadId: ThreadId,
    eventId: string,
  ) {
    const ownedProjects = yield* projectStore
      .listByOwnerThreadId(retiredThreadId)
      .pipe(Effect.orElseSucceed(() => []));
    for (const project of ownedProjects) {
      yield* projectService
        .update({
          commandId: CommandId.make(
            `server:project-owner-clear:${project.projectId}:${retiredThreadId}:${eventId}`,
          ),
          projectId: project.projectId,
          ownerThreadId: null,
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("clearing owner on retired owner thread failed", {
              projectId: project.projectId,
              retiredThreadId,
              cause,
            }),
          ),
        );
    }
  });

  const handleEnrolmentNotice = Effect.fnUntraced(function* (
    managedThread: OrchestrationV2AppThread,
    firstUserText: string,
  ) {
    const ownerThreadId = managedThread.managedByThreadId;
    if (ownerThreadId == null || ownerThreadId === managedThread.id) return;
    const ownerOption = yield* projections.getThread(ownerThreadId).pipe(Effect.option);
    if (Option.isNone(ownerOption) || !isActiveThread(ownerOption.value)) return;
    const projectOption = yield* projectStore
      .get(managedThread.projectId)
      .pipe(Effect.orElseSucceed(() => Option.none()));
    const projectTitle = Option.isSome(projectOption)
      ? projectOption.value.title
      : managedThread.projectId;
    const preview = truncatePreview(firstUserText, FIRST_MESSAGE_PREVIEW_MAX_CHARS);
    const modeNote = modeCeilingNotice(ownerOption.value, managedThread);
    yield* dispatchOwnerNotice({
      ownerThreadId,
      managedThreadId: managedThread.id,
      projectId: managedThread.projectId,
      reason: "enrolled",
      commandId: CommandId.make(`server:project-owner-enrolled:${managedThread.id}`),
      messageId: MessageId.make(`message:project-owner-enrolled:${managedThread.id}`),
      summary: `New managed thread "${managedThread.title}" in "${projectTitle}"`,
      text:
        `A new user thread started in "${projectTitle}" and was automatically enrolled under you: ` +
        `${threadMarkdownLink(managedThread)} (threadId: ${managedThread.id}).` +
        `${modeNote}\n\nFirst message:\n${preview || "(no text)"}\n\n` +
        `The thread is already running. Use t3_thread_read, t3_thread_send, or t3_pending_request when needed.`,
    });
  });

  const handleRuntimeRequest = Effect.fnUntraced(function* (
    event: Extract<OrchestrationV2DomainEvent, { readonly type: "runtime-request.updated" }>,
  ) {
    const isApproval = isApprovalRequestKind(event.payload.kind);
    if (event.payload.kind !== "user_input" && !isApproval) return;
    const managedOption = yield* projections.getThread(event.threadId).pipe(Effect.option);
    if (Option.isNone(managedOption)) return;
    const managed = managedOption.value;
    const ownerThreadId = managed.managedByThreadId;
    if (
      ownerThreadId == null ||
      ownerThreadId === managed.id ||
      managed.lineage.parentThreadId !== null
    ) {
      return;
    }

    const requestId: RuntimeRequestId = event.payload.id;
    const key = `${ownerThreadId}:${requestId}`;
    const messageId = MessageId.make(
      isApproval
        ? `message:project-owner-approval:${key}`
        : `message:project-owner-question:${key}`,
    );

    const request: OrchestrationV2RuntimeRequest | undefined = yield* projections
      .getRuntimeRequest(event.threadId, requestId)
      .pipe(Effect.orElseSucceed(() => undefined));

    if (event.payload.status !== "pending" || request?.status !== "pending") {
      yield* cancelQueuedWake(
        ownerThreadId,
        messageId,
        CommandId.make(
          isApproval
            ? `server:project-owner-approval-cancel:${key}`
            : `server:project-owner-question-cancel:${key}`,
        ),
      );
      return;
    }

    const ownerOption = yield* projections.getThread(ownerThreadId).pipe(Effect.option);
    if (Option.isNone(ownerOption) || !isActiveThread(ownerOption.value)) return;
    const link = threadMarkdownLink(managed);

    if (isApproval) {
      yield* dispatchOwnerNotice({
        ownerThreadId,
        managedThreadId: managed.id,
        projectId: managed.projectId,
        reason: "approval",
        commandId: CommandId.make(`server:project-owner-approval:${key}`),
        messageId,
        summary: `Managed thread "${managed.title}" needs human approval`,
        text:
          `Managed thread ${link} (threadId: ${managed.id}) is waiting on a permission approval. ` +
          `Only the user can approve permission requests; plan around it or let the user know.`,
      });
      return;
    }

    const exceeded = exceededDispatchModeLimit(ownerOption.value, managed);
    const situation =
      request.responseCapability.type === "message"
        ? `Managed thread ${link} (threadId: ${managed.id}) asked a question and is still working.`
        : `Managed thread ${link} (threadId: ${managed.id}) is blocked on a question and cannot continue until it is answered.`;
    const actionHint =
      exceeded !== undefined
        ? `Read it with t3_pending_request action read, threadId ${managed.id}, and requestId ${request.id}. ` +
          `Because that thread runs in broader modes than yours, only the user can answer it.`
        : `Read it with t3_pending_request action read, threadId ${managed.id}, and requestId ${request.id}. ` +
          `Answer it with action respond when the answer follows from the task or the user's instructions; otherwise ask the user, then answer it. ` +
          `If it is no longer pending, it was answered or dismissed.`;

    yield* dispatchOwnerNotice({
      ownerThreadId,
      managedThreadId: managed.id,
      projectId: managed.projectId,
      reason: "question",
      commandId: CommandId.make(`server:project-owner-question:${key}`),
      messageId,
      summary: `Managed thread "${managed.title}" has a question`,
      text: `${situation} ${actionHint}`,
    });
  });

  const handleRunFinished = Effect.fnUntraced(function* (
    run: OrchestrationV2Run,
    threadId: ThreadId,
  ) {
    if (run.status !== "completed" && run.status !== "failed") return;
    const recordsOption = yield* projections
      .getThreadRecords(threadId, ["runs", "runtimeRequests", "turnItems"])
      .pipe(Effect.option);
    if (Option.isNone(recordsOption)) return;
    const { thread, runs, runtimeRequests, turnItems } = recordsOption.value;
    const ownerThreadId = thread.managedByThreadId;
    if (
      ownerThreadId == null ||
      ownerThreadId === thread.id ||
      thread.lineage.parentThreadId !== null
    ) {
      return;
    }

    const hasActiveOrQueuedRun = runs.some(
      (candidate) =>
        candidate.id !== run.id &&
        ["queued", "preparing", "starting", "running", "waiting"].includes(candidate.status),
    );
    if (hasActiveOrQueuedRun) return;

    const hasPendingRequest = runtimeRequests.some((req) => req.status === "pending");
    if (hasPendingRequest) return;

    const lastAssistant = turnItems
      .filter(
        (item) =>
          item.runId === run.id && item.type === "assistant_message" && item.text.trim().length > 0,
      )
      .at(-1);
    const preview =
      lastAssistant?.type === "assistant_message"
        ? `\n\nLast reply:\n${truncatePreview(lastAssistant.text, REPLY_PREVIEW_MAX_CHARS)}`
        : "";
    const statusWord = run.status === "failed" ? "failed" : "finished a run and is now idle";
    const key = `${ownerThreadId}:${thread.id}:${run.id}`;

    yield* dispatchOwnerNotice({
      ownerThreadId,
      managedThreadId: thread.id,
      projectId: thread.projectId,
      reason: "run_completed",
      outcome: run.status === "failed" ? "failed" : "completed",
      commandId: CommandId.make(`server:project-owner-run-done:${key}`),
      messageId: MessageId.make(`message:project-owner-run-done:${key}`),
      summary: `Managed thread "${thread.title}" ${run.status === "failed" ? "failed" : "is idle"}`,
      text:
        `Managed thread ${threadMarkdownLink(thread)} (threadId: ${thread.id}) ${statusWord}.${preview}\n\n` +
        `Read the full thread with t3_thread_read if you need more detail.`,
    });
  });

  const handle: ProjectOwnerReactor["Service"]["handle"] = Effect.fnUntraced(
    function* (stored) {
      if ("aggregateKind" in stored) {
        if (stored.type === "project.deleted") {
          ownerByProjectId.delete(stored.payload.projectId);
          return;
        }
        if (stored.type === "project.created") {
          ownerByProjectId.set(stored.payload.projectId, null);
          return;
        }
        if (stored.type === "project.meta-updated" && stored.payload.ownerThreadId !== undefined) {
          yield* handleProjectOwnerChanged(
            stored.payload.projectId,
            stored.payload.ownerThreadId,
            stored.sequence,
          );
        }
        return;
      }

      const event = stored.event;
      switch (event.type) {
        case "thread.settled":
        case "thread.archived":
        case "thread.deleted":
          yield* handleOwnerRetired(event.threadId, event.id);
          return;
        case "message.updated": {
          if (event.payload.role !== "user" || event.payload.createdBy !== "user") return;
          const recordsOption = yield* projections
            .getThreadRecords(event.threadId, ["messages"])
            .pipe(Effect.option);
          if (
            Option.isNone(recordsOption) ||
            recordsOption.value.thread.managedByThreadId == null
          ) {
            return;
          }
          // Only the opening user message triggers enrolment, even if a fast assistant reply
          // lands before the reactor consumes this event; commandId deduplication also guarantees
          // at-most-once delivery.
          const firstUserMessage = recordsOption.value.messages.find(
            (message) => message.role === "user" && message.createdBy === "user",
          );
          if (firstUserMessage?.id !== event.payload.id) return;
          yield* handleEnrolmentNotice(recordsOption.value.thread, event.payload.text);
          return;
        }
        case "runtime-request.updated":
          yield* handleRuntimeRequest(event);
          return;
        case "run.updated":
          yield* handleRunFinished(event.payload, event.threadId);
          return;
        default:
          return;
      }
    },
    (effect, stored) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("project owner reactor failed to process event", {
            sequence: stored.sequence,
            cause,
          }),
        ),
      ),
  );

  const lockKeyFor = (stored: ApplicationStoredEvent): string | null => {
    if ("aggregateKind" in stored) {
      if (
        stored.type === "project.created" ||
        stored.type === "project.deleted" ||
        (stored.type === "project.meta-updated" && stored.payload.ownerThreadId !== undefined)
      ) {
        return `project:${stored.payload.projectId}`;
      }
      return null;
    }
    switch (stored.event.type) {
      case "thread.settled":
      case "thread.archived":
      case "thread.deleted":
      case "message.updated":
      case "runtime-request.updated":
      case "run.updated":
        return `thread:${stored.event.threadId}`;
      default:
        return null;
    }
  };

  const start: ProjectOwnerReactor["Service"]["start"] = Effect.fn("ProjectOwnerReactor.start")(
    function* () {
      yield* seedProjectOwners();
      const latestSequence = yield* eventStore.latestApplicationSequence.pipe(
        Effect.orElseSucceed(() => 0),
      );
      const reactions = yield* KeyedLock.makeRunner<string>();
      yield* forkParked(
        Stream.runForEach(
          eventStore.streamApplicationEvents({ afterSequence: latestSequence }),
          (stored) => {
            const key = lockKeyFor(stored);
            return key === null ? Effect.void : reactions.run(key, handle(stored));
          },
        ).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("project owner event stream failed", { cause }),
          ),
        ),
      );
    },
  );

  return ProjectOwnerReactor.of({ start, handle });
});

export const layer = Layer.effect(ProjectOwnerReactor, make);
