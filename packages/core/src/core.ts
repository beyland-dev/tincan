import {
  AgentAccess,
  AgentHandlePolicy,
  AgentReadPolicy,
  AgentSendPolicy,
  DEFAULT_SETTINGS,
  effectiveAgents,
  SendDelaySeconds,
  Settings as SettingsSchema,
  TincanError,
  type AgentClient,
  type AgentSettingsPatch,
  type AgentConnection,
  type ClientInfo,
  type ConnectionState,
  type ContractName,
  type Device,
  type EffectiveAgents,
  type InputOf,
  type ProfileState,
  type OutputOf,
  type Settings,
} from "@beyland/tincan-protocol";
import type { z } from "zod";
import type { AncsWatcher } from "./ancs.ts";
import {
  AgentRateLimiter,
  type AgentAction,
  type AgentLimit,
  DEFAULT_AGENT_SEND_WINDOW_MS,
  HandleMasker,
} from "./agent-privacy.ts";
import { storedOwnHandles, type ContactSync } from "./contacts.ts";
import type { ServiceFacts, SystemFacts } from "./doctor.ts";
import type { Pairing } from "./pairing.ts";
import { EventBus } from "./events.ts";
import { ConnectionLog } from "./history.ts";
import { agentHandlers } from "./handlers/agents.ts";
import { contactHandlers } from "./handlers/contact.ts";
import { deviceHandlers } from "./handlers/device.ts";
import { draftHandlers } from "./handlers/draft.ts";
import { groupHandlers } from "./handlers/group.ts";
import { messageHandlers } from "./handlers/message.ts";
import { syncHandlers } from "./handlers/sync.ts";
import { systemHandlers } from "./handlers/system.ts";
import { threadHandlers } from "./handlers/thread.ts";
import type { Outbox } from "./outbox.ts";
import { CommandRegistry } from "./registry.ts";
import { isShortCode } from "./keys.ts";
import type { AgentScopeFilter, Store } from "./store/store.ts";
import type { AdapterInfo, AncsSessionState, BtDevice } from "./phone.ts";
import type { SyncEngine, SyncStatus } from "./sync.ts";

export interface NativeInfo {
  loaded: boolean;
  version: string | null;
  error: string | null;
}

export interface CoreOptions {
  /** Version reported by `status` and `version`. */
  version: string;
  native?: NativeInfo;
  /** Overrides on top of the stored (or default) settings; not persisted. */
  settings?: SettingsPatch;
  /** Persistent storage. Without it settings and messages live in memory only. */
  store?: Store;
  now?: () => number;
  /**
   * Maximum sends an MCP agent can perform within `agentSendWindowMs`. Overrides the
   * `agents.sendLimit` setting while given (for tests); otherwise the setting applies, live.
   */
  agentSendLimit?: number;
  /** Sliding window for agent send rate limiting (default 10 min). */
  agentSendWindowMs?: number;
  /** Limits for agents' other phone-side changes (mark read, mute, syncs); see `DEFAULT_AGENT_LIMITS`. */
  agentLimits?: Partial<Record<AgentAction, AgentLimit>>;
  /** Inspects the computer for `doctor`. Without it every system check is skipped. */
  probeSystem?: () => Promise<SystemFacts>;
  /** Tincan's systemd user service. Without it `service.*` commands fail with `NOT_FOUND`. */
  service?: ServiceControl;
  /** Adds Tincan's MCP server to agents. Without it `agents.*` commands fail with `NOT_FOUND`. */
  agentConnections?: AgentConnections;
}

/** Reads and edits agents' MCP configs, for the desktop's agent setup. */
export interface AgentConnections {
  /** How any MCP client starts Tincan's server. */
  launch: { command: string; args: string[] };
  list(): Promise<AgentConnection[]>;
  /** `CONFLICT` when the app has a different Tincan entry, unless `force`. */
  connect(client: AgentClient, force?: boolean): Promise<AgentConnection>;
  disconnect(client: AgentClient): Promise<AgentConnection>;
}

