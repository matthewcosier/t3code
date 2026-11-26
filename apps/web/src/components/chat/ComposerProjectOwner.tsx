import { msg } from "gt-react";
import { UserCheckIcon } from "lucide-react";

import { m, type MessageResolver } from "../../i18n/messages";

import type { ComposerBannerStackItem } from "./ComposerBannerStack";

/** Shown on a new draft thread when its project has an owner; dismissing starts the thread unmanaged. */
export function projectOwnerEnrolmentBannerItem(
  input: {
    readonly ownerTitle: string;
    readonly onOptOut: () => void;
  },
  resolve: MessageResolver = m,
): ComposerBannerStackItem {
  return {
    id: "project-owner-enrolment",
    variant: "info",
    icon: <UserCheckIcon />,
    title: resolve(msg("Managed by {owner}", { owner: input.ownerTitle })),
    description: resolve(msg("Enrols automatically. Dismiss to start unmanaged.")),
    dismissLabel: resolve(msg("Start unmanaged")),
    onDismiss: input.onOptOut,
  };
}
