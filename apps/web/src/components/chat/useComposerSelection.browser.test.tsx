import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type ServerProvider,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { createModelSelection } from "@t3tools/shared/model";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

const mocks = vi.hoisted(() => ({
  setModelSelection: null as ((value: unknown) => Promise<AtomCommandResult<void, unknown>>) | null,
  setRuntimeMode: null as ((value: unknown) => Promise<AtomCommandResult<void, unknown>>) | null,
}));

vi.mock(import("../../state/use-orchestration-command"), async (importOriginal) => ({
  ...(await importOriginal()),
  useOrchestrationCommand: (() => (value: { input: object }) =>
    "runtimeMode" in value.input
      ? mocks.setRuntimeMode?.(value)
      : mocks.setModelSelection?.(value)) as never,
}));

vi.mock(import("../../state/threads"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    environmentThreadShells: {
      ...actual.environmentThreadShells,
      threadShellAtom: ((ref: { threadId: string }) => shellAtom(ref.threadId)) as never,
    },
  };
});

import { render } from "../../../test/render";
import {
  DraftId,
  deriveEffectiveComposerModelState,
  queuedRunEditDraftId,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { AppAtomRegistryProvider, appAtomRegistry } from "../../rpc/atomRegistry";
import { toastManager } from "../ui/toast";
import { useComposerSelection } from "./useComposerSelection";

// Kept alive so a shell set before the hook mounts is still there when it saves a pick.
const shellAtom = Atom.family((_threadId: string) => Atom.make<unknown>(null).pipe(Atom.keepAlive));

function setup() {
  const setModelSelection = vi.fn<(value: unknown) => Promise<AtomCommandResult<void, unknown>>>();
  const setRuntimeMode = vi.fn<(value: unknown) => Promise<AtomCommandResult<void, unknown>>>();
  mocks.setModelSelection = setModelSelection;
  mocks.setRuntimeMode = setRuntimeMode;
  return { setModelSelection, setRuntimeMode };
}

const environmentId = EnvironmentId.make("environment-local");
const cursor = ProviderInstanceId.make("cursor");
const stored = createModelSelection(cursor, "claude-opus-5-5", [{ id: "effort", value: "medium" }]);

const providers: ReadonlyArray<ServerProvider> = [
  {
    instanceId: cursor,
    driver: ProviderDriverKind.make("cursor"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [{ slug: "auto-smart", name: "Auto", isCustom: false, capabilities: {} }],
    slashCommands: [],
    skills: [],
  },
];

// The hook reads only the thread's identity, stored selection and permission mode.
function cursorThread(id: string) {
  return {
    environmentId,
    id: ThreadId.make(id),
    modelSelection: stored,
    runtimeMode: "full-access",
  } as EnvironmentThreadShell;
}

type SelectionInput = Parameters<typeof useComposerSelection>[0];

function Picker(props: {
  thread: EnvironmentThreadShell;
  runtime: SelectionInput["activeRuntime"];
  model?: string;
  draftTarget?: SelectionInput["composerDraftTarget"];
  runtimeModeSwitchesInSession?: boolean;
  isLocalDraftThread?: boolean;
}) {
  const { handleRuntimeModeChangeStable, onProviderModelSelectStable } = useComposerSelection({
    environmentId,
    composerDraftTarget: props.draftTarget ?? scopeThreadRef(environmentId, props.thread.id),
    draftThread: null,
    activeThread: props.thread,
    activeRuntime: props.runtime,
    runMayBeActive: props.runtime?.activeRunId != null,
    runtimeModeSwitchesInSession: props.runtimeModeSwitchesInSession ?? false,
    activeProjectSettings: { settings: { newWorktreesStartFromOrigin: false } },
    settings: DEFAULT_UNIFIED_SETTINGS,
    providerStatuses: providers,
    lockedProvider: null,
    supportsProviderSwitchingViaHandoff: true,
    multipleModelSelections: null,
    runtimeMode: "full-access",
    isLocalDraftThread: props.isLocalDraftThread ?? false,
    canOverrideServerThreadEnvMode: false,
    setPendingServerThreadEnvModeEntry: () => {},
    setPendingServerThreadStartFromOriginByThreadId: () => {},
    scheduleComposerFocus: () => {},
  });
  return (
    <>
      <button
        type="button"
        onClick={() => onProviderModelSelectStable(cursor, props.model ?? stored.model)}
      >
        Pick the model
      </button>
      <button type="button" onClick={() => handleRuntimeModeChangeStable("approval-required")}>
        Pick supervised
      </button>
    </>
  );
}

const runningOn = (instanceId: ProviderInstanceId) =>
  ({
    activeRunId: RunId.make("run-live"),
    providerInstanceId: instanceId,
  }) as SelectionInput["activeRuntime"];

const runtimeModeSets = (thread: EnvironmentThreadShell) => [
  [
    expect.objectContaining({
      environmentId,
      input: expect.objectContaining({ threadId: thread.id, runtimeMode: "approval-required" }),
    }),
  ],
];

const draftRuntimeMode = (target: SelectionInput["composerDraftTarget"]) => {
  const draft = useComposerDraftStore.getState().getComposerDraft(target);
  return {
    runtimeMode: draft?.runtimeMode ?? null,
    runtimeModeBase: draft?.runtimeModeBase ?? null,
  };
};

it("keeps a Cursor thread's stored model and options when the user re-picks its unavailable row", async () => {
  setup();
  const thread = cursorThread("thread-cursor");
  await using _screen = await render(<Picker thread={thread} runtime={null} />);
  await page.getByRole("button", { name: "Pick the model" }).click();

  await vi.waitFor(() => {
    const draft = useComposerDraftStore
      .getState()
      .getComposerDraft(scopeThreadRef(environmentId, thread.id));
    expect(draft?.modelSelectionByProvider[cursor] ?? thread.modelSelection).toEqual(stored);
  });
});

it("switches back to the thread's stored model while the session runs on another instance", async () => {
  setup();
  const thread = cursorThread("thread-cursor-handoff");
  const runtime = { providerInstanceId: ProviderInstanceId.make("codex") } as Parameters<
    typeof useComposerSelection
  >[0]["activeRuntime"];
  await using _screen = await render(<Picker thread={thread} runtime={runtime} />);
  await page.getByRole("button", { name: "Pick the model" }).click();

  await vi.waitFor(() => {
    const draft = useComposerDraftStore
      .getState()
      .getComposerDraft(scopeThreadRef(environmentId, thread.id));
    expect(draft?.activeProvider).toBe(cursor);
    expect(
      deriveEffectiveComposerModelState({
        draft,
        threadStarted: true,
        providers,
        selectedProvider: ProviderDriverKind.make("cursor"),
        selectedInstanceId: cursor,
        threadModelSelection: thread.modelSelection,
        projectModelSelection: null,
        settings: DEFAULT_UNIFIED_SETTINGS,
      }),
    ).toEqual({ selectedModel: stored.model, modelOptions: { [cursor]: stored.options } });
  });
});

it("saves a re-picked model again when its first save failed", async () => {
  const { setModelSelection } = setup();
  setModelSelection
    .mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("offline"))))
    .mockResolvedValue(AsyncResult.success(undefined));
  const thread = cursorThread("thread-cursor-retry");
  appAtomRegistry.set(shellAtom(thread.id), thread);
  await using _screen = await render(
    <AppAtomRegistryProvider>
      <Picker thread={thread} runtime={null} model="auto-smart" />
    </AppAtomRegistryProvider>,
  );
  const pick = page.getByRole("button", { name: "Pick the model" });
  await pick.click();
  await vi.waitFor(() => expect(setModelSelection).toHaveBeenCalledTimes(1));
  await pick.click();

  const autoSave = expect.objectContaining({
    input: {
      threadId: thread.id,
      modelSelection: expect.objectContaining({ instanceId: cursor, model: "auto-smart" }),
    },
  });
  await vi.waitFor(() => expect(setModelSelection.mock.calls).toEqual([[autoSave], [autoSave]]));
});

