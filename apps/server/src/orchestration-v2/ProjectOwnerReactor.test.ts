import { assert, describe, it } from "@effect/vitest";
import {
  type ApplicationStoredEvent,
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2TurnItem,
  ProjectId,
  ProjectMutation,
  ProjectUpdatePayload,
  ProviderInstanceId,
  ProviderSessionId,
  RunId,
  RuntimeRequestId,
  ScheduledTaskId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ManagedThreadAppContext from "./ManagedThreadAppContext.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectOwnerReactor from "./ProjectOwnerReactor.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { shouldAutoEnrolWithProjectOwner } from "./ThreadLaunchService.ts";

const NOW = DateTime.makeUnsafe("2026-11-26T00:00:00.000Z");
const NOW_ISO = "2026-11-26T00:00:00.000Z";
const PROJECT_ID = ProjectId.make("project:alpha");
const PROJECT_B_ID = ProjectId.make("project:beta");
const OWNER_A_ID = ThreadId.make("thread:owner-a");
const OWNER_B_ID = ThreadId.make("thread:owner-b");
const MANAGED_ID = ThreadId.make("thread:managed-1");
const ARCHIVED_MANAGED_ID = ThreadId.make("thread:managed-archived");
const PROVIDER_ID = ProviderInstanceId.make("codex");
const PROVIDER_SESSION_ID = ProviderSessionId.make("session:1");

const decodeProjectUpdatePayload = Schema.decodeUnknownSync(ProjectUpdatePayload);
const decodeProjectMutation = Schema.decodeUnknownSync(ProjectMutation);

function makeThread(
  id: ThreadId,
  overrides: Partial<OrchestrationV2AppThread> = {},
): OrchestrationV2AppThread {
  return {
    id,
    projectId: PROJECT_ID,
    title: `Thread ${id}`,
    providerInstanceId: PROVIDER_ID,
    modelSelection: {
      instanceId: PROVIDER_ID,
      model: "gpt-5",
    },
    runtimeMode: "auto-accept-edits",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    createdBy: "user",
    creationSource: "web",
    lineage: {
      parentThreadId: null,
      rootThreadId: id,
      relationshipToParent: null,
    },
    forkedFrom: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    deletedAt: null,
    settledAt: null,
    settledOverride: null,
    lastVisitedAt: null,
    ...overrides,
  };
}

function makeMessage(
  id: string,
  threadId: ThreadId,
  overrides: Partial<OrchestrationV2ConversationMessage> = {},
): OrchestrationV2ConversationMessage {
  return {
    id: MessageId.make(id),
    threadId,
    runId: null,
    nodeId: null,
    role: "user",
    text: "",
    attachments: [],
    streaming: false,
    createdBy: "user",
    creationSource: "web",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeRun(
  id: string,
  threadId: ThreadId,
  overrides: Partial<OrchestrationV2Run> = {},
): OrchestrationV2Run {
  return {
    id: RunId.make(id),
    threadId,
    ordinal: 1,
    providerInstanceId: PROVIDER_ID,
    modelSelection: { instanceId: PROVIDER_ID, model: "gpt-5" },
    providerThreadId: null,
    userMessageId: MessageId.make("msg:1"),
    rootNodeId: null,
    activeAttemptId: null,
    status: "completed",
    queuePosition: null,
    requestedAt: NOW,
    startedAt: NOW,
    completedAt: NOW,
    checkpointId: null,
    contextHandoffId: null,
    ...overrides,
  };
}

function makeProjectRow(
  projectId: ProjectId,
  overrides: Partial<ProjectStore.ProjectRow> = {},
): ProjectStore.ProjectRow {
  return {
    projectId,
    title: projectId === PROJECT_ID ? "Alpha" : "Beta",
    workspaceRoot: `/workspaces/${projectId}`,
    defaultModelSelection: null,
    defaultThreadEnvMode: null,
    hasCustomTitle: false,
    autoPull: false,
    faviconPath: null,
    projectIcon: null,
    scripts: [],
    trackedFolders: [],
    pinnedAt: null,
    archivedAt: null,
    ownerThreadId: null,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    deletedAt: null,
    ...overrides,
  };
}

function makeHarness(initial: {
  readonly projects?: ReadonlyArray<ProjectStore.ProjectRow>;
  readonly threads?: ReadonlyArray<OrchestrationV2AppThread>;
  readonly messagesByThread?: Readonly<
    Record<string, ReadonlyArray<OrchestrationV2ConversationMessage>>
  >;
  readonly runsByThread?: Readonly<Record<string, ReadonlyArray<OrchestrationV2Run>>>;
  readonly runtimeRequestsByThread?: Readonly<
    Record<string, ReadonlyArray<OrchestrationV2RuntimeRequest>>
  >;
  readonly turnItemsByThread?: Readonly<Record<string, ReadonlyArray<OrchestrationV2TurnItem>>>;
}) {
  const projectsMap = new Map<ProjectId, ProjectStore.ProjectRow>(
    (initial.projects ?? []).map((row) => [row.projectId, row]),
  );
  const threadsMap = new Map<ThreadId, OrchestrationV2AppThread>(
    (initial.threads ?? []).map((thread) => [thread.id, thread]),
  );
  const messagesByThread = new Map<ThreadId, ReadonlyArray<OrchestrationV2ConversationMessage>>(
    Object.entries(initial.messagesByThread ?? {}).map(([id, list]) => [ThreadId.make(id), list]),
  );
  const runsByThread = new Map<ThreadId, ReadonlyArray<OrchestrationV2Run>>(
    Object.entries(initial.runsByThread ?? {}).map(([id, list]) => [ThreadId.make(id), list]),
  );
  const requestsByThread = new Map<ThreadId, ReadonlyArray<OrchestrationV2RuntimeRequest>>(
    Object.entries(initial.runtimeRequestsByThread ?? {}).map(([id, list]) => [
      ThreadId.make(id),
      list,
    ]),
  );
  const turnItemsByThread = new Map<ThreadId, ReadonlyArray<OrchestrationV2TurnItem>>(
    Object.entries(initial.turnItemsByThread ?? {}).map(([id, list]) => [ThreadId.make(id), list]),
  );

  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  const projectUpdates: Array<ProjectService.ProjectUpdateInput> = [];

  const layer = ProjectOwnerReactor.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.mock(Orchestrator.OrchestratorV2)({
          dispatch: (command) =>
            Effect.sync(() => {
              dispatched.push(command);
              if (
                command.type === "thread.metadata.update" &&
                command.managedByThreadId !== undefined
              ) {
                const current = threadsMap.get(command.threadId);
                if (current) {
                  threadsMap.set(command.threadId, {
                    ...current,
                    managedByThreadId: command.managedByThreadId,
                  });
                }
              }
              return {
                sequence: dispatched.length,
                storedEvents: [],
              };
            }),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThread: (threadId) => {
            const thread = threadsMap.get(threadId);
            return thread ? Effect.succeed(thread) : Effect.fail({ _tag: "NotFound" } as never);
          },
          getThreadRecords: (threadId) => {
            const thread = threadsMap.get(threadId);
            if (!thread) return Effect.fail({ _tag: "NotFound" } as never);
            return Effect.succeed({
              thread,
              messages: messagesByThread.get(threadId) ?? [],
              runs: runsByThread.get(threadId) ?? [],
              runtimeRequests: requestsByThread.get(threadId) ?? [],
              turnItems: turnItemsByThread.get(threadId) ?? [],
            } as never);
          },
          getRuntimeRequest: (threadId, requestId) =>
            Effect.succeed(
              (requestsByThread.get(threadId) ?? []).find((req) => req.id === requestId),
            ),
          listActiveManagedThreadsForProject: (projectId) =>
            Effect.succeed(
              [...threadsMap.values()].filter(
                (thread) =>
                  thread.projectId === projectId &&
                  thread.deletedAt === null &&
                  thread.archivedAt === null &&
                  thread.settledOverride !== "settled" &&
                  thread.managedByThreadId != null,
              ),
            ),
        }),
        Layer.mock(ProjectStore.ProjectStoreV2)({
          list: () => Effect.succeed([...projectsMap.values()]),
          get: (projectId) => Effect.succeed(Option.fromUndefinedOr(projectsMap.get(projectId))),
          listByOwnerThreadId: (ownerThreadId) =>
            Effect.succeed(
              [...projectsMap.values()].filter(
                (row) => row.deletedAt === null && row.ownerThreadId === ownerThreadId,
              ),
            ),
        }),
        Layer.mock(ProjectService.ProjectService)({
          update: (input) =>
            Effect.sync(() => {
              projectUpdates.push(input);
              const existing = projectsMap.get(input.projectId);
              if (existing && input.ownerThreadId !== undefined) {
                projectsMap.set(input.projectId, {
                  ...existing,
                  ownerThreadId: input.ownerThreadId,
                });
              }
              return {} as never;
            }),
        }),
        Layer.mock(OrchestrationEventStore.OrchestrationEventStore)({
          latestApplicationSequence: Effect.succeed(0),
          streamApplicationEvents: () => Stream.empty,
        }),
      ),
    ),
  );

  return { layer, dispatched, projectUpdates, threadsMap, projectsMap };
}

