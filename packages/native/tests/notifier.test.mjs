// Desktop notifications without a desktop: every scenario drives a `Notifier`
// in a child process whose session (and system) bus is a private dbus-daemon,
// on which the `fake_notifications` example (crates/tincan-bt) serves
// `org.freedesktop.Notifications`. Nothing here can pop up a real
// notification. A child that never exits means a leaked callback.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { dbusDaemon, startPrivateBus } from "./private-bus.mjs";

const indexUrl = new URL("../index.js", import.meta.url);
const root = fileURLToPath(new URL("../../..", import.meta.url));
const fakeNotifications = join(root, "target/debug/examples/fake_notifications");

let native;
try {
  native = await import(indexUrl.href);
} catch {}

function skipReason() {
  if (!native) return "addon not built (run `pnpm build:native`)";
  if (!dbusDaemon) return "no dbus-daemon";
  return false;
}

/** Reads a stream line by line; `next()` resolves the next unread line, or null at its end. */
function lines(stream, name) {
  const queue = [];
  const waiting = [];
  let text = "";
  let ended = false;
  stream.on("end", () => {
    ended = true;
    for (const resolve of waiting.splice(0)) resolve(null);
  });
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    text += chunk;
    let i;
    while ((i = text.indexOf("\n")) >= 0) {
      const line = text.slice(0, i);
      text = text.slice(i + 1);
      const resolve = waiting.shift();
      if (resolve) resolve(line);
      else queue.push(line);
    }
  });
  return {
    next(timeout = 5000) {
      if (queue.length) return Promise.resolve(queue.shift());
      if (ended) return Promise.resolve(null);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`${name}: no line in ${timeout}ms`)),
          timeout,
        );
        waiting.push((line) => {
          clearTimeout(timer);
          resolve(line);
        });
      });
    },
  };
}

// The child: one JSON request per stdin line ({ op, args }), one JSON reply per
// line ({ result } or { error }), and an { event } line per notifier event.
const childScript = `
  const native = await import(${JSON.stringify(indexUrl.href)});
  const { createInterface } = await import("node:readline");
  const say = (x) => process.stdout.write(JSON.stringify(x) + "\\n");
  let notifier;
  for await (const line of createInterface({ input: process.stdin })) {
    const { op, args } = JSON.parse(line);
    try {
      let result = null;
      if (op === "open") {
        notifier = await native.Notifier.open((event) => say({ event }), args);
      } else if (op === "close") {
        notifier.close();
      } else {
        result = (await notifier[op](args)) ?? null;
      }
      say({ result });
    } catch (e) {
      say({ error: e.code, message: e.message });
    }
  }`;

/** A child process holding one `Notifier`, driven with `call()`. */
function startChild(busAddress) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", childScript], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: {
      ...process.env,
      DBUS_SESSION_BUS_ADDRESS: busAddress,
      DBUS_SYSTEM_BUS_ADDRESS: busAddress,
    },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  const out = lines(child.stdout, "child");
  const replies = [];
  const events = [];
  const pump = async () => {
    for (;;) {
      const line = await out.next(60_000).catch(() => null);
      if (line === null) return;
      const message = JSON.parse(line);
      (message.event ? events : replies).push(message.event ?? message);
    }
  };
  void pump();
  const until = async (list, what) => {
    for (let i = 0; i < 500 && list.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    if (list.length === 0) throw new Error(`no ${what} from the child`);
    return list.shift();
  };
  return {
    async call(op, args) {
      child.stdin.write(JSON.stringify({ op, args }) + "\n");
      return until(replies, `reply to ${op}`);
    },
    event: () => until(events, "event"),
    events,
    /** Ends stdin; resolves the exit code, or "hung" if the child stays. */
    async end() {
      child.stdin.end();
      const timer = new Promise((r) => setTimeout(() => r("hung"), 5000));
      const code = await Promise.race([exited, timer]);
      if (code === "hung") child.kill();
      return code;
    },
  };
}

