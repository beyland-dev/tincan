import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { encodeLine, PROTOCOL_VERSION } from "@beyland/tincan-protocol";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { TincanClient, verifySocket } from "../src/index.ts";

const client = { kind: "cli", name: "test" } as const;
let root: string;
let server: net.Server | undefined;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "tincan-socket-check-"));
});

afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
  await rm(root, { recursive: true, force: true });
});

async function listen(socketPath: string): Promise<void> {
  server = net.createServer((socket) =>
    socket.write(
      encodeLine({
        hello: {
          protocolVersion: PROTOCOL_VERSION,
          server: { name: "tincan", version: "t" },
          methods: [],
        },
      }),
    ),
  );
  await new Promise<void>((r) => server!.listen(socketPath, r));
}

describe("verifySocket", () => {
  it("accepts a socket we own in a private directory", async () => {
    const dir = path.join(root, "tincan");
    await mkdir(dir, { mode: 0o700 });
    const socketPath = path.join(dir, "tincan.sock");
    await listen(socketPath);
    await expect(verifySocket(socketPath)).resolves.toBeUndefined();
    const connected = await TincanClient.connect({ socketPath, client });
    await connected.close();
  });

  it("refuses a directory others can reach, before connecting", async () => {
    const dir = path.join(root, "tincan");
    await mkdir(dir, { mode: 0o700 });
    const socketPath = path.join(dir, "tincan.sock");
    await listen(socketPath);
    let connections = 0;
    server!.on("connection", () => connections++);
    for (const mode of [0o755, 0o770, 0o1777]) {
      await chmod(dir, mode);
      await expect(TincanClient.connect({ socketPath, client })).rejects.toMatchObject({
        code: "PERMISSION_DENIED",
        message: expect.stringContaining("only be accessible by you"),
      });
    }
    expect(connections).toBe(0);
  });

  it("refuses something at the socket path that isn't a socket", async () => {
    const socketPath = path.join(root, "tincan.sock");
    await writeFile(socketPath, "");
    await expect(verifySocket(socketPath)).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });

  it("refuses a directory owned by another user", async () => {
    // `/` is owned by root; a non-root test runner can't own it.
    if (process.getuid?.() === 0) return;
    await expect(verifySocket("/tincan.sock")).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
      message: expect.stringContaining("owned by another user"),
    });
  });

  it("follows a symlinked directory to the real one and checks that", async () => {
    const real = path.join(root, "real");
    await mkdir(real, { mode: 0o755 });
    const link = path.join(root, "link");
    await symlink(real, link);
    await expect(verifySocket(path.join(link, "tincan.sock"))).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
  });

  it("reports a missing directory or socket as not running", async () => {
    await expect(verifySocket(path.join(root, "nope", "tincan.sock"))).rejects.toMatchObject({
      code: "NOT_CONNECTED",
    });
    await expect(verifySocket(path.join(root, "tincan.sock"))).rejects.toMatchObject({
      code: "NOT_CONNECTED",
    });
  });
});
