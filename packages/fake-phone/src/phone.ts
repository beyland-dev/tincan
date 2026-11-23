import type {
  AdapterInfo,
  AncsNotification,
  AncsOptions,
  AncsSessionEvent,
  AncsSessionHandle,
  AncsSessionState,
  BluetoothHandle,
  BtDevice,
  BtDeviceEvent,
  BtPairingRequest,
  DesktopNotification,
  DeviceWatchHandle,
  MapLinkEvent,
  MapLinkHandle,
  MapLinkState,
  MapListFilter,
  MapListing,
  MapTrigger,
  NotifierEvent,
  NotifierHandle,
  ParsedBMessage,
  ParsedVCard,
  PbapPullOptions,
  PbapSessionHandle,
  Phonebook,
  PhonebookVersion,
  PhonePort,
  PushOutcome,
} from "@beyland/tincan-core";
import { TincanError, type ErrorCode } from "@beyland/tincan-protocol";

/** How many inbox messages iOS lists over MAP, whatever `maxCount` asks for. */
export const IOS_INBOX_WINDOW = 10;
/** How many ANCS notifications `recent()` keeps, as in the native session. */
const ANCS_RECENT = 200;
const MESSAGES_APP = { appId: "com.apple.MobileSMS", appName: "Messages" };
const MAP_FOLDERS = new Set(["inbox", "sent", "outbox", "deleted"]);

export interface FakePhoneOptions {
  address?: string;
  name?: string;
  /** The phone's own number; pushes to it come back as new messages, as on a real iPhone. */
  ownNumber?: string;
  ownerName?: string;
  /** Unix seconds. Default: the wall clock. */
  now?: () => number;
  /** Default {@link IOS_INBOX_WINDOW}. */
  inboxWindow?: number;
  /** Milliseconds before a push to the own number comes back (default 0). */
  echoDelayMs?: number;
  /** Whether the phone is paired with this computer (default true). */
  paired?: boolean;
  /** Whether the phone is in range and accepting connections (default true). */
  reachable?: boolean;
  /** "Share System Notifications" is on (default true). Off, ANCS stays `waiting`. */
  shareNotifications?: boolean;
  /**
   * "Show Message Notifications" is on (default true). Off, the phone doesn't offer MAP to this
   * computer and every open fails with `NOT_FOUND`, as a real iPhone does.
   */
  shareMessages?: boolean;
  /** This computer's Class of Device (default 0x7c0408, hands-free); null when BlueZ hides it. */
  adapterClass?: number | null;
  /**
   * What pairing asks: `confirm` compares a code, as an iPhone does (default); `authorize` is
   * "Just Works" pairing without one, as an impostor or a non-iPhone would ask.
   */
  pairingRequest?: "confirm" | "authorize";
}

export interface IncomingMessage {
  /** The sender's address as the phone gives it: a bare number, an email or a short code. */
  from: string;
  name?: string;
  body: string;
  /** Unix seconds (default: now). */
  timestamp?: number;
  read?: boolean;
  /**
   * The Messages notification sent over ANCS (default: one titled with the sender). Its `subtitle`
   * carries the group: a name, or "To you & …" for an unnamed group. `false` sends none.
   */
  notification?: { title?: string; subtitle?: string } | false;
}

export interface FakeMessage {
  handle: string;
  from: string;
  name: string;
  body: string;
  timestamp: number;
  read: boolean;
}

export interface FakeContact {
  name: string;
  tels?: string[];
  emails?: string[];
  favorite?: boolean;
  /** A base64 photo, returned when a pull asks for photos. */
  photo?: { mediaType: string; data: string };
  organization?: string;
  addresses?: string[];
  urls?: string[];
}

export interface PushRecord {
  recipients: string[];
  body: string;
  outcome: PushOutcome | { error: ErrorCode };
}

export type PushFailure = ErrorCode | Exclude<PushOutcome, "accepted">;

/**
 * A scripted iPhone. `phone.port` is a {@link PhonePort} like the native addon; the other methods
 * script what the phone does. It models iOS's MAP behaviour (see docs/native.md): a 10-message inbox
 * window, `sent`/`outbox`/`deleted` always empty, new messages signalled by `statusChanged`
 * `notification`, no read events, downloads that don't mark read, paths that belong to one session,
 * and pushes that are only `accepted`.
 *
 * Callbacks run asynchronously and in order, like the addon's threadsafe functions; `await
 * phone.settle()` waits for everything queued.
 */
export class FakePhone {
  readonly address: string;
  readonly name: string;
  readonly ownNumber: string | null;
  readonly pairingRequest: "confirm" | "authorize";
  readonly ownerName: string;
  readonly port: PhonePort;
  readonly desktop = new FakeDesktop(this);
  /** Every push, in order. */
  readonly pushes: PushRecord[] = [];
  /** Every ANCS action performed, in order. */
  readonly actions: Array<{ uid: number; action: "positive" | "negative" }> = [];