describe("Notifier", { skip: skipReason() }, () => {
  it("rejects open() with NOT_CONNECTED when there is no session bus", async () => {
    const child = startChild("unix:path=/nonexistent/tincan-test-bus");
    assert.equal((await child.call("open")).error, "NOT_CONNECTED");
    assert.equal(await child.end(), 0);
  });

  describe("on a private bus", () => {
    let bus;

    before(
      async (t) => {
        try {
          await promisify(execFile)(
            "cargo",
            ["build", "--example", "fake_notifications", "-p", "tincan-bt", "-q"],
            { cwd: root },
          );
        } catch {
          t.skip("cannot build the fake_notifications example");
          return;
        }
        bus = await startPrivateBus("tincan-notifier-");
      },
      { timeout: 600_000 },
    );

    after(() => bus?.stop());

    it("rejects notify() with NOT_CONNECTED when no server runs", async () => {
      const child = startChild(bus.address);
      assert.deepEqual(await child.call("open"), { result: null });
      const reply = await child.call("notify", { title: "Ada", body: "hi", threadKey: "t" });
      assert.equal(reply.error, "NOT_CONNECTED");
      assert.deepEqual(await child.call("close"), { result: null });
      assert.equal(await child.end(), 0);
    });

    describe("with a fake server", () => {
      let fake;
      let fakeOut;
      const command = async (line) => {
        fake.stdin.write(line + "\n");
        const reply = await fakeOut.next();
        if (reply.startsWith("error")) throw new Error(reply);
        return reply === "ok" ? reply : JSON.parse(reply);
      };

      beforeEach(async () => {
        fake = spawn(fakeNotifications, [], {
          env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: bus.address },
          stdio: ["pipe", "pipe", "inherit"],
        });
        fakeOut = lines(fake.stdout, "fake_notifications");
        const exited = new Promise((_, reject) =>
          fake.on("exit", (code) => reject(new Error(`fake_notifications exited (${code})`))),
        );
        assert.equal(await Promise.race([fakeOut.next(), exited]), "ready");
      });

      afterEach(async () => {
        const exited = new Promise((resolve) => fake.on("exit", resolve));
        fake.stdin.end();
        await exited;
      });

      it("shows a message as the app, escaped, with a default action", async () => {
        const child = startChild(bus.address);
        await child.call("open", { appName: "Tincan Test", desktopEntry: "dev.beyland.Tincan" });
        const reply = await child.call("notify", {
          title: "Ada",
          body: "see <b>you</b> & bye",
          threadKey: "thread-ada",
        });
        assert.deepEqual(reply, { result: 1 });
        assert.deepEqual((await child.call("capabilities")).result, [
          "actions",
          "body",
          "body-markup",
        ]);
        const { shown } = await command("state");
        assert.deepEqual(shown, [
          {
            id: 1,
            appName: "Tincan Test",
            replaces: 0,
            icon: "",
            summary: "Ada",
            body: "see &lt;b&gt;you&lt;/b&gt; &amp; bye",
            actions: ["default", "Open"],
            category: "im.received",
            desktopEntry: "dev.beyland.Tincan",
            urgency: 1,
            expireTimeout: -1,
          },
        ]);
        assert.deepEqual(await child.call("close"), { result: null });
        assert.equal(await child.end(), 0);
      });

      it("adapts to a server without actions or markup, and replaces in place", async () => {
        await command("capabilities body");
        const child = startChild(bus.address);
        await child.call("open");
        const first = (await child.call("notify", { title: "Ada", body: "a < b", threadKey: "t" }))
          .result;
        const second = await child.call("notify", {
          title: "Ada",
          body: "two",
          threadKey: "t",
          icon: "mail-message-new",
          replaces: first,
        });
        assert.equal(second.result, first);
        const { shown } = await command("state");
        assert.equal(shown[0].appName, "Tincan");
        assert.equal(shown[0].body, "a < b");
        assert.deepEqual(shown[0].actions, []);
        assert.equal(shown[0].desktopEntry, null);
        assert.equal(shown[1].icon, "mail-message-new");
        assert.equal(shown[1].replaces, first);
        assert.deepEqual(await child.call("close"), { result: null });
        assert.equal(await child.end(), 0);
      });

      it("reports clicks and closes of its own notifications only", async () => {
        const child = startChild(bus.address);
        await child.call("open");
        const ada = (await child.call("notify", { title: "Ada", body: "hi", threadKey: "t-ada" }))
          .result;
        const bob = (await child.call("notify", { title: "Bob", body: "yo", threadKey: "t-bob" }))
          .result;

        await command("invoke 99 default");
        await command(`invoke ${ada} default token-1`);
        assert.deepEqual(await child.event(), {
          kind: "action",
          id: ada,
          threadKey: "t-ada",
          action: "default",
          activationToken: "token-1",
        });

        await command(`close ${bob} 2`);
        assert.deepEqual(await child.event(), {
          kind: "closed",
          id: bob,
          threadKey: "t-bob",
          reason: "dismissed",
        });

        assert.deepEqual(await child.call("dismiss", ada), { result: null });
        assert.deepEqual(await child.event(), {
          kind: "closed",
          id: ada,
          threadKey: "t-ada",
          reason: "closed",
        });
        assert.deepEqual((await command("state")).closedByApp, [ada]);

        // Already gone: nothing more happens.
        await command(`invoke ${ada} default`);
        await new Promise((r) => setTimeout(r, 100));
        assert.deepEqual(child.events, []);
        assert.deepEqual(await child.call("close"), { result: null });
        assert.equal(await child.end(), 0);
      });

      it("refuses an empty title and works no more after close(), then exits", async () => {
        const child = startChild(bus.address);
        await child.call("open");
        const empty = await child.call("notify", { title: "", body: "hi", threadKey: "t" });
        assert.equal(empty.error, "INVALID_INPUT");
        await child.call("close");
        assert.deepEqual(await child.call("close"), { result: null });
        const late = await child.call("notify", { title: "Ada", body: "hi", threadKey: "t" });
        assert.equal(late.error, "NOT_CONNECTED");
        assert.equal((await child.call("dismiss", 1)).error, "NOT_CONNECTED");
        assert.deepEqual((await command("state")).shown, []);
        assert.equal(await child.end(), 0);
      });

      it("lets Node exit while open only after close()", async () => {
        const child = startChild(bus.address);
        await child.call("open");
        assert.equal(await child.end(), "hung");
      });
    });
  });
});
