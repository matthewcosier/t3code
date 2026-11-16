import { createFileRoute } from "@tanstack/react-router";

import { ExternalSessionsPanel } from "../components/settings/ExternalSessionsPanel";

export const Route = createFileRoute("/_chat/settings/external-sessions")({
  component: ExternalSessionsPanel,
});
