/**
 * A least-recently-used cache capped by entry count and by total size. Each entry carries its own
 * size (for previews, the length of the data URLs it holds); the oldest entries go once either cap
 * is passed. An entry bigger than the whole budget is not kept at all.
 */
export class SizedLru<V> {
  readonly #entries = new Map<string, { value: V; size: number }>();
  readonly #maxEntries: number;
  readonly #maxSize: number;
  #size = 0;

  constructor(options: { maxEntries: number; maxSize: number }) {
    this.#maxEntries = options.maxEntries;
    this.#maxSize = options.maxSize;
  }

  get size(): number {
    return this.#entries.size;
  }

  /** The total size of everything held. */
  get totalSize(): number {
    return this.#size;
  }

  has(key: string): boolean {
    return this.#entries.has(key);
  }

  /** The value, marking it most recently used. */
  get(key: string): V | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V, size = 0): void {
    this.delete(key);
    if (size > this.#maxSize) return;
    this.#entries.set(key, { value, size });
    this.#size += size;
    this.#evict();
  }

  /** Changes an entry's size (a pending fetch that has landed), keeping its place. */
  resize(key: string, size: number): void {
    const entry = this.#entries.get(key);
    if (!entry) return;
    if (size > this.#maxSize) {
      this.delete(key);
      return;
    }
    this.#size += size - entry.size;
    entry.size = size;
    this.#evict(key);
  }

  delete(key: string): boolean {
    const entry = this.#entries.get(key);
    if (!entry) return false;
    this.#entries.delete(key);
    this.#size -= entry.size;
    return true;
  }

  keys(): IterableIterator<string> {
    return this.#entries.keys();
  }

  /** Drops the oldest entries until both caps hold, sparing `keep` (the one just changed). */
  #evict(keep?: string): void {
    for (const [key, entry] of this.#entries) {
      if (this.#entries.size <= this.#maxEntries && this.#size <= this.#maxSize) return;
      if (key === keep) continue;
      this.#entries.delete(key);
      this.#size -= entry.size;
    }
  }
}
