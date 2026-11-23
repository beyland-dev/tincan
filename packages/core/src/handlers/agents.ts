import { agents, TincanError, type HiddenPerson } from "@beyland/tincan-protocol";
import type { Core } from "../core.ts";
import { emitDraftChanged } from "../drafts.ts";
import { handleFor, normalizeThreadKey } from "../keys.ts";
import type { CommandRegistry } from "../registry.ts";
import { groupByTitle, requireThread, resolveGroupTarget } from "./common.ts";

export function agentHandlers(registry: CommandRegistry): CommandRegistry {
  return (
    registry
      .implement(agents.connections, async (_input, { core }) => {
        const apps = agentConnections(core);
        return { clients: await apps.list(), launch: apps.launch };
      })
      .implement(agents.connect, (input, { core }) =>
        agentConnections(core).connect(input.client, input.force),
      )
      .implement(agents.disconnect, (input, { core }) =>
        agentConnections(core).disconnect(input.client),
      )
      // Internal, all three: only the user gets here.
      .implement(agents.hidden, (_input, { core }) => {
        const store = core.requireStore();
        return { people: store.listHiddenPeople(), groups: store.listHiddenGroups() };
      })
      .implement(agents.hide, (input, { core }) => {
        const store = core.requireStore();
        const target =
          input.contactId !== undefined
            ? ({ kind: "contact", id: input.contactId } as const)
            : input.handle !== undefined
              ? ({ kind: "handle", handle: handleOf(core, input.handle) } as const)
              : input.groupKey !== undefined
                ? ({ kind: "group", key: resolveGroupTarget(core, input.groupKey) } as const)
                : hideTarget(core, input.target ?? "");
        if (target.kind === "group") {
          const thread = requireThread(core, target.key);
          if (thread.kind !== "group") throw new TincanError("INVALID_INPUT", "Not a group");
          const changed = thread.hiddenBy !== "group";
          if (changed) {
            store.setThreadHiddenFromAgents(thread.key, true);
            core.events.emit("thread.changed", { keys: [thread.key] });
          }
          const group = { threadKey: thread.key, title: thread.title };
          // Nobody can send to a group, so no agent send waits for one.
          return { changed, person: null, group, requeued: 0 };
        }
        const change =
          target.kind === "contact"
            ? store.hideContact(target.id)
            : store.hideHandle(target.handle, displayHandle(target.handle));
        if (!change) throw new TincanError("NOT_FOUND", "No such contact");
        announce(core, change.person.handles, change.changed);
        const requeued = requeueAgentSends(core, change.person.handles);
        return { changed: change.changed, person: change.person, group: null, requeued };
      })
      .implement(agents.show, (input, { core }) => {
        const store = core.requireStore();
        const target =
          input.personId !== undefined
            ? ({ kind: "person", id: input.personId } as const)
            : input.groupKey !== undefined
              ? ({ kind: "group", key: resolveGroupTarget(core, input.groupKey) } as const)
              : showTarget(core, input.target ?? "");
        if (target.kind === "none") return { changed: false };
        if (target.kind === "person") {
          const handles = store.showPerson(target.id);
          if (!handles) throw new TincanError("NOT_FOUND", "Nobody hidden from agents has that id");
          announce(core, handles, true);
          return { changed: true };
        }
        const thread = requireThread(core, target.key);
        const changed = thread.hiddenBy === "group";
        if (changed) {
          store.setThreadHiddenFromAgents(thread.key, false);
          core.events.emit("thread.changed", { keys: [thread.key] });
        } else if (thread.hiddenPerson) {
          throw new TincanError(
            "CONFLICT",
            `The group is hidden because ${thread.hiddenPerson.label} is in it; show them to agents instead`,
          );
        }
        return { changed };
      })
  );
}

type Target =
  | { kind: "contact"; id: string }
  | { kind: "handle"; handle: string }
  | { kind: "group"; key: string };

/** A phone number, email address or `tel:`/`email:`/`sender:` key as a handle; never a group. */
function handleOf(core: Core, raw: string): string {
  const text = raw.trim();
  const region = core.settings.defaultRegion;
  const key = text.startsWith("handle:")
    ? core.handleMasker.unmask(text, core.store)
    : (normalizeThreadKey(text, region) ?? handleFor(text, region));
  if (!key || key.startsWith("group:")) {
    throw new TincanError("INVALID_INPUT", "Expected a phone number or email address");
  }
  return key;
}

/**
 * What `agents.hide`'s `target` names: a group key, a number or address (or its key), else a
 * name: a contact called exactly that, a group conversation with that title, or the one contact
 * whose name has it.
 */
