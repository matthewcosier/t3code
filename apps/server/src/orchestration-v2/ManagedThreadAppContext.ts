import type { OrchestrationV2AppThread, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ProjectionStore from "./ProjectionStore.ts";

export interface ManagedThreadOwnerContextEntry {
  readonly key: string;
  readonly text: string;
  readonly updatedAt: string;
}

const OWNER_APP_CONTEXT_KEY = "t3_managed_by_owner";

function formatManagedThreadOwnerContextText(input: {
  readonly ownerThreadId: ThreadId;
  readonly ownerTitle: string;
}): string {
  return (
    `This thread is automatically managed by the project owner thread "${input.ownerTitle}" ` +
    `(threadId: ${input.ownerThreadId}). Continue working normally without waiting on the owner. ` +
    `Report blockers, questions, or results to ${input.ownerThreadId} with t3_thread_send when helpful. ` +
    `Only the user can approve permission requests.`
  );
}

const safeGetThread = (
  projections: ProjectionStore.ProjectionStoreV2["Service"],
  threadId: ThreadId,
) =>
  Effect.suspend(() => projections.getThread(threadId)).pipe(
    Effect.asSome,
    Effect.catchCause(() => Effect.succeedNone),
  );

/**
 * Returns a single appContext note when `threadId` is managed by an active project owner thread.
 * Failures degrade to empty so turn startup is never blocked by a metadata lookup.
 */
export const forProvider = Effect.fn("ManagedThreadAppContext.forProvider")(function* (
  projections: ProjectionStore.ProjectionStoreV2["Service"],
  threadId: ThreadId,
  knownThread?: Pick<OrchestrationV2AppThread, "id" | "managedByThreadId" | "updatedAt">,
): Effect.fn.Return<ReadonlyArray<ManagedThreadOwnerContextEntry>> {
  const thread =
    knownThread !== undefined
      ? Option.some(knownThread)
      : yield* safeGetThread(projections, threadId);
  if (Option.isNone(thread) || thread.value.managedByThreadId == null) return [];
  const ownerId = thread.value.managedByThreadId;
  if (ownerId === threadId) return [];
  const owner = yield* safeGetThread(projections, ownerId);
  if (
    Option.isNone(owner) ||
    owner.value.deletedAt !== null ||
    owner.value.archivedAt !== null ||
    owner.value.settledOverride === "settled"
  ) {
    return [];
  }
  return [
    {
      key: OWNER_APP_CONTEXT_KEY,
      text: formatManagedThreadOwnerContextText({
        ownerThreadId: owner.value.id,
        ownerTitle: owner.value.title,
      }),
      updatedAt: DateTime.formatIso(thread.value.updatedAt),
    },
  ];
});
