import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TincanClient } from "@beyland/tincan-client";
import type { BtDevice, PhonePort } from "@beyland/tincan-core";
import { FakePhone } from "@beyland/tincan-fake-phone";
import type { RuntimePaths } from "@beyland/tincan-protocol/paths";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  openMemoryStore,
  PHONE_SETTING,
  pickIphone,
  runDaemon,
  type OpenedStore,
} from "../src/index.ts";

let root: string;
let paths: RuntimePaths;
let logs: string[];
const running: Array<() => Promise<void>> = [];
const clients: TincanClient[] = [];

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "tincan-phone-"));
  const dir = path.join(root, "run");
  paths = { dir, socket: path.join(dir, "tincan.sock"), lock: path.join(dir, "tincan.lock") };
  logs = [];
});

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const stop of running.splice(0)) await stop();
  await rm(root, { recursive: true, force: true });
});

async function start(
  port: PhonePort,
  store: OpenedStore = openMemoryStore(),
  extra: { legacyPhotosDir?: string; iconDir?: string } = {},
) {
  const result = await runDaemon({
    version: "0.0.0-test",
    paths,
    store,
    port,
    ...extra,
    handleSignals: false,
    log: (message) => logs.push(message),
  });
  running.push(result.stop);
  const client = await TincanClient.connect({
    socketPath: paths.socket,
    client: { kind: "cli", name: "test" },
  });
  clients.push(client);
  return { ...result, client };
}

async function settle(fake: FakePhone, ready: () => Promise<void>) {
  for (let i = 0; i < 4; i++) {
    await ready();
    await fake.settle();
  }
}

