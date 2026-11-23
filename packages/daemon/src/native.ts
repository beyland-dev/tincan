import type { NativeInfo, PhonePort } from "@beyland/tincan-core";
import type * as Native from "@beyland/tincan-native";

/** Kept in a variable so a missing addon is a runtime condition, not a build error. */
const NATIVE_PACKAGE = "@beyland/tincan-native";

export interface LoadedNative {
  info: NativeInfo;
  module: Record<string, unknown> | null;
  /** The addon as the core's phone port. */
  port: PhonePort | null;
}

/** Load the Rust addon if it is installed and built for this machine. */
export async function loadNative(specifier: string = NATIVE_PACKAGE): Promise<LoadedNative> {
  try {
    const module = (await import(specifier)) as Record<string, unknown>;
    const exported = (module.default ?? module) as Record<string, unknown>;
    const versionFn = exported.nativeVersion ?? exported.version;
    const version =
      typeof versionFn === "function"
        ? String((versionFn as () => unknown)())
        : typeof versionFn === "string"
          ? versionFn
          : null;
    // `satisfies` makes the typecheck fail if the addon's API drifts from the core's port.
    const port = exported as unknown as typeof Native satisfies PhonePort;
    return { info: { loaded: true, version, error: null }, module: exported, port };
  } catch (error) {
    const message =
      (error as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND"
        ? `${NATIVE_PACKAGE} is not installed or not built (run \`pnpm build:native\`)`
        : (error as Error).message;
    return { info: { loaded: false, version: null, error: message }, module: null, port: null };
  }
}
