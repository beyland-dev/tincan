# 0004. Run the daemon as Node, never as an Electron main process

- **Status:** Accepted
- **Date:** 2026-10-31

## Context

The daemon is always on. It comes from two sources: the npm CLI, which uses system Node, and the
AppImage, which only contains Electron's binary. The plan assumed Electron would run in a windowless
`--daemon` mode.

The Phase 0.2 and 0.4 spike loaded the addon and measured the PSS of the whole process tree after it
went idle. See [the Phase 0 notes](../history/native-phase-0.md#addon-in-node-and-electron-phase-02-and-04-2026-10-31).

| Runtime                                   | Processes | PSS    |
| ----------------------------------------- | --------- | ------ |
| System Node 24                            | 1         | 24 MB  |
| Electron 45 with `ELECTRON_RUN_AS_NODE=1` | 1         | 81 MB  |
| Electron 45 main, no window, GPU disabled | 7         | 173 MB |

## Decision

- From the AppImage, the daemon runs the bundled Electron binary with `ELECTRON_RUN_AS_NODE=1`.
  `tincan service install` writes that into the unit's environment.
- From npm, it runs on system Node ≥ 22.18.
- The daemon never imports `electron`. Notifications, the tray and the window belong to the desktop
  app, which talks to the daemon over the socket.
- The packaged app keeps Electron's `runAsNode` fuse enabled.

## Consequences

- An idle AppImage daemon costs about 81 MB instead of 173 MB, in one process instead of seven.
- Anything the daemon needs from the desktop session, such as notifications, has to come from D-Bus
  or the addon, not from Electron APIs.
- Leaving `runAsNode` enabled means the AppImage can run arbitrary scripts as Node. That is no worse
  than the system Node the npm path already uses.
- A Node single-executable app is still an option if the AppImage daemon needs to be smaller.