function wrapThreadEvent(event: OrchestrationV2DomainEvent, sequence = 1): ApplicationStoredEvent {
  return { sequence, commandId: null, event };
}

describe("shouldAutoEnrolWithProjectOwner", () => {
  const base = {
    createdBy: "user" as const,
    creationSource: "web" as const,
    ownerThreadId: OWNER_A_ID,
    candidateThreadId: MANAGED_ID,
  };

  it("enrols fresh user-started web and mobile threads", () => {
    assert.isTrue(shouldAutoEnrolWithProjectOwner(base));
    assert.isTrue(shouldAutoEnrolWithProjectOwner({ ...base, creationSource: "mobile" }));
  });

  it("skips opt-out, reused, agent/MCP, delegated, linked, workflow, imported, scheduled, and self threads", () => {
    assert.isFalse(shouldAutoEnrolWithProjectOwner({ ...base, skipOwnerEnrolment: true }));
    assert.isFalse(shouldAutoEnrolWithProjectOwner({ ...base, reuseExistingThread: true }));
    assert.isFalse(shouldAutoEnrolWithProjectOwner({ ...base, createdBy: "agent" }));
    assert.isFalse(shouldAutoEnrolWithProjectOwner({ ...base, creationSource: "mcp" }));
    assert.isFalse(shouldAutoEnrolWithProjectOwner({ ...base, creationSource: "server" }));
    assert.isFalse(shouldAutoEnrolWithProjectOwner({ ...base, creationSource: "provider" }));
    assert.isFalse(
      shouldAutoEnrolWithProjectOwner({
        ...base,
        linkOrigin: { sessionId: "session:1", label: "Remote" },
      }),
    );
    assert.isFalse(
      shouldAutoEnrolWithProjectOwner({
        ...base,
        delegatedFrom: {
          environmentId: EnvironmentId.make("env:remote"),
          threadId: OWNER_A_ID,
          title: "Remote parent",
        },
      }),
    );
    assert.isFalse(
      shouldAutoEnrolWithProjectOwner({
        ...base,
        workflowRun: { workflowRunId: "wf:1", stepId: "step:1" } as never,
      }),
    );
    assert.isFalse(shouldAutoEnrolWithProjectOwner({ ...base, importedNativeThread: { ref: {} } }));
    assert.isFalse(
      shouldAutoEnrolWithProjectOwner({
        ...base,
        scheduledTaskId: ScheduledTaskId.make("sched:1"),
      }),
    );
    assert.isFalse(shouldAutoEnrolWithProjectOwner({ ...base, ownerThreadId: null }));
    assert.isFalse(shouldAutoEnrolWithProjectOwner({ ...base, candidateThreadId: OWNER_A_ID }));
  });
});