it("saves a pick of a seeded model the started thread does not show", async () => {
  const { setModelSelection } = setup();
  setModelSelection.mockResolvedValue(AsyncResult.success(undefined));
  const thread = cursorThread("thread-cursor-seeded");
  appAtomRegistry.set(shellAtom(thread.id), thread);
  useComposerDraftStore
    .getState()
    .setModelSelection(
      scopeThreadRef(environmentId, thread.id),
      createModelSelection(cursor, "auto-smart"),
    );
  await using _screen = await render(
    <AppAtomRegistryProvider>
      <Picker thread={thread} runtime={null} model="auto-smart" />
    </AppAtomRegistryProvider>,
  );
  await page.getByRole("button", { name: "Pick the model" }).click();

  await vi.waitFor(() =>
    expect(setModelSelection).toHaveBeenCalledWith(
      expect.objectContaining({
        input: {
          threadId: thread.id,
          modelSelection: expect.objectContaining({ instanceId: cursor, model: "auto-smart" }),
        },
      }),
    ),
  );
});

it("keeps a queued edit's model pick in its own draft", async () => {
  const { setModelSelection } = setup();
  const thread = cursorThread("thread-queued-edit");
  const threadRef = scopeThreadRef(environmentId, thread.id);
  const draftTarget = queuedRunEditDraftId(threadRef, RunId.make("queued-run"));
  await using _screen = await render(
    <Picker thread={thread} runtime={null} model="auto-smart" draftTarget={draftTarget} />,
  );
  await page.getByRole("button", { name: "Pick the model" }).click();
  const store = useComposerDraftStore.getState();
  expect(store.getComposerDraft(draftTarget)?.modelSelectionByProvider[cursor]?.model).toBe(
    "auto-smart",
  );
  expect(store.getComposerDraft(threadRef)).toBeNull();
  expect(setModelSelection).not.toHaveBeenCalled();
});

