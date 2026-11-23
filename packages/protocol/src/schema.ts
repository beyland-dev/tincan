import { z } from "zod";
import { describeContracts } from "./contracts/index.ts";
import { ErrorCode } from "./errors.ts";
import {
  EventMessage,
  eventSchemas,
  Hello,
  PROTOCOL_VERSION,
  Request,
  Response,
} from "./envelope.ts";

const json = (schema: z.ZodType) =>
  z.toJSONSchema(schema, { unrepresentable: "any" }) as Record<string, unknown>;

/** A single JSON document describing the whole protocol, for tools outside the monorepo. */
export function protocolSchema() {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "Tincan protocol",
    protocolVersion: PROTOCOL_VERSION,
    transport: "Newline-delimited JSON over the Unix socket $XDG_RUNTIME_DIR/tincan/tincan.sock",
    envelope: {
      request: json(Request),
      response: json(Response),
      hello: json(Hello),
      event: json(EventMessage),
    },
    errorCodes: ErrorCode.options,
    events: Object.fromEntries(Object.entries(eventSchemas).map(([name, s]) => [name, json(s)])),
    commands: describeContracts({ includeInternal: true }),
  };
}
