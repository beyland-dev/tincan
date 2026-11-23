import { errorCodeOf, TincanError, type device } from "@beyland/tincan-protocol";
import { isHandsFree } from "./doctor.ts";
import type { EventBus } from "./events.ts";
import type { BluetoothHandle, BtDevice, BtPairingRequest } from "./phone.ts";

export type PairingStatus = device.PairingStatus;

export interface PairingOptions {
  /** This computer's Bluetooth, or null when there is none. */
  bluetooth: () => BluetoothHandle | null;
  events: EventBus;
  /** An iPhone paired with this computer, either way round. */
  onPaired: (device: BtDevice) => void | Promise<void>;
  onError?: (context: string, error: unknown) => void;
  /** How often to look for iPhones while searching (default 2 s). */
  pollMs?: number;
  /** How long to search before giving up (default 2 min, inside BlueZ's 3 min discoverable timeout). */
  timeoutMs?: number;
  /** How long to look for an address that isn't known yet before pairing it (default 15 s). */
  findMs?: number;
}

const IDLE: PairingStatus = {
  state: "idle",
  candidates: [],
  address: null,
  name: null,
  passkey: null,
  adapterName: null,
  discoverable: false,
  handsFree: null,
  error: null,
};

/**
 * Pairs a new iPhone: searches for iPhones while making this computer visible to them, pairs the
 * one the user picks (passing the passkey to the user to compare), and notices an iPhone that pairs
 * from its own Settings › Bluetooth meanwhile. Only one pairing runs at a time.
 */
export class Pairing {
  readonly #options: PairingOptions;
  readonly #pollMs: number;
  readonly #timeoutMs: number;
  readonly #findMs: number;
  #status: PairingStatus = IDLE;
  /** Bumped on every start and cancel, so a stale attempt's results are dropped. */
  #attempt = 0;
  #poll: ReturnType<typeof setInterval> | null = null;
  #timeout: ReturnType<typeof setTimeout> | null = null;
  #answer: ((accept: boolean) => void) | null = null;
  /** Paired iPhones when the search began; any other that turns up paired paired from the phone. */
  #pairedBefore = new Set<string>();
  /** The search made this computer discoverable, so hide it again afterwards. */
  #madeDiscoverable = false;
  #discovering = false;
  /** The attempt that declined a pairing request without a code. */
  #declinedUnverified = -1;

  constructor(options: PairingOptions) {
    this.#options = options;
    this.#pollMs = options.pollMs ?? 2_000;
    this.#timeoutMs = options.timeoutMs ?? 120_000;
    this.#findMs = options.findMs ?? 15_000;
  }

