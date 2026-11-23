import { DatabaseSync } from "node:sqlite";
import {
  ContactSync,
  EventBus,
  Store,
  nodeSqliteDb,
  type ContactSyncOptions,
} from "@beyland/tincan-core";
import type { TincanEvent } from "@beyland/tincan-protocol";
import { describe, expect, it } from "vite-plus/test";
import { FakePhone, type FakeContact } from "../src/index.ts";

const T0 = 1_750_000_000;
const HOUR = 3600;
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).toString("base64");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 4, 5, 6]).toString("base64");

const ADA: FakeContact = { name: "Ada Lovelace", tels: ["(555) 010-0001"], favorite: true };
const GRACE: FakeContact = { name: "Grace Hopper", emails: ["Grace@Example.com"] };

function setup(options: Partial<ContactSyncOptions> = {}) {
  let seconds = T0;
  const now = () => seconds * 1000;
  const fake = new FakePhone({
    now: () => seconds,
    ownerName: "Pat Owner",
    ownNumber: "5550100009",
  });
  const store = Store.open(nodeSqliteDb(new DatabaseSync(":memory:")), { now });
  const events = new EventBus();
  const seen: TincanEvent[] = [];
  events.subscribe((event) => seen.push(event));
  const errors: string[] = [];
  const contacts = new ContactSync({
    store,
    port: fake.port,
    address: fake.address,
    events,
    defaultRegion: () => "US",
    now,
    onError: (context) => errors.push(context),
    ...options,
  });
  return {
    fake,
    store,
    events,
    seen,
    contacts,
    errors,
    photoNames: () =>
      store.db
        .query<{ name: string }>("SELECT name FROM contact_photos ORDER BY name")
        .map((row) => row.name),
    tick: (s = 1) => (seconds += s),
  };
}

