/**
 * The Bluetooth surface the core drives. Core never imports `@beyland/tincan-native`: these types mirror
 * its exports structurally, so the loaded addon *is* a {@link PhonePort} (the daemon checks this at
 * compile time) and `@beyland/tincan-fake-phone` provides a scripted one for tests and demos.
 *
 * Failures reject with an `Error` whose `code` is a `TincanError` code (`NOT_CONNECTED`, `TIMEOUT`, …).
 */

// ── MAP ──────────────────────────────────────────────────────────────────────────────────────────

export type MapTrigger =
  | "sleep"
  | "resume"
  | "adapterDown"
  | "adapterUp"
  | "deviceConnected"
  | "deviceDisconnected"
  | "reconnect";

export type PushOutcome = "accepted" | "unconfirmed" | "pending";

export interface MapLinkOptions {
  backoffMinMs?: number;
  backoffMaxMs?: number;
  openTimeoutMs?: number;
  transferTimeoutMs?: number;
}

export type MapLinkState =
  | { kind: "connecting"; attempt: number }
  | { kind: "connected"; session: string }
  | { kind: "waiting"; attempt: number; delayMs: number }
  | { kind: "paused"; reason: "sleep" | "adapterDown" }
  | { kind: "stopped" };

export type MapEvent =
  | { kind: "messageAdded"; handle: string; path: string; folder: string; type: string }
  | { kind: "statusChanged"; handle: string; path: string; status: string }
  | { kind: "folderChanged"; handle: string; path: string; folder: string }
  | { kind: "readChanged"; handle: string; path: string; read: boolean }
  | { kind: "messageRemoved"; handle: string; path: string }
  | { kind: "sessionClosed" };

export type MapLinkEvent =
  | { kind: "state"; state: MapLinkState }
  | { kind: "openFailed"; attempt: number; code: string; message: string }
  | { kind: "map"; event: MapEvent }
  | { kind: "systemWatchFailed"; code: string; message: string };

export interface MapListFilter {
  offset?: number;
  maxCount?: number;
  subjectLength?: number;
  periodBegin?: string;
  periodEnd?: string;
  read?: boolean;
  types?: Array<string>;
  fields?: Array<string>;
}

export interface MapListing {
  handle: string;
  path: string;
  folder: string;
  subject: string;
  /** Unix seconds; the phone's local time, converted with this computer's zone. */
  timestamp: number;
  sender: string;
  senderAddress: string;
  replyTo: string;
  recipient: string;
  recipientAddress: string;
  type: string;
  size?: number;
  attachmentSize?: number;
  status: string;
  priority: boolean;
  read: boolean;
  sent: boolean;
  protected: boolean;
}

export interface Party {
  name: string;
  tel: string;
  email: string;
}

export interface ParsedBMessage {
  valid: boolean;
  version: string;
  read: boolean;
  type: string;
  folder: string;
  originator: Party;
  recipients: Array<Party>;
  body: string;
  parts: Array<string>;
  charset: string;
  encoding: string;
  language: string;
  length?: number;
  threadKey: string;
}

/** One phone's MAP session, kept open by the native reconnect supervisor. */
export interface MapLinkHandle {
  state(): MapLinkState;
  trigger(trigger: MapTrigger): void;
  listMessages(folder: string, filter?: MapListFilter | null): Promise<Array<MapListing>>;
  getMessage(path: string): Promise<ParsedBMessage>;
  setRead(path: string, read: boolean): Promise<void>;
  pushMessage(recipients: Array<string>, body: string): Promise<PushOutcome>;
  shutdown(): Promise<void>;
}

// ── PBAP ─────────────────────────────────────────────────────────────────────────────────────────

export type Phonebook = "pb" | "fav" | "ich" | "och" | "mch" | "cch";

export interface PbapSessionOptions {
  transferTimeoutMs?: number;
}

export interface PbapPullOptions {
  format?: "vcard21" | "vcard30";
  offset?: number;
  maxCount?: number;
  photos?: boolean;
}

export interface PhonebookVersion {
  folder?: string;
  databaseIdentifier?: string;
  primaryCounter?: string;
  secondaryCounter?: string;
}

export interface TypedValue {
  value: string;
  types: Array<string>;
}

export interface Photo {
  mediaType: string;
  data: string;
  uri: string;
}

export interface ParsedVCard {
  version: string;
  name: string;
  family: string;
  given: string;
  tels: Array<TypedValue>;
  emails: Array<TypedValue>;
  photo?: Photo;
  callType: string;
  callTime: string;
  favorite: boolean;
  nickname: string;
  organization: string;
  department: string;
  title: string;
  birthday: string;
  note: string;
  addresses: Array<TypedValue>;
  urls: Array<TypedValue>;
}

export interface PbapSessionHandle {
  readonly sessionPath: string;
  readonly closed: boolean;
  pullContacts(options?: PbapPullOptions): Promise<Array<ParsedVCard>>;
  pull(phonebook: Phonebook, options?: PbapPullOptions): Promise<Array<ParsedVCard>>;
  size(phonebook?: Phonebook): Promise<number>;
  version(phonebook?: Phonebook): Promise<PhonebookVersion>;
  close(): Promise<void>;
}

// ── ANCS ─────────────────────────────────────────────────────────────────────────────────────────

