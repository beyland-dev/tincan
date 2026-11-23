import type { Contact, Thread } from "@beyland/tincan-protocol";
import { useEffect, useRef } from "preact/hooks";
import {
  agentsOn,
  hiddenReason,
  personAction,
  threadHideAction,
  type HideAction,
} from "../agent-hiding.ts";
import { formatHandle } from "../format.ts";
import {
  connected,
  contactsByHandle,
  contactsSyncing,
  deleteThread,
  detail,
  infoOpen,
  names,
  photoFor,
  picked,
  pickMode,
  renameGroup,
  renamingThread,
  startPicking,
  setFlag,
  hiddenHandleMap,
  hideFromAgents,
  settings,
  showToAgents,
  syncContacts,
} from "../store.ts";
import { Avatar, ThreadAvatar } from "./Avatar.tsx";
import { CopyRow } from "./CopyRow.tsx";
import { Icon } from "./Icon.tsx";

/** Contact or group details beside the open conversation. */
export function InfoPanel({ thread }: { thread: Thread }) {
  const group = thread.kind === "group";
  const contact = group ? undefined : contactsByHandle.value.get(thread.members[0] ?? thread.key);
  const handles = group ? thread.members : (contact?.handles ?? thread.members);
  const roster = detail.value?.thread.key === thread.key ? detail.value.group : null;
  const title = group ? "Group Info" : "Contact Info";
  const moving = !!picked.value && pickMode.value === "group";
  const deleting = !!picked.value && pickMode.value === "delete";
  const agents = threadHideAction(thread, contact, settings.value);
  const reason = agentsOn(settings.value) ? hiddenReason(thread, !!contact) : null;
  return (
    <aside class="info-panel" aria-label={title}>
      <header class="info-panel-header">
        <h2>{title}</h2>
        <button
          class="icon-button"
          data-tip="Close"
          aria-label="Close"
          onClick={() => (infoOpen.value = false)}
        >
          <Icon name="close" />
        </button>
      </header>
      <div class="info-panel-body">
        <div class="info-hero">
          <ThreadAvatar thread={thread} size={76} />
          {group ? <GroupName thread={thread} /> : <h3>{thread.title}</h3>}
          {group &&
            roster?.participants &&
            roster.participants.length > 0 &&
            roster.participants.join(", ") !== thread.title && (
              <p class="muted">{roster.participants.join(", ")}</p>
            )}
          {reason && (
            <p class="info-hidden">
              <Icon name="hide" size={13} />
              {reason}
            </p>
          )}
        </div>
        {handles.length > 0 && (
          <section class="info-section">
            <h4>{group ? "Members" : "Phone & email"}</h4>
            <ul class="info-list">
              {handles.map((h) => {
                const shown = formatHandle(h);
                const phone = h.startsWith("tel:");
                return group ? (
                  <CopyRow
                    key={h}
                    text={shown}
                    what={phone ? "phone number" : "email address"}
                    label={<MemberLabel handle={h} />}
                    leading={
                      <Avatar name={names.value.get(h) ?? shown} photo={photoFor(h)} size={28} />
                    }
                    actions={<MemberHideButton handle={h} />}
                  />
                ) : (
                  <CopyRow
                    key={h}
                    text={shown}
                    what={phone ? "phone number" : "email address"}
                    label={handleLabel(contact?.labels?.[h], phone)}
                  />
                );
              })}
            </ul>
          </section>
        )}
        {contact && <ContactDetailsCard contact={contact} />}
        <section class="info-section info-actions">
          <button class="button" onClick={() => void setFlag(thread.key, "pinned", !thread.pinned)}>
            <Icon name="pin" size={15} /> {thread.pinned ? "Unpin" : "Pin"}
          </button>
          <button class="button" onClick={() => void setFlag(thread.key, "muted", !thread.muted)}>
            <Icon name={thread.muted ? "bell" : "bellOff"} size={15} />{" "}
            {thread.muted ? "Unmute" : "Mute"}
          </button>
          {agents && agents.kind !== "explain" && (
            <button
              class="button"
              data-tip={agents.hint}
              onClick={() => void runHideAction(agents)}
            >
              <Icon name={agents.icon} size={15} /> {agents.label}
            </button>
          )}
          {!group && (
            <button
              class={`button ${moving ? "on" : ""}`}
              data-tip="Pick messages from this conversation that belong in a group"
              aria-pressed={moving}
              onClick={() => startPicking("group")}
            >
              <Icon name="people" size={15} /> Move Messages to a Group…
            </button>
          )}
          <button
            class={`button ${deleting ? "on" : ""}`}
            data-tip="Pick messages to delete from Tincan; your iPhone keeps them"
            aria-pressed={deleting}
            onClick={() => startPicking("delete")}
          >
            <Icon name="trash" size={15} /> Delete Messages…
          </button>
          <button class="button danger" onClick={() => void deleteThread(thread.key)}>
            <Icon name="trash" size={15} /> Delete Conversation
          </button>
        </section>
        <p class="setting-hint info-hint">
          {group
            ? "Your iPhone doesn't share group details over Bluetooth; Tincan pieces them together from the texts it sees."
            : contact
              ? "Contacts come from your iPhone over Bluetooth, read-only. Edit them on your iPhone, then refresh them here."
              : "This number isn't in your iPhone's contacts. Add it there, then refresh contacts here."}
        </p>
        {!group && (
          <button
            class="button info-refresh"
            disabled={!connected.value || contactsSyncing.value}
            data-tip={
              connected.value
                ? "Read every contact from your iPhone again"
                : "Connect your iPhone to refresh contacts"
            }
            onClick={() => void syncContacts()}
          >
            <span class={contactsSyncing.value ? "spin" : ""}>
              <Icon name="refresh" size={15} />
            </span>
            {contactsSyncing.value ? "Refreshing Contacts…" : "Refresh Contacts"}
          </button>
        )}
        {!group && <SharedFields />}
      </div>
    </aside>
  );
}