  readonly #now: () => number;
  readonly #inboxWindow: number;
  readonly #echoDelayMs: number;
  readonly #mailbox = new Mailbox();
  readonly #messages: FakeMessage[] = [];
  readonly #links = new Set<FakeMapLink>();
  readonly #ancs = new Set<FakeAncsSession>();
  /** What the phone's Notification Center shows; survives reconnects. */
  readonly #center = new Map<number, AncsNotification>();
  readonly #watchers = new Set<(event: BtDeviceEvent) => void>();
  #contacts: ParsedVCard[] = [];
  #calls = new Map<Phonebook, ParsedVCard[]>();
  #contactsVersion = 1;
  #nextHandle = 4_000_000_000_000_000_000n;
  #nextSession = 1;
  #nextUid = 0;
  #pushFailures: PushFailure[] = [];
  #pullFailures: Array<{ photos: boolean | null; code: ErrorCode }> = [];
  #reachable: boolean;
  #shareNotifications: boolean;
  #shareMessages: boolean;
  #adapterClass: number | null;
  #paired: boolean;
  #known: boolean;
  #connected: boolean;

  constructor(options: FakePhoneOptions = {}) {
    this.address = (options.address ?? "AA:BB:CC:DD:EE:01").toUpperCase();
    this.name = options.name ?? "Fake iPhone";
    this.ownNumber = options.ownNumber ?? null;
    this.ownerName = options.ownerName ?? "Me";
    this.#now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.#inboxWindow = options.inboxWindow ?? IOS_INBOX_WINDOW;
    this.#echoDelayMs = options.echoDelayMs ?? 0;
    this.#paired = options.paired ?? true;
    this.#known = this.#paired;
    this.#reachable = options.reachable ?? true;
    this.#connected = this.#paired && this.#reachable;
    this.#shareNotifications = options.shareNotifications ?? true;
    this.#shareMessages = options.shareMessages ?? true;
    this.#adapterClass = options.adapterClass === undefined ? 0x7c0408 : options.adapterClass;
    this.pairingRequest = options.pairingRequest ?? "confirm";
    this.port = this.#makePort();
  }

  // ── Scripting ──────────────────────────────────────────────────────────────────────────────────