function hideTarget(core: Core, raw: string): Target {
  const text = raw.trim();
  if (text.startsWith("group:")) return { kind: "group", key: resolveGroupTarget(core, text) };
  if (text.startsWith("handle:")) {
    const key = core.handleMasker.unmask(text, core.store);
    if (!key) throw new TincanError("NOT_FOUND", "No such conversation");
    return key.startsWith("group:") ? { kind: "group", key } : { kind: "handle", handle: key };
  }
  if (
    normalizeThreadKey(text, core.settings.defaultRegion) ||
    text.includes("@") ||
    !/\p{L}/u.test(text)
  ) {
    return { kind: "handle", handle: handleOf(core, text) };
  }
  const store = core.requireStore();
  const found = store.searchContacts(text, { limit: 20 });
  const exact = found.filter((c) => c.name.toLocaleLowerCase() === text.toLocaleLowerCase());
  if (exact.length > 1) {
    throw new TincanError("INVALID_INPUT", `${exact.length} contacts have that name`);
  }
  if (exact[0]) return { kind: "contact", id: exact[0].id };
  const group = groupByTitle(core, text);
  if (group) return { kind: "group", key: group };
  if (found.length === 1) return { kind: "contact", id: found[0]!.id };
  if (found.length > 1) {
    throw new TincanError("INVALID_INPUT", `${found.length} contacts match; be more specific`);
  }
  throw new TincanError("NOT_FOUND", "No contact or group conversation matches");
}

/**
 * What `agents.show`'s `target` names: a hidden person's id or label, or anything `agents.hide`
 * takes. `none` when it names someone who isn't hidden.
 */
function showTarget(
  core: Core,
  raw: string,
): { kind: "person"; id: string } | { kind: "group"; key: string } | { kind: "none" } {
  const store = core.requireStore();
  const text = raw.trim();
  const people = store.listHiddenPeople();
  const byId = people.find((p) => p.id === text);
  if (byId) return { kind: "person", id: byId.id };
  const byLabel = people.filter((p) => p.label.toLocaleLowerCase() === text.toLocaleLowerCase());
  if (byLabel.length > 1) {
    throw new TincanError("INVALID_INPUT", `${byLabel.length} hidden people have that name`);
  }
  if (byLabel[0]) return { kind: "person", id: byLabel[0].id };
  const target = hideTarget(core, text);
  if (target.kind === "group") return target;
  const person: HiddenPerson | null =
    target.kind === "handle"
      ? store.hiddenPersonForHandle(target.handle)
      : (people.find((p) => p.contactId === target.id) ??
        store
          .getContact(target.id)
          ?.handles.map((h) => store.hiddenPersonForHandle(h))
          .find(Boolean) ??
        null);
  return person ? { kind: "person", id: person.id } : { kind: "none" };
}

/** Tells clients what hiding or showing someone changed: their conversations and contacts. */
function announce(core: Core, handles: readonly string[], changed: boolean): void {
  if (!changed) return;
  const store = core.requireStore();
  const keys = store.threadsWithHandles(handles);
  if (keys.length > 0) core.events.emit("thread.changed", { keys });
  const ids = store.contactsWithHandles(handles);
  if (ids.length > 0) core.events.emit("contact.changed", { ids });
}

/**
 * Takes back agents' direct sends to `handles` that haven't reached the phone (held for the agent
 * send delay, or waiting for it with no push running) and queues them as agent drafts for the
 * user, noted `hidden`. Messages the user sent from an agent draft are theirs and go on. Returns
 * how many it took back.
 */
function requeueAgentSends(core: Core, handles: readonly string[]): number {
  const store = core.requireStore();
  const keys = new Set(handles);
  let requeued = 0;
  for (const entry of store.outboxEntries()) {
    if (!entry.agentDraftId || entry.pushingSince !== null) continue;
    const message = store.getMessage(entry.messageId);
    if (!message || !keys.has(message.threadKey) || message.agent?.via !== "policy") continue;
    if (message.status !== "scheduled" && message.status !== "pending") continue;
    let draftId: string | null;
    try {
      draftId = cancelSend(core, message.id);
    } catch {
      // Already going to the phone: too late to take it back.
      continue;
    }
    if (!draftId) continue;
    const draft = store.setAgentDraftState(draftId, "queued", {
      from: ["scheduled"],
      messageId: null,
      front: true,
      note: "hidden",
    });
    if (draft) {
      emitDraftChanged(core.events, draft);
      core.events.emit("thread.changed", { keys: [draft.to] });
      requeued++;
    }
  }
  return requeued;
}

/** Cancels an outgoing message that hasn't reached the phone; returns its agent draft's id. */
function cancelSend(core: Core, id: string): string | null {
  const outbox = core.services.outbox;
  if (outbox) return outbox.cancel(id).agentDraftId;
  const store = core.requireStore();
  const result = store.cancelOutgoing(id);
  if (result === null) throw new TincanError("NOT_FOUND", "No such message");
  if (result === "busy") throw new TincanError("CONFLICT", "Already sending");
  core.events.emit("message.changed", { threadKey: result.threadKey, ids: [id] });
  core.events.emit("thread.changed", { keys: [result.threadKey] });
  return result.agentDraftId;
}

/** A raw handle as a label: its address without the scheme. */
function displayHandle(handle: string): string {
  return handle.replace(/^(tel|email|sender):/, "");
}

function agentConnections(core: Core) {
  if (!core.agentConnections) {
    throw new TincanError("NOT_FOUND", "This daemon can't set up agents");
  }
  return core.agentConnections;
}