function runHideAction(action: HideAction): Promise<boolean> | undefined {
  if (action.kind === "hide") return hideFromAgents(action.target);
  if (action.kind === "show") return showToAgents(action.target);
  return undefined;
}

/** Whether a group member is hidden from agents: as a contact, or as a number or address. */
function hiddenMember(handle: string) {
  const person = hiddenHandleMap.value.get(handle);
  if (person) return person;
  const contact = contactsByHandle.value.get(handle);
  return contact?.hiddenFromAgents ? { id: undefined, label: contact.name } : undefined;
}

/** A member's name, with a mark when they're hidden from agents. */
function MemberLabel({ handle }: { handle: string }) {
  const name = names.value.get(handle) ?? null;
  const hidden = agentsOn(settings.value) && !!hiddenMember(handle);
  return (
    <>
      {name}
      {hidden && (
        <span
          class="agent-hidden-badge"
          role="img"
          aria-label="Hidden from agents"
          data-tip="Hidden from agents"
        >
          <Icon name="hide" size={12} />
        </span>
      )}
    </>
  );
}

/** Hide a group member from agents, or show them again, beside the member's Copy button. */
function MemberHideButton({ handle }: { handle: string }) {
  if (!agentsOn(settings.value)) return null;
  const contact = contactsByHandle.value.get(handle);
  const person = hiddenMember(handle);
  // A hidden contact not in the list yet (it's still loading) can't be shown by id.
  if (person && !person.id) return null;
  const action = personAction(
    handle,
    contact,
    person?.id ? { id: person.id, label: person.label } : undefined,
  );
  return (
    <button
      type="button"
      class="copy-row-button"
      aria-label={action.label}
      data-tip={action.hint}
      onClick={() => void runHideAction(action)}
    >
      <Icon name={action.icon} size={13} />
      <span>{action.kind === "show" ? "Show" : "Hide"}</span>
    </button>
  );
}

