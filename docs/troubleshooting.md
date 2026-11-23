# Troubleshooting

Start by running:

```sh
tincan doctor
```

If you are opening a GitHub issue, use the redacted report instead:

```sh
tincan doctor --report
```

The report masks Bluetooth addresses, device names and home-directory paths, but read it before you
paste it anywhere. Never include message text, phone numbers or contact names in an issue.

## The AppImage won't start on Ubuntu 24.04 or newer

Ubuntu 24.04 restricts unprivileged user namespaces with AppArmor, and Chromium's sandbox (which
Electron uses) needs them. The `.deb` installs an AppArmor profile that allows this for Tincan, so the
simplest fix is to install the `.deb` instead.

**Don't run the AppImage with `--no-sandbox`.** That turns off the sandbox around the window that
displays messages from anyone who texts you.

To keep using the AppImage, add a local AppArmor profile for it. Adjust the path to where you keep the
file:

```sh
sudo tee /etc/apparmor.d/tincan-appimage >/dev/null <<'EOF'
abi <abi/4.0>,
include <tunables/global>

profile tincan-appimage @{HOME}/Applications/Tincan-*.AppImage flags=(unconfined) {
  userns,
}
EOF
sudo apparmor_parser -r /etc/apparmor.d/tincan-appimage
```

Remove `/etc/apparmor.d/tincan-appimage` when you stop using the AppImage.

## Pairing is refused, or no code appears

Tincan only accepts pairings where both screens show the same six-digit code. It turns down
"Just Works" pairings that skip the code, because those can't confirm which device is on the other end.
Keep the iPhone unlocked on **Settings › Bluetooth** during pairing and accept the code on both
screens. If it keeps failing, forget the computer on the iPhone, restart the iPhone and try again.

## iPhone does not show "Show Notifications" or "Sync Contacts"

iOS only offers message and contact sharing toggles to a Bluetooth peer whose **Class of Device** is
Audio/Video Hands-Free (`0x0408`) _at pairing time_. By default, BlueZ's `hostname` plugin resets
the adapter class to Computer/Laptop.

Fix:

1. Run `tincan setup` (installs `tincan-btclass@.service` + udev rule and enables `Experimental = true`).
2. Forget this computer on your iPhone (**Settings › Bluetooth › (i) › Forget This Device**).
3. Restart your iPhone (iOS caches refused SDP answers until reboot).
4. Pair again with `tincan pair` (or the desktop app's **Pair iPhone** dialog).
5. Turn on **Show Notifications** (called **Show Message Notifications** on some iOS versions) and
   **Sync Contacts** under **(i)** on your iPhone.

## MAP fails with `NOT_FOUND` ("refused") even with toggles on

iOS occasionally caches a stale pairing or refused SDP lookup after forgetting/re-pairing.

1. Confirm **Show Notifications** is on in iPhone **Settings › Bluetooth › (i)**.
2. Forget the device on **both** the iPhone and Linux (`tincan device forget`).
3. **Restart the iPhone.**
4. Run `tincan doctor` to confirm Device class is `Hands-free (0x...0408)`, then pair again.

## MAP fails with `BUSY`

An iPhone allows only **one** active Bluetooth MAP session at a time. Quit any other Bluetooth
messaging app on this computer or turn off Bluetooth on another computer/car kit currently connected
to your iPhone.

## `bluetooth.disable_ertm=1` fails OBEX transfers

BlueZ OBEX (MAP/PBAP) requires Enhanced Retransmission Mode (ERTM). If `tincan doctor` reports
`bluetooth.disable_ertm=1` (often set for older Bluetooth gamepads), remove
`bluetooth.disable_ertm=1` from your kernel command line or `/etc/modprobe.d/` and reboot.

## `obexd` isn't available on the session bus

Install your distribution's BlueZ OBEX package (typically `bluez` or `bluez-obexd`), then log out
and back in (or run `systemctl --user start obex.service`).

## Database key warning ("In a file, because no keyring was available")

Tincan stores its SQLCipher encryption key in the desktop Secret Service (GNOME Keyring or
KWallet). If you run headless or without a Secret Service daemon, Tincan creates a `0600` key file
next to `tincan.db`. To use the keyring instead, install and unlock GNOME Keyring or KWallet.

## An agent can't see a conversation

Conversations you hide from AI agents (right-click ▸ Hide from agents) stay hidden from them, even
after new messages arrive, until you show them to agents again: Settings ▸ AI agents ▸ Hidden from
agents lists them. Short-code senders (banks, sign-in codes) are hidden from agents unless
**Show verification codes to agents** (Full access only) is on. See the [agent docs](https://tincan.beyland.dev/docs.html#agents).
