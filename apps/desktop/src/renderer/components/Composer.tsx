import type { AgentDraft, Thread } from "@beyland/tincan-protocol";
import type { Ref } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { draftAge } from "../countdown.ts";
import { draftChips, stripHidden, type DraftChip } from "../draft-checks.ts";
import { draftText } from "../draft-rows.ts";
import { takeDraft } from "../draft.ts";
import {
  enterBlocked,
  guardUntil,
  nextSlot,
  OWN,
  queueLabel,
  savedOwnDraft,
  type SlotId,
  slotOrder,
  stepperPosition,
  stepSlot,
} from "../slots.ts";
import {
  connected,
  detail,
  dialog,
  discardAgentDraft,
  discardDraft,
  draftsByKey,
  draftsLoaded,
  focusDraft,
  isPending,
  pendingOwnDraft,
  picked,
  saveAgentDraft,
  saveDraft,
  saveNewRecipientDraft,
  send,
  sendAgentDraft,
  setOwnTextSink,
  threads,
  undoLatestScheduled,
} from "../store.ts";
import { Icon } from "./Icon.tsx";

export const SELF_REPORTED =
  "Apps name themselves when they connect to Tincan, and Tincan can't check the name. Anything that can reach Tincan on this computer can claim to be any app.";

const SAVE_MS = 600;

function cannotReply(thread: Thread): string | null {
  if (thread.kind === "group") return "Reply to group conversations on your iPhone.";
  if (thread.key.startsWith("sender:")) return "This sender doesn't accept replies.";
  return null;
}

type Timer = ReturnType<typeof setTimeout>;

/**
 * The message box, with its slots: the user's own draft and the conversation's queued agent
 * drafts (oldest first). One shows at a time; the pill above says whose it is.
 */