/** A group's name, which the user can change: Enter or leaving the field saves, Escape cancels. */
function GroupName({ thread }: { thread: Thread }) {
  const editing = renamingThread.value === thread.key;
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);
  if (!editing) {
    return (
      <h3 class="info-name">
        <span>{thread.title}</span>
        <button
          class="icon-button info-rename"
          data-tip="Rename group"
          aria-label="Rename group"
          onClick={() => (renamingThread.value = thread.key)}
        >
          <Icon name="pencil" size={14} />
        </button>
      </h3>
    );
  }
  return (
    <div class="info-name-edit">
      <input
        ref={input}
        class="input"
        aria-label="Group name"
        maxLength={200}
        defaultValue={thread.title}
        placeholder="Members' names"
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            e.stopPropagation();
            renamingThread.value = null;
          }
        }}
        onBlur={(e) => {
          if (renamingThread.value === thread.key)
            void renameGroup(thread.key, e.currentTarget.value);
        }}
      />
      <p class="setting-hint">Only Tincan uses this name. Leave it empty to list the members.</p>
    </div>
  );
}

/** iOS's names for vCard types: "cell" is "mobile". */
function handleLabel(label: string | undefined, phone: boolean): string {
  if (!label) return phone ? "phone" : "email";
  const names: Record<string, string> = { cell: "mobile", iphone: "iPhone", main: "main" };
  return names[label] ?? label;
}

/** A vCard BDAY (`1815-12-10`, `18151210`, `--1210`, `--12-10`) as a date, else as sent. */
function formatBirthday(value: string): string {
  const m = /^(\d{4}|--)-?(\d{2})-?(\d{2})/.exec(value.trim());
  if (!m) return value;
  const year = m[1] === "--" ? 2000 : Number(m[1]);
  const date = new Date(year, Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, {
    month: "long",
    day: "numeric",
    ...(m[1] === "--" ? {} : { year: "numeric" }),
  });
}

/** The rest of the phone's card: company, addresses, websites and whatever else it sent. */
function ContactDetailsCard({ contact }: { contact: Contact }) {
  const d = contact.details;
  if (!d) return null;
  const work = [d.jobTitle, d.department, d.company].filter(Boolean).join(" · ");
  const rows = [
    d.nickname && <CopyRow key="nick" label="nickname" what="nickname" text={d.nickname} />,
    work && <CopyRow key="work" label="work" what="company" text={work} />,
    d.birthday && (
      <CopyRow key="bday" label="birthday" what="birthday" text={formatBirthday(d.birthday)} />
    ),
    ...(d.addresses ?? []).map((a, i) => (
      <CopyRow key={`adr${i}`} label={a.label ?? "address"} what="address" text={a.value}>
        <span class="copy-row-multiline">{a.value}</span>
      </CopyRow>
    )),
    ...(d.urls ?? []).map((u, i) => (
      <CopyRow key={`url${i}`} label={u.label ?? "website"} what="website" text={u.value} />
    )),
    d.note && (
      <CopyRow key="note" label="notes" what="notes" text={d.note}>
        <span class="copy-row-multiline">{d.note}</span>
      </CopyRow>
    ),
  ].filter(Boolean);
  if (rows.length === 0) return null;
  return (
    <section class="info-section">
      <h4>Details</h4>
      <ul class="info-list">{rows}</ul>
    </section>
  );
}

const SHARED = [
  "Name",
  "Phone numbers",
  "Email addresses",
  "Photo",
  "Company",
  "Addresses",
  "Websites",
];
const NOT_SHARED = [
  "Birthday",
  "Notes",
  "Nickname",
  "Job title",
  "Related names",
  "Social profiles",
  "Dates",
];

/** What the iPhone's Bluetooth phonebook includes, and what stays on the phone. */
function SharedFields() {
  return (
    <details class="info-shared">
      <summary>
        <Icon name="chevronDown" size={13} /> What your iPhone shares
      </summary>
      <div class="info-shared-body">
        <p class="info-shared-label">Shared over Bluetooth</p>
        <ul class="info-chips">
          {SHARED.map((f) => (
            <li key={f}>
              <Icon name="check" size={11} /> {f}
            </li>
          ))}
        </ul>
        <p class="info-shared-label">Stays on your iPhone</p>
        <ul class="info-chips off">
          {NOT_SHARED.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
        <p class="setting-hint">
          iOS sends only these fields over Bluetooth, so the rest can't appear in Tincan.
        </p>
      </div>
    </details>
  );
}