  /** A message arrives on the phone: MAP reports it to connected links, ANCS shows a notification. */
  receive(input: IncomingMessage): FakeMessage {
    const message: FakeMessage = {
      handle: String(this.#nextHandle++),
      from: input.from,
      name: input.name ?? "",
      body: input.body,
      timestamp: input.timestamp ?? this.#now(),
      read: input.read ?? false,
    };
    this.#messages.push(message);
    for (const link of this.#links) link.reportNew(message);
    if (input.notification !== false) {
      this.notify({
        ...MESSAGES_APP,
        title: input.notification?.title ?? (message.name || message.from),
        subtitle: input.notification?.subtitle ?? "",
        body: message.body,
        category: "social",
        received: message.timestamp,
        hasNegativeAction: true,
      });
    }
    return message;
  }

  /** Seed the inbox without any reports, as if the messages arrived before Tincan was running. */
  seed(inputs: Array<Omit<IncomingMessage, "notification">>): FakeMessage[] {
    const links = [...this.#links];
    this.#links.clear();
    try {
      return inputs.map((input) => this.receive({ ...input, notification: false }));
    } finally {
      for (const link of links) this.#links.add(link);
    }
  }

  /** The user reads (or unreads) a message on the phone. iOS sends no MAP event for this. */
  setReadOnPhone(handle: string, read = true): void {
    this.#message(handle).read = read;
  }

  /** All messages on the phone, oldest first (MAP lists only the newest {@link IOS_INBOX_WINDOW}). */
  get messages(): readonly FakeMessage[] {
    return this.#messages;
  }

  /** The phone goes out of range: sessions close and the links start retrying. */
  disconnect(): void {
    if (!this.#reachable) return;
    this.#reachable = false;
    this.#setConnected(false);
    for (const link of this.#links) link.lost();
    for (const session of this.#ancs) session.lost();
  }

  /** The phone comes back: waiting links reconnect and ANCS replays its backlog. */
  reconnect(): void {
    if (this.#reachable) return;
    this.#reachable = true;
    if (this.#paired) this.#setConnected(true);
    for (const link of this.#links) link.retry();
    for (const session of this.#ancs) session.retry();
  }

  get reachable(): boolean {
    return this.#reachable;
  }

  /** The next push fails with this error code, or reports this outcome. Queue several to chain. */
  failNextPush(failure: PushFailure = "TIMEOUT"): void {
    this.#pushFailures.push(failure);
  }

  /**
   * Make the next PBAP pull fail with `code`; with `photos` set, the next pull that does (or
   * doesn't) ask for photos.
   */
  failNextPull(code: ErrorCode = "TIMEOUT", photos: boolean | null = null): void {
    this.#pullFailures.push({ photos, code });
  }

  /** @internal The failure for a pull, if one was queued. */
  takePullFailure(photos: boolean): ErrorCode | null {
    const index = this.#pullFailures.findIndex((f) => f.photos === null || f.photos === photos);
    if (index < 0) return null;
    return this.#pullFailures.splice(index, 1)[0]!.code;
  }

  /**
   * Post a notification over ANCS (another app's, or a Messages one without a MAP message). The
   * returned `uid` is the phone's, for {@link removeNotification}; each subscription numbers its own.
   */
  notify(
    input: Partial<Omit<AncsNotification, "uid" | "preExisting">> & { title: string },
  ): AncsNotification {
    const notification: AncsNotification = {
      ...MESSAGES_APP,
      subtitle: "",
      body: "",
      category: "social",
      received: this.#now(),
      silent: false,
      important: false,
      hasPositiveAction: false,
      hasNegativeAction: false,
      ...input,
      uid: this.#nextUid++,
      preExisting: false,
    };
    this.#center.set(notification.uid, notification);
    for (const session of this.#ancs) session.post(notification);
    return notification;
  }

  /** Clear a notification on the phone. */
  removeNotification(uid: number): void {
    if (!this.#center.delete(uid)) return;
    for (const session of this.#ancs) session.remove(uid);
  }

  /** The phone's Notification Center, oldest first. */
  get notifications(): readonly AncsNotification[] {
    return [...this.#center.values()];
  }

  /** Turn "Share System Notifications" on or off for this computer. */
  setShareNotifications(on: boolean): void {
    if (this.#shareNotifications === on) return;
    this.#shareNotifications = on;
    for (const session of this.#ancs) {
      if (!on) session.lost();
      session.retry();
    }
  }

  get shareNotifications(): boolean {
    return this.#shareNotifications;
  }

  /** Turn "Show Message Notifications" on or off for this computer: MAP opens fail while off. */
  setShareMessages(on: boolean): void {
    if (this.#shareMessages === on) return;
    this.#shareMessages = on;
    for (const link of this.#links) {
      if (on) link.retry();
      else link.lost();
    }
  }

  get shareMessages(): boolean {
    return this.#shareMessages;
  }

  /**
   * Change this computer's Class of Device, as BlueZ's hostname plugin does when it resets it to
   * Computer. Watchers see `adapterChanged`.
   */
  setAdapterClass(cls: number | null): void {
    if (this.#adapterClass === cls) return;
    this.#adapterClass = cls;
    void new FakeBluetooth(this).adapter().then((adapter) => {
      for (const listener of this.#watchers) {
        this.#mailbox.post(() => listener({ kind: "adapterChanged", adapter }));
      }
    });
  }

  get adapterClass(): number | null {
    return this.#adapterClass;
  }

  /** Replace the address book. Entry 0 of `pb` is the owner's card, as on iOS. */
  setContacts(contacts: FakeContact[]): void {
    this.#contacts = contacts.map(vcard);
    this.#contactsVersion++;
  }

  /** Replace a call history list (`ich`, `och`, `mch` or `cch`). */
  setCallHistory(
    phonebook: Exclude<Phonebook, "pb" | "fav">,
    calls: Array<{ number: string; name?: string; type: string; time: string }>,
  ): void {
    this.#calls.set(
      phonebook,
      calls.map((call) => ({
        ...vcard({ name: call.name ?? "", tels: [call.number] }),
        callType: call.type,
        callTime: call.time,
      })),
    );
  }

  /** Wait until every queued callback has run, including delayed echoes. */
  async settle(): Promise<void> {
    await this.#mailbox.settle();
  }

  // ── Internals shared with the handles ──────────────────────────────────────────────────────────

  get mailbox(): Mailbox {
    return this.#mailbox;
  }

  get online(): boolean {
    return this.#reachable && this.#paired && this.#known;
  }

  get device(): BtDevice {
    return {
      path: `/org/bluez/hci0/dev_${this.address.replaceAll(":", "_")}`,
      adapter: "/org/bluez/hci0",
      address: this.address,
      name: this.name,
      alias: this.name,
      icon: "phone",
      class: 0x7a020c,
      paired: this.#paired,
      bonded: this.#paired,
      trusted: this.#paired,
      blocked: false,
      connected: this.#connected,
      uuids: [
        "0000112f-0000-1000-8000-00805f9b34fb",
        "00001132-0000-1000-8000-00805f9b34fb",
        "7905f431-b5ce-4e99-a40f-4b1e122d00d0",
      ],
      isIphone: true,
      supportsMap: true,
      supportsPbap: true,
      supportsAncs: true,
    };
  }

  nextSession(): string {
    return `/org/bluez/obex/client/session${this.#nextSession++}`;
  }

  inbox(): FakeMessage[] {
    return this.#messages
      .map((message, index) => ({ message, index }))
      .sort((a, b) => b.message.timestamp - a.message.timestamp || b.index - a.index)
      .slice(0, this.#inboxWindow)
      .map(({ message }) => message);
  }

  findMessage(handle: string): FakeMessage | undefined {
    return this.#messages.find((message) => message.handle === handle);
  }

  push(recipients: string[], body: string): PushOutcome {
    if (recipients.length === 0 || recipients.some((recipient) => recipient.trim() === "")) {
      throw new TincanError("INVALID_INPUT", "A push needs at least one non-empty recipient");
    }
    const failure = this.#pushFailures.shift();
    if (failure && failure !== "unconfirmed" && failure !== "pending") {
      this.pushes.push({ recipients, body, outcome: { error: failure } });
      throw new TincanError(failure, "Push failed (scripted)");
    }
    const outcome: PushOutcome = failure ?? "accepted";
    this.pushes.push({ recipients, body, outcome });
    const own = this.ownNumber;
    if (outcome === "accepted" && own && recipients.some((r) => sameNumber(r, own))) {
      this.#mailbox.later(this.#echoDelayMs, () => {
        this.receive({ from: digits(own), name: this.ownerName, body });
      });
    }
    return outcome;
  }

  contactsFor(phonebook: Phonebook): ParsedVCard[] {
    if (phonebook === "pb") {
      const owner = vcard({ name: this.ownerName, tels: this.ownNumber ? [this.ownNumber] : [] });
      // As on iOS, only `fav` marks favourites.
      return [owner, ...this.#contacts.map((card) => ({ ...card, favorite: false }))];
    }
    if (phonebook === "fav") return this.#contacts.filter((card) => card.favorite);
    return this.#calls.get(phonebook) ?? [];
  }

  contactsVersion(phonebook: Phonebook): PhonebookVersion {
    const counter = (phonebook === "pb" || phonebook === "fav" ? this.#contactsVersion : 1)
      .toString(16)
      .padStart(32, "0");
    return {
      folder: `telecom/${phonebook}`,
      databaseIdentifier: "0".repeat(31) + "1",
      primaryCounter: counter,
      secondaryCounter: counter,
    };
  }

  ancsSession(session: FakeAncsSession, add: boolean): void {
    if (add) this.#ancs.add(session);
    else this.#ancs.delete(session);
  }

  mapLink(link: FakeMapLink, add: boolean): void {
    if (add) this.#links.add(link);
    else this.#links.delete(link);
  }

  watch(listener: (event: BtDeviceEvent) => void, add: boolean): void {
    if (add) this.#watchers.add(listener);
    else this.#watchers.delete(listener);
  }

  pair(accepted: boolean): void {
    if (!accepted) throw new TincanError("PERMISSION_DENIED", "Pairing was rejected");
    this.#known = true;
    this.#paired = true;
    this.#broadcastDevice("deviceChanged");
    if (this.#reachable) this.#setConnected(true);
  }

  forget(): void {
    this.#paired = false;
    this.#known = false;
    this.#connected = false;
    for (const link of this.#links) link.lost();
    for (const session of this.#ancs) session.lost();
    const { path, address } = this.device;
    for (const listener of this.#watchers) {
      this.#mailbox.post(() => listener({ kind: "deviceRemoved", path, address }));
    }
  }

  linkUp(up: boolean): void {
    if (up) {
      if (!this.#reachable || !this.#paired) {
        throw new TincanError("NOT_CONNECTED", "The phone is out of range");
      }
      this.#setConnected(true);
      for (const link of this.#links) link.trigger("deviceConnected");
      for (const session of this.#ancs) session.retry();
    } else {
      this.#setConnected(false);
      for (const link of this.#links) link.lost();
      for (const session of this.#ancs) session.lost();
    }
  }

  get known(): boolean {
    return this.#known;
  }

  /** Whether this computer's adapter is visible to the phone (set through Bluetooth). */
  discoverable = false;

  /**
   * The user taps this computer in the iPhone's Settings › Bluetooth, and accepts the code on both
   * screens. The computer must be discoverable for the phone to list it.
   */
  pairFromPhone(): void {
    if (!this.discoverable || !this.#reachable) {
      throw new TincanError("NOT_FOUND", "The phone can't see this computer");
    }
    this.pair(true);
  }

  #setConnected(connected: boolean): void {
    if (this.#connected === connected) return;
    this.#connected = connected;
    this.#broadcastDevice("deviceChanged");
  }

  #broadcastDevice(kind: "deviceAdded" | "deviceChanged"): void {
    const device = this.device;
    for (const listener of this.#watchers) this.#mailbox.post(() => listener({ kind, device }));
  }

  #message(handle: string): FakeMessage {
    const message = this.findMessage(handle);
    if (!message) throw new TincanError("NOT_FOUND", `No message ${handle}`);
    return message;
  }

  #makePort(): PhonePort {
    return {
      Bluetooth: {
        open: async () => new FakeBluetooth(this),
      },
      MapLink: {
        start: async (address, _options, onEvent) => {
          const link = new FakeMapLink(this, address.toUpperCase(), onEvent);
          this.mapLink(link, true);
          link.connect();
          return link;
        },
      },
      PbapSession: {
        open: async (address) => {
          if (address.toUpperCase() !== this.address || !this.known) {
            throw new TincanError("NOT_FOUND", "Unknown device");
          }
          if (!this.online) throw new TincanError("NOT_CONNECTED", "The phone is out of range");
          return new FakePbapSession(this, this.nextSession());
        },
      },
      AncsSession: {
        start: async (address, options, onEvent) => {
          const session = new FakeAncsSession(this, address.toUpperCase(), options, onEvent);
          this.ancsSession(session, true);
          session.retry();
          return session;
        },
      },
      Notifier: {
        open: async (onEvent) => this.desktop.open(onEvent),
      },
    };
  }
}

// ── MAP ──────────────────────────────────────────────────────────────────────────────────────────

class FakeMapLink implements MapLinkHandle {
  readonly #phone: FakePhone;
  readonly #address: string;
  readonly #onEvent: (event: MapLinkEvent) => void;
  #state: MapLinkState = { kind: "stopped" };
  #session: string | null = null;
  #attempt = 0;
  #paused: "sleep" | "adapterDown" | null = null;
  #stopped = false;

  constructor(phone: FakePhone, address: string, onEvent: (event: MapLinkEvent) => void) {
    this.#phone = phone;
    this.#address = address;
    this.#onEvent = onEvent;
  }

  state(): MapLinkState {
    return this.#state;
  }

  trigger(trigger: MapTrigger): void {
    if (this.#stopped) return;
    switch (trigger) {
      case "sleep":
      case "adapterDown":
        if (trigger === "sleep" && this.#paused === "adapterDown") return;
        this.#close();
        this.#paused = trigger;
        this.#setState({ kind: "paused", reason: trigger });
        return;
      case "resume":
        if (this.#paused === "sleep") this.#paused = null;
        return this.#connectNow();
      case "adapterUp":
        if (this.#paused === "adapterDown") this.#paused = null;
        return this.#connectNow();
      case "deviceConnected":
      case "reconnect":
        return this.#connectNow();
      case "deviceDisconnected":
        return;
    }
  }

  async listMessages(folder: string, filter?: MapListFilter | null): Promise<MapListing[]> {
    const session = this.#require();
    const name = folder.replace(/^\/?(telecom\/msg\/)?/, "");
    if (!MAP_FOLDERS.has(name)) throw new TincanError("INVALID_INPUT", `Unknown folder ${folder}`);
    const max = filter?.maxCount;
    if (max !== undefined && (max < 0 || max > 0xffff)) {
      throw new TincanError("INVALID_INPUT", "maxCount must be 0–65535");
    }
    if (name !== "inbox") return [];
    let listed = this.#phone.inbox();
    if (filter?.read !== undefined) listed = listed.filter((m) => m.read === filter.read);
    const offset = filter?.offset ?? 0;
    listed = listed.slice(offset, max === undefined ? undefined : offset + max);
    const subjectLength = filter?.subjectLength ?? 256;
    return listed.map((message) => ({
      handle: message.handle,
      path: `${session}/message${message.handle}`,
      folder: "/telecom/msg/inbox",
      // Code points, not UTF-16 units, so an emoji is never split in half.
      // oxlint-disable-next-line no-misused-spread
      subject: [...message.body].slice(0, subjectLength).join(""),
      timestamp: message.timestamp,
      sender: message.name,
      senderAddress: message.from,
      replyTo: "",
      recipient: "",
      recipientAddress: "",
      type: "sms-gsm",
      size: Buffer.byteLength(message.body),
      status: "complete",
      priority: false,
      read: message.read,
      sent: false,
      protected: false,
    }));
  }

  async getMessage(path: string): Promise<ParsedBMessage> {
    const message = this.#resolve(path);
    const party = message.from.includes("@")
      ? { name: message.name, tel: "", email: message.from }
      : { name: message.name, tel: message.from, email: "" };
    return {
      valid: true,
      version: "1.0",
      read: message.read,
      type: "SMS_GSM",
      folder: "telecom/msg/inbox",
      originator: party,
      recipients: [],
      body: message.body,
      parts: [message.body],
      charset: "UTF-8",
      encoding: "",
      language: "",
      length: Buffer.byteLength(message.body),
      threadKey: rawThreadKey(message.from),
    };
  }

  async setRead(path: string, read: boolean): Promise<void> {
    this.#resolve(path).read = read;
  }

  async pushMessage(recipients: string[], body: string): Promise<PushOutcome> {
    this.#require();
    return this.#phone.push(recipients, body);
  }

  async shutdown(): Promise<void> {
    if (this.#stopped) return;
    this.#close();
    this.#stopped = true;
    this.#phone.mapLink(this, false);
    this.#setState({ kind: "stopped" });
  }

  connect(): void {
    if (this.#stopped || this.#paused || this.#session) return;
    this.#attempt++;
    this.#setState({ kind: "connecting", attempt: this.#attempt });
    const ours = this.#address === this.#phone.address;
    if (ours && this.#phone.online && this.#phone.shareMessages) {
      this.#attempt = 0;
      this.#session = this.#phone.nextSession();
      this.#setState({ kind: "connected", session: this.#session });
      return;
    }
    // Out of range is NOT_CONNECTED; an unknown computer or a phone not offering MAP is NOT_FOUND.
    const code = ours && this.#phone.known && !this.#phone.online ? "NOT_CONNECTED" : "NOT_FOUND";
    this.#emit({
      kind: "openFailed",
      attempt: this.#attempt,
      code,
      message: "Session open failed",
    });
    const delayMs = Math.min(1000 * 2 ** (this.#attempt - 1), 300_000);
    this.#setState({ kind: "waiting", attempt: this.#attempt, delayMs });
  }

  /** The session dropped (obexd removed it); the supervisor tries again at once. */
  lost(): void {
    if (!this.#session) return;
    this.#close();
    this.connect();
  }

  /** The backoff timer fired, or the phone came back. */
  retry(): void {
    if (this.#state.kind === "waiting") this.connect();
  }

  reportNew(message: FakeMessage): void {
    if (!this.#session) return;
    const path = `${this.#session}/message${message.handle}`;
    const handle = message.handle;
    this.#emit({
      kind: "map",
      event: { kind: "messageAdded", handle, path, folder: "inbox", type: "SMS_GSM" },
    });
    this.#emit({
      kind: "map",
      event: { kind: "statusChanged", handle, path, status: "notification" },
    });
  }

  #connectNow(): void {
    this.#attempt = 0;
    this.connect();
  }

  #close(): void {
    if (!this.#session) return;
    this.#session = null;
    this.#emit({ kind: "map", event: { kind: "sessionClosed" } });
  }

  #require(): string {
    if (!this.#session) throw new TincanError("NOT_CONNECTED", "No MAP session is open");
    return this.#session;
  }

  #resolve(path: string): FakeMessage {
    const session = this.#require();
    const prefix = `${session}/message`;
    const message = path.startsWith(prefix)
      ? this.#phone.findMessage(path.slice(prefix.length))
      : undefined;
    if (!message) throw new TincanError("NOT_FOUND", "No such message in this session");
    return message;
  }

  #setState(state: MapLinkState): void {
    this.#state = state;
    this.#emit({ kind: "state", state });
  }

  #emit(event: MapLinkEvent): void {
    this.#phone.mailbox.post(() => this.#onEvent(event));
  }
}

// ── ANCS ─────────────────────────────────────────────────────────────────────────────────────────

class FakeAncsSession implements AncsSessionHandle {
  readonly #phone: FakePhone;
  readonly #address: string;
  readonly #content: boolean;
  readonly #onEvent: (event: AncsSessionEvent) => void;
  /** This subscription's view: phone uid → delivered notification. */
  #delivered = new Map<number, AncsNotification>();
  #recent: AncsNotification[] = [];
  #state: AncsSessionState = { kind: "closed" };
  #nextUid = 0;

  constructor(
    phone: FakePhone,
    address: string,
    options: AncsOptions | null | undefined,
    onEvent: (event: AncsSessionEvent) => void,
  ) {
    this.#phone = phone;
    this.#address = address;
    this.#content = options?.content ?? true;
    this.#onEvent = onEvent;
  }

  state(): AncsSessionState {
    return this.#state;
  }

  async recent(limit?: number | null): Promise<AncsNotification[]> {
    return limit == null ? [...this.#recent] : this.#recent.slice(-limit);
  }

  async performAction(uid: number, action: "positive" | "negative"): Promise<void> {
    if (this.#state.kind !== "ready") throw new TincanError("NOT_CONNECTED", "ANCS is not ready");
    const entry = [...this.#delivered].find(([, n]) => n.uid === uid);
    if (!entry) throw new TincanError("NOT_FOUND", `No notification ${uid}`);
    const [phoneUid, notification] = entry;
    const offered =
      action === "positive" ? notification.hasPositiveAction : notification.hasNegativeAction;
    if (!offered) throw new TincanError("INVALID_INPUT", `No ${action} action on ${uid}`);
    this.#phone.actions.push({ uid, action });
    if (action === "negative") this.#phone.removeNotification(phoneUid);
  }

  async close(): Promise<void> {
    if (this.#state.kind === "closed") return;
    this.#phone.ancsSession(this, false);
    this.#setState({ kind: "closed" });
  }

  post(notification: AncsNotification): void {
    if (this.#state.kind === "ready") this.#deliver(notification, false);
  }

  remove(phoneUid: number): void {
    const delivered = this.#delivered.get(phoneUid);
    if (!delivered) return;
    this.#delivered.delete(phoneUid);
    this.#emit({ kind: "removed", uid: delivered.uid });
  }

  lost(): void {
    if (this.#state.kind === "closed") return;
    this.#delivered.clear();
    this.#setState({
      kind: "unavailable",
      code: "NOT_CONNECTED",
      reason: "The phone disconnected",
    });
  }

  /** Subscribe again: `waiting`, then `ready` with the backlog flagged `preExisting`. */
  retry(): void {
    if (this.#state.kind === "ready") return;
    if (this.#address !== this.#phone.address || !this.#phone.online) {
      if (this.#state.kind !== "unavailable") {
        this.#setState({ kind: "unavailable", code: "NOT_CONNECTED", reason: "Not connected" });
      }
      return;
    }
    if (this.#state.kind !== "waiting") {
      this.#setState({ kind: "waiting", hint: "Turn on Share System Notifications" });
    }
    if (!this.#phone.shareNotifications) return;
    this.#delivered.clear();
    this.#setState({ kind: "ready" });
    for (const notification of this.#phone.notifications) this.#deliver(notification, true);
  }

  #deliver(notification: AncsNotification, preExisting: boolean): void {
    const delivered: AncsNotification = {
      ...notification,
      ...(this.#content ? {} : { title: "", subtitle: "", body: "" }),
      uid: this.#nextUid++,
      preExisting,
    };
    this.#delivered.set(notification.uid, delivered);
    this.#recent.push(delivered);
    if (this.#recent.length > ANCS_RECENT) this.#recent.shift();
    this.#emit({ kind: "notification", notification: delivered });
  }

  #setState(state: AncsSessionState): void {
    this.#state = state;
    this.#emit({ kind: "state", state });
  }

  #emit(event: AncsSessionEvent): void {
    this.#phone.mailbox.post(() => this.#onEvent(event));
  }
}

// ── PBAP ─────────────────────────────────────────────────────────────────────────────────────────

class FakePbapSession implements PbapSessionHandle {
  readonly sessionPath: string;
  readonly #phone: FakePhone;
  #closed = false;

  constructor(phone: FakePhone, sessionPath: string) {
    this.#phone = phone;
    this.sessionPath = sessionPath;
  }

  get closed(): boolean {
    return this.#closed;
  }

  pullContacts(options?: PbapPullOptions): Promise<ParsedVCard[]> {
    return this.pull("pb", options);
  }

  async pull(phonebook: Phonebook, options?: PbapPullOptions): Promise<ParsedVCard[]> {
    this.#require();
    const failure = this.#phone.takePullFailure(options?.photos ?? false);
    if (failure) throw new TincanError(failure, "The pull failed");
    const offset = options?.offset ?? 0;
    const max = options?.maxCount ?? 0xffff;
    return this.#phone
      .contactsFor(phonebook)
      .slice(offset, offset + max)
      .map((card) => (options?.photos ? card : { ...card, photo: undefined }));
  }

  async size(phonebook: Phonebook = "pb"): Promise<number> {
    this.#require();
    return this.#phone.contactsFor(phonebook).length;
  }

  async version(phonebook: Phonebook = "pb"): Promise<PhonebookVersion> {
    this.#require();
    return this.#phone.contactsVersion(phonebook);
  }

  async close(): Promise<void> {
    this.#closed = true;
  }

  #require(): void {
    if (this.#closed) throw new TincanError("NOT_CONNECTED", "The PBAP session is closed");
    if (!this.#phone.online) throw new TincanError("NOT_CONNECTED", "The phone is out of range");
  }
}

// ── Bluetooth ────────────────────────────────────────────────────────────────────────────────────

class FakeBluetooth implements BluetoothHandle {
  readonly #phone: FakePhone;
  #discovering = false;

  constructor(phone: FakePhone) {
    this.#phone = phone;
  }

  async adapter(): Promise<AdapterInfo> {
    return {
      path: "/org/bluez/hci0",
      address: "00:11:22:33:44:55",
      name: "tincan-test",
      alias: "tincan-test",
      powered: true,
      discoverable: this.#phone.discoverable,
      pairable: true,
      discovering: this.#discovering,
      ...(this.#phone.adapterClass === null ? {} : { class: this.#phone.adapterClass }),
    };
  }

  async devices(): Promise<BtDevice[]> {
    const visible = this.#phone.known || (this.#discovering && this.#phone.reachable);
    return visible ? [this.#phone.device] : [];
  }

  async startDiscovery(): Promise<void> {
    this.#discovering = true;
  }

  async stopDiscovery(): Promise<void> {
    this.#discovering = false;
  }

  async setDiscoverable(discoverable: boolean): Promise<void> {
    this.#phone.discoverable = discoverable;
  }

  async pair(
    address: string,
    onRequest: (request: BtPairingRequest) => boolean | Promise<boolean>,
  ): Promise<void> {
    this.#check(address);
    if (!this.#phone.reachable) throw new TincanError("NOT_CONNECTED", "The phone is out of range");
    const accepted = await onRequest(
      this.#phone.pairingRequest === "authorize"
        ? { kind: "authorize", address: this.#phone.address }
        : { kind: "confirm", address: this.#phone.address, passkey: "123456" },
    );
    this.#phone.pair(accepted);
  }

  async cancelPairing(address: string): Promise<void> {
    this.#check(address);
  }

  async connect(address: string): Promise<void> {
    this.#check(address);
    this.#phone.linkUp(true);
  }

  async disconnect(address: string): Promise<void> {
    this.#check(address);
    this.#phone.linkUp(false);
  }

  async forget(address: string): Promise<void> {
    this.#check(address);
    this.#phone.forget();
  }

  async watchDevices(onEvent: (event: BtDeviceEvent) => void): Promise<DeviceWatchHandle> {
    this.#phone.watch(onEvent, true);
    return { close: () => this.#phone.watch(onEvent, false) };
  }

  #check(address: string): void {
    if (address.toUpperCase() !== this.#phone.address) {
      throw new TincanError("NOT_FOUND", "Unknown device");
    }
  }
}

// ── Desktop notifications ────────────────────────────────────────────────────────────────────────

/** Records desktop notifications instead of showing them; `click` and `close` script the user. */
export class FakeDesktop {
  /** Notifications on screen, by id. */
  readonly shown = new Map<number, DesktopNotification>();
  /** Every notification sent, in order. */
  readonly history: Array<DesktopNotification & { id: number }> = [];
  readonly #phone: FakePhone;
  readonly #listeners = new Set<(event: NotifierEvent) => void>();
  #nextId = 1;

  constructor(phone: FakePhone) {
    this.#phone = phone;
  }

  open(onEvent: (event: NotifierEvent) => void): NotifierHandle {
    this.#listeners.add(onEvent);
    return {
      capabilities: async () => ["actions", "body", "persistence"],
      notify: async (notification) => {
        const id =
          notification.replaces && this.shown.has(notification.replaces)
            ? notification.replaces
            : this.#nextId++;
        this.shown.set(id, notification);
        this.history.push({ ...notification, id });
        return id;
      },
      dismiss: async (id) => this.close(id, "closed"),
      close: () => this.#listeners.delete(onEvent),
    };
  }

  /** The user clicks a notification (or one of its actions). */
  click(id: number, action = "default"): void {
    const notification = this.#get(id);
    this.#emit({ kind: "action", id, threadKey: notification.threadKey, action });
    this.close(id, "dismissed");
  }

  close(id: number, reason: "expired" | "dismissed" | "closed" | "undefined" = "dismissed"): void {
    const notification = this.shown.get(id);
    if (!notification) return;
    this.shown.delete(id);
    this.#emit({ kind: "closed", id, threadKey: notification.threadKey, reason });
  }

  #get(id: number): DesktopNotification {
    const notification = this.shown.get(id);
    if (!notification) throw new TincanError("NOT_FOUND", `No notification ${id}`);
    return notification;
  }

  #emit(event: NotifierEvent): void {
    for (const listener of this.#listeners) this.#phone.mailbox.post(() => listener(event));
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────────

/** Delivers callbacks in order on a later turn, like napi threadsafe functions. */
export class Mailbox {
  #queue: Array<() => void> = [];
  #scheduled = false;
  #timers = new Set<Promise<void>>();

  post(callback: () => void): void {
    this.#queue.push(callback);
    if (this.#scheduled) return;
    this.#scheduled = true;
    setImmediate(() => this.#flush());
  }

  later(delayMs: number, callback: () => void): void {
    const timer = new Promise<void>((resolve) =>
      setTimeout(() => {
        this.#timers.delete(timer);
        callback();
        resolve();
      }, delayMs),
    );
    this.#timers.add(timer);
  }

  async settle(): Promise<void> {
    while (this.#scheduled || this.#timers.size > 0) {
      if (this.#timers.size > 0) await Promise.all(this.#timers);
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  #flush(): void {
    this.#scheduled = false;
    const queue = this.#queue;
    this.#queue = [];
    for (const callback of queue) {
      try {
        callback();
      } catch (error) {
        // Surface the listener's bug without losing the rest of the queue.
        setImmediate(() => {
          throw error;
        });
      }
    }
  }
}

function digits(text: string): string {
  return text.replace(/\D/g, "");
}

function sameNumber(a: string, b: string): boolean {
  const x = digits(a);
  const y = digits(b);
  return x.length > 0 && y.length > 0 && x.slice(-10) === y.slice(-10);
}

/** What the native `threadKeyFor` gives: an unnormalised `tel:`, `email:` or `sender:` key. */
function rawThreadKey(address: string): string {
  if (address.includes("@")) return `email:${address.trim().toLowerCase()}`;
  if (/[a-z]/i.test(address)) return `sender:${address.replace(/[\s\x7f]/g, "").toLowerCase()}`;
  const plus = address.trim().startsWith("+") ? "+" : "";
  return `tel:${plus}${digits(address)}`;
}

function vcard(contact: FakeContact): ParsedVCard {
  const parts = contact.name.trim().split(/\s+/);
  const family = parts.length > 1 ? parts.pop()! : "";
  return {
    version: "3.0",
    name: contact.name,
    family,
    given: parts.join(" "),
    tels: (contact.tels ?? []).map((value) => ({ value, types: ["cell"] })),
    emails: (contact.emails ?? []).map((value) => ({ value, types: ["home"] })),
    callType: "",
    callTime: "",
    favorite: contact.favorite ?? false,
    nickname: "",
    organization: contact.organization ?? "",
    department: "",
    title: "",
    birthday: "",
    note: "",
    addresses: (contact.addresses ?? []).map((value) => ({ value, types: ["home"] })),
    urls: (contact.urls ?? []).map((value) => ({ value, types: [] })),
    ...(contact.photo ? { photo: { ...contact.photo, uri: "" } } : {}),
  };
}
