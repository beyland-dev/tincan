import { describe, expect, it } from "vite-plus/test";
import {
  agentEnvironmentMarker,
  agentEnvironmentName,
  contact,
  draft,
  message,
  redactCheckDetail,
  redactDiagnosticText,
  redactDoctorReport,
  REDACTED_MAC,
} from "../src/index.ts";

describe("diagnostics redaction", () => {
  it("fully masks Bluetooth addresses in colon, dash and D-Bus forms", () => {
    expect(redactDiagnosticText("AA:BB:CC:DD:EE:FF and aa-bb-cc-dd-ee-ff")).toBe(
      `${REDACTED_MAC} and ${REDACTED_MAC}`,
    );
    expect(redactDiagnosticText("/org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF/service0010")).toBe(
      "/org/bluez/hci0/dev_XX_XX_XX_XX_XX_XX/service0010",
    );
    expect(redactDiagnosticText("at 18:00:00 on 2026-11-03")).toBe("at 18:00:00 on 2026-11-03");
  });

  it("masks home directories and collapses control characters", () => {
    expect(
      redactDiagnosticText(
        "Cannot load /home/alex/.local/lib/tincan.node or /var/home/sam/x\nnext‮line",
      ),
    ).toBe("Cannot load ~/.local/lib/tincan.node or ~/x next line");
    expect(redactDiagnosticText("/opt/odd-home/me/file", { home: "/opt/odd-home/me" })).toBe(
      "~/file",
    );
    expect(redactDiagnosticText("/root/.cache and /Users/kim/Library")).toBe(
      "~/.cache and ~/Library",
    );
  });

  it("replaces the device name in phone and adapter checks, even with a newline in it", () => {
    expect(redactCheckDetail("phone", "Alex's iPhone (AA:BB:CC:DD:EE:FF) is connected")).toBe(
      `iPhone (${REDACTED_MAC}) is connected`,
    );
    expect(redactCheckDetail("adapter", "Alex's\nlaptop (Sam's) (00:11:22:33:44:55) is off")).toBe(
      `adapter (${REDACTED_MAC}) is off`,
    );
    expect(redactCheckDetail("phone", "No iPhone is paired")).toBe("No iPhone is paired");
  });

  it("redacts every check's detail and hint", () => {
    const report = redactDoctorReport(
      {
        generatedAt: 0,
        daemon: true,
        checks: [
          {
            id: "native",
            title: "Bluetooth addon",
            status: "fail",
            detail: "Cannot find /home/alex/tincan/tincan.node",
            hint: "Rebuild in /home/alex/tincan",
          },
          { id: "map", title: "Messages", status: "warn", detail: "dev_AA_BB_CC_DD_EE_FF refused" },
        ],
      },
      { home: "/home/alex" },
    );
    expect(JSON.stringify(report)).not.toMatch(/alex|AA_BB/);
    expect(report.checks[0]).toMatchObject({
      detail: "Cannot find ~/tincan/tincan.node",
      hint: "Rebuild in ~/tincan",
    });
  });
});

describe("agent environment markers", () => {
  it("spots agents' shells and ignores settings people export themselves", () => {
    expect(agentEnvironmentMarker({ CLAUDECODE: "1" })).toBe("CLAUDECODE");
    expect(agentEnvironmentMarker({ CODEX_SANDBOX_FOO: "seatbelt" })).toBe("CODEX_SANDBOX_FOO");
    expect(agentEnvironmentMarker({ GEMINI_CLI: "1" })).toBe("GEMINI_CLI");
    expect(agentEnvironmentMarker({ CURSOR_AGENT: "1" })).toBe("CURSOR_AGENT");
    expect(agentEnvironmentMarker({ CLAUDECODE: "0", CURSOR_AGENT: "" })).toBeNull();
    expect(
      agentEnvironmentMarker({ HOME: "/home/a", CLAUDE_CODE_USE_BEDROCK: "1", CODEX_HOME: "/x" }),
    ).toBeNull();
  });

  it("names the agent a marker belongs to", () => {
    expect(agentEnvironmentName("CLAUDECODE")).toBe("Claude Code");
    expect(agentEnvironmentName("CLAUDE_CODE_ENTRYPOINT")).toBe("Claude Code");
    expect(agentEnvironmentName("CODEX_THREAD_ID")).toBe("Codex");
    expect(agentEnvironmentName("CODEX_SANDBOX_FOO")).toBe("Codex");
    expect(agentEnvironmentName("CURSOR_AGENT")).toBe("Cursor");
    expect(agentEnvironmentName("GEMINI_CLI")).toBe("Gemini CLI");
    expect(agentEnvironmentName("COPILOT_AGENT_X")).toBe("GitHub Copilot");
    expect(agentEnvironmentName("AGENT")).toBe("AI agent");
  });
});

describe("input caps", () => {
  it("bounds ids", () => {
    const long = "x".repeat(10_000);
    expect(contact.get.input.safeParse({ id: long }).success).toBe(false);
    expect(message.retry.input.safeParse({ id: long }).success).toBe(false);
    expect(message.remove.input.safeParse({ ids: [long] }).success).toBe(false);
    expect(draft.get.input.safeParse({ id: long }).success).toBe(false);
    expect(draft.get.input.safeParse({ id: "drf_1", wait: 61 }).success).toBe(false);
    expect(message.cancel.input.safeParse({ id: long }).success).toBe(false);
    expect(contact.get.input.safeParse({ id: "ok" }).success).toBe(true);
  });
});
