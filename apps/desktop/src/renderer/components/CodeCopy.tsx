import { useCopy } from "./CopyRow.tsx";
import { Icon } from "./Icon.tsx";

/** A one-time code written in a message, which copies (as digits) when clicked. */
export function CodeChip({ code, children }: { code: string; children: string }) {
  const [copied, copy] = useCopy();
  return (
    <button
      type="button"
      class={`code-chip ${copied ? "copied" : ""}`}
      data-tip={copied ? "Copied" : "Copy code"}
      data-tip-anchor="bubble"
      aria-label={copied ? `Copied ${code}` : `Copy code ${code}`}
      onClick={(e) => {
        e.stopPropagation();
        void copy(code);
      }}
    >
      {children}
    </button>
  );
}

/** Under a message that just brought a one-time code: copies it in one click. */
export function CopyCodePill({ code }: { code: string }) {
  const [copied, copy] = useCopy();
  return (
    <button
      type="button"
      class={`code-pill ${copied ? "copied" : ""}`}
      aria-label={copied ? `Copied ${code}` : `Copy code ${code}`}
      onClick={() => void copy(code)}
    >
      <Icon name={copied ? "check" : "copy"} size={12} />
      {copied ? "Copied" : "Copy code"}
    </button>
  );
}
