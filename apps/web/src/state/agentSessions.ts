import { WS_METHODS, type AgentSessionCatalogInput, type EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom } from "effect/reactivity";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

export const agentSessionScan = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:agent-sessions:scan",
  tag: WS_METHODS.agentSessionsScan,
  staleTimeMs: 30_000,
  idleTtlMs: 5 * 60_000,
});

export const agentSessionImport = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:agent-sessions:import",
  tag: WS_METHODS.agentSessionsImport,
});

/** One page of the machine's external sessions; re-read while the server is still indexing. */
export const agentSessionCatalog = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:agent-sessions:catalog",
  tag: WS_METHODS.agentSessionsCatalog,
  // Every mount re-reads: a page shown again after paging or opening a session must not bring
  // back a session that has left the External shelf.
  staleTimeMs: 0,
  idleTtlMs: 5 * 60_000,
  // A first index of a large machine takes a while; the shelf fills in as it goes.
  refreshIntervalMs: 2_000,
  isFinal: (result) => !result.indexing,
});

export const agentSessionCatalogPagesKey = (
  environmentId: EnvironmentId,
  inputs: ReadonlyArray<AgentSessionCatalogInput>,
) => JSON.stringify({ environmentId, inputs });

/** Every page the External shelf shows, in order; equal page lists reuse one atom. */
export const agentSessionCatalogPages = Atom.family((key: string) => {
  const { environmentId, inputs } = JSON.parse(key) as {
    readonly environmentId: EnvironmentId;
    readonly inputs: ReadonlyArray<AgentSessionCatalogInput>;
  };
  return Atom.make((get) =>
    inputs.map((input) => get(agentSessionCatalog({ environmentId, input }))),
  ).pipe(Atom.withLabel(`environment-data:agent-sessions:catalog-pages:${key}`));
});

export const agentSessionHydrate = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:agent-sessions:hydrate",
  tag: WS_METHODS.agentSessionsHydrate,
});

/**
 * Bumped each time sessions are banished or restored, so the External shelf and the archive,
 * which can be on screen at once, both read again.
 */
export const agentSessionBanishVersion = Atom.make(0).pipe(
  Atom.keepAlive,
  Atom.withLabel("environment-data:agent-sessions:banish-version"),
);

/** Banished sessions still on disk, for the archive. */
export const agentSessionBanished = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:agent-sessions:banished",
  tag: WS_METHODS.agentSessionsBanished,
  staleTimeMs: 0,
  idleTtlMs: 5 * 60_000,
  refreshTrigger: () => agentSessionBanishVersion,
});

export const agentSessionBanish = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:agent-sessions:banish",
  tag: WS_METHODS.agentSessionsBanish,
  onSuccess: (_target, registry) =>
    Effect.sync(() => registry.update(agentSessionBanishVersion, (version) => version + 1)),
});

export const agentSessionRestore = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:agent-sessions:restore",
  tag: WS_METHODS.agentSessionsRestore,
  onSuccess: (_target, registry) =>
    Effect.sync(() => registry.update(agentSessionBanishVersion, (version) => version + 1)),
});