describe("ManagedThreadAppContext", () => {
  it.effect("injects owner context only when managed by an active owner thread", () =>
    Effect.gen(function* () {
      const owner = makeThread(OWNER_A_ID, { title: "Release Manager" });
      const settledOwner = makeThread(OWNER_B_ID, {
        title: "Old Manager",
        settledOverride: "settled",
      });
      const managed = makeThread(MANAGED_ID, { managedByThreadId: OWNER_A_ID });
      const unmanaged = makeThread(ThreadId.make("thread:unmanaged"), { managedByThreadId: null });
      const staleManaged = makeThread(ThreadId.make("thread:stale"), {
        managedByThreadId: OWNER_B_ID,
      });

      const map = new Map(
        [owner, settledOwner, managed, unmanaged, staleManaged].map((t) => [t.id, t]),
      );
      const projections = {
        getThread: (id: ThreadId) => {
          const found = map.get(id);
          return found ? Effect.succeed(found) : Effect.fail({ _tag: "NotFound" } as never);
        },
      } as unknown as ProjectionStore.ProjectionStoreV2["Service"];

      const activeEntries = yield* ManagedThreadAppContext.forProvider(projections, MANAGED_ID);
      assert.lengthOf(activeEntries, 1);
      assert.strictEqual(activeEntries[0]?.key, "t3_managed_by_owner");
      assert.include(activeEntries[0]?.text ?? "", "Release Manager");
      assert.include(activeEntries[0]?.text ?? "", OWNER_A_ID);

      assert.deepStrictEqual(
        yield* ManagedThreadAppContext.forProvider(projections, unmanaged.id),
        [],
      );
      assert.deepStrictEqual(
        yield* ManagedThreadAppContext.forProvider(projections, staleManaged.id),
        [],
      );
    }),
  );
});

