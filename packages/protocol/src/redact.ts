/*
 * Redaction for diagnostics people paste into bug reports (`tincan doctor --report`, the desktop's
 * Copy diagnostics). One helper for every client, so they can't drift apart.
 */
import type { DoctorReport } from "./entities.ts";

export const REDACTED_MAC = "XX:XX:XX:XX:XX:XX";

/** Colon- or dash-separated MACs, and BlueZ's D-Bus form (`dev_AA_BB_CC_DD_EE_FF`). */
const MAC = /(?<![0-9A-F])[0-9A-F]{2}([:-])[0-9A-F]{2}(?:\1[0-9A-F]{2}){4}(?![0-9A-F])/giu;
const DBUS_MAC = /dev(?:_[0-9A-F]{2}){6}(?![0-9A-F])/giu;
/** Home directories: `/home/<user>`, `/var/home/<user>` (Fedora Atomic), `/Users/<user>`, `/root`. */
const HOME_PATH = /(?:\/var)?\/home\/[^/\s:'"]+|\/Users\/[^/\s:'"]+|\/root(?=[/\s:'"]|$)/gu;
/** Newlines, tabs and other control or separator characters that could break a line apart. */
const CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu;

/** Checks whose detail starts with a personal device name: `<name> (<MAC>) …`. */
const NAMED_CHECKS: Record<string, string> = { phone: "iPhone", adapter: "adapter" };

/**
 * Text safe to share: control characters and newlines collapsed to a space, every Bluetooth
 * address fully masked (colon, dash and `dev_` forms) and home directories shown as `~`
 * (`home` is the user's own, when known, e.g. `$HOME`).
 */
export function redactDiagnosticText(text: string, options: { home?: string } = {}): string {
  let out = text.replace(CONTROL, " ");
  const home = options.home?.replace(/\/+$/, "");
  if (home && home.length > 1) out = out.split(home).join("~");
  return out
    .replace(DBUS_MAC, "dev_XX_XX_XX_XX_XX_XX")
    .replace(MAC, REDACTED_MAC)
    .replace(HOME_PATH, "~");
}

/** A Bluetooth address for a report: always fully masked. */
export function redactAddress(_address: string): string {
  return REDACTED_MAC;
}

/**
 * A doctor check's detail for a report. The phone and adapter checks start with the device's
 * name, which is often a person's name ("Alex's iPhone"): it is replaced with a generic label.
 */
export function redactCheckDetail(id: string, detail: string, options: { home?: string } = {}) {
  const out = redactDiagnosticText(detail, options);
  const label = NAMED_CHECKS[id];
  if (!label) return out;
  // Everything before the masked address is the name, whatever it contains. Without an address
  // the detail names no device ("No iPhone is paired").
  const at = out.indexOf(` (${REDACTED_MAC})`);
  return at >= 0 ? `${label}${out.slice(at)}` : out;
}

/** A doctor report with personal details redacted everywhere: details and hints. */
export function redactDoctorReport(
  report: DoctorReport,
  options: { home?: string } = {},
): DoctorReport {
  return {
    ...report,
    checks: report.checks.map((check) => ({
      ...check,
      title: redactDiagnosticText(check.title, options),
      detail: redactCheckDetail(check.id, check.detail, options),
      ...(check.hint !== undefined ? { hint: redactDiagnosticText(check.hint, options) } : {}),
    })),
  };
}