/** Reads, installs and disables the background service, for the desktop's Run in the background setting. */
export interface ServiceControl {
  /** Null when systemd can't be asked. */
  status(): Promise<ServiceFacts | null>;
  /**
   * Writes and enables the unit. When this daemon isn't the service, it then stops so the service
   * can take over (`handover`).
   */
  install(): Promise<ServiceFacts & { handover: boolean }>;
  /**
   * Disables the unit. When this daemon is the service, it then stops so the app can start its own
   * daemon (`handover`).
   */
  disable(): Promise<ServiceFacts & { handover: boolean }>;
}

/** The phone as Bluetooth sees it; the profiles' states come from the attached services. */
export interface PhoneDevice {
  address: string;
  name: string;
  paired: boolean;
  connected: boolean;
  /** The user disconnected it from Tincan. */
  paused?: boolean;
}

/** Why an agent may not touch a conversation; see `Core.agentThreadAccess`. */
export type AgentThreadAccess = "hidden" | "shortCode" | "outOfScope";

/** A conversation for `Core.agentThreadAccess`: its key, and whether it's hidden when known. */
export interface AgentThreadTarget {
  key: string;
  hiddenFromAgents?: boolean;
}

export interface PhoneStatus {
  state: ConnectionState;
  device: Device | null;
}

/**
 * The phone-facing services the daemon starts once a phone is set up. Commands that need one that
 * isn't attached fail with `NOT_CONNECTED`.
 */
export interface PhoneServices {
  sync?: Pick<SyncEngine, "status" | "sync" | "markReadOnPhone" | "trigger">;
  outbox?: Pick<Outbox, "send" | "retry" | "cancel" | "sendNow" | "dropThread">;
  contacts?: Pick<ContactSync, "sync" | "lastSyncAt" | "lastError"> & {
    ownHandles?: readonly string[];
  };
  ancs?: Pick<AncsWatcher, "state">;
}

/**
 * Connects, disconnects and forgets the phone. The daemon provides it once Bluetooth is open;
 * `device.*` commands fail with `NOT_CONNECTED` without it.
 */
export interface PhoneControl {
  /** The phone (null when none is set up) and adapter as Bluetooth sees them now. */
  details(): Promise<{ device: BtDevice | null; adapter: AdapterInfo | null; paused: boolean }>;
  /** Connect and start syncing; clears a disconnect the user asked for. */
  connect(): Promise<void>;
  /** Stop syncing and disconnect, and stay disconnected until `connect`. */
  disconnect(): Promise<void>;
  /** Unpair the phone and stop using it. Its messages stay. */
  forget(): Promise<void>;
  /** Pairs a new iPhone; the daemon adopts it once paired. */
  readonly pairing: Pairing;
}

export class Core {
  readonly version: string;
  readonly events = new EventBus();
  readonly registry: CommandRegistry;
  readonly native: NativeInfo;
  readonly startedAt: number;
  readonly now: () => number;
  readonly store: Store | null;
  readonly handleMasker: HandleMasker;
  readonly agentRateLimiter: AgentRateLimiter;
  readonly probeSystem: (() => Promise<SystemFacts>) | null;
  readonly service: ServiceControl | null;
  readonly agentConnections: AgentConnections | null;
  /** How the phone's connection has changed, for `device.history` and `doctor`. */
  readonly history: ConnectionLog;
  #settings: Settings;
  #device: PhoneDevice | null = null;
  #services: PhoneServices = {};
  #control: PhoneControl | null = null;
  #closed = false;

