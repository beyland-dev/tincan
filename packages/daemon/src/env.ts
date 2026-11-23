/**
 * The environment for programs the daemon starts. The packaged daemon runs the Electron binary as
 * Node with `ELECTRON_RUN_AS_NODE=1`; passed on, it would turn any Electron app those programs
 * start into plain Node.
 */
export function childEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out = { ...env };
  delete out.ELECTRON_RUN_AS_NODE;
  return out;
}