describe("phone wiring", () => {
  it("starts the phone's services, stores and notifies messages", async () => {
    const fake = new FakePhone({ name: "Test iPhone" });
    const { client, phone } = await start(fake.port);
    await settle(fake, () => phone!.ready());

    const status = await client.run("status");
    expect(status.phone).toMatchObject({
      state: "connected",
      device: {
        address: fake.address,
        name: "Test iPhone",
        profiles: { map: "ready", ancs: "ready" },
      },
    });
    expect(phone!.address).toBe(fake.address);

    fake.receive({ from: "+15550100001", body: "hello" });
    await settle(fake, () => phone!.ready());
    const threads = await client.run("thread.list", {});
    expect(threads).toHaveLength(1);

    await new Promise((resolve) => setTimeout(resolve, 1_700));
    await fake.settle();
    expect(fake.desktop.history.map((n) => n.body)).toEqual(["hello"]);
  });

  it("keeps contact photos in the store: moves the old folder in, and shows avatars from RAM", async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    const data = path.join(root, "data");
    const photos = path.join(data, "photos");
    await mkdir(photos, { recursive: true, mode: 0o700 });
    const name = `${createHash("sha256").update(jpeg).digest("hex")}.jpg`;
    await writeFile(path.join(photos, name), jpeg, { mode: 0o600 });
    const store = openMemoryStore();
    store.store.replaceContacts([
      {
        id: "old",
        name: "Old",
        favorite: false,
        handles: [{ handle: "tel:+15550100002", label: null }],
      },
    ]);
    store.store.setContactPhoto("old", name);

    const fake = new FakePhone();
    fake.setContacts([
      {
        name: "Ada",
        tels: ["(555) 010-0001"],
        photo: { mediaType: "image/jpeg", data: jpeg.toString("base64") },
      },
    ]);
    const { client, phone, stop } = await start(fake.port, store, {
      legacyPhotosDir: photos,
      iconDir: paths.dir,
    });
    expect(logs).toContain("moved 1 contact photos into the store");
    expect(readdirSync(data)).toEqual([]);

    await settle(fake, () => phone!.ready());
    await client.run("contact.sync", { force: true });
    const [ada] = await client.run("contact.list", {});
    expect(await client.run("contact.photo", { id: ada!.id })).toMatchObject({
      mediaType: "image/jpeg",
      data: jpeg.toString("base64"),
    });

    fake.receive({ from: "+15550100001", body: "hello" });
    await settle(fake, () => phone!.ready());
    await new Promise((resolve) => setTimeout(resolve, 1_700));
    await fake.settle();
    const icon = fake.desktop.history.at(-1)?.icon;
    expect(icon).toBeDefined();
    const file = fileURLToPath(icon!);
    expect(path.dirname(file)).toBe(paths.dir);
    expect(readFileSync(file)).toEqual(jpeg);
    // Nothing was written under the data folder.
    expect(readdirSync(data)).toEqual([]);

    await stop();
    expect(existsSync(file)).toBe(false);
  });

  it("remembers the phone it chose", async () => {
    const fake = new FakePhone();
    const store = openMemoryStore();
    const { phone, core } = await start(fake.port, store);
    await phone!.ready();
    expect(core.requireStore().getSetting(PHONE_SETTING)).toEqual({ address: fake.address });
  });

  it("waits for a phone to be paired", async () => {
    const fake = new FakePhone({ paired: false });
    const { client, phone } = await start(fake.port);
    await phone!.ready();
    expect((await client.run("status")).phone.state).toBe("unpaired");

    const bluetooth = await fake.port.Bluetooth.open();
    await bluetooth.pair(fake.address, () => true);
    await settle(fake, () => phone!.ready());
    expect((await client.run("status")).phone.state).toBe("connected");
  });

  it("pairs a new iPhone from Tincan and starts using it", async () => {
    const fake = new FakePhone({ paired: false, name: "Test iPhone" });
    const store = openMemoryStore();
    // A phone forgotten on both sides is still remembered; pairing another replaces it.
    store.store.setSetting(PHONE_SETTING, { address: "AA:BB:CC:DD:EE:FF", paused: true });
    const { client, phone, core } = await start(fake.port, store);
    await phone!.ready();

    const searching = await client.run("device.pair.start", {});
    expect(searching).toMatchObject({
      state: "searching",
      candidates: [{ address: fake.address, name: "Test iPhone" }],
    });
    await client.run("device.pair.start", { address: fake.address });
    for (let i = 0; i < 50 && (await client.run("device.pair.status", {})).state !== "confirm"; i++)
      await fake.settle();
    expect(await client.run("device.pair.status", {})).toMatchObject({
      state: "confirm",
      passkey: "123456",
    });
    await client.run("device.pair.confirm", { accept: true });
    for (let i = 0; i < 50 && (await client.run("device.pair.status", {})).state !== "paired"; i++)
      await fake.settle();
    await settle(fake, () => phone!.ready());

    expect((await client.run("status")).phone).toMatchObject({
      state: "connected",
      device: { address: fake.address, paused: false },
    });
    expect(core.requireStore().getSetting(PHONE_SETTING)).toEqual({ address: fake.address });
    expect(fake.discoverable).toBe(false);
  });

  it("follows the phone going out of range", async () => {
    const fake = new FakePhone();
    const { client, phone } = await start(fake.port);
    await settle(fake, () => phone!.ready());
    fake.disconnect();
    await settle(fake, () => phone!.ready());
    const status = await client.run("status");
    expect(status.phone.state).toBe("disconnected");
    expect(status.phone.device?.profiles.map).not.toBe("ready");
  });

  it("keeps running without Bluetooth", async () => {
    const fake = new FakePhone();
    const port: PhonePort = {
      ...fake.port,
      Bluetooth: {
        open: () => Promise.reject(Object.assign(new Error("no bus"), { name: "BusError" })),
      },
    };
    const { client } = await start(port);
    expect((await client.run("status")).phone.state).toBe("unpaired");
    expect(logs).toContain("Bluetooth unavailable (INTERNAL)");
    await expect(client.run("device.connect", {})).rejects.toMatchObject({
      code: "NOT_CONNECTED",
    });
  });
});