export function Composer({ thread }: { thread: Thread }) {
  // A new recipient (drafts waiting, no conversation yet): the user's own draft is saved for the
  // recipient (`to`) and comes back with the list's new recipients.
  const pending = !threads.value.some((t) => t.key === thread.key) && isPending(thread.key);
  const persist = (value: string) =>
    pending ? saveNewRecipientDraft(thread.key, value) : saveDraft(thread.key, value);
  const queue = draftsByKey.value.get(thread.key) ?? [];
  const ids = queue.map((d) => d.id);
  const idsKey = ids.join(",");

  const [active, setActive] = useState<SlotId>(OWN);
  const [own, setOwn] = useState("");
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const [announced, setAnnounced] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  // Mirrors of state the effects below read before a re-render lands.
  const ownRef = useRef("");
  const editsRef = useRef<Record<string, string>>({});
  const ownTimer = useRef<Timer | undefined>(undefined);
  const agentTimers = useRef(new Map<string, Timer>());
  // The user's saved draft the composer last took, or null before the details arrive.
  const loadedOwn = useRef<string | null>(null);
  // The queue as last seen, or null before it first loads.
  const seen = useRef<string[] | null>(null);
  // Enter (and Send) does nothing until then: just after a send, or a draft loading by itself.
  const guard = useRef(0);
  const blocked = cannotReply(thread);

  const setOwnText = (value: string) => {
    ownRef.current = value;
    setOwn(value);
  };

  // The user's saved draft arrives with the conversation's details (a new recipient's, with the
  // drafts).
  const info = detail.value?.thread.key === thread.key ? detail.value : undefined;
  const ownSaved = savedOwnDraft({
    newRecipient: pending,
    draftsLoaded: draftsLoaded.value,
    newRecipientDraft: pending ? pendingOwnDraft(thread.key) : "",
    detailDraft: info ? info.draft : undefined,
  });
  useEffect(() => {
    if (ownSaved === undefined) return;
    const next = takeDraft(ownRef.current, loadedOwn.current, ownSaved);
    if (next === null) return;
    loadedOwn.current = ownSaved;
    if (next !== ownRef.current) setOwnText(next);
  }, [ownSaved]);

  // Pick the slot to show as drafts arrive and leave.
  const ready = ownSaved !== undefined && draftsLoaded.value;
  const wanted = focusDraft.value;
  useEffect(() => {
    if (!ready) return;
    const first = seen.current === null;
    const before = seen.current ?? [];
    seen.current = ids;
    let next = nextSlot({ active, ownText: ownRef.current, before, after: ids });
    if (wanted && ids.includes(wanted)) {
      next = wanted;
      focusDraft.value = null;
    } else if (next !== active && next !== OWN) {
      // Loaded by itself: give the user a moment before Enter can send it.
      guard.current = Math.max(guard.current, guardUntil(Date.now()));
    }
    if (next !== active) setActive(next);
    const arrived = queue.filter((d) => !before.includes(d.id));
    if (!first && arrived.length > 0) {
      const who = arrived[0]!.agentName;
      setAnnounced(
        next === arrived[0]!.id
          ? `${who} drafted a message here. It's in the message box.`
          : `${who} drafted a message here. Press Control right bracket to view it.`,
      );
    }
    const kept = Object.fromEntries(
      Object.entries(editsRef.current).filter(([id]) => ids.includes(id)),
    );
    if (Object.keys(kept).length !== Object.keys(editsRef.current).length) {
      editsRef.current = kept;
      setEdits(kept);
    }
  }, [ready, idsKey, wanted]);

  useEffect(() => {
    if (!blocked) ref.current?.focus();
  }, [thread.key]);

  // A cancelled message of the user's comes back here when their own draft is empty.
  useEffect(
    () =>
      setOwnTextSink((key, value) => {
        if (key !== thread.key || ownRef.current.trim()) return false;
        setOwnText(value);
        setActive(OWN);
        void persist(value);
        ref.current?.focus();
        return true;
      }),
    [thread.key, pending],
  );

  const activeDraft = active === OWN ? undefined : queue.find((d) => d.id === active);
  const slot = activeDraft?.id ?? OWN;
  const text = activeDraft ? (edits[activeDraft.id] ?? draftText(activeDraft)) : own;

  const show = (next: SlotId) => {
    setActive(next);
    ref.current?.focus();
  };

  const step = (delta: number) => {
    const order = slotOrder(slot, own, ids);
    show(stepSlot(order, slot, delta));
  };

  /** Saves an agent draft's pending edit now instead of after the pause. */
  const flushDraft = (draft: AgentDraft) => {
    const timer = agentTimers.current.get(draft.id);
    if (!timer) return;
    clearTimeout(timer);
    agentTimers.current.delete(draft.id);
    void saveAgentDraft(draft.id, editsRef.current[draft.id] ?? draftText(draft));
  };

  const update = (value: string) => {
    if (activeDraft) {
      const id = activeDraft.id;
      editsRef.current = { ...editsRef.current, [id]: value };
      setEdits(editsRef.current);
      clearTimeout(agentTimers.current.get(id));
      agentTimers.current.set(
        id,
        setTimeout(() => {
          agentTimers.current.delete(id);
          void saveAgentDraft(id, value);
        }, SAVE_MS),
      );
      return;
    }
    setOwnText(value);
    clearTimeout(ownTimer.current);
    ownTimer.current = setTimeout(() => void persist(value), SAVE_MS);
  };

  const discard = () => {
    if (!activeDraft) return;
    flushDraft(activeDraft);
    void discardAgentDraft(activeDraft);
    ref.current?.focus();
  };

  const submit = async () => {
    if (sending || enterBlocked(guard.current, Date.now())) return;
    if (activeDraft) {
      if (!text.trim()) return;
      clearTimeout(agentTimers.current.get(activeDraft.id));
      agentTimers.current.delete(activeDraft.id);
      setSending(true);
      const ok = await sendAgentDraft(activeDraft, text);
      setSending(false);
      if (ok) guard.current = guardUntil(Date.now());
    } else {
      const body = own.trim();
      if (!body) return;
      setSending(true);
      clearTimeout(ownTimer.current);
      const sent = await send(thread.key, body, { fromNewRecipientDraft: pending });
      setSending(false);
      if (sent) {
        guard.current = guardUntil(Date.now());
        setOwnText("");
        loadedOwn.current = "";
        // A new recipient's draft goes in `send`, before the new conversation opens.
        if (!pending) void discardDraft(thread.key);
      }
    }
    ref.current?.focus();
  };

  // Shortcuts anywhere in the conversation (the composer is only there while one is open).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (dialog.value || picked.value || blocked) return;
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      if (e.code === "BracketRight" || e.code === "BracketLeft") {
        e.preventDefault();
        step(e.code === "BracketRight" ? 1 : -1);
      } else if (e.shiftKey && e.key === "Backspace" && activeDraft) {
        e.preventDefault();
        discard();
      } else if (e.shiftKey && e.key.toLowerCase() === "z" && undoLatestScheduled(thread.key)) {
        // Otherwise it's left to the text box (redo).
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (blocked) return <div class="composer blocked">{blocked}</div>;

  return (
    <>
      <p class="sr-only" role="status" aria-live="polite">
        {announced}
      </p>
      {activeDraft ? (
        <DraftBar
          draft={activeDraft}
          text={text}
          position={stepperPosition(slot, ids)}
          ownWaiting={own.trim() !== ""}
          onStep={step}
          onDiscard={discard}
          onOwn={() => show(OWN)}
          onRemoveHidden={() => update(stripHidden(text))}
        />
      ) : (
        queue.length > 0 && (
          <div class="draft-bar">
            <div class="draft-notice">
              <Icon name="pencil" size={13} />
              <span class="draft-notice-text">{queueLabel(queue)}</span>
              <Dot />
              <button
                type="button"
                class="link"
                data-tip="Show the drafts (Ctrl+])"
                onClick={() => show(ids[0]!)}
              >
                View
              </button>
            </div>
          </div>
        )
      )}
      <MessageField
        inputRef={ref}
        value={text}
        busy={sending}
        onInput={update}
        onSubmit={() => void submit()}
        onKeyDown={(e) => {
          // Ctrl+Z in an empty box undoes the last message still waiting to send.
          const z = (e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "z";
          if (z && text === "" && undoLatestScheduled(thread.key)) e.preventDefault();
        }}
      />
    </>
  );
}

function Dot() {
  return (
    <span class="draft-dot" aria-hidden="true">
      ·
    </span>
  );
}

/**
 * Above the composer while it shows an agent's draft: whose it is, its place in the queue, how to
 * throw it away or get back to the user's own draft, and anything in it worth a second look.
 */
function DraftBar(props: {
  draft: AgentDraft;
  text: string;
  position: { index: number; total: number } | null;
  ownWaiting: boolean;
  onStep: (delta: number) => void;
  onDiscard: () => void;
  onOwn: () => void;
  onRemoveHidden: () => void;
}) {
  const { draft, position } = props;
  const age = draftAge(draft.createdAt, Date.now());
  const chips = draftChips(props.text, { note: draft.note });
  return (
    <div class="draft-bar">
      <div class="draft-notice" role="group" aria-label={`Draft by ${draft.agentName}`}>
        {position ? (
          <span class="draft-stepper">
            <button
              type="button"
              class="icon-button tiny"
              aria-label="Previous draft"
              data-tip="Previous (Ctrl+[)"
              disabled={position.index === 1 && !props.ownWaiting}
              onClick={() => props.onStep(-1)}
            >
              <Icon name="back" size={12} />
            </button>
            <span class="draft-position">
              {position.index} of {position.total}
            </span>
            <button
              type="button"
              class="icon-button tiny flip"
              aria-label="Next draft"
              data-tip="Next (Ctrl+])"
              disabled={position.index === position.total}
              onClick={() => props.onStep(1)}
            >
              <Icon name="back" size={12} />
            </button>
          </span>
        ) : (
          <Icon name="pencil" size={13} />
        )}
        <span class="draft-notice-text">
          Drafted by{" "}
          <strong class="draft-agent" data-tip={SELF_REPORTED}>
            {draft.agentName}
          </strong>
          {age && (
            <span class="draft-age" data-tip={new Date(draft.createdAt).toLocaleString()}>
              {" "}
              · {age}
            </span>
          )}
        </span>
        <Dot />
        <button
          type="button"
          class="link"
          data-tip="Discard (Ctrl+Shift+Backspace)"
          onClick={props.onDiscard}
        >
          Discard
        </button>
        {props.ownWaiting && (
          <>
            <Dot />
            <button type="button" class="link" onClick={props.onOwn}>
              Your draft
            </button>
          </>
        )}
      </div>
      {chips.length > 0 && (
        <ul class="draft-chips" aria-label="Things to check">
          {chips.map((chip) => (
            <Chip key={chip.id} chip={chip} onRemoveHidden={props.onRemoveHidden} />
          ))}
        </ul>
      )}
    </div>
  );
}

function Chip({ chip, onRemoveHidden }: { chip: DraftChip; onRemoveHidden: () => void }) {
  return (
    <li class={`draft-chip ${chip.tone}`}>
      <span data-tip={chip.tip} tabIndex={chip.tip ? 0 : undefined}>
        <Icon name={chip.icon} size={12} />
        {chip.label}
      </span>
      {chip.id === "hidden" && (
        <button type="button" class="link" onClick={onRemoveHidden}>
          Remove hidden characters
        </button>
      )}
    </li>
  );
}

/** The message box and send button at the foot of a conversation. */
export function MessageField(props: {
  value: string;
  busy: boolean;
  disabled?: boolean;
  inputRef?: Ref<HTMLTextAreaElement>;
  onInput: (value: string) => void;
  onSubmit: () => void;
  /** Runs first; preventing the default skips the field's own handling. */
  onKeyDown?: (e: KeyboardEvent) => void;
}) {
  const own = useRef<HTMLTextAreaElement>(null);
  const ref = (props.inputRef ?? own) as { current: HTMLTextAreaElement | null };

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    const border = el.offsetHeight - el.clientHeight;
    const height = el.scrollHeight + border;
    el.style.height = `${Math.min(height, 180)}px`;
    el.style.overflowY = height > 180 ? "auto" : "hidden";
  }, [props.value]);

  const ready = connected.value && !props.disabled;
  return (
    <form
      class="composer"
      onSubmit={(e) => {
        e.preventDefault();
        props.onSubmit();
      }}
    >
      <div class="composer-field">
        <textarea
          ref={ref}
          rows={1}
          placeholder={connected.value ? "Text Message" : "Waiting for Tincan…"}
          value={props.value}
          maxLength={10_000}
          onInput={(e) => props.onInput(e.currentTarget.value)}
          onKeyDown={(e) => {
            props.onKeyDown?.(e);
            if (e.defaultPrevented) return;
            if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
              e.preventDefault();
              props.onSubmit();
            }
          }}
        />
        <button
          class="send-button"
          type="submit"
          data-tip="Send (Enter)"
          aria-label="Send"
          disabled={!props.value.trim() || props.busy || !ready}
        >
          <Icon name="send" size={16} />
        </button>
      </div>
    </form>
  );
}
