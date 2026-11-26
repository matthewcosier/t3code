import { describe, expect, it } from "vite-plus/test";

import { buildThreadActionMenuItems, type ThreadActionMenuState } from "./threadActionMenu.logic";

const baseState: ThreadActionMenuState = {
  canOperate: true,
  branch: null,
  projectFilter: null,
  isPinned: false,
  isSettled: false,
  autoSettleEnabled: true,
  isSnoozed: false,
  canSnoozeNow: true,
  isRegeneratingTitle: false,
  isRunning: false,
  hasCompletedRun: true,
  supports: {
    settlement: true,
    autoSettleOptOut: true,
    snooze: true,
    pinning: true,
    titleRegeneration: true,
  },
  snoozePresets: [
    { id: "hour", label: "In 1 hour", whenLabel: "3:00 PM", snoozedUntil: "2026-08-07T15:00:00Z" },
  ],
};

describe("buildThreadActionMenuItems", () => {
  it.each([false, true])(
    "disables both lifecycle directions without permission (reversed: %s)",
    (reversed) => {
      const items = buildThreadActionMenuItems({
        ...baseState,
        canOperate: false,
        isPinned: reversed,
        isSettled: reversed,
        isSnoozed: reversed,
      });
      const expected = reversed
        ? [
            "unpin",
            "unsettle",
            "unsnooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ]
        : [
            "pin",
            "settle",
            "snooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ];
      expect(items.filter((item) => item.disabled).map((item) => item.id)).toEqual(expected);
      expect(
        items.find((item) => item.id === "snooze")?.children?.every((child) => child.disabled) ??
          true,
      ).toBe(true);
    },
  );

  it("disables archive and turning into a project while the thread is running", () => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      isRunning: true,
      canTurnIntoProject: true,
    });
    expect(items.find((item) => item.id === "archive")?.disabled).toBe(true);
    expect(items.find((item) => item.id === "turn-into-project")?.disabled).toBe(true);
  });

  it.each([
    ["while the thread is running", { isRunning: true }],
    ["before any run has completed", { hasCompletedRun: false }],
  ])("omits mark unread %s", (_, overrides) => {
    const items = buildThreadActionMenuItems({ ...baseState, ...overrides });
    expect(items.map((item) => item.id)).not.toContain("mark-unread");
  });

  it("disables only rename where no inline title editor exists", () => {
    const items = buildThreadActionMenuItems({ ...baseState, canRename: false });
    expect(items.filter((item) => item.disabled).map((item) => item.id)).toEqual(["rename"]);
  });

  it("includes project owner submenu with checked projects, search trigger, and detach action", () => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      projectOwnerMenu: {
        projects: [
          { id: "proj-a", label: "Alpha", isOwner: true },
          { id: "proj-b", label: "Beta", isOwner: false },
        ],
      },
      managedByOwnerTitle: "Lead Thread",
    });

    const ownerSubmenu = items.find((item) => item.id === "set-project-owner");
    expect(ownerSubmenu?.children?.map((child) => [child.id, child.checked])).toEqual([
      ["set-project-owner:proj-a", true],
      ["set-project-owner:proj-b", false],
      ["set-project-owner:more", undefined],
    ]);
    expect(items.find((item) => item.id === "detach-owner")?.disabled).toBeUndefined();

    const readOnly = buildThreadActionMenuItems({
      ...baseState,
      canOperate: false,
      projectOwnerMenu: {
        projects: [{ id: "proj-a", label: "Alpha", isOwner: false }],
      },
      managedByOwnerTitle: "Lead Thread",
    });
    expect(readOnly.find((item) => item.id === "set-project-owner")?.disabled).toBe(true);
    expect(
      readOnly
        .find((item) => item.id === "set-project-owner")
        ?.children?.every((child) => child.disabled),
    ).toBe(true);
    expect(readOnly.find((item) => item.id === "detach-owner")?.disabled).toBe(true);
  });
});
