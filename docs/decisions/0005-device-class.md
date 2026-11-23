# 0005. Set the Bluetooth Class of Device with a privileged unit

- **Status:** Accepted
- **Date:** 2026-10-31

## Context

iOS only offers **Show Message Notifications** and **Sync Contacts** to a computer whose Class of
Device is Audio/Video Hands-Free (major 4, minor 8). Without those permissions, MAP and PBAP SDP
lookups fail. Permissions that are already granted survive a later class change.

Setting `Class=` in `/etc/bluetooth/main.conf` doesn't hold. BlueZ's `hostname` plugin derives a
class from the chassis type and overwrites it when the adapter is probed and whenever the hostname
changes. Every chassis maps to major class Computer. The daemon can't fix this itself:
`Adapter1.Class` is read-only over D-Bus, and setting the class through mgmt needs `CAP_NET_ADMIN`.

See [the Phase 0 notes](../history/native-phase-0.md#device-class-phase-05-2026-10-31).

## Decision

`system-setup`, which already runs with root for the bluetoothd `--experimental` drop-in, installs a
oneshot unit. The unit is bound to `bluetooth.service` (`PartOf=`, `After=`). It runs `btmgmt class 4 8`
and reads the class back, retrying until it matches. Uninstalling removes it.

We rejected `--noplugin=hostname` plus `Class = 0x000408`. It means editing the bluetoothd command
line, and it disables the pretty-hostname sync for every user of the machine.

`doctor` reads the adapter class:

- `fail` with the fix while the phone permissions are not yet granted;
- `warn` afterwards, since the class is then only needed for re-pairing.

## Consequences

- The adapter advertises itself as a hands-free device. Other devices may show a headset icon for it.
- The class has to be set before pairing. Onboarding and `tincan doctor` check it first.
- `packaging/system-setup/tincan-system-setup.sh` installs `tincan-btclass@.service` and its udev rule, and cleanly removes them on `uninstall`.
