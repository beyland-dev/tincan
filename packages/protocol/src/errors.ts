import { z } from "zod";

export const ERROR_CODES = [
  "NOT_FOUND",
  "INVALID_INPUT",
  "CONFLICT",
  /** No phone connected, or the Bluetooth stack is unavailable. */
  "NOT_CONNECTED",
  /** Another computer (or another daemon) holds the phone's MAP session. */
  "BUSY",
  /** The phone or the user's agent policy refused the request. */
  "PERMISSION_DENIED",
  "TIMEOUT",
  /** The client and daemon speak different protocol versions. */
  "PROTOCOL_MISMATCH",
  "INTERNAL",
] as const;

export const ErrorCode = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const WireError = z.object({
  code: ErrorCode,
  message: z.string(),
  details: z.unknown().optional(),
});
export type WireError = z.infer<typeof WireError>;

export class TincanError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "TincanError";
    this.code = code;
    this.details = details;
  }

  toWire(): WireError {
    return this.details === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, details: this.details };
  }

  static fromWire(error: WireError): TincanError {
    return new TincanError(error.code, error.message, error.details);
  }
}

export function isTincanError(error: unknown): error is TincanError {
  return error instanceof TincanError;
}

/** The `TincanError` code an error carries (native errors too), else `INTERNAL`. */
export function errorCodeOf(error: unknown): ErrorCode {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && (ERROR_CODES as readonly string[]).includes(code)
    ? (code as ErrorCode)
    : "INTERNAL";
}

/** Any thrown value as a wire error; unknown errors become INTERNAL. */
export function toWireError(error: unknown): WireError {
  if (isTincanError(error)) return error.toWire();
  const message = error instanceof Error ? error.message : String(error);
  return { code: "INTERNAL", message };
}
