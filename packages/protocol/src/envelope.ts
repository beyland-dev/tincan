import { z } from "zod";
import { AgentDraftState, AgentVisibleSettings, ClientInfo, Settings } from "./entities.ts";
import { WireError } from "./errors.ts";

/** Bumped on incompatible envelope or contract changes. */
export const PROTOCOL_VERSION = 2 as const;

/** Lines longer than this (in characters) are rejected so a bad peer can't exhaust memory. */
export const MAX_LINE_LENGTH = 4 * 1024 * 1024;

/** Methods the transport handles itself (not commands): subscribe this connection to events. */
export const TRANSPORT_METHODS = ["events.subscribe", "events.unsubscribe"] as const;

export const RequestId = z.union([z.number().int(), z.string().min(1).max(64)]);
export type RequestId = z.infer<typeof RequestId>;

export const Request = z.object({
  id: RequestId,
  method: z.string().min(1),
  params: z.unknown().optional(),
  client: ClientInfo,
});
export type Request = z.infer<typeof Request>;

export const SuccessResponse = z.object({ id: RequestId, result: z.unknown() });
export const ErrorResponse = z.object({ id: RequestId.nullable(), error: WireError });
export const Response = z.union([SuccessResponse, ErrorResponse]);
export type SuccessResponse = z.infer<typeof SuccessResponse>;
export type ErrorResponse = z.infer<typeof ErrorResponse>;
export type Response = z.infer<typeof Response>;

export const Hello = z.object({
  hello: z.object({
    protocolVersion: z.number().int(),
    server: z.object({ name: z.string(), version: z.string() }),
    methods: z.array(z.string()),
  }),
});
export type Hello = z.infer<typeof Hello>;

export const eventSchemas = {
  "daemon.stopping": z.object({}),
  /** The phone, or this computer's adapter (its address), changed; read `device.info`. */
  "device.changed": z.object({ address: z.string() }),
  "sync.changed": z.object({ state: z.string() }),
  /** Pairing a new iPhone moved on; read `device.pair.status` for the details. */
  "pairing.changed": z.object({ state: z.string() }),
  /** The phone's notification subscription (ANCS): `waiting`, `ready`, `unavailable`, `closed`. */
  "notifications.changed": z.object({ state: z.string() }),
  "thread.changed": z.object({ keys: z.array(z.string()) }),
  "message.changed": z.object({ threadKey: z.string(), ids: z.array(z.string()) }),
  "message.sendStatus": z.object({ id: z.string(), status: z.string() }),
  "contact.changed": z.object({ ids: z.array(z.string()) }),
  /**
   * An agent draft was created or changed (its text, or its state). `threadKey` is the key of the
   * conversation it belongs to (or will, once it's sent). Agents get `{ id, state }` for their own
   * drafts only, even when they may not read the conversation.
   */
  "draft.changed": z.object({
    id: z.string(),
    state: AgentDraftState,
    threadKey: z.string().optional(),
  }),
  /** The settings changed. Agents get only the agent policy (`AgentVisibleSettings`), as `settings.get`. */
  "settings.changed": z.union([Settings, AgentVisibleSettings]),
} as const;

export type EventName = keyof typeof eventSchemas;
export type EventData<E extends EventName> = z.output<(typeof eventSchemas)[E]>;
export const EVENT_NAMES = Object.keys(eventSchemas) as EventName[];

export const EventMessage = z.object({
  event: z.string(),
  seq: z.number().int().nonnegative(),
  data: z.unknown(),
});
export type EventMessage = z.infer<typeof EventMessage>;

export type TincanEvent = {
  [E in EventName]: { event: E; seq: number; data: EventData<E> };
}[EventName];

export const ServerMessage = z.union([Hello, SuccessResponse, ErrorResponse, EventMessage]);
export type ServerMessage = z.infer<typeof ServerMessage>;

export function encodeLine(message: unknown): string {
  return `${JSON.stringify(message)}\n`;
}

/**
 * Splits a byte stream into JSON lines. Throws when a single line exceeds
 * `maxLineLength` characters; the caller should drop the connection.
 */
export class LineDecoder {
  #buffer = "";
  readonly #maxLineLength: number;
  readonly #decoder = new TextDecoder();

  constructor(maxLineLength = MAX_LINE_LENGTH) {
    this.#maxLineLength = maxLineLength;
  }

  push(chunk: Uint8Array | string): string[] {
    const text = typeof chunk === "string" ? chunk : this.#decoder.decode(chunk, { stream: true });
    // Only the new text is scanned for newlines, so a long line arriving in many small chunks
    // costs linear, not quadratic, time.
    let newline = text.indexOf("\n");
    if (newline === -1) {
      this.#buffer += text;
      this.#checkLength(this.#buffer.length);
      return [];
    }
    const lines: string[] = [];
    let start = 0;
    let line = this.#buffer + text.slice(0, newline);
    for (;;) {
      this.#checkLength(line.length);
      if (line.trim() !== "") lines.push(line);
      start = newline + 1;
      newline = text.indexOf("\n", start);
      if (newline === -1) break;
      line = text.slice(start, newline);
    }
    this.#buffer = text.slice(start);
    this.#checkLength(this.#buffer.length);
    return lines;
  }

  #checkLength(length: number): void {
    if (length > this.#maxLineLength) {
      throw new Error(`Line exceeds ${this.#maxLineLength} characters`);
    }
  }
}