  private constructor(options: CoreOptions) {
    this.version = options.version;
    this.now = options.now ?? Date.now;
    this.startedAt = this.now();
    this.native = options.native ?? { loaded: false, version: null, error: "Not loaded" };
    this.store = options.store ?? null;
    this.probeSystem = options.probeSystem ?? null;
    this.service = options.service ?? null;
    this.agentConnections = options.agentConnections ?? null;
    const stored = migrateStoredSettings(this.store?.getSetting(SETTINGS_KEY));
    this.#settings = mergeSettings(mergeSettings(DEFAULT_SETTINGS, stored), options.settings ?? {});
    this.handleMasker = new HandleMasker(this.store);
    const sendWindowMs = options.agentSendWindowMs ?? DEFAULT_AGENT_SEND_WINDOW_MS;
    this.agentRateLimiter = new AgentRateLimiter(this.store, {
      ...options.agentLimits,
      // Read at every send, so changing `agents.sendLimit` or `agents.access` applies at once.
      // No limit (`full` access, or none set) still records sends, so dropping back to a limit
      // counts the recent ones.
      send: () => {
        const limit = this.agents.sendLimit;
        return {
          max: limit === null ? Infinity : (options.agentSendLimit ?? limit),
          windowMs: sendWindowMs,
        };
      },
    });
    this.history = new ConnectionLog(this);
    let registry = systemHandlers(new CommandRegistry());
    for (const add of [
      syncHandlers,
      threadHandlers,
      messageHandlers,
      contactHandlers,
      deviceHandlers,
      groupHandlers,
      draftHandlers,
      agentHandlers,
    ]) {
      registry = add(registry);
    }
    this.registry = registry;
  }

  static async open(options: CoreOptions): Promise<Core> {
    return new Core(options);
  }

  get settings(): Settings {
    return this.#settings;
  }

