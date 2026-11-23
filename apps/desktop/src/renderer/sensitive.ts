/**
 * Phone details blurred until clicked (`<Sensitive>`): what the control says in each state. The
 * value itself is never in a tooltip or label, only on screen once revealed.
 */

export interface SensitiveCopy {
  /** The tooltip: what a click does. */
  tip: "Click to reveal" | "Click to hide";
  /** The accessible name while hidden (the value isn't read out); undefined once revealed. */
  label: string | undefined;
}

/** `what` names the value, such as "Bluetooth address" or "iPhone name". */
export function sensitiveCopy(what: string, revealed: boolean): SensitiveCopy {
  return revealed
    ? { tip: "Click to hide", label: undefined }
    : { tip: "Click to reveal", label: `${what}, hidden. Click to reveal.` };
}