export type AncsCategory =
  | "other"
  | "incomingCall"
  | "missedCall"
  | "voicemail"
  | "social"
  | "schedule"
  | "email"
  | "news"
  | "healthAndFitness"
  | "businessAndFinance"
  | "location"
  | "entertainment";

export interface AncsNotification {
  uid: number;
  appId: string;
  appName: string;
  title: string;
  subtitle: string;
  body: string;
  category: AncsCategory;
  /** Unix seconds: the phone's Date attribute (or the arrival time without one). */
  received: number;
  silent: boolean;
  important: boolean;
  hasPositiveAction: boolean;
  hasNegativeAction: boolean;
  preExisting: boolean;
}

export interface AncsOptions {
  content?: boolean;
  retryMs?: number;
  verifyMs?: number;
}

export type AncsSessionState =
  | { kind: "unavailable"; code: string; reason: string }
  | { kind: "waiting"; hint: string }
  | { kind: "ready" }
  | { kind: "closed" };

export type AncsSessionEvent =
  | { kind: "state"; state: AncsSessionState }
  | { kind: "notification"; notification: AncsNotification }
  | { kind: "removed"; uid: number };

export interface AncsSessionHandle {
  state(): AncsSessionState;
  recent(limit?: number | null): Promise<Array<AncsNotification>>;
  performAction(uid: number, action: "positive" | "negative"): Promise<void>;
  close(): Promise<void>;
}

// ── Adapter and devices ──────────────────────────────────────────────────────────────────────────

export interface AdapterInfo {
  path: string;
  address: string;
  name: string;
  alias: string;
  powered: boolean;
  discoverable: boolean;
  pairable: boolean;
  discovering: boolean;
  class?: number;
}

export interface BtDevice {
  path: string;
  adapter: string;
  address: string;
  name?: string;
  alias: string;
  icon?: string;
  class?: number;
  modalias?: string;
  paired: boolean;
  bonded: boolean;
  trusted: boolean;
  blocked: boolean;
  connected: boolean;
  uuids: Array<string>;
  isIphone: boolean;
  supportsMap: boolean;
  supportsPbap: boolean;
  supportsAncs: boolean;
}

export type BtDeviceEvent =
  | { kind: "deviceAdded"; device: BtDevice }
  | { kind: "deviceChanged"; device: BtDevice }
  | { kind: "deviceRemoved"; path: string; address: string }
  | { kind: "adapterChanged"; adapter: AdapterInfo }
  | { kind: "adapterRemoved"; path: string };

export type BtPairingRequest =
  | { kind: "confirm"; address: string; passkey: string }
  | { kind: "authorize"; address: string };

export interface DeviceWatchHandle {
  close(): void;
}

export interface BluetoothHandle {
  adapter(): Promise<AdapterInfo | null>;
  devices(): Promise<Array<BtDevice>>;
  startDiscovery(): Promise<void>;
  stopDiscovery(): Promise<void>;
  /** Lets other devices (an iPhone's Settings › Bluetooth) see this computer; BlueZ turns it off after a while. */
  setDiscoverable(discoverable: boolean): Promise<void>;
  pair(
    address: string,
    onRequest: (request: BtPairingRequest) => boolean | Promise<boolean>,
  ): Promise<void>;
  cancelPairing(address: string): Promise<void>;
  connect(address: string): Promise<void>;
  disconnect(address: string): Promise<void>;
  forget(address: string): Promise<void>;
  watchDevices(onEvent: (event: BtDeviceEvent) => void): Promise<DeviceWatchHandle>;
}

// ── Desktop notifications ────────────────────────────────────────────────────────────────────────

export interface DesktopNotification {
  title: string;
  body: string;
  threadKey: string;
  icon?: string;
  replaces?: number;
  /** Buttons after the default action; a click reports an `action` event with the button's id. */
  actions?: Array<{ id: string; label: string }>;
}

export type NotifierEvent =
  | { kind: "action"; id: number; threadKey: string; action: string; activationToken?: string }
  | {
      kind: "closed";
      id: number;
      threadKey: string;
      reason: "expired" | "dismissed" | "closed" | "undefined";
    };

export interface NotifierOptions {
  appName?: string;
  desktopEntry?: string;
}

export interface NotifierHandle {
  capabilities(): Promise<Array<string>>;
  notify(notification: DesktopNotification): Promise<number>;
  dismiss(id: number): Promise<void>;
  close(): void;
}

// ── The port ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Everything the core needs from the phone and the desktop, shaped like the native module's exports
 * (`MapLink.start`, `PbapSession.open`, …) so the addon can be passed in unchanged.
 */
export interface PhonePort {
  Bluetooth: { open(): Promise<BluetoothHandle> };
  MapLink: {
    start(
      address: string,
      options: MapLinkOptions | undefined | null,
      onEvent: (event: MapLinkEvent) => void,
    ): Promise<MapLinkHandle>;
  };
  PbapSession: { open(address: string, options?: PbapSessionOptions): Promise<PbapSessionHandle> };
  AncsSession: {
    start(
      address: string,
      options: AncsOptions | undefined | null,
      onEvent: (event: AncsSessionEvent) => void,
    ): Promise<AncsSessionHandle>;
  };
  Notifier: {
    open(
      onEvent: (event: NotifierEvent) => void,
      options?: NotifierOptions,
    ): Promise<NotifierHandle>;
  };
}
