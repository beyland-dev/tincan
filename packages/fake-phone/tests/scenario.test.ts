import { fileURLToPath } from "node:url";
import type { MapLinkEvent } from "@beyland/tincan-core";
import { describe, expect, it } from "vite-plus/test";
import {
  loadScenario,
  parseScenario,
  phoneFromScenario,
  playScenario,
  type Scenario,
} from "../src/index.ts";

const BUSY_GROUP = fileURLToPath(
  new URL("../../../fixtures/scenarios/busy-group.json", import.meta.url),
);
const REFUSED = fileURLToPath(new URL("../../../fixtures/scenarios/refused.json", import.meta.url));
const CLASS_RESET = fileURLToPath(
  new URL("../../../fixtures/scenarios/class-reset.json", import.meta.url),
);
const T0 = 1_750_000_000;

describe("scenarios", () => {
  it("loads the busy-group fixture into a phone in its starting state", async () => {
    const scenario = await loadScenario(BUSY_GROUP);
    const phone = phoneFromScenario(scenario, { now: () => T0 });
    expect(phone.ownNumber).toBe("+1 555 010 0000");
    expect(phone.messages).toHaveLength(4);
    expect(phone.messages.at(-1)).toMatchObject({ timestamp: T0 - 12 * 60, read: false });
    expect(phone.notifications.map((n) => n.appName)).toEqual(["Calendar"]);

    const pbap = await phone.port.PbapSession.open(phone.address);
    expect((await pbap.pullContacts()).map((c) => c.name)).toEqual([
      "Pat Example",
      "Ada Lovelace",
      "Grace Hopper",
      "Alan Turing",
      "Katherine Johnson",
    ]);
  });

  it("spaces seeded messages a minute apart when they have no time", () => {
    const phone = phoneFromScenario(
      parseScenario({
        inbox: [
          { from: "5550100001", body: "a" },
          { from: "5550100001", body: "b" },
        ],
      }),
      { now: () => T0 },
    );
    expect(phone.messages.map((m) => m.timestamp)).toEqual([T0 - 120, T0 - 60]);
  });

  it("plays the refused fixture: NOT_FOUND three times, then connected", async () => {
    const scenario = await loadScenario(REFUSED);
    const phone = phoneFromScenario(scenario);
    const events: MapLinkEvent[] = [];
    const link = await phone.port.MapLink.start(phone.address, {}, (e) => events.push(e));
    await playScenario(phone, scenario, { speed: 1000 }).done;
    await phone.settle();
    const failed = events.flatMap((e) => (e.kind === "openFailed" ? [e.code] : []));
    expect(failed).toEqual(["NOT_FOUND", "NOT_FOUND", "NOT_FOUND"]);
    expect(link.state().kind).toBe("connected");
  });

  it("plays the class-reset fixture: the adapter stops being hands-free", async () => {
    const scenario = await loadScenario(CLASS_RESET);
    const phone = phoneFromScenario(scenario);
    const bluetooth = await phone.port.Bluetooth.open();
    const classes: Array<number | undefined> = [];
    await bluetooth.watchDevices((e) => {
      if (e.kind === "adapterChanged") classes.push(e.adapter.class);
    });
    expect((await bluetooth.adapter())?.class).toBe(0x7c0408);
    await playScenario(phone, scenario, { speed: 1000 }).done;
    await phone.settle();
    expect(classes).toEqual([0x7c010c]);
  });

  it("plays the script in order", async () => {
    const scenario = await loadScenario(BUSY_GROUP);
    const phone = phoneFromScenario(scenario);
    const events: MapLinkEvent[] = [];
    const link = await phone.port.MapLink.start(phone.address, {}, (e) => events.push(e));
    const playback = playScenario(phone, scenario, { speed: 1000 });
    await playback.done;
    await phone.settle();

    expect(phone.messages).toHaveLength(9);
    const sessions = events.flatMap((e) =>
      e.kind === "state" && e.state.kind === "connected" ? [e.state.session] : [],
    );
    expect(sessions).toHaveLength(2);
    // The message sent while away was never reported; the re-list after reconnecting finds it.
    const added = events.filter((e) => e.kind === "map" && e.event.kind === "messageAdded");
    expect(added).toHaveLength(4);
    expect((await link.listMessages("inbox")).map((m) => m.subject)).toContain(
      "Sent while you were away",
    );
    const groupNotes = phone.notifications.filter((n) => n.subtitle === "Book club");
    expect(groupNotes).toHaveLength(4);
    await expect(link.pushMessage(["5550100001"], "x")).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  it("stops playback early", async () => {
    const phone = phoneFromScenario(parseScenario({}));
    const scenario: Scenario = parseScenario({
      script: [{ afterMs: 60_000, receive: { from: "5550100001", body: "never" } }],
    });
    const playback = playScenario(phone, scenario);
    playback.stop();
    await playback.done;
    expect(phone.messages).toEqual([]);
  });

  it("rejects bad scenarios with INVALID_INPUT and missing files with NOT_FOUND", async () => {
    expect(() => parseScenario({ script: [{ explode: true }] })).toThrow(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
    expect(() => parseScenario({ inbox: [{ from: "", body: "x" }] })).toThrow(/Invalid scenario/);
    await expect(loadScenario("/nonexistent/scenario.json")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