describe("ProjectOwnerReactor", () => {
  it.effect(
    "delivers enrolment notice on the opening user message even after a fast assistant reply, and includes mode-ceiling note",
    () =>
      Effect.gen(function* () {
        const owner = makeThread(OWNER_A_ID, {
          title: "Project Lead",
          runtimeMode: "approval-required",
        });
        const managed = makeThread(MANAGED_ID, {
          title: "Fix login bug",
          runtimeMode: "full-access",
          managedByThreadId: OWNER_A_ID,
        });
        const firstMsg = makeMessage("msg:first", MANAGED_ID, {
          text: "Please investigate the login redirect loop.",
        });
        const fastAssistantReply = makeMessage("msg:assistant", MANAGED_ID, {
          role: "assistant",
          text: "Looking into it now.",
          createdBy: "agent",
          creationSource: "provider",
        });
        const secondUserMsg = makeMessage("msg:second", MANAGED_ID, {
          text: "Follow up question",
        });

        const harness = makeHarness({
          projects: [makeProjectRow(PROJECT_ID, { ownerThreadId: OWNER_A_ID })],
          threads: [owner, managed],
          messagesByThread: {
            [MANAGED_ID]: [firstMsg, fastAssistantReply, secondUserMsg],
          },
        });

        yield* Effect.gen(function* () {
          const reactor = yield* ProjectOwnerReactor.ProjectOwnerReactor;
          yield* reactor.handle(
            wrapThreadEvent({
              id: EventId.make("evt:msg1"),
              type: "message.updated",
              threadId: MANAGED_ID,
              occurredAt: NOW,
              payload: firstMsg,
            }),
          );
          yield* reactor.handle(
            wrapThreadEvent({
              id: EventId.make("evt:msg2"),
              type: "message.updated",
              threadId: MANAGED_ID,
              occurredAt: NOW,
              payload: secondUserMsg,
            }),
          );
        }).pipe(Effect.provide(harness.layer));

        assert.lengthOf(harness.dispatched, 1);
        const notice = harness.dispatched[0];
        assert.strictEqual(notice?.type, "message.dispatch");
        if (notice?.type === "message.dispatch") {
          assert.strictEqual(notice.threadId, OWNER_A_ID);
          assert.deepStrictEqual(notice.notification?.source, {
            kind: "managed_thread",
            managedThreadId: MANAGED_ID,
            projectId: PROJECT_ID,
            reason: "enrolled",
          });
          assert.include(notice.text, "Please investigate the login redirect loop.");
          assert.include(notice.text, "read-only to you");
        }
      }),
  );

  it.effect(
    "wakes owner on pending question and approval, and cancels queued wakes when resolved",
    () =>
      Effect.gen(function* () {
        const owner = makeThread(OWNER_A_ID, { runtimeMode: "full-access" });
        const managed = makeThread(MANAGED_ID, {
          title: "Deploy script",
          runtimeMode: "auto-accept-edits",
          managedByThreadId: OWNER_A_ID,
        });
        const questionReq: OrchestrationV2RuntimeRequest = {
          id: RuntimeRequestId.make("req:q1"),
          nodeId: NodeId.make("node:1"),
          providerTurnId: null,
          nativeRequestRef: null,
          kind: "user_input",
          status: "pending",
          responseCapability: { type: "live", providerSessionId: PROVIDER_SESSION_ID },
          createdAt: NOW,
          resolvedAt: null,
        };
        const approvalReq: OrchestrationV2RuntimeRequest = {
          id: RuntimeRequestId.make("req:a1"),
          nodeId: NodeId.make("node:1"),
          providerTurnId: null,
          nativeRequestRef: null,
          kind: "command",
          status: "pending",
          responseCapability: { type: "live", providerSessionId: PROVIDER_SESSION_ID },
          createdAt: NOW,
          resolvedAt: null,
        };
        const queuedQuestionRun = makeRun("run:queued-q1", OWNER_A_ID, {
          ordinal: 2,
          userMessageId: MessageId.make(`message:project-owner-question:${OWNER_A_ID}:req:q1`),
          status: "queued",
          queuePosition: 1,
          startedAt: null,
          completedAt: null,
        });
        const queuedApprovalRun = makeRun("run:queued-a1", OWNER_A_ID, {
          ordinal: 3,
          userMessageId: MessageId.make(`message:project-owner-approval:${OWNER_A_ID}:req:a1`),
          status: "queued",
          queuePosition: 2,
          startedAt: null,
          completedAt: null,
        });

        const harness = makeHarness({
          projects: [makeProjectRow(PROJECT_ID, { ownerThreadId: OWNER_A_ID })],
          threads: [owner, managed],
          runtimeRequestsByThread: { [MANAGED_ID]: [questionReq, approvalReq] },
          runsByThread: { [OWNER_A_ID]: [queuedQuestionRun, queuedApprovalRun] },
        });

        yield* Effect.gen(function* () {
          const reactor = yield* ProjectOwnerReactor.ProjectOwnerReactor;
          yield* reactor.handle(
            wrapThreadEvent({
              id: EventId.make("evt:q-pending"),
              type: "runtime-request.updated",
              threadId: MANAGED_ID,
              occurredAt: NOW,
              payload: questionReq,
            }),
          );
          yield* reactor.handle(
            wrapThreadEvent({
              id: EventId.make("evt:a-pending"),
              type: "runtime-request.updated",
              threadId: MANAGED_ID,
              occurredAt: NOW,
              payload: approvalReq,
            }),
          );
          yield* reactor.handle(
            wrapThreadEvent({
              id: EventId.make("evt:q-resolved"),
              type: "runtime-request.updated",
              threadId: MANAGED_ID,
              occurredAt: NOW,
              payload: { ...questionReq, status: "resolved", resolvedAt: NOW },
            }),
          );
          yield* reactor.handle(
            wrapThreadEvent({
              id: EventId.make("evt:a-resolved"),
              type: "runtime-request.updated",
              threadId: MANAGED_ID,
              occurredAt: NOW,
              payload: { ...approvalReq, status: "resolved", resolvedAt: NOW },
            }),
          );
        }).pipe(Effect.provide(harness.layer));

        assert.lengthOf(harness.dispatched, 4);
        assert.strictEqual(harness.dispatched[0]?.type, "message.dispatch");
        if (harness.dispatched[0]?.type === "message.dispatch") {
          assert.deepStrictEqual(harness.dispatched[0].notification?.source, {
            kind: "managed_thread",
            managedThreadId: MANAGED_ID,
            projectId: PROJECT_ID,
            reason: "question",
          });
          assert.include(harness.dispatched[0].text, "t3_pending_request");
        }
        assert.strictEqual(harness.dispatched[1]?.type, "message.dispatch");
        if (harness.dispatched[1]?.type === "message.dispatch") {
          assert.deepStrictEqual(harness.dispatched[1].notification?.source, {
            kind: "managed_thread",
            managedThreadId: MANAGED_ID,
            projectId: PROJECT_ID,
            reason: "approval",
          });
          assert.include(harness.dispatched[1].text, "Only the user can approve");
        }
        assert.deepStrictEqual(harness.dispatched[2], {
          type: "queued-run.cancel",
          commandId: CommandId.make(`server:project-owner-question-cancel:${OWNER_A_ID}:req:q1`),
          threadId: OWNER_A_ID,
          runId: queuedQuestionRun.id,
        });
        assert.deepStrictEqual(harness.dispatched[3], {
          type: "queued-run.cancel",
          commandId: CommandId.make(`server:project-owner-approval-cancel:${OWNER_A_ID}:req:a1`),
          threadId: OWNER_A_ID,
          runId: queuedApprovalRun.id,
        });
      }),
  );

  it.effect(
    "notifies owner when a managed thread finishes a run and goes idle, and skips while queued runs remain",
    () =>
      Effect.gen(function* () {
        const owner = makeThread(OWNER_A_ID);
        const managed = makeThread(MANAGED_ID, {
          title: "Refactor parser",
          managedByThreadId: OWNER_A_ID,
        });
        const completedRun = makeRun("run:1", MANAGED_ID);
        const queuedRun = makeRun("run:2", MANAGED_ID, {
          ordinal: 2,
          status: "queued",
          queuePosition: 1,
          startedAt: null,
          completedAt: null,
        });
        const replyItem: OrchestrationV2TurnItem = {
          id: TurnItemId.make("item:reply"),
          threadId: MANAGED_ID,
          runId: completedRun.id,
          nodeId: NodeId.make("node:1"),
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          status: "completed",
          title: null,
          startedAt: NOW,
          completedAt: NOW,
          updatedAt: NOW,
          type: "assistant_message",
          messageId: MessageId.make("msg:reply"),
          text: "Parser refactor complete with all tests green.",
          streaming: false,
        };

        const busyHarness = makeHarness({
          projects: [makeProjectRow(PROJECT_ID, { ownerThreadId: OWNER_A_ID })],
          threads: [owner, managed],
          runsByThread: { [MANAGED_ID]: [completedRun, queuedRun] },
          turnItemsByThread: { [MANAGED_ID]: [replyItem] },
        });
        yield* Effect.gen(function* () {
          const reactor = yield* ProjectOwnerReactor.ProjectOwnerReactor;
          yield* reactor.handle(
            wrapThreadEvent({
              id: EventId.make("evt:run-busy"),
              type: "run.updated",
              threadId: MANAGED_ID,
              runId: completedRun.id,
              occurredAt: NOW,
              payload: completedRun,
            }),
          );
        }).pipe(Effect.provide(busyHarness.layer));
        assert.lengthOf(busyHarness.dispatched, 0);

        const idleHarness = makeHarness({
          projects: [makeProjectRow(PROJECT_ID, { ownerThreadId: OWNER_A_ID })],
          threads: [owner, managed],
          runsByThread: { [MANAGED_ID]: [completedRun] },
          turnItemsByThread: { [MANAGED_ID]: [replyItem] },
        });
        yield* Effect.gen(function* () {
          const reactor = yield* ProjectOwnerReactor.ProjectOwnerReactor;
          yield* reactor.handle(
            wrapThreadEvent({
              id: EventId.make("evt:run-idle"),
              type: "run.updated",
              threadId: MANAGED_ID,
              runId: completedRun.id,
              occurredAt: NOW,
              payload: completedRun,
            }),
          );
        }).pipe(Effect.provide(idleHarness.layer));

        assert.lengthOf(idleHarness.dispatched, 1);
        const notice = idleHarness.dispatched[0];
        assert.strictEqual(notice?.type, "message.dispatch");
        if (notice?.type === "message.dispatch") {
          assert.deepStrictEqual(notice.notification?.source, {
            kind: "managed_thread",
            managedThreadId: MANAGED_ID,
            projectId: PROJECT_ID,
            reason: "run_completed",
          });
          assert.strictEqual(notice.notification?.outcome, "completed");
          assert.include(notice.text, "Parser refactor complete with all tests green.");
        }
      }),
  );

  it.effect(
    "transfers active managed threads on owner replacement, skips archived threads, and notifies both owners",
    () =>
      Effect.gen(function* () {
        const ownerA = makeThread(OWNER_A_ID, { title: "Owner A" });
        const ownerB = makeThread(OWNER_B_ID, {
          title: "Owner B",
          managedByThreadId: OWNER_A_ID,
        });
        const activeManaged = makeThread(MANAGED_ID, {
          title: "Active Feature",
          managedByThreadId: OWNER_A_ID,
        });
        const archivedManaged = makeThread(ARCHIVED_MANAGED_ID, {
          title: "Archived Feature",
          managedByThreadId: OWNER_A_ID,
          archivedAt: NOW,
        });

        const harness = makeHarness({
          projects: [makeProjectRow(PROJECT_ID, { ownerThreadId: OWNER_B_ID })],
          threads: [ownerA, ownerB, activeManaged, archivedManaged],
        });

        yield* Effect.gen(function* () {
          const reactor = yield* ProjectOwnerReactor.ProjectOwnerReactor;
          yield* reactor.handle({
            sequence: 10,
            eventId: EventId.make("evt:owner-replace"),
            aggregateKind: "project",
            aggregateId: PROJECT_ID,
            occurredAt: NOW_ISO,
            commandId: null,
            causationEventId: null,
            correlationId: null,
            metadata: {},
            type: "project.meta-updated",
            payload: {
              projectId: PROJECT_ID,
              ownerThreadId: OWNER_B_ID,
              updatedAt: NOW_ISO,
            },
          });
        }).pipe(Effect.provide(harness.layer));

        // Active managed thread transfers to Owner B; Owner B itself is detached (never self-owned);
        // archived thread is untouched.
        assert.strictEqual(harness.threadsMap.get(MANAGED_ID)?.managedByThreadId, OWNER_B_ID);
        assert.strictEqual(harness.threadsMap.get(OWNER_B_ID)?.managedByThreadId, null);
        assert.strictEqual(
          harness.threadsMap.get(ARCHIVED_MANAGED_ID)?.managedByThreadId,
          OWNER_A_ID,
        );

        const notices = harness.dispatched.filter(
          (
            cmd,
          ): cmd is Extract<OrchestrationV2ServerCommand, { readonly type: "message.dispatch" }> =>
            cmd.type === "message.dispatch",
        );
        assert.lengthOf(notices, 2);
        assert.strictEqual(notices[0]?.threadId, OWNER_A_ID);
        assert.strictEqual(
          notices[0]?.notification?.source.kind === "managed_thread"
            ? notices[0].notification.source.reason
            : null,
          "owner_replaced",
        );
        assert.strictEqual(notices[1]?.threadId, OWNER_B_ID);
        assert.strictEqual(
          notices[1]?.notification?.source.kind === "managed_thread"
            ? notices[1].notification.source.reason
            : null,
          "owner_assigned",
        );
        assert.include(notices[1]?.text ?? "", "Active Feature");
      }),
  );

  it.effect(
    "clears ownerThreadId on all owned projects when owner settles, archives, or deletes without waking the retired owner",
    () =>
      Effect.gen(function* () {
        const retiredOwner = makeThread(OWNER_A_ID, { settledOverride: "settled", settledAt: NOW });
        const activeManaged = makeThread(MANAGED_ID, { managedByThreadId: OWNER_A_ID });
        const harness = makeHarness({
          projects: [
            makeProjectRow(PROJECT_ID, { ownerThreadId: OWNER_A_ID }),
            makeProjectRow(PROJECT_B_ID, { ownerThreadId: OWNER_A_ID }),
          ],
          threads: [retiredOwner, activeManaged],
        });

        yield* Effect.gen(function* () {
          const reactor = yield* ProjectOwnerReactor.ProjectOwnerReactor;
          yield* reactor.handle(
            wrapThreadEvent({
              id: EventId.make("evt:settled"),
              type: "thread.settled",
              threadId: OWNER_A_ID,
              occurredAt: NOW,
              payload: retiredOwner,
            }),
          );
          // Simulate the resulting project.meta-updated event clearing ownership.
          yield* reactor.handle({
            sequence: 20,
            eventId: EventId.make("evt:clear-owner"),
            aggregateKind: "project",
            aggregateId: PROJECT_ID,
            occurredAt: NOW_ISO,
            commandId: null,
            causationEventId: null,
            correlationId: null,
            metadata: {},
            type: "project.meta-updated",
            payload: {
              projectId: PROJECT_ID,
              ownerThreadId: null,
              updatedAt: NOW_ISO,
            },
          });
        }).pipe(Effect.provide(harness.layer));

        assert.deepStrictEqual(
          harness.projectUpdates.map((u) => [u.projectId, u.ownerThreadId]),
          [
            [PROJECT_ID, null],
            [PROJECT_B_ID, null],
          ],
        );
        assert.strictEqual(harness.threadsMap.get(MANAGED_ID)?.managedByThreadId, null);
        // Never wakes the retired owner.
        assert.isFalse(harness.dispatched.some((cmd) => cmd.type === "message.dispatch"));
      }),
  );
});

describe("Project owner schema boundary", () => {
  it("exposes ownerThreadId on ProjectMutation but never on MCP ProjectUpdatePayload", () => {
    assert.isUndefined((ProjectUpdatePayload.fields as Record<string, unknown>).ownerThreadId);
    const decodedUpdate = decodeProjectUpdatePayload({
      title: "Alpha",
      ownerThreadId: OWNER_A_ID,
    } as Record<string, unknown>);
    assert.isUndefined((decodedUpdate as Record<string, unknown>).ownerThreadId);

    const decodedMutation = decodeProjectMutation({
      type: "project.update",
      commandId: CommandId.make("cmd:owner-set"),
      projectId: PROJECT_ID,
      ownerThreadId: OWNER_A_ID,
    });
    assert.strictEqual(
      decodedMutation.type === "project.update" ? decodedMutation.ownerThreadId : undefined,
      OWNER_A_ID,
    );
  });
});
