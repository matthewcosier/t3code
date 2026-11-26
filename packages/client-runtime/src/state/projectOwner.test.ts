import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { isThreadEligibleProjectOwner, recentProjectsForOwnerMenu } from "./projectOwner.ts";

const envA = EnvironmentId.make("env:a");
const envB = EnvironmentId.make("env:b");

function makeProject(
  id: string,
  overrides: Partial<{
    environmentId: EnvironmentId;
    title: string;
    archivedAt: string | null;
    updatedAt: string;
    ownerThreadId: ThreadId | null;
    isScratch: true;
  }> = {},
) {
  return {
    id: ProjectId.make(id),
    environmentId: overrides.environmentId ?? envA,
    title: overrides.title ?? id,
    archivedAt: overrides.archivedAt ?? null,
    updatedAt: overrides.updatedAt ?? "2026-11-01T00:00:00.000Z",
    ownerThreadId: overrides.ownerThreadId ?? null,
    ...(overrides.isScratch ? { isScratch: true as const } : {}),
  };
}

describe("recentProjectsForOwnerMenu", () => {
  it("sorts projects by most recent active thread activity, excludes archived/scratch/other environments, and slices recent", () => {
    const projects = [
      makeProject("p-older", { title: "Older", updatedAt: "2026-11-01T00:00:00.000Z" }),
      makeProject("p-active", { title: "Active", updatedAt: "2026-10-01T00:00:00.000Z" }),
      makeProject("p-archived", { title: "Archived", archivedAt: "2026-11-10T00:00:00.000Z" }),
      makeProject("p-scratch", { title: "Scratch", isScratch: true }),
      makeProject("p-other-env", { title: "Other Env", environmentId: envB }),
      makeProject("p-newest-meta", { title: "Newest Meta", updatedAt: "2026-11-15T00:00:00.000Z" }),
    ];

    const threads = [
      {
        environmentId: envA,
        projectId: ProjectId.make("p-active"),
        updatedAt: "2026-11-20T00:00:00.000Z",
        archivedAt: null,
      },
      {
        environmentId: envA,
        projectId: ProjectId.make("p-older"),
        updatedAt: "2026-11-25T00:00:00.000Z",
        archivedAt: "2026-11-25T00:00:00.000Z",
      },
    ];

    const result = recentProjectsForOwnerMenu({
      projects,
      threads,
      environmentId: envA,
      limit: 2,
    });

    expect(result.all.map((p) => p.id)).toEqual(["p-active", "p-newest-meta", "p-older"]);
    expect(result.recent.map((p) => p.id)).toEqual(["p-active", "p-newest-meta"]);
    expect(result.hasMore).toBe(true);
  });
});

describe("isThreadEligibleProjectOwner", () => {
  it("accepts only active, unsettled, non-delegated threads", () => {
    expect(
      isThreadEligibleProjectOwner({
        archivedAt: null,
        settledOverride: null,
        isDelegated: false,
      }),
    ).toBe(true);
    expect(
      isThreadEligibleProjectOwner({
        archivedAt: "2026-11-20T00:00:00.000Z",
        settledOverride: null,
        isDelegated: false,
      }),
    ).toBe(false);
    expect(
      isThreadEligibleProjectOwner({
        archivedAt: null,
        settledOverride: "settled",
        isDelegated: false,
      }),
    ).toBe(false);
    expect(
      isThreadEligibleProjectOwner({
        archivedAt: null,
        settledOverride: null,
        isDelegated: true,
      }),
    ).toBe(false);
    expect(
      isThreadEligibleProjectOwner({
        archivedAt: null,
        deletedAt: "2026-11-20T00:00:00.000Z",
        settledOverride: null,
        isDelegated: false,
      }),
    ).toBe(false);
  });
});