describe("ContactSync", () => {
  it("mirrors the address book, favourites and the owner's number", async () => {
    const t = setup();
    t.store.ensureThread("tel:+15550100001");
    t.fake.setContacts([ADA, GRACE]);

    const result = await t.contacts.sync();
    expect(result).toEqual({ skipped: false, contacts: 2, changed: 2, removed: 0, photos: 0 });
    expect(t.store.listContacts().map((c) => [c.name, c.handles])).toEqual([
      ["Ada Lovelace", ["tel:+15550100001"]],
      ["Grace Hopper", ["email:grace@example.com"]],
    ]);
    expect(t.store.listContacts({ favoritesOnly: true }).map((c) => c.name)).toEqual([
      "Ada Lovelace",
    ]);
    expect(t.store.getThread("tel:+15550100001")?.title).toBe("Ada Lovelace");
    expect(t.contacts.ownHandles).toEqual(["tel:+15550100009"]);
    expect(t.contacts.lastSyncAt).toBe(T0 * 1000);

    const ids = t.seen.filter((e) => e.event === "contact.changed").flatMap((e) => e.data.ids);
    expect(ids.sort()).toEqual(
      t.store
        .listContacts()
        .map((c) => c.id)
        .sort(),
    );
    expect(t.seen.find((e) => e.event === "thread.changed")?.data).toEqual({
      keys: ["tel:+15550100001"],
    });
  });

  it("keeps company, addresses and websites", async () => {
    const t = setup();
    t.fake.setContacts([
      { ...ADA, organization: "Engines", addresses: ["London"], urls: ["https://ada.dev"] },
    ]);
    await t.contacts.sync();
    expect(t.store.listContacts()[0]?.details).toEqual({
      company: "Engines",
      addresses: [{ label: "home", value: "London" }],
      urls: [{ label: null, value: "https://ada.dev" }],
    });
  });

  it("gives every computer the same ids", async () => {
    const a = setup();
    const b = setup();
    a.fake.setContacts([ADA, GRACE, GRACE]);
    b.fake.setContacts([GRACE, GRACE, ADA]);
    await a.contacts.sync();
    await b.contacts.sync();
    const ids = (t: typeof a) =>
      t.store
        .listContacts()
        .map((c) => c.id)
        .sort();
    expect(ids(a)).toHaveLength(3);
    expect(ids(a)).toEqual(ids(b));
  });

  it("skips an unchanged phonebook until it's a day old, and pulls when forced", async () => {
    const t = setup();
    t.fake.setContacts([ADA]);
    await t.contacts.sync();
    const events = t.seen.length;

    expect((await t.contacts.sync()).skipped).toBe(true);
    expect(t.seen).toHaveLength(events);
    expect((await t.contacts.sync({ force: true })).skipped).toBe(false);

    t.tick(25 * HOUR);
    expect((await t.contacts.sync()).skipped).toBe(false);

    t.fake.setContacts([GRACE]);
    const result = await t.contacts.sync();
    expect(result).toMatchObject({ skipped: false, contacts: 1, changed: 1, removed: 1 });
    expect(t.store.listContacts().map((c) => c.name)).toEqual(["Grace Hopper"]);
  });

  it("keeps photos in the store once each, by content, and forgets ones no contact uses", async () => {
    const t = setup();
    t.fake.setContacts([
      { ...ADA, photo: { mediaType: "image/jpeg", data: JPEG } },
      { ...GRACE, photo: { mediaType: "image/jpeg", data: JPEG } },
    ]);
    expect((await t.contacts.sync()).photos).toBe(2);
    const [ada, grace] = t.store.listContacts();
    expect(ada?.hasPhoto && grace?.hasPhoto).toBe(true);
    expect(t.photoNames()).toEqual([expect.stringMatching(/^[0-9a-f]{64}\.jpg$/)]);
    expect(t.store.contactPhoto(ada!.id)).toBe(t.photoNames()[0]);
    expect(t.store.contactPhoto(grace!.id)).toBe(t.photoNames()[0]);
    const photo = t.store.getContactPhoto(ada!.id);
    expect(photo?.mediaType).toBe("image/jpeg");
    expect(Buffer.from(photo!.data).toString("base64")).toBe(JPEG);

    // Pulled again unchanged: nothing about the photos is written.
    const total = () => t.store.db.query<{ n: number }>("SELECT total_changes() AS n")[0]!.n;
    const before = total();
    const seq = t.store.changeSeq;
    expect((await t.contacts.sync({ force: true })).photos).toBe(0);
    expect(t.store.changeSeq).toBe(seq);
    // Only the phonebook's bookkeeping (one settings row) changed.
    expect(total() - before).toBe(1);

    t.fake.setContacts([{ ...ADA, photo: { mediaType: "image/png", data: PNG } }, GRACE]);
    expect((await t.contacts.sync()).photos).toBe(2);
    expect(t.store.getContact(grace!.id)?.hasPhoto).toBe(false);
    expect(t.store.getContactPhoto(grace!.id)).toBeNull();
    expect(t.photoNames()).toEqual([expect.stringMatching(/\.png$/)]);
    expect(t.store.getContactPhoto(ada!.id)?.mediaType).toBe("image/png");

    t.fake.setContacts([GRACE]);
    await t.contacts.sync();
    expect(t.photoNames()).toEqual([]);
  });

  it("only stores raster photos, whatever type the card claims", async () => {
    const t = setup();
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>x</script></svg>');
    t.fake.setContacts([
      { ...ADA, photo: { mediaType: "image/svg+xml", data: svg.toString("base64") } },
      // Claims to be a JPEG but is SVG.
      { ...GRACE, photo: { mediaType: "image/jpeg", data: svg.toString("base64") } },
    ]);
    await t.contacts.sync();
    expect(t.photoNames()).toEqual([]);
    expect(t.store.listContacts().some((c) => c.hasPhoto)).toBe(false);

    // A real PNG labelled as SVG is stored, as a .png.
    t.fake.setContacts([{ ...ADA, photo: { mediaType: "image/svg+xml", data: PNG } }]);
    await t.contacts.sync();
    expect(t.photoNames()).toEqual([expect.stringMatching(/^[0-9a-f]{64}\.png$/)]);
    expect(t.store.getContactPhoto(t.store.listContacts()[0]!.id)?.mediaType).toBe("image/png");
  });

  it("keeps contacts when the photo pull fails, and pulls again next time", async () => {
    const t = setup();
    t.fake.setContacts([{ ...ADA, photo: { mediaType: "image/jpeg", data: JPEG } }]);
    t.fake.failNextPull("TIMEOUT", true);
    expect(await t.contacts.sync()).toMatchObject({ contacts: 1, photos: 0 });
    expect(t.errors).toEqual(["contacts.photos"]);
    const result = await t.contacts.sync();
    expect(result).toMatchObject({ skipped: false, changed: 0, photos: 1 });
  });

  it("fails without touching the store when the phone is away or the pull fails", async () => {
    const t = setup();
    t.fake.setContacts([ADA]);
    t.fake.disconnect();
    await expect(t.contacts.sync()).rejects.toMatchObject({ code: "NOT_CONNECTED" });
    t.fake.reconnect();
    t.fake.failNextPull("TIMEOUT", false);
    await expect(t.contacts.sync()).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(t.store.listContacts()).toEqual([]);
    expect(t.contacts.lastSyncAt).toBeNull();
    expect(t.contacts.lastError).toMatchObject({ code: "TIMEOUT" });

    await t.contacts.sync();
    expect(t.contacts.lastError).toBeNull();
  });

  it("joins a running sync", async () => {
    const t = setup();
    t.fake.setContacts([ADA]);
    const [a, b] = [t.contacts.sync(), t.contacts.sync()];
    expect(a).toBe(b);
    await a;
  });

  it("skips contacts with no phone number or email", async () => {
    const t = setup();
    t.fake.setContacts([ADA, { name: "Ada Lovelace" }, { name: "Ghost Card" }]);
    const result = await t.contacts.sync();
    expect(result).toMatchObject({ contacts: 1 });
    expect(t.store.listContacts().map((c) => c.name)).toEqual(["Ada Lovelace"]);
  });

  it("syncs on connect at most once an interval", async () => {
    const t = setup({ autoIntervalMs: HOUR * 1000 });
    t.fake.setContacts([ADA]);
    t.events.emit("sync.changed", { state: "connected" });
    await t.contacts.idle();
    expect(t.store.listContacts()).toHaveLength(1);

    t.fake.setContacts([ADA, GRACE]);
    t.events.emit("sync.changed", { state: "connected" });
    await t.contacts.idle();
    expect(t.store.listContacts()).toHaveLength(1);

    t.tick(HOUR);
    t.events.emit("sync.changed", { state: "connected" });
    await t.contacts.idle();
    expect(t.store.listContacts()).toHaveLength(2);

    t.contacts.stop();
    await expect(t.contacts.sync()).rejects.toMatchObject({ code: "NOT_CONNECTED" });
  });
});
