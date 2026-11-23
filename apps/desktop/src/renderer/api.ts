import type { ContractName, ErrorCode, InputOf, OutputOf } from "@beyland/tincan-protocol";
import type { TincanBridge } from "../shared/bridge.ts";

declare global {
  interface Window {
    tincan: TincanBridge;
  }
}

export class CommandError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** Run a daemon command through the main process. */
export async function call<N extends ContractName>(
  name: N,
  input: InputOf<N>,
): Promise<OutputOf<N>> {
  const response = await window.tincan.run(name, input);
  if (!response.ok) throw new CommandError(response.error.code, response.error.message);
  return response.result as OutputOf<N>;
}