describe("device controls", () => {
  it("describes the phone and adapter", async () => {
    const fake = new FakePhone({ name: "Test iPhone" });
    const { client, phone } = await start(fake.port);
    await settle(fake, () => phone!.ready());
    fake.receive({ from: "+15550100001", body: "hello" });
    await settle(fake, () => phone!.ready());

    const info = await client.run("device.info", {});
    expect(info).toMatchObject({
      state: "connected",
      phone: {
        address: fake.address,
        name: "Test iPhone",
        paired: true,
        connected: true,
        paused: false,
        supports: { map: true, pbap: true, ancs: true },
        profiles: { map: "ready" },
      },
      adapter: { powered: true, handsFree: true },
      stored: { threads: 1, messages: 1 },
    });
    expect(info.lastSync.messages).not.toBeNull();
  });

  it("notices when the adapter stops being hands-free", async () => {
    const fake = new FakePhone();
    const { client, phone, core } = await start(fake.port);
    await settle(fake, () => phone!.ready());
    const changed: string[] = [];
    core.events.subscribe((event) => {
      if (event.event === "device.changed") changed.push(event.data.address);
    });

    // BlueZ's hostname plugin resets the class to Computer (laptop).
    fake.setAdapterClass(0x7c010c);
    await settle(fake, () => phone!.ready());
    expect((await client.run("device.info", {})).adapter).toMatchObject({ handsFree: false });
    expect(changed).toEqual(["00:11:22:33:44:55"]);
    expect(logs).toContain("the adapter's device class changed to 0x7c010c");

    fake.setAdapterClass(0x7c0408);
    await settle(fake, () => phone!.ready());
    expect((await client.run("device.info", {})).adapter).toMatchObject({ handsFree: true });
    expect(changed).toHaveLength(2);
    const adapter = (await client.run("device.history", {})).filter((e) => e.kind === "adapter");
    expect(adapter.map((e) => e.state)).toEqual(["not-hands-free", "hands-free"]);
  });

  it("stays disconnected across restarts until asked to connect", async () => {
    const fake = new FakePhone();
    const store = openMemoryStore();
    const first = await start(fake.port, store);
    await settle(fake, () => first.phone!.ready());

    await first.client.run("device.disconnect", {});
    let status = await first.client.run("status");
    expect(status.phone).toMatchObject({ state: "disconnected", device: { paused: true } });
    expect(first.core.services.sync).toBeUndefined();
    expect(store.store.getSetting(PHONE_SETTING)).toEqual({ address: fake.address, paused: true });

    // The phone coming back by itself doesn't undo the user's disconnect.
    await (await fake.port.Bluetooth.open()).connect(fake.address);
    await settle(fake, () => first.phone!.ready());
    expect((await first.client.run("status")).phone.state).toBe("disconnected");

    await first.client.run("device.connect", {});
    await settle(fake, () => first.phone!.ready());
    status = await first.client.run("status");
    expect(status.phone).toMatchObject({ state: "connected", device: { paused: false } });
    expect(store.store.getSetting(PHONE_SETTING)).toEqual({ address: fake.address });
  });

  it("forgets the phone but keeps its messages", async () => {
    const fake = new FakePhone();
    const store = openMemoryStore();
    const { client, phone, core } = await start(fake.port, store);
    await settle(fake, () => phone!.ready());
    fake.receive({ from: "+15550100001", body: "hello" });
    await settle(fake, () => phone!.ready());

    await expect(client.run("device.forget", {})).resolves.toEqual({ address: fake.address });
    await settle(fake, () => phone!.ready());
    expect((await client.run("status")).phone).toEqual({ state: "unpaired", device: null });
    expect(phone!.address).toBeNull();
    expect(core.requireStore().getSetting(PHONE_SETTING)).toBeNull();
    expect(await client.run("thread.list", {})).toHaveLength(1);
    await expect(client.run("device.disconnect", {})).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("pickIphone", () => {
  const device = (address: string, extra: Partial<BtDevice> = {}): BtDevice =>
    ({ address, paired: true, connected: false, isIphone: true, ...extra }) as BtDevice;

  it("takes the only paired iPhone", () => {
    expect(
      pickIphone([device("A"), device("B", { isIphone: false }), device("C", { paired: false })])
        ?.address,
    ).toBe("A");
  });

  it("takes the connected one when several are paired, else none", () => {
    expect(pickIphone([device("A"), device("B", { connected: true })])?.address).toBe("B");
    expect(pickIphone([device("A"), device("B")])).toBeNull();
  });
});

describe("background service", () => {
  it("hands over to the service it installs", async () => {
    const calls: string[] = [];
    let active = false;
    const result = await runDaemon({
      version: "0.0.0-test",
      paths,
      handleSignals: false,
      log: (message) => logs.push(message),
      service: {
        status: async () => ({ installed: calls.includes("enable"), enabled: null, active }),
        enable: async () => {
          calls.push("enable");
          return { installed: true, enabled: true, active };
        },
        start: async () => {
          calls.push("start");
          active = true;
        },
        disable: async () => ({ installed: true, enabled: false, active: false }),
      },
    });
    running.push(result.stop);
    const client = await TincanClient.connect({
      socketPath: paths.socket,
      client: { kind: "desktop", name: "test" },
    });
    clients.push(client);

    expect(await client.run("service.status")).toMatchObject({ installed: false });
    expect(await client.run("service.install")).toEqual({
      installed: true,
      enabled: true,
      active: false,
      handover: true,
    });
    await result.stopped;
    expect(calls).toEqual(["enable", "start"]);
    expect(logs).toContain("handing over to the background service");
  });

  it("stays up when it already is the service", async () => {
    const calls: string[] = [];
    const result = await runDaemon({
      version: "0.0.0-test",
      paths,
      handleSignals: false,
      log: (message) => logs.push(message),
      service: {
        status: async () => ({ installed: true, enabled: false, active: true }),
        enable: async () => {
          calls.push("enable");
          return { installed: true, enabled: true, active: true };
        },
        start: async () => {
          calls.push("start");
        },
        disable: async () => ({ installed: true, enabled: false, active: false }),
      },
    });
    running.push(result.stop);
    const client = await TincanClient.connect({
      socketPath: paths.socket,
      client: { kind: "desktop", name: "test" },
    });
    clients.push(client);
    expect(await client.run("service.install")).toMatchObject({ handover: false });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect((await client.run("status")).daemon.pid).toBe(process.pid);
    expect(calls).toEqual(["enable"]);
  });

  it.each([
    ["stops when it is the service it turns off", true],
    ["stays up when it turns off a service it isn't", false],
  ])("%s", async (_name, isService) => {
    const calls: string[] = [];
    const result = await runDaemon({
      version: "0.0.0-test",
      paths,
      handleSignals: false,
      log: (message) => logs.push(message),
      service: {
        status: async () => ({ installed: true, enabled: true, active: isService }),
        enable: async () => ({ installed: true, enabled: true, active: isService }),
        start: async () => {
          calls.push("start");
        },
        disable: async () => {
          calls.push("disable");
          return { installed: true, enabled: false, active: isService };
        },
      },
    });
    running.push(result.stop);
    const client = await TincanClient.connect({
      socketPath: paths.socket,
      client: { kind: "desktop", name: "test" },
    });
    clients.push(client);
    expect(await client.run("service.disable")).toEqual({
      installed: true,
      enabled: false,
      active: isService,
      handover: isService,
    });
    if (isService) {
      await result.stopped;
      expect(logs).toContain("background service turned off, stopping");
    } else {
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect((await client.run("status")).daemon.pid).toBe(process.pid);
    }
    expect(calls).toEqual(["disable"]);
  });
});