it("sets a permission mode picked on an idle thread on the thread at once, without a draft mode", async () => {
  const { setRuntimeMode } = setup();
  setRuntimeMode.mockResolvedValue(AsyncResult.success(undefined));
  const thread = cursorThread("thread-mode-idle");
  await using _screen = await render(<Picker thread={thread} runtime={null} />);
  await page.getByRole("button", { name: "Pick supervised" }).click();

  await vi.waitFor(() => expect(setRuntimeMode.mock.calls).toEqual(runtimeModeSets(thread)));
  expect(draftRuntimeMode(scopeThreadRef(environmentId, thread.id))).toEqual({
    runtimeMode: null,
    runtimeModeBase: null,
  });
});

it("sets a permission mode picked during a run at once when the session switches modes in place", async () => {
  const { setRuntimeMode } = setup();
  setRuntimeMode.mockResolvedValue(AsyncResult.success(undefined));
  const thread = cursorThread("thread-mode-switches");
  await using _screen = await render(
    <Picker thread={thread} runtime={runningOn(cursor)} runtimeModeSwitchesInSession />,
  );
  await page.getByRole("button", { name: "Pick supervised" }).click();

  await vi.waitFor(() => expect(setRuntimeMode.mock.calls).toEqual(runtimeModeSets(thread)));
});

it("holds a permission mode picked during a run whose session cannot switch modes, against the thread's mode", async () => {
  const { setRuntimeMode } = setup();
  const thread = cursorThread("thread-mode-held");
  const target = scopeThreadRef(environmentId, thread.id);
  await using _screen = await render(<Picker thread={thread} runtime={runningOn(cursor)} />);
  await page.getByRole("button", { name: "Pick supervised" }).click();

  expect(draftRuntimeMode(target)).toEqual({
    runtimeMode: "approval-required",
    runtimeModeBase: "full-access",
  });
  expect(setRuntimeMode).not.toHaveBeenCalled();
});

it("reports a refused permission mode and keeps the thread's mode", async () => {
  const { setRuntimeMode } = setup();
  setRuntimeMode.mockResolvedValue(AsyncResult.failure(Cause.fail(new Error("refused"))));
  const thread = cursorThread("thread-mode-refused");
  await using _screen = await render(<Picker thread={thread} runtime={null} />);
  using toast = vi.spyOn(toastManager, "add");
  await page.getByRole("button", { name: "Pick supervised" }).click();

  await vi.waitFor(() =>
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ type: "error" })),
  );
  expect(draftRuntimeMode(scopeThreadRef(environmentId, thread.id))).toEqual({
    runtimeMode: null,
    runtimeModeBase: null,
  });
});

it("keeps a local draft thread's permission pick in its draft", async () => {
  const { setRuntimeMode } = setup();
  const thread = cursorThread("thread-mode-local-draft");
  const draftId = DraftId.make("draft-mode-local");
  useComposerDraftStore
    .getState()
    .setProjectDraftThreadId(scopeProjectRef(environmentId, ProjectId.make("project")), draftId, {
      threadId: thread.id,
      runtimeMode: "full-access",
    });
  await using _screen = await render(
    <Picker thread={thread} runtime={null} draftTarget={draftId} isLocalDraftThread />,
  );
  await page.getByRole("button", { name: "Pick supervised" }).click();

  expect(draftRuntimeMode(draftId)).toEqual({
    runtimeMode: "approval-required",
    runtimeModeBase: null,
  });
  expect(useComposerDraftStore.getState().getDraftSession(draftId)?.runtimeMode).toBe(
    "approval-required",
  );
  expect(setRuntimeMode).not.toHaveBeenCalled();
});
