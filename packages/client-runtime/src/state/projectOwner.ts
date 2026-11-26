import type { EnvironmentId, ProjectId } from "@t3tools/contracts";

import type { EnvironmentProject } from "./models.ts";

export interface OwnerMenuThreadActivity {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
}

/**
 * Non-archived projects on `environmentId`, sorted by most recent thread activity
 * (falling back to project `updatedAt`), with a slice for native context submenus.
 */
export function recentProjectsForOwnerMenu<
  TProject extends Pick<
    EnvironmentProject,
    "id" | "environmentId" | "title" | "archivedAt" | "updatedAt" | "ownerThreadId" | "isScratch"
  >,
>(input: {
  readonly projects: ReadonlyArray<TProject>;
  readonly threads: ReadonlyArray<OwnerMenuThreadActivity>;
  readonly environmentId: EnvironmentId;
  readonly limit?: number;
}): {
  readonly recent: ReadonlyArray<TProject>;
  readonly all: ReadonlyArray<TProject>;
  readonly hasMore: boolean;
} {
  const limit = input.limit ?? 10;
  const latestActivityByProjectId = new Map<ProjectId, number>();
  for (const thread of input.threads) {
    if (thread.environmentId !== input.environmentId || thread.archivedAt !== null) continue;
    const timestamp = Date.parse(thread.updatedAt);
    if (!Number.isFinite(timestamp)) continue;
    const prev = latestActivityByProjectId.get(thread.projectId);
    if (prev === undefined || timestamp > prev) {
      latestActivityByProjectId.set(thread.projectId, timestamp);
    }
  }
  const eligible = input.projects
    .filter(
      (project) =>
        project.environmentId === input.environmentId &&
        project.archivedAt == null &&
        project.isScratch !== true,
    )
    .sort((left, right) => {
      const leftTime = latestActivityByProjectId.get(left.id) ?? Date.parse(left.updatedAt);
      const rightTime = latestActivityByProjectId.get(right.id) ?? Date.parse(right.updatedAt);
      const timeDiff =
        (Number.isFinite(rightTime) ? rightTime : 0) - (Number.isFinite(leftTime) ? leftTime : 0);
      if (timeDiff !== 0) return timeDiff;
      return left.title.localeCompare(right.title);
    });
  return {
    recent: eligible.slice(0, limit),
    all: eligible,
    hasMore: eligible.length > limit,
  };
}

export function isThreadEligibleProjectOwner(thread: {
  readonly archivedAt: string | null;
  readonly deletedAt?: string | null;
  readonly settledOverride: "settled" | "active" | null;
  readonly isDelegated: boolean;
}): boolean {
  return (
    thread.archivedAt === null &&
    (thread.deletedAt ?? null) === null &&
    thread.settledOverride !== "settled" &&
    !thread.isDelegated
  );
}
