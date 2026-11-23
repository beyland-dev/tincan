import { getContract, TincanError } from "@beyland/tincan-protocol";
import { describe, expect, it } from "vite-plus/test";
import {
  checkRequest,
  isTrustedUrl,
  RENDERER_COMMANDS,
  threadArg,
  toWireError,
} from "../src/main/gate.ts";

describe("checkRequest", () => {
  it("accepts a known command and returns the parsed input", () => {
    const checked = checkRequest("thread.list", { limit: 10 });
    expect(checked.ok).toBe(true);
    if (checked.ok) expect(checked.input).toMatchObject({ limit: 10 });
  });

  it("treats a missing input as empty", () => {
    expect(checkRequest("status", undefined).ok).toBe(true);
  });

  it("allows only the commands the app's pages use", () => {
    for (const name of RENDERER_COMMANDS) {
      expect(getContract(name), name).toBeDefined();
    }
    // Real commands the window has no use for.
    for (const name of ["commands", "version", "contact.get", "group.delete", "sync.status"]) {
      expect(getContract(name), name).toBeDefined();
      expect(checkRequest(name, {})).toMatchObject({
        ok: false,
        error: { code: "PERMISSION_DENIED" },
      });
    }
  });

  it("lets the window work agent drafts and held sends, and nothing of approvals", () => {
    for (const name of [
      "draft.list",
      "draft.update",
      "draft.send",
      "draft.discard",
      "draft.restore",
      "message.cancel",
      "message.sendNow",
    ]) {
      expect(RENDERER_COMMANDS.has(name), name).toBe(true);
    }
    expect([...RENDERER_COMMANDS].filter((name) => name.startsWith("approval."))).toEqual([]);
    // Agents' long poll has no use in the window.
    expect(checkRequest("draft.get", { id: "drf_1" })).toMatchObject({
      ok: false,
      error: { code: "PERMISSION_DENIED" },
    });
  });

  it("checks a draft send's input", () => {
    expect(checkRequest("draft.send", { id: "drf_1", text: "Hi", revision: 2 }).ok).toBe(true);
    expect(checkRequest("draft.send", { id: "drf_1", text: "" })).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
    expect(checkRequest("message.cancel", { id: "m1", requeue: true }).ok).toBe(true);
  });

  it("rejects unknown commands and non-string names", () => {
    expect(checkRequest("nope.nothing", {})).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
    expect(checkRequest(42, {})).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
  });

  it("rejects input that doesn't match the contract, naming the field", () => {
    const checked = checkRequest("message.send", { to: "tel:+15550100001" });
    expect(checked).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    if (!checked.ok) expect(checked.error.message).toMatch(/^text: /);
  });
});

describe("settings.set", () => {
  it("passes a partial agent patch through without filling in defaults", () => {
    const checked = checkRequest("settings.set", { agents: { read: "known" } });
    expect(checked).toEqual({ ok: true, input: { agents: { read: "known" } } });
  });

  it("accepts every agent setting", () => {
    const agents = {
      access: "full",
      read: "contacts",
      send: "always",
      sendLimit: 30,
      sendDelaySeconds: 20,
      manage: true,
      handles: "visible",
      hideCodes: false,
    };
    expect(checkRequest("settings.set", { agents })).toEqual({ ok: true, input: { agents } });
  });

  it("accepts the user's own send delay, within limits", () => {
    expect(checkRequest("settings.set", { sendDelaySeconds: 5 })).toEqual({
      ok: true,
      input: { sendDelaySeconds: 5 },
    });
    expect(checkRequest("settings.set", { sendDelaySeconds: 301 }).ok).toBe(false);
  });

  it("accepts turning the send limit off", () => {
    const agents = { sendLimit: null };
    expect(checkRequest("settings.set", { agents })).toEqual({ ok: true, input: { agents } });
  });

  it("rejects a send limit out of range", () => {
    for (const sendLimit of [0, 61, 2.5]) {
      expect(checkRequest("settings.set", { agents: { sendLimit } })).toMatchObject({
        ok: false,
        error: { code: "INVALID_INPUT" },
      });
    }
  });
});

describe("isTrustedUrl", () => {
  it("trusts the app's own pages", () => {
    expect(isTrustedUrl("app://tincan/index.html")).toBe(true);
    expect(isTrustedUrl("app://tincan/")).toBe(true);
  });

  it("trusts the dev server only when one is configured and rejects prefix spoofing", () => {
    expect(isTrustedUrl("http://localhost:5174/", "http://localhost:5174/")).toBe(true);
    expect(isTrustedUrl("http://localhost:5174.evil.example/", "http://localhost:5174")).toBe(
      false,
    );
    expect(isTrustedUrl("http://localhost:5174/")).toBe(false);
  });

  it("rejects files, other hosts on the app scheme and the web", () => {
    expect(isTrustedUrl("file:///opt/Tincan/resources/app.asar/dist/renderer/index.html")).toBe(
      false,
    );
    expect(isTrustedUrl("file:///tmp/evil.html")).toBe(false);
    expect(isTrustedUrl("app://evil/index.html")).toBe(false);
    expect(isTrustedUrl("app://tincan.evil/index.html")).toBe(false);
    expect(isTrustedUrl("app://user@tincan/index.html")).toBe(false);
    expect(isTrustedUrl("https://example.com/")).toBe(false);
    expect(isTrustedUrl("not a url")).toBe(false);
  });
});

describe("threadArg", () => {
  it("finds --thread=", () => {
    expect(threadArg(["tincan", "--thread=tel:+15550100001"])).toBe("tel:+15550100001");
    expect(threadArg(["tincan", "--thread="])).toBeUndefined();
    expect(threadArg(["tincan"])).toBeUndefined();
  });
});

describe("toWireError", () => {
  it("keeps Tincan error codes and wraps everything else", () => {
    expect(toWireError(new TincanError("NOT_CONNECTED", "away"))).toMatchObject({
      code: "NOT_CONNECTED",
    });
    expect(toWireError(new Error("boom"))).toEqual({ code: "INTERNAL", message: "boom" });
  });
});
