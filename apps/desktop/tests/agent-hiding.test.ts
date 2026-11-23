import {
  DEFAULT_SETTINGS,
  type AgentAccess,
  type Contact,
  type HiddenPerson,
  type Thread,
} from "@beyland/tincan-protocol";
import { describe, expect, it } from "vite-plus/test";
import {
  agentsOn,
  displayLabel,
  hiddenList,
  hiddenPersonDetail,
  hiddenPersonLabel,
  hiddenReason,
  hideCandidates,
  personAction,
  PICKER_LIMIT,
  threadHideAction,
  typedHandle,
} from "../src/renderer/agent-hiding.ts";

function settings(access: AgentAccess) {
  return { agents: { ...DEFAULT_SETTINGS.agents, access } };
}
const ON = settings("assistant");

function thread(key: string, title: string, change: Partial<Thread> = {}): Thread {
  return {
    key,
    kind: key.startsWith("group:") ? "group" : "direct",
    title,
    members: key.startsWith("group:") ? [] : [key],
    lastMessage: null,
    unread: 0,
    muted: false,
    pinned: false,
    ...change,
  };
}

function contact(id: string, name: string, handles: string[], change: Partial<Contact> = {}) {
  return { id, name, handles, hasPhoto: false, ...change } satisfies Contact;
}

function person(change: Partial<HiddenPerson> = {}): HiddenPerson {
  return {
    id: "p1",
    label: "Mom",
    contactId: "c-mom",
    contactRemoved: false,
    handles: ["tel:+12065550101"],
    createdAt: 0,
    ...change,
  };
}

const MOM = contact("c-mom", "Mom", ["tel:+12065550101", "email:mom@example.com"]);
const ADA = contact("c-ada", "Ada Lovelace", ["tel:+12065550102"]);
const NEVER = contact("c-nev", "Nevin Texted", ["tel:+12065550199"]);
const MOM_CHAT = thread("tel:+12065550101", "Mom");
const ADA_CHAT = thread("tel:+12065550102", "Ada Lovelace");
const STRANGER = thread("tel:+447700900123", "+447700900123");
const CLUB = thread("group:name:club", "Book Club", {
  members: ["tel:+12065550101", "email:carol@example.com"],
});

describe("when the actions show", () => {
  it("only while agents have some access", () => {
    expect(agentsOn(null)).toBe(false);
    expect(agentsOn(undefined)).toBe(false);
    expect(agentsOn(settings("off"))).toBe(false);
    for (const access of ["readOnly", "assistant", "full"] as const) {
      expect(agentsOn(settings(access))).toBe(true);
    }
    expect(threadHideAction(MOM_CHAT, MOM, settings("off"))).toBeNull();
    expect(threadHideAction(CLUB, undefined, null)).toBeNull();
  });
});

describe("threadHideAction", () => {
  it("hides a contact's conversation as the person, by name", () => {
    expect(threadHideAction(MOM_CHAT, MOM, ON)).toMatchObject({
      kind: "hide",
      label: "Hide Mom from agents",
      target: { contactId: "c-mom" },
    });
  });

  it("hides a raw number as a number", () => {
    expect(threadHideAction(STRANGER, undefined, ON)).toMatchObject({
      kind: "hide",
      label: "Hide number from agents",
      target: { handle: "tel:+447700900123" },
    });
    const email = thread("email:x@example.com", "x@example.com");
    expect(threadHideAction(email, undefined, ON)?.label).toBe("Hide email from agents");
  });

  it("shows a hidden person again by their id", () => {
    const hidden = { ...MOM_CHAT, hiddenFromAgents: true, hiddenBy: "person" as const };
    expect(
      threadHideAction({ ...hidden, hiddenPerson: { id: "p1", label: "Mom" } }, MOM, ON),
    ).toMatchObject({ kind: "show", label: "Show Mom to agents", target: { personId: "p1" } });
    const raw = {
      ...STRANGER,
      hiddenFromAgents: true,
      hiddenBy: "person" as const,
      hiddenPerson: { id: "p2", label: "+447700900123" },
    };
    expect(threadHideAction(raw, undefined, ON)?.label).toBe("Show number to agents");
  });

  it("keeps a deleted contact's name", () => {
    const hidden = {
      ...MOM_CHAT,
      hiddenFromAgents: true,
      hiddenBy: "person" as const,
      hiddenPerson: { id: "p1", label: "Mom" },
    };
    expect(threadHideAction(hidden, undefined, ON)?.label).toBe("Show Mom to agents");
  });

  it("hides and shows a group as itself", () => {
    expect(threadHideAction(CLUB, undefined, ON)).toMatchObject({
      kind: "hide",
      label: "Hide group from agents",
      target: { groupKey: "group:name:club" },
    });
    const hidden = { ...CLUB, hiddenFromAgents: true, hiddenBy: "group" as const };
    expect(threadHideAction(hidden, undefined, ON)).toMatchObject({
      kind: "show",
      label: "Show group to agents",
      target: { groupKey: "group:name:club" },
    });
  });

  it("explains a group hidden only through a member, instead of offering Show", () => {
    const hidden = {
      ...CLUB,
      hiddenFromAgents: true,
      hiddenBy: "person" as const,
      hiddenPerson: { id: "p1", label: "Mom" },
    };
    expect(threadHideAction(hidden, undefined, ON)).toMatchObject({
      kind: "explain",
      label: "Hidden because Mom is hidden",
    });
    const raw = { ...hidden, hiddenPerson: { id: "p2", label: "+12065550101" } };
    expect(threadHideAction(raw, undefined, ON)?.label).toBe(
      "Hidden because +1 (206) 555-0101 is hidden",
    );
  });
});