  /**
   * The agent policy as enforced: the stored agent settings capped by `agents.access`. Every
   * policy decision reads this, never `settings.agents` directly.
   */
  get agents(): EffectiveAgents {
    return effectiveAgents(this.#settings.agents);
  }

  /** Whether phone numbers and emails should be masked behind opaque IDs for `client`. */
  maskHandles(client: ClientInfo): boolean {
    return client.kind === "mcp" && this.agents.handles === "hidden";
  }

  /** Whether verification codes and short-code senders should be hidden from `client`. */
  hideCodes(client: ClientInfo): boolean {
    return client.kind === "mcp" && this.agents.hideCodes;
  }

  /**
   * The user's own handles from the phone's owner card, when known: from the contact sync, or
   * what the last one stored when it isn't running.
   */
  ownHandles(): Set<string> {
    const contacts = this.#services.contacts;
    if (contacts?.ownHandles) return new Set(contacts.ownHandles);
    return new Set(this.store ? storedOwnHandles(this.store, this.#device?.address) : []);
  }

  /** Which conversations `client` may read, for the store's scope filters. */
  agentScope(client: ClientInfo): AgentScopeFilter {
    const read = client.kind === "mcp" ? this.agents.read : "all";
    return { read, hideCodes: this.hideCodes(client), ownHandles: [...this.ownHandles()] };
  }

  /**
   * Why `client` may not touch a conversation, or null when it may. Only agents (`mcp`) are ever
   * refused: `hidden` (the user hid it from them), `shortCode` (a short code or alphanumeric
   * sender while `agents.hideCodes`) or `outOfScope` (outside what `agents.read` lets them
   * read). Every agent read and write of a conversation goes through this, and callers report
   * all three the same way (`NOT_FOUND`), so agents can't tell them from conversations that
   * don't exist. `target` is a thread key, or a thread as the store returned it.
   */
  agentThreadAccess(
    client: ClientInfo,
    target: string | AgentThreadTarget,
  ): AgentThreadAccess | null {
    if (client.kind !== "mcp") return null;
    const thread = typeof target === "string" ? { key: target } : target;
    const store = this.store;
    if (thread.hiddenFromAgents || store?.isThreadHiddenFromAgents(thread.key)) {
      return "hidden";
    }
    if (this.hideCodes(client) && isShortCode(thread.key)) return "shortCode";
    const read = this.agents.read;
    if (read === "all") return null;
    if (read === "off" || !store) return "outOfScope";
    return store.inAgentScope(thread.key, this.agentScope(client)) ? null : "outOfScope";
  }

  /** The phone and how far each profile has got. */
  get phone(): PhoneStatus {
    const device = this.#device;
    if (!device) return { state: "unpaired", device: null };
    const { sync, contacts, ancs } = this.#services;
    const map: ProfileState = sync ? mapProfile(sync.status) : "unavailable";
    const pbap: ProfileState = !contacts
      ? "unavailable"
      : contacts.lastError?.code === "PERMISSION_DENIED"
        ? "denied"
        : contacts.lastSyncAt !== null
          ? "ready"
          : "idle";
    const state: ConnectionState = !device.paired
      ? "unpaired"
      : !device.connected || device.paused
        ? "disconnected"
        : map === "ready"
          ? "connected"
          : "connecting";
    return {
      state,
      device: {
        ...device,
        state,
        profiles: { map, pbap, ancs: ancs ? ancsProfile(ancs.state) : "unavailable" },
      },
    };
  }

  /** Records the phone Tincan talks to (null: none set up). Emits `device.changed` on a change. */
  setPhone(device: PhoneDevice | null): void {
    const before = this.#device;
    const next = device && { ...device, address: device.address.toUpperCase() };
    if (
      before === next ||
      (before &&
        next &&
        before.address === next.address &&
        before.name === next.name &&
        before.paired === next.paired &&
        before.connected === next.connected &&
        Boolean(before.paused) === Boolean(next.paused))
    ) {
      return;
    }
    this.#device = next;
    const address = next?.address ?? before?.address;
    if (address) this.events.emit("device.changed", { address });
  }

  get services(): Readonly<PhoneServices> {
    return this.#services;
  }

  /** Attaches (or, with `undefined` values, detaches) phone services. */
  attach(services: PhoneServices): void {
    this.#services = { ...this.#services, ...services };
  }

  get control(): PhoneControl | null {
    return this.#control;
  }

  /** Sets (or, with null, removes) the phone's connection controls. */
  setControl(control: PhoneControl | null): void {
    this.#control = control;
  }

  /** The phone's connection controls. Throws `NOT_CONNECTED` without Bluetooth. */
  requireControl(): PhoneControl {
    if (!this.#control) throw new TincanError("NOT_CONNECTED", "Bluetooth isn't available");
    return this.#control;
  }

  /** The message store. Throws when Tincan runs without one. */
  requireStore(): Store {
    if (!this.store) throw new TincanError("INTERNAL", "Tincan is running without a message store");
    return this.store;
  }

  /** An attached phone service. Throws `NOT_CONNECTED` when it isn't running. */
  requireService<K extends keyof PhoneServices>(name: K): NonNullable<PhoneServices[K]> {
    const service = this.#services[name];
    if (!service) throw new TincanError("NOT_CONNECTED", "No phone is set up");
    return service as NonNullable<PhoneServices[K]>;
  }

  updateSettings(patch: SettingsPatch): Settings {
    this.#settings = mergeSettings(this.#settings, patch);
    this.store?.setSetting(SETTINGS_KEY, this.#settings);
    this.events.emit("settings.changed", this.#settings);
    return this.#settings;
  }

  /** Run a command as `client`. Throws `TincanError`. */
  run(name: string, input: unknown, client: ClientInfo): Promise<unknown> {
    if (this.#closed) return Promise.reject(new TincanError("NOT_CONNECTED", "Core is closed"));
    return this.registry.run(name, input, { core: this, client });
  }

  /** Typed variant of `run` for known contracts. */
  async call<N extends ContractName>(
    name: N,
    input: InputOf<N>,
    client: ClientInfo,
  ): Promise<OutputOf<N>> {
    return (await this.run(name, input, client)) as OutputOf<N>;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.events.emit("daemon.stopping", {});
  }
}

const SETTINGS_KEY = "settings";

/**
 * A change to the settings. Values are checked as they're merged, so this also takes settings
 * stored by older versions (see `migrateStoredSettings`) and fields since added (their defaults)
 * or removed (dropped).
 */
export type SettingsPatch = {
  agents?: AgentSettingsPatch;
  notifications?: Partial<Settings["notifications"]>;
  defaultRegion?: string;
  sendDelaySeconds?: number;
};

/** What older versions stored for these settings, and what each became. */
const LEGACY_READ: Record<string, Settings["agents"]["read"]> = { on: "known" };
const LEGACY_SEND: Record<string, Settings["agents"]["send"]> = { allow: "replied" };

/**
 * Settings as an older version stored them, brought up to date. Before `agents.access` there was
 * a master switch, `agents.enabled`: off stays off; on becomes `readOnly` when agents couldn't
 * send (`send: never`, the old default when none was stored) and `assistant` otherwise, never
 * `full`. On with neither reading nor sending let agents do nothing, so it stays `off` rather
 * than gaining read access. `agents.read: "on"` became `known` and `agents.send: "allow"`
 * became `replied`.
 */
export function migrateStoredSettings(stored: unknown): SettingsPatch {
  if (typeof stored !== "object" || stored === null) return {};
  const settings = { ...(stored as Record<string, unknown>) };
  const raw = settings.agents;
  if (typeof raw !== "object" || raw === null) return settings as SettingsPatch;
  const { enabled, ...agents } = raw as Record<string, unknown>;
  if (typeof agents.read === "string") agents.read = LEGACY_READ[agents.read] ?? agents.read;
  if (typeof agents.send === "string") agents.send = LEGACY_SEND[agents.send] ?? agents.send;
  if (agents.access === undefined && typeof enabled === "boolean") {
    const send = agents.send ?? "never";
    const read = agents.read ?? "off";
    agents.access = !enabled
      ? "off"
      : send === "never"
        ? read === "off"
          ? "off"
          : "readOnly"
        : "assistant";
  }
  return { ...settings, agents } as SettingsPatch;
}

/** `value` when it's valid for `schema`, else `fallback` (a value stored by another version). */
function valid<T>(schema: z.ZodType<T>, value: unknown, fallback: T): T {
  if (value === undefined) return fallback;
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : fallback;
}

function mergeSettings(base: Settings, patch: SettingsPatch): Settings {
  const agents = (patch.agents ?? {}) as Record<string, unknown>;
  const fields = SettingsSchema.shape.agents.shape;
  return {
    // Only known keys: `enabled` (replaced by `access`), `drafts` (drafts follow sending) and other
    // removed fields are dropped.
    agents: {
      access: valid(AgentAccess, agents.access, base.agents.access),
      read: valid(AgentReadPolicy, agents.read, base.agents.read),
      send: valid(AgentSendPolicy, agents.send, base.agents.send),
      sendLimit: valid(fields.sendLimit, agents.sendLimit, base.agents.sendLimit),
      sendDelaySeconds: valid(
        SendDelaySeconds,
        agents.sendDelaySeconds,
        base.agents.sendDelaySeconds,
      ),
      manage: valid(fields.manage, agents.manage, base.agents.manage),
      handles: valid(AgentHandlePolicy, agents.handles, base.agents.handles),
      hideCodes: valid(fields.hideCodes, agents.hideCodes, base.agents.hideCodes),
    },
    // Only known keys: settings stored by older versions may carry ones since removed.
    notifications: {
      preview: valid(
        SettingsSchema.shape.notifications.shape.preview,
        patch.notifications?.preview,
        base.notifications.preview,
      ),
    },
    defaultRegion: valid(
      SettingsSchema.shape.defaultRegion,
      patch.defaultRegion,
      base.defaultRegion,
    ),
    sendDelaySeconds: valid(SendDelaySeconds, patch.sendDelaySeconds, base.sendDelaySeconds),
  };
}

/** Failed opens in a row, all NOT_FOUND, before MAP counts as refused rather than still connecting. */
export const MAP_REFUSED_AFTER = 3;

function mapProfile(status: Pick<SyncStatus, "link" | "lastError" | "failures">): ProfileState {
  if (status.lastError?.code === "PERMISSION_DENIED") return "denied";
  if (
    status.link.kind !== "connected" &&
    status.lastError?.code === "NOT_FOUND" &&
    status.failures >= MAP_REFUSED_AFTER
  ) {
    return "refused";
  }
  switch (status.link.kind) {
    case "connected":
      return "ready";
    case "connecting":
    case "waiting":
      return "connecting";
    case "paused":
    case "stopped":
      return "idle";
  }
}

function ancsProfile(state: AncsSessionState): ProfileState {
  switch (state.kind) {
    case "ready":
      return "ready";
    case "waiting":
      return "connecting";
    case "unavailable":
      return state.code === "PERMISSION_DENIED" ? "denied" : "unavailable";
    case "closed":
      return "idle";
  }
}
