import { device } from "@beyland/tincan-protocol";
import { isHandsFree } from "../doctor.ts";
import type { CommandRegistry } from "../registry.ts";

const IDLE_PAIRING: device.PairingStatus = {
  state: "idle",
  candidates: [],
  address: null,
  name: null,
  passkey: null,
  adapterName: null,
  discoverable: false,
  handsFree: null,
  error: null,
};

export function deviceHandlers(registry: CommandRegistry): CommandRegistry {
  return registry
    .implement(device.info, async (_input, { core }): Promise<device.DeviceInfo> => {
      const { state, device: phone } = core.phone;
      const details = core.control
        ? await core.control.details()
        : { device: null, adapter: null, paused: false };
      const bt = details.device;
      const { sync, contacts } = core.services;
      return {
        state,
        phone: phone && {
          address: phone.address,
          name: phone.name,
          deviceName: bt?.name && bt.name !== phone.name ? bt.name : null,
          paired: phone.paired,
          bonded: bt?.bonded ?? phone.paired,
          trusted: bt?.trusted ?? false,
          connected: phone.connected,
          paused: phone.paused ?? details.paused,
          supports: {
            map: bt?.supportsMap ?? phone.profiles.map !== "unavailable",
            pbap: bt?.supportsPbap ?? phone.profiles.pbap !== "unavailable",
            ancs: bt?.supportsAncs ?? phone.profiles.ancs !== "unavailable",
          },
          profiles: phone.profiles,
        },
        adapter: details.adapter && {
          address: details.adapter.address,
          name: details.adapter.alias || details.adapter.name,
          powered: details.adapter.powered,
          handsFree: isHandsFree(details.adapter.class),
        },
        lastSync: {
          messages: sync?.status.lastSyncAt ?? null,
          contacts: contacts?.lastSyncAt ?? null,
        },
        stored: core.store?.counts() ?? { threads: 0, messages: 0, contacts: 0 },
      };
    })
    .implement(device.connect, async (_input, { core }) => {
      await core.requireControl().connect();
      // Already connected over Bluetooth, messages may be waiting out a backoff (say after the
      // iPhone refused them): try again now, as the user asked.
      core.services.sync?.trigger("reconnect");
      return { address: core.phone.device?.address ?? null };
    })
    .implement(device.disconnect, async (_input, { core }) => {
      await core.requireControl().disconnect();
      return { address: core.phone.device?.address ?? null };
    })
    .implement(device.forget, async (_input, { core }) => {
      const address = core.phone.device?.address ?? null;
      await core.requireControl().forget();
      return { address };
    })
    .implement(device.pairStart, (input, { core }) => core.requireControl().pairing.start(input))
    .implement(device.pairConfirm, (input, { core }) =>
      core.requireControl().pairing.confirm(input.accept),
    )
    .implement(device.pairCancel, (_input, { core }) => core.requireControl().pairing.cancel())
    .implement(device.history, (input, { core }) => core.history.list(input.limit))
    .implement(device.pairStatus, async (_input, { core }) => {
      if (!core.control) return { ...IDLE_PAIRING };
      return core.control.pairing.status();
    });
}
