export { TincanClient, type ConnectOptions } from "./client.ts";
export { ensureDaemon, type EnsureDaemonOptions } from "./ensure.ts";
export { ReconnectingClient, type ConnectionState, type ReconnectOptions } from "./reconnect.ts";
export { runtimePaths, type RuntimePaths } from "@beyland/tincan-protocol/paths";
export { verifySocket } from "./socket-check.ts";
