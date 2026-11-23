import type { EventData, EventName, TincanEvent } from "@beyland/tincan-protocol";

export type EventListener = (event: TincanEvent) => void;

/** In-process event fan-out with a monotonically increasing sequence number. */
export class EventBus {
  #seq = 0;
  #listeners = new Set<EventListener>();

  get seq(): number {
    return this.#seq;
  }

  emit<E extends EventName>(event: E, data: EventData<E>): TincanEvent {
    const message = { event, seq: ++this.#seq, data } as TincanEvent;
    for (const listener of this.#listeners) {
      try {
        listener(message);
      } catch {
        // A failing listener must not stop delivery to the others.
      }
    }
    return message;
  }

  subscribe(listener: EventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}
