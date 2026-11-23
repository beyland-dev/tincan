import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { formatHandle } from "../format.ts";
import { cancelCompose, contacts, peek, select, send, threads } from "../store.ts";
import { Avatar } from "./Avatar.tsx";
import { MessageField } from "./Composer.tsx";
import { MessageList } from "./Conversation.tsx";
import { Icon } from "./Icon.tsx";

interface Recipient {
  label: string;
  detail: string;
  to: string;
}

/** Phone numbers before email addresses: texting a number is what people mostly mean. */
function byPreference(handles: readonly string[]): string[] {
  const rank = (handle: string) => (handle.startsWith("tel:") ? 0 : 1);
  return [...handles].sort((a, b) => rank(a) - rank(b));
}

function suggest(query: string): Recipient[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const digits = q.replace(/\D/g, "");
  const out: Recipient[] = [];
  for (const contact of contacts.value) {
    for (const handle of byPreference(contact.handles)) {
      if (handle.startsWith("sender:")) continue;
      const shown = formatHandle(handle);
      const match =
        contact.name.toLowerCase().includes(q) ||
        shown.toLowerCase().includes(q) ||
        (digits.length >= 3 && handle.replace(/\D/g, "").includes(digits));
      if (match) out.push({ label: contact.name, detail: shown, to: handle });
    }
    if (out.length >= 8) break;
  }
  return out;
}

/** A new message, written in place of the open conversation. */
export function NewConversation() {
  const [to, setTo] = useState("");
  const [chosen, setChosen] = useState<Recipient | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState(0);
  const toRef = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => toRef.current?.focus(), []);

  const suggestions = useMemo(() => (chosen ? [] : suggest(to)), [to, chosen]);
  const existing = chosen ? threads.value.find((t) => t.key === chosen.to) : undefined;
  useEffect(() => {
    if (existing) void peek(existing.key);
  }, [existing?.key]);

  const pick = (r: Recipient) => {
    setChosen(r);
    setTo(r.label);
    textRef.current?.focus();
  };

  const submit = async () => {
    const target = chosen?.to ?? to.trim();
    const body = text.trim();
    if (!target || !body || busy) return;
    setBusy(true);
    const message = await send(target, body);
    setBusy(false);
    if (message) await select(message.threadKey);
  };

  return (
    <main class="conversation">
      <header class="conversation-header new-conversation">
        <label class="to-field">
          <span>To:</span>
          <input
            ref={toRef}
            placeholder="Name, phone number or email"
            value={to}
            onInput={(e) => {
              setTo(e.currentTarget.value);
              setChosen(null);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((i) => Math.min(i + 1, suggestions.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((i) => Math.max(i - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                const s = suggestions[active];
                if (s) pick(s);
                else textRef.current?.focus();
              } else if (e.key === "Escape" && !to) {
                cancelCompose();
              }
            }}
          />
          {chosen && <small>{chosen.detail}</small>}
        </label>
        <div class="toolbar">
          <button class="icon-button" data-tip="Cancel" aria-label="Cancel" onClick={cancelCompose}>
            <Icon name="close" />
          </button>
        </div>
        {suggestions.length > 0 && (
          <ul class="suggestions" role="listbox">
            {suggestions.map((s, i) => (
              <li key={s.to}>
                <button
                  class={i === active ? "active" : ""}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(s);
                  }}
                >
                  <Avatar name={s.label} size={28} />
                  <span>
                    {s.label}
                    <small>{s.detail}</small>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </header>
      {existing ? (
        <MessageList thread={existing} />
      ) : (
        <div class="message-list">
          <p class="history-start">Your iPhone sends it, just as if you'd typed it there.</p>
        </div>
      )}
      <MessageField
        inputRef={textRef}
        value={text}
        busy={busy}
        disabled={!(chosen || to.trim())}
        onInput={setText}
        onSubmit={() => void submit()}
      />
    </main>
  );
}
