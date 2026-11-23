#!/bin/sh
set -e

# dpkg calls this with remove, purge, upgrade, failed-upgrade, abort-install, abort-upgrade or
# disappear. Only tear down on remove/purge: during an upgrade the new package's after-install
# re-creates everything below.
case "$1" in
  remove | purge) ;;
  *) exit 0 ;;
esac

rm -f /usr/bin/tincan-desktop
if [ -f /usr/bin/tincan ] && grep -q '/opt/Tincan/resources/daemon/dist/bin.mjs' /usr/bin/tincan 2>/dev/null; then
  rm -f /usr/bin/tincan
fi
if [ -f /etc/apparmor.d/tincan-desktop ]; then
  # Unload the profile from the kernel before deleting it.
  if command -v apparmor_parser >/dev/null 2>&1; then
    apparmor_parser -R /etc/apparmor.d/tincan-desktop 2>/dev/null || true
  fi
  rm -f /etc/apparmor.d/tincan-desktop
fi

# `tincan setup install` (run by the user, not this package) adds a root unit and udev rule that
# keep the adapter's hands-free class, and enables BlueZ experimental features. The unit and rule
# are Tincan's alone, so remove them; main.conf is left for the user to revert, since rewriting it
# and restarting Bluetooth from a package removal would drop their Bluetooth devices unasked.
BTCLASS_UNIT=/etc/systemd/system/tincan-btclass@.service
BTCLASS_RULE=/etc/udev/rules.d/90-tincan-btclass.rules
if [ -e "$BTCLASS_UNIT" ] || [ -e "$BTCLASS_RULE" ]; then
  rm -f "$BTCLASS_UNIT" "$BTCLASS_RULE"
  if command -v systemctl >/dev/null 2>&1; then systemctl daemon-reload 2>/dev/null || true; fi
  if command -v udevadm >/dev/null 2>&1; then udevadm control --reload-rules 2>/dev/null || true; fi
  echo "Tincan: removed ${BTCLASS_UNIT} and ${BTCLASS_RULE}."
fi
if [ -f /etc/bluetooth/main.conf ] && grep -q 'tincan-system-setup' /etc/bluetooth/main.conf 2>/dev/null; then
  echo "Tincan: /etc/bluetooth/main.conf still has BlueZ experimental features enabled by Tincan."
  echo "  To revert, delete the '# Added by tincan-system-setup' and 'Experimental = true' lines below"
  echo "  it, uncomment any line ending in '(replaced by tincan-system-setup)', then run"
  echo "  'sudo systemctl restart bluetooth.service' (Bluetooth devices disconnect briefly)."
fi

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database -q /usr/share/applications || true
fi
if command -v update-mime-database >/dev/null 2>&1; then
  update-mime-database /usr/share/mime || true
fi
