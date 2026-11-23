import {
  redactAddress,
  redactCheckDetail,
  redactDiagnosticText,
  type DoctorReport,
  type OutputOf,
} from "@beyland/tincan-protocol";

export { redactAddress };

type History = OutputOf<"device.history">;

const MARKS: Record<DoctorReport["checks"][number]["status"], string> = {
  ok: "✓",
  warn: "!",
  fail: "✗",
  skip: "-",
};

/**
 * Plain text for a bug report: the doctor's checks and the connection history, with Bluetooth
 * addresses, personal device names and home directories redacted (the same redaction as
 * `tincan doctor --report`). Never holds messages or contacts.
 */
export function diagnosticsText(input: {
  version: string | null;
  doctor: DoctorReport | null;
  history: History | null;
}): string {
  const lines = [`Tincan ${input.version ?? "(daemon not running)"}`, ""];
  lines.push("Checks");
  if (input.doctor) {
    lines.push(`  generated ${iso(input.doctor.generatedAt)}`);
    for (const c of input.doctor.checks) {
      const title = redactDiagnosticText(c.title);
      lines.push(`  ${MARKS[c.status]} ${title}: ${redactCheckDetail(c.id, c.detail)}`);
    }
  } else {
    lines.push("  unavailable");
  }
  lines.push("", "Connection history");
  if (!input.history) lines.push("  unavailable");
  else if (input.history.length === 0) lines.push("  nothing recorded yet");
  for (const e of input.history ?? []) {
    const address = e.address ? redactAddress(e.address) : null;
    const code = e.code && `[${redactDiagnosticText(e.code)}]`;
    const rest = [address, code].filter(Boolean).join(" ");
    const kind = redactDiagnosticText(e.kind).padEnd(8);
    const state = redactDiagnosticText(e.state);
    lines.push(`  ${iso(e.at)}  ${kind} ${state}${rest ? `  ${rest}` : ""}`);
  }
  return `${lines.join("\n")}\n`;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}
