import { EventBus, Pairing, type BluetoothHandle, type BtDevice } from "@beyland/tincan-core";
import { describe, expect, it } from "vite-plus/test";
import { FakePhone } from "../src/index.ts";

async function setup(options: ConstructorParameters<typeof FakePhone>[0] = {}, timeoutMs = 5_000) {
  const fake = new FakePhone({ paired: false, ...options });
  const bluetooth: BluetoothHandle = await fake.port.Bluetooth.open();
  const events = new EventBus();
  const states: string[] = [];
  events.subscribe((event) => {
    if (event.event === "pairing.changed") states.push(event.data.state);
  });
  const paired: BtDevice[] = [];
  const errors: string[] = [];
  const pairing = new Pairing({
    bluetooth: () => bluetooth,
    events,
    onPaired: (device) => {
      paired.push(device);
    },
    onError: (context) => errors.push(context),
    pollMs: 10,
    timeoutMs,
    findMs: 50,
  });
  return { fake, bluetooth, pairing, states, paired, errors };
}

/** Waits until `check` passes, letting the fake phone's queued callbacks run. */
async function until(fake: FakePhone, check: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await fake.settle();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("pairing", () => {
  it("finds an unpaired iPhone, makes this computer visible and pairs it after the code", async () => {
    const t = await setup({ name: "Test iPhone" });
    const searching = await t.pairing.start();
    expect(searching).toMatchObject({
      state: "searching",
      adapterName: "tincan-test",
      discoverable: true,
      handsFree: true,
      candidates: [{ address: t.fake.address, name: "Test iPhone" }],
    });
    expect(t.fake.discoverable).toBe(true);

    await t.pairing.start({ address: t.fake.address.toLowerCase() });
    await until(t.fake, () => t.pairing.status().state === "confirm");
    expect(t.pairing.status()).toMatchObject({
      address: t.fake.address,
      name: "Test iPhone",
      passkey: "123456",
    });

    await t.pairing.confirm(true);
    await until(t.fake, () => t.pairing.status().state === "paired");
    expect(t.paired.map((d) => d.address)).toEqual([t.fake.address]);
    expect(t.fake.device.paired).toBe(true);
    expect(t.fake.discoverable).toBe(false);
    expect((await t.bluetooth.adapter())?.discovering).toBe(false);
    const distinct = t.states.filter((s, i) => s !== t.states[i - 1]);
    expect(distinct).toEqual(["searching", "pairing", "confirm", "pairing", "paired"]);
  });

  it("says when this computer isn't hands-free, so the iPhone won't share messages", async () => {
    const t = await setup({ adapterClass: 0x7c010c });
    expect(await t.pairing.start()).toMatchObject({ state: "searching", handsFree: false });
    await t.pairing.cancel();
  });

  it("reports a rejected code and hides the computer again", async () => {
    const t = await setup();
    await t.pairing.start();
    await t.pairing.start({ address: t.fake.address });
    await until(t.fake, () => t.pairing.status().state === "confirm");
    await t.pairing.confirm(false);
    await until(t.fake, () => t.pairing.status().state === "failed");
    expect(t.pairing.status().error).toEqual({
      code: "PERMISSION_DENIED",
      message: "Pairing was declined",
    });
    expect(t.paired).toEqual([]);
    await until(t.fake, () => !t.fake.discoverable);
  });

  it('declines pairing without a code to compare ("Just Works"), which no iPhone asks for', async () => {
    const t = await setup({ pairingRequest: "authorize" });
    await t.pairing.start();
    await t.pairing.start({ address: t.fake.address });
    await until(t.fake, () => t.pairing.status().state === "failed");
    expect(t.pairing.status().error).toEqual({
      code: "PERMISSION_DENIED",
      message: expect.stringMatching(/without a code to compare/),
    });
    expect(t.states).not.toContain("confirm");
    expect(t.fake.device.paired).toBe(false);
    expect(t.paired).toEqual([]);
    await until(t.fake, () => !t.fake.discoverable);
  });

  it("notices an iPhone that pairs from its own Settings while searching", async () => {
    const t = await setup();
    expect(() => t.fake.pairFromPhone()).toThrow();
    await t.pairing.start();
    t.fake.pairFromPhone();
    await until(t.fake, () => t.pairing.status().state === "paired");
    expect(t.pairing.status()).toMatchObject({ address: t.fake.address, discoverable: false });
    expect(t.paired).toHaveLength(1);
  });

  it("ignores iPhones that were already paired", async () => {
    const t = await setup({ paired: true });
    await t.pairing.start();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(t.pairing.status()).toMatchObject({ state: "searching", candidates: [] });
    expect(t.paired).toEqual([]);
    await t.pairing.cancel();
  });

  it("cancels a search and a pending code", async () => {
    const t = await setup();
    await t.pairing.start();
    expect(await t.pairing.cancel()).toMatchObject({ state: "idle", discoverable: false });
    expect(t.fake.discoverable).toBe(false);

    await t.pairing.start({ address: t.fake.address });
    await until(t.fake, () => t.pairing.status().state === "confirm");
    await expect(t.pairing.start()).rejects.toMatchObject({ code: "BUSY" });
    await t.pairing.cancel();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(t.pairing.status().state).toBe("idle");
    expect(t.paired).toEqual([]);
    await expect(t.pairing.confirm(true)).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("gives up when no iPhone pairs in time", async () => {
    const t = await setup({ reachable: false }, 50);
    await t.pairing.start();
    expect(t.pairing.status().candidates).toEqual([]);
    await until(t.fake, () => t.pairing.status().state === "failed");
    expect(t.pairing.status().error?.code).toBe("TIMEOUT");
    await until(t.fake, () => !t.fake.discoverable);
  });

  it("fails to pair an iPhone that isn't in range", async () => {
    const t = await setup({ reachable: false });
    await t.pairing.start({ address: t.fake.address });
    await until(t.fake, () => t.pairing.status().state === "failed");
    expect(t.pairing.status().error?.code).toBe("NOT_FOUND");
  });
});
