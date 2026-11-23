import { TincanError, PROTOCOL_VERSION, system } from "@beyland/tincan-protocol";
import type { Core } from "../core.ts";
import { diagnose, unknownFacts, type RuntimeFacts } from "../doctor.ts";
import type { CommandRegistry } from "../registry.ts";

export function systemHandlers(registry: CommandRegistry): CommandRegistry {
  return (
    registry
      .implement(system.status, (_input, { core, client }) => {
        const phone = core.phone;
        const redactedPhone =
          client.kind === "mcp" && phone.device
            ? {
                ...phone,
                device: {
                  ...phone.device,
                  address: "00:00:00:00:00:00",
                  name: "iPhone",
                },
              }
            : phone;
        return {
          daemon: {
            version: core.version,
            protocolVersion: PROTOCOL_VERSION,
            pid: process.pid,
            startedAt: core.startedAt,
            uptimeMs: Math.max(0, core.now() - core.startedAt),
          },
          native: core.native,
          phone: redactedPhone,
        };
      })
      .implement(system.version, (_input, { core }) => ({
        version: core.version,
        protocolVersion: PROTOCOL_VERSION,
      }))
      .implement(system.doctor, async (_input, { core }) => {
        const facts = core.probeSystem ? await core.probeSystem() : unknownFacts(core.native);
        return {
          generatedAt: core.now(),
          daemon: true,
          checks: diagnose(facts, runtimeFacts(core)),
        };
      })
      .implement(system.commands, (input, { core, client }) =>
        core.registry.describe({
          includeInternal: (input.includeInternal ?? false) && client.kind !== "mcp",
        }),
      )
      // Agents get only the agent policy: what access the user has given them, nothing else.
      .implement(system.settingsGet, (_input, { core, client }) =>
        client.kind === "mcp" ? { agents: core.settings.agents } : core.settings,
      )
      .implement(system.settingsSet, (input, { core }) => core.updateSettings(input))
      .implement(system.serviceStatus, (_input, { core }) => serviceControl(core).status())
      .implement(system.serviceInstall, (_input, { core }) => serviceControl(core).install())
      .implement(system.serviceDisable, (_input, { core }) => serviceControl(core).disable())
  );
}

function serviceControl(core: Core) {
  if (!core.service) {
    throw new TincanError("NOT_FOUND", "This daemon can't manage the background service");
  }
  return core.service;
}

/** What the running daemon knows about the phone, for `doctor`. */
export function runtimeFacts(core: Core): RuntimeFacts {
  const { sync, contacts, ancs } = core.services;
  const map = sync?.status;
  return {
    version: core.version,
    phoneAddress: core.phone.device?.address ?? null,
    map: map ? { link: map.link, lastError: map.lastError, failures: map.failures } : null,
    contacts: contacts ? { lastSyncAt: contacts.lastSyncAt, lastError: contacts.lastError } : null,
    ancs: ancs?.state ?? null,
    history: { now: core.now(), events: core.history.list() },
  };
}