  status(): PairingStatus {
    return structuredClone(this.#status);
  }

  get active(): boolean {
    return ["searching", "pairing", "confirm"].includes(this.#status.state);
  }

  /** Starts searching, or pairs `address` (from the search's candidates, or one already known). */
  async start(input: { address?: string } = {}): Promise<PairingStatus> {
    const bt = this.#bluetooth();
    const address = input.address?.toUpperCase();
    if (this.#status.state === "pairing" || this.#status.state === "confirm") {
      if (address && address === this.#status.address) return this.status();
      throw new TincanError("BUSY", "Already pairing an iPhone; cancel it first");
    }
    if (!address && this.#status.state === "searching") return this.status();

    const adapter = await bt.adapter();
    if (!adapter) throw new TincanError("NOT_FOUND", "This computer has no Bluetooth adapter");
    if (!adapter.powered) throw new TincanError("NOT_CONNECTED", "Bluetooth is turned off");
    const adapterName = adapter.alias || adapter.name;
    const handsFree = isHandsFree(adapter.class);

    if (address) {
      const searching = this.#status.state === "searching";
      const attempt = searching ? this.#attempt : ++this.#attempt;
      this.#stopTimers();
      const candidate = this.#status.candidates.find((c) => c.address === address);
      this.#set({
        ...IDLE,
        state: "pairing",
        address,
        name: candidate?.name ?? null,
        adapterName,
        handsFree,
        discoverable: searching ? this.#status.discoverable : adapter.discoverable,
      });
      void this.#pair(bt, address, attempt);
      return this.status();
    }

    const attempt = ++this.#attempt;
    const devices = await bt.devices();
    this.#pairedBefore = new Set(devices.filter((d) => d.paired && d.isIphone).map(key));
    this.#set({
      ...IDLE,
      state: "searching",
      adapterName,
      handsFree,
      discoverable: adapter.discoverable,
    });
    try {
      await bt.startDiscovery();
      this.#discovering = true;
    } catch (error) {
      this.#fail(attempt, error);
      throw error;
    }
    if (!adapter.discoverable) {
      try {
        await bt.setDiscoverable(true);
        this.#madeDiscoverable = true;
        this.#update(attempt, { discoverable: true });
      } catch (error) {
        // Laptop-initiated pairing still works; the iPhone just can't find this computer.
        this.#options.onError?.("bluetooth.setDiscoverable", error);
      }
    }
    if (attempt !== this.#attempt) return this.status();
    this.#poll = setInterval(() => void this.#refresh(bt, attempt), this.#pollMs);
    this.#timeout = setTimeout(
      () =>
        this.#fail(
          attempt,
          new TincanError(
            "TIMEOUT",
            "No iPhone paired. Keep the iPhone unlocked on Settings › Bluetooth, near this computer.",
          ),
        ),
      this.#timeoutMs,
    );
    await this.#refresh(bt, attempt);
    return this.status();
  }

  /** Accepts or rejects the passkey both screens show. */
  async confirm(accept: boolean): Promise<PairingStatus> {
    const answer = this.#answer;
    if (this.#status.state !== "confirm" || !answer) {
      throw new TincanError("INVALID_INPUT", "There's no pairing code to confirm");
    }
    this.#answer = null;
    this.#set({ ...this.#status, state: "pairing", passkey: null });
    answer(accept);
    return this.status();
  }

  /** Stops searching or pairing and returns to idle. */
  async cancel(): Promise<PairingStatus> {
    const { state, address } = this.#status;
    ++this.#attempt;
    this.#answer?.(false);
    this.#answer = null;
    const bt = this.#options.bluetooth();
    if (bt && address && (state === "pairing" || state === "confirm")) {
      await bt.cancelPairing(address).catch(() => {});
    }
    await this.#cleanup(bt);
    this.#set(IDLE);
    return this.status();
  }

  /** Stops whatever is under way (the daemon is stopping). */
  async close(): Promise<void> {
    if (this.active) await this.cancel();
  }

  async #pair(bt: BluetoothHandle, address: string, attempt: number): Promise<void> {
    try {
      await this.#find(bt, address, attempt);
      if (this.#discovering) {
        // BlueZ pairs more reliably with discovery off.
        await bt.stopDiscovery().catch(() => {});
        this.#discovering = false;
      }
      if (attempt !== this.#attempt) return;
      await bt.pair(address, (request) => this.#request(request, attempt));
      if (attempt !== this.#attempt) return;
      const paired = (await bt.devices()).find((d) => key(d) === address);
      if (!paired?.paired) throw new TincanError("INTERNAL", "The iPhone didn't finish pairing");
      await this.#finish(bt, paired, attempt);
    } catch (error) {
      this.#fail(attempt, error);
    }
  }

  /** Waits for `address` to show up, searching if it isn't known yet. */
  async #find(bt: BluetoothHandle, address: string, attempt: number): Promise<void> {
    const deadline = Date.now() + this.#findMs;
    for (;;) {
      const device = (await bt.devices()).find((d) => key(d) === address);
      if (device) {
        if (this.#status.name === null) this.#update(attempt, { name: nameOf(device) });
        return;
      }
      if (attempt !== this.#attempt) return;
      if (Date.now() >= deadline) {
        throw new TincanError(
          "NOT_FOUND",
          "That iPhone isn't in range. Unlock it, open Settings › Bluetooth and try again.",
        );
      }
      if (!this.#discovering) {
        await bt.startDiscovery();
        this.#discovering = true;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(this.#pollMs, 500)));
    }
  }

  #request(request: BtPairingRequest, attempt: number): boolean | Promise<boolean> {
    if (attempt !== this.#attempt) return false;
    if (request.kind === "authorize") {
      // "Just Works" pairing has no code to compare, so nothing stops someone in radio range
      // from sitting in the middle. iPhones always pair with a code; this isn't one.
      this.#declinedUnverified = attempt;
      return false;
    }
    this.#answer?.(false);
    return new Promise<boolean>((resolve) => {
      this.#answer = resolve;
      this.#set({ ...this.#status, state: "confirm", passkey: request.passkey });
    });
  }

  async #refresh(bt: BluetoothHandle, attempt: number): Promise<void> {
    let devices: BtDevice[];
    try {
      devices = await bt.devices();
    } catch (error) {
      this.#options.onError?.("bluetooth.devices", error);
      return;
    }
    if (attempt !== this.#attempt || this.#status.state !== "searching") return;
    const fromPhone = devices.find(
      (d) => d.isIphone && d.paired && !this.#pairedBefore.has(key(d)),
    );
    if (fromPhone) {
      this.#stopTimers();
      this.#set({ ...this.#status, state: "pairing", address: key(fromPhone) });
      await this.#finish(bt, fromPhone, attempt);
      return;
    }
    const candidates = devices
      .filter((d) => d.isIphone && !d.paired)
      .map((d) => ({ address: key(d), name: nameOf(d) }));
    if (JSON.stringify(candidates) !== JSON.stringify(this.#status.candidates)) {
      this.#update(attempt, { candidates });
    }
  }

  async #finish(bt: BluetoothHandle, device: BtDevice, attempt: number): Promise<void> {
    const hidden = this.#madeDiscoverable;
    await this.#cleanup(bt);
    if (attempt !== this.#attempt) return;
    this.#set({
      ...this.#status,
      state: "paired",
      address: key(device),
      name: nameOf(device),
      passkey: null,
      candidates: [],
      discoverable: this.#status.discoverable && !hidden,
      error: null,
    });
    try {
      await this.#options.onPaired(device);
    } catch (error) {
      this.#options.onError?.("pairing.onPaired", error);
    }
  }

  #fail(attempt: number, error: unknown): void {
    if (attempt !== this.#attempt) return;
    ++this.#attempt;
    this.#answer = null;
    const code = errorCodeOf(error);
    const message =
      code === "PERMISSION_DENIED"
        ? this.#declinedUnverified === attempt
          ? "Declined: the device asked to pair without a code to compare. iPhones always show a code, so it may not be your iPhone. Try again next to your iPhone."
          : "Pairing was declined"
        : error instanceof Error
          ? error.message
          : String(error);
    this.#set({
      ...this.#status,
      state: "failed",
      passkey: null,
      discoverable: this.#status.discoverable && !this.#madeDiscoverable,
      error: { code, message },
    });
    void this.#cleanup(this.#options.bluetooth());
  }

  /** Stops searching and hides this computer again, if the search made it visible. */
  async #cleanup(bt: BluetoothHandle | null): Promise<void> {
    this.#stopTimers();
    if (!bt) return;
    if (this.#discovering) {
      this.#discovering = false;
      await bt.stopDiscovery().catch(() => {});
    }
    if (this.#madeDiscoverable) {
      this.#madeDiscoverable = false;
      await bt.setDiscoverable(false).catch(() => {});
    }
  }

  #stopTimers(): void {
    if (this.#poll) clearInterval(this.#poll);
    if (this.#timeout) clearTimeout(this.#timeout);
    this.#poll = null;
    this.#timeout = null;
  }

  #bluetooth(): BluetoothHandle {
    const bt = this.#options.bluetooth();
    if (!bt) throw new TincanError("NOT_CONNECTED", "Bluetooth isn't available");
    return bt;
  }

  #update(attempt: number, patch: Partial<PairingStatus>): void {
    if (attempt === this.#attempt) this.#set({ ...this.#status, ...patch });
  }

  #set(status: PairingStatus): void {
    const changed = JSON.stringify(status) !== JSON.stringify(this.#status);
    this.#status = status;
    if (changed) this.#options.events.emit("pairing.changed", { state: status.state });
  }
}

function key(device: BtDevice): string {
  return device.address.toUpperCase();
}

function nameOf(device: BtDevice): string {
  return device.alias || device.name || device.address;
}