describe("personAction", () => {
  it("names a member by contact, else by what they are", () => {
    expect(personAction("tel:+12065550102", ADA, undefined).label).toBe(
      "Hide Ada Lovelace from agents",
    );
    expect(personAction("email:carol@example.com", undefined, undefined)).toMatchObject({
      label: "Hide email from agents",
      target: { handle: "email:carol@example.com" },
    });
    expect(
      personAction("email:carol@example.com", undefined, {
        id: "p3",
        label: "carol@example.com",
      }),
    ).toMatchObject({ label: "Show email to agents", target: { personId: "p3" } });
  });
});

describe("hiddenReason", () => {
  it("says nothing for a conversation agents can see", () => {
    expect(hiddenReason(MOM_CHAT, true)).toBeNull();
  });

  it("covers a contact's every number and group", () => {
    expect(hiddenReason({ ...MOM_CHAT, hiddenFromAgents: true }, true)).toBe(
      "Hidden from AI agents, including all their numbers and emails and groups they're in.",
    );
    expect(hiddenReason({ ...STRANGER, hiddenFromAgents: true }, false)).toMatch(
      /groups with this number/,
    );
  });

  it("names the hidden member that hides a group", () => {
    const byMom = {
      ...CLUB,
      hiddenFromAgents: true,
      hiddenBy: "person" as const,
      hiddenPerson: { id: "p1", label: "Mom" },
    };
    expect(hiddenReason(byMom, false)).toBe("Hidden from AI agents because Mom is hidden.");
    expect(hiddenReason({ ...CLUB, hiddenFromAgents: true, hiddenBy: "group" }, false)).toBe(
      "Hidden from AI agents.",
    );
  });
});

describe("the Settings list", () => {
  it("counts a contact's numbers and emails", () => {
    expect(hiddenPersonDetail(person())).toBe("1 number");
    expect(hiddenPersonDetail(person({ handles: ["tel:+1", "tel:+2", "email:a@b.co"] }))).toBe(
      "2 numbers · 1 email",
    );
  });

  it("says when the contact's gone, or there never was one", () => {
    expect(hiddenPersonDetail(person({ contactId: null, contactRemoved: true }))).toBe(
      "Contact removed",
    );
    expect(hiddenPersonDetail(person({ contactId: null }))).toBe("Not in your contacts");
  });

  it("formats a raw number's label, keeps a name", () => {
    const raw = person({ contactId: null, label: "+12065550101" });
    expect(hiddenPersonLabel(raw)).toBe("+1 (206) 555-0101");
    expect(hiddenPersonLabel(person())).toBe("Mom");
    expect(displayLabel("Mom")).toBe("Mom");
  });

  it("sorts people and groups by name", () => {
    const list = hiddenList({
      people: [person({ id: "z", label: "zed" }), person({ id: "a", label: "Amy" })],
      groups: [
        { threadKey: "group:b", title: "b team" },
        { threadKey: "group:a", title: "A team" },
      ],
    });
    expect(list.people.map((p) => p.label)).toEqual(["Amy", "zed"]);
    expect(list.groups.map((g) => g.title)).toEqual(["A team", "b team"]);
  });
});

describe("hideCandidates", () => {
  const source = {
    threads: [MOM_CHAT, CLUB, STRANGER, ADA_CHAT],
    contacts: [MOM, ADA, NEVER],
  };

  it("offers recent conversations with no query, as people and groups", () => {
    expect(hideCandidates(source, "").map((c) => [c.kind, c.label])).toEqual([
      ["contact", "Mom"],
      ["group", "Book Club"],
      ["handle", "+447700900123"],
      ["contact", "Ada Lovelace"],
    ]);
  });

  it("finds saved contacts that were never texted", () => {
    expect(hideCandidates(source, "nevin").map((c) => c.target)).toEqual([{ contactId: "c-nev" }]);
  });

  it("matches numbers however they're written, without offering them twice", () => {
    expect(hideCandidates(source, "(206) 555-0102").map((c) => c.label)).toEqual(["Ada Lovelace"]);
    expect(hideCandidates(source, "7700 900").map((c) => c.kind)).toEqual(["handle"]);
  });

  it("leaves out whoever is hidden already", () => {
    const hidden = {
      threads: [{ ...MOM_CHAT, hiddenFromAgents: true }, CLUB],
      contacts: [{ ...MOM, hiddenFromAgents: true }],
    };
    expect(hideCandidates(hidden, "mom")).toEqual([]);
    expect(hideCandidates(hidden, "").map((c) => c.label)).toEqual(["Book Club"]);
  });

  it("offers a typed number or address", () => {
    expect(hideCandidates(source, "+1 425 555 0100").at(-1)).toMatchObject({
      kind: "typed",
      target: { handle: "+1 425 555 0100" },
    });
    expect(typedHandle("someone@example.com")).toBe("someone@example.com");
    expect(typedHandle("mom")).toBeNull();
    expect(typedHandle("12")).toBeNull();
  });

  it("shows a handful at most", () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      thread(`tel:+1206555${String(1000 + i)}`, `Friend ${i}`),
    );
    expect(hideCandidates({ threads: many, contacts: [] }, "friend")).toHaveLength(PICKER_LIMIT);
  });
});
