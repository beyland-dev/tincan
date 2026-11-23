/**
 * Hybrid logical clocks (Kulkarni et al.): a timestamp that follows the wall clock but never goes
 * backwards and orders every event a computer has seen before the ones it creates next, even when
 * computers' clocks disagree.
 *
 * Encoded as `<ms, 15 digits>-<counter, 4 hex>-<origin>` so that plain string comparison is the
 * clock order, with the origin breaking ties between computers.
 */

const MAX_COUNTER = 0xffff;

export interface HlcParts {
  time: number;
  counter: number;
  origin: string;
}

export function formatHlc({ time, counter, origin }: HlcParts): string {
  return `${String(time).padStart(15, "0")}-${counter.toString(16).padStart(4, "0")}-${origin}`;
}

export function parseHlc(value: string): HlcParts {
  const match = /^(\d{15})-([0-9a-f]{4})-(.+)$/.exec(value);
  if (!match) throw new TypeError("Not a hybrid logical clock value");
  return { time: Number(match[1]), counter: parseInt(match[2]!, 16), origin: match[3]! };
}

/** Negative if `a` happened before `b`, positive if after, 0 if they are the same event. */
export function compareHlc(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The version of a row that wins a merge: the one written last by the clock. */
export function lastWriterWins<T extends { updatedAt: string }>(local: T, remote: T): T {
  return compareHlc(remote.updatedAt, local.updatedAt) > 0 ? remote : local;
}

export class HybridClock {
  readonly origin: string;
  readonly #wall: () => number;
  #time: number;
  #counter: number;

  /** `last` is the newest value this computer has issued or seen, to stay monotonic across restarts. */
  constructor(origin: string, wall: () => number, last?: string) {
    this.origin = origin;
    this.#wall = wall;
    const parts = last ? parseHlc(last) : { time: 0, counter: 0 };
    this.#time = parts.time;
    this.#counter = parts.counter;
  }

  /** The newest value issued or observed. */
  get last(): string {
    return formatHlc({ time: this.#time, counter: this.#counter, origin: this.origin });
  }

  /** A new value for a local change, later than every value issued or observed so far. */
  now(): string {
    const time = Math.max(this.#time, this.#wall());
    this.#set(time, time === this.#time ? this.#counter + 1 : 0);
    return this.last;
  }

  /** Records a value from another computer, so later local changes order after it. */
  observe(remote: string): void {
    const r = parseHlc(remote);
    const time = Math.max(this.#time, r.time, this.#wall());
    let counter = 0;
    if (time === this.#time && time === r.time) counter = Math.max(this.#counter, r.counter) + 1;
    else if (time === this.#time) counter = this.#counter + 1;
    else if (time === r.time) counter = r.counter + 1;
    this.#set(time, counter);
  }

  #set(time: number, counter: number): void {
    // A counter overflow borrows the next millisecond rather than wrapping.
    if (counter > MAX_COUNTER) {
      this.#time = time + 1;
      this.#counter = 0;
    } else {
      this.#time = time;
      this.#counter = counter;
    }
  }
}
