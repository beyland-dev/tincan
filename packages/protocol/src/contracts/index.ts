import type { z } from "zod";
import { describeContract, type AnyContract, type ContractDescriptor } from "../contract.ts";
import * as agents from "./agents.ts";
import * as contact from "./contact.ts";
import * as device from "./device.ts";
import * as draft from "./draft.ts";
import * as group from "./group.ts";
import * as message from "./message.ts";
import * as sync from "./sync.ts";
import * as system from "./system.ts";
import * as thread from "./thread.ts";

export { AgentClient, AgentConnection, HideFromAgentsResult } from "./agents.ts";
export { agents, contact, device, draft, group, message, sync, system, thread };
export { DRAFT_WAIT_MAX_SECONDS } from "./draft.ts";
export { NewRecipientDraft, SendOutcome, SendResult } from "./message.ts";

/** Every contract the daemon serves, in display order. */
export const contracts = [
  system.status,
  system.version,
  system.doctor,
  system.commands,
  system.settingsGet,
  system.settingsSet,
  system.serviceStatus,
  system.serviceInstall,
  system.serviceDisable,
  agents.connections,
  agents.connect,
  agents.disconnect,
  agents.hidden,
  agents.hide,
  agents.show,
  sync.status,
  sync.now,
  device.info,
  device.connect,
  device.disconnect,
  device.forget,
  device.pairStart,
  device.pairConfirm,
  device.pairCancel,
  device.pairStatus,
  device.history,
  thread.list,
  thread.get,
  thread.markRead,
  thread.mute,
  thread.pin,
  thread.remove,
  message.list,
  message.search,
  message.send,
  message.retry,
  message.cancel,
  message.sendNow,
  message.draftSave,
  message.draftList,
  message.remove,
  draft.list,
  draft.get,
  draft.update,
  draft.send,
  draft.discard,
  draft.restore,
  contact.list,
  contact.search,
  contact.get,
  contact.sync,
  contact.photo,
  group.list,
  group.save,
  group.remove,
  group.assignMessage,
] as const;

export type KnownContract = (typeof contracts)[number];
export type ContractName = KnownContract["name"];
export type ContractFor<N extends ContractName> = Extract<KnownContract, { name: N }>;
export type InputOf<N extends ContractName> = z.input<ContractFor<N>["input"]>;
export type OutputOf<N extends ContractName> = z.output<ContractFor<N>["output"]>;

const byName = new Map<string, AnyContract>(contracts.map((c) => [c.name, c]));

export function getContract(name: string): AnyContract | undefined {
  return byName.get(name);
}

export function describeContracts(
  options: { includeInternal?: boolean } = {},
): ContractDescriptor[] {
  return contracts
    .filter((c) => options.includeInternal || !("internal" in c && c.internal))
    .map((c) => describeContract(c));
}
