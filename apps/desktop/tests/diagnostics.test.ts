import { describe, expect, it } from "vite-plus/test";
import { diagnosticsText } from "../src/renderer/diagnostics.ts";

const T = Date.UTC(2026, 10, 3, 18, 0, 0);

describe("diagnosticsText", () => {
  it("lists the checks and the history with MAC addresses and personal device names redacted", () => {
    const text = diagnosticsText({
      version: "0.1.0",
      doctor: {
        generatedAt: T,
        daemon: true,
        checks: [
          {
            id: "adapter",
            title: "Bluetooth adapter",
            status: "ok",
            detail: "my-laptop (00:11:22:33:44:55)",
          },
          {
            id: "phone",
            title: "iPhone",
            status: "ok",
            detail: "Alex's iPhone (AA:BB:CC:DD:EE:FF) is connected",
          },
          { id: "map", title: "Messages", status: "warn", detail: "refused 3 times", hint: "x" },
        ],
      },
      history: [
        { at: T, kind: "phone", state: "connected", address: "AA:BB:CC:DD:EE:FF", code: null },
        {
          at: T,
          kind: "messages",
          state: "refused",
          address: "AA:BB:CC:DD:EE:FF",
          code: "NOT_FOUND",
        },
        { at: T, kind: "adapter", state: "off", address: null, code: null },
      ],
    });
    expect(text).toBe(
      [
        "Tincan 0.1.0",
        "",
        "Checks",
        "  generated 2026-11-03T18:00:00.000Z",
        "  ✓ Bluetooth adapter: adapter (XX:XX:XX:XX:XX:XX)",
        "  ✓ iPhone: iPhone (XX:XX:XX:XX:XX:XX) is connected",
        "  ! Messages: refused 3 times",
        "",
        "Connection history",
        "  2026-11-03T18:00:00.000Z  phone    connected  XX:XX:XX:XX:XX:XX",
        "  2026-11-03T18:00:00.000Z  messages refused  XX:XX:XX:XX:XX:XX [NOT_FOUND]",
        "  2026-11-03T18:00:00.000Z  adapter  off",
        "",
      ].join("\n"),
    );
  });

  it("redacts D-Bus addresses, names with newlines and home directories in every check", () => {
    const text = diagnosticsText({
      version: "0.1.0",
      doctor: {
        generatedAt: T,
        daemon: true,
        checks: [
          {
            id: "phone",
            title: "iPhone",
            status: "warn",
            detail: "Alex's\nsecret iPhone (AA:BB:CC:DD:EE:FF) isn't connected",
          },
          {
            id: "native",
            title: "Bluetooth addon",
            status: "fail",
            detail: "Cannot open /home/alex/.local/share/tincan/tincan.node",
          },
          {
            id: "map",
            title: "Messages",
            status: "warn",
            detail: "/org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF refused",
          },
        ],
      },
      history: [],
    });
    expect(text).toContain("  ! iPhone: iPhone (XX:XX:XX:XX:XX:XX) isn't connected\n");
    expect(text).toContain("~/.local/share/tincan/tincan.node");
    expect(text).toContain("dev_XX_XX_XX_XX_XX_XX refused");
    expect(text).not.toMatch(/Alex|secret|alex|AA_BB|AA:BB/);
  });

  it("says what it couldn't get", () => {
    const text = diagnosticsText({ version: null, doctor: null, history: [] });
    expect(text).toContain("Tincan (daemon not running)");
    expect(text).toContain("Checks\n  unavailable");
    expect(text).toContain("nothing recorded yet");
  });
});
