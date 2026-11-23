#!/usr/bin/env bash
# Configure BlueZ for Tincan:
#   1. Enable BlueZ experimental features (for ANCS notifications) in /etc/bluetooth/main.conf.
#   2. Install tincan-btclass@.service + udev rule so adapters keep the hands-free Class of Device
#      (0x0408) across restarts, which iOS requires when pairing to offer message/contact sharing.
#
# Usage:
#   sudo ./tincan-system-setup.sh install [--yes]
#   sudo ./tincan-system-setup.sh uninstall [--yes]
#   ./tincan-system-setup.sh status
#
# install and uninstall restart bluetooth.service, which briefly disconnects Bluetooth keyboards,
# mice and headphones. On a terminal they ask first; --yes (or TINCAN_SETUP_YES=1) skips the
# question, and without a terminal they go ahead. Answering no leaves the restart to you.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNIT_NAME="tincan-btclass@.service"
UNIT_DEST="/etc/systemd/system/${UNIT_NAME}"
UDEV_NAME="90-tincan-btclass.rules"
UDEV_DEST="/etc/udev/rules.d/${UDEV_NAME}"
MAIN_CONF="/etc/bluetooth/main.conf"
MARKER="# Added by tincan-system-setup"
REPLACED_SUFFIX=" (replaced by tincan-system-setup)"
ASSUME_YES="${TINCAN_SETUP_YES:-0}"
TMP_CONF=""

cleanup() {
  if [[ -n "$TMP_CONF" ]]; then rm -f "$TMP_CONF"; fi
}
trap cleanup EXIT

require_root() {
  if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
    echo "tincan-system-setup: run as root (e.g. sudo $0 $*)" >&2
    exit 1
  fi
}

# Restarting bluetoothd drops every Bluetooth connection, so say so (and ask, on a terminal).
restart_bluetooth() {
  echo "Restarting bluetooth.service: Bluetooth keyboards, mice and headphones will disconnect for a moment." >&2
  if [[ "$ASSUME_YES" != "1" && -t 0 && -t 2 ]]; then
    read -r -p "Restart Bluetooth now? [Y/n] " answer || answer="n"
    case "$answer" in
      "" | [Yy] | [Yy][Ee][Ss]) ;;
      *)
        echo "Skipped. Run \`sudo systemctl restart bluetooth.service\` (or reboot) for the change to take effect." >&2
        return 0
        ;;
    esac
  fi
  systemctl restart bluetooth.service
}

# Replace main.conf's contents with $TMP_CONF after sanity checks. Writing through the existing
# file (rather than moving a new one over it) keeps its owner, mode and SELinux label.
commit_conf() {
  local min_lines="$1"
  if [[ ! -s "$TMP_CONF" ]]; then
    echo "tincan-system-setup: refusing to write an empty ${MAIN_CONF}; it is unchanged." >&2
    exit 1
  fi
  local lines
  lines="$(wc -l < "$TMP_CONF")"
  if (( lines < min_lines )) || ! grep -q '^\[General\]' "$TMP_CONF"; then
    echo "tincan-system-setup: the edited ${MAIN_CONF} looks wrong; it is unchanged." >&2
    exit 1
  fi
  cat "$TMP_CONF" > "$MAIN_CONF"
  rm -f "$TMP_CONF"
  TMP_CONF=""
}

new_tmp_conf() {
  TMP_CONF="$(mktemp "${MAIN_CONF}.tincan.XXXXXX")"
}

has_experimental() {
  [[ -f "$MAIN_CONF" ]] && awk '
    /^\[/ { section = $0; next }
    section == "[General]" && /^[[:space:]]*Experimental[[:space:]]*=/ {
      val = $0
      sub(/^[[:space:]]*Experimental[[:space:]]*=[[:space:]]*/, "", val)
      sub(/[[:space:]]*$/, "", val)
      last = tolower(val)
    }
    END { exit !(last == "true") }
  ' "$MAIN_CONF"
}

enable_experimental() {
  if has_experimental; then
    echo "BlueZ experimental features already enabled in ${MAIN_CONF}"
    return
  fi
  mkdir -p "$(dirname "$MAIN_CONF")"
  # GLib GKeyFile does not support inline `#` comments on boolean values, so put the marker on its own line.
  if [[ ! -f "$MAIN_CONF" ]]; then
    printf '[General]\n%s\nExperimental = true\n' "$MARKER" > "$MAIN_CONF"
  elif grep -q '^\[General\]' "$MAIN_CONF"; then
    # An existing `Experimental = ...` line is commented out with a suffix so uninstall can put it back.
    new_tmp_conf
    awk -v marker="$MARKER" -v suffix="$REPLACED_SUFFIX" '
      /^\[/ {
        if (in_general && !done) { print marker; print "Experimental = true"; done = 1 }
        in_general = ($0 == "[General]")
        print
        next
      }
      in_general && /^[[:space:]]*Experimental[[:space:]]*=/ {
        print "# " $0 suffix
        next
      }
      { print }
      END {
        if (in_general && !done) { print marker; print "Experimental = true" }
      }
    ' "$MAIN_CONF" > "$TMP_CONF"
    grep -qxF "$MARKER" "$TMP_CONF" || { echo "tincan-system-setup: couldn't edit ${MAIN_CONF}; it is unchanged." >&2; exit 1; }
    commit_conf "$(( $(wc -l < "$MAIN_CONF") + 2 ))"
  else
    printf '\n[General]\n%s\nExperimental = true\n' "$MARKER" >> "$MAIN_CONF"
  fi
  echo "Enabled Experimental = true in ${MAIN_CONF}"
}

install_setup() {
  require_root install
  enable_experimental
  install -Dm644 "${SCRIPT_DIR}/${UNIT_NAME}" "$UNIT_DEST"
  install -Dm644 "${SCRIPT_DIR}/${UDEV_NAME}" "$UDEV_DEST"
  systemctl daemon-reload
  udevadm control --reload-rules || true
  restart_bluetooth
  for hci in /sys/class/bluetooth/hci*; do
    [[ -e "$hci" ]] || continue
    idx="${hci##*/}"
    # Skip connection entries like hci0:51; only adapters (hciN) take a class.
    [[ "$idx" =~ ^hci[0-9]+$ ]] || continue
    systemctl start "tincan-btclass@${idx}.service" || btmgmt --index "$idx" class 4 8 || true
  done
  echo "Tincan Bluetooth system setup complete."
}

uninstall_setup() {
  require_root uninstall
  rm -f "$UNIT_DEST" "$UDEV_DEST"
  if [[ -f "$MAIN_CONF" ]] && grep -qF -e "$MARKER" -e "$REPLACED_SUFFIX" "$MAIN_CONF"; then
    # Drop the lines install added and restore any `Experimental = ...` line it commented out.
    new_tmp_conf
    awk -v marker="$MARKER" -v suffix="$REPLACED_SUFFIX" '
      $0 == marker { skip_next = 1; next }
      skip_next && /^[[:space:]]*Experimental[[:space:]]*=[[:space:]]*true[[:space:]]*$/ { skip_next = 0; next }
      {
        skip_next = 0
        n = length(suffix)
        if (substr($0, 1, 2) == "# " && length($0) > n + 2 && substr($0, length($0) - n + 1) == suffix) {
          print substr($0, 3, length($0) - n - 2)
          next
        }
        print
      }
    ' "$MAIN_CONF" > "$TMP_CONF"
    commit_conf "$(( $(wc -l < "$MAIN_CONF") - 2 ))"
  fi
  systemctl daemon-reload
  udevadm control --reload-rules || true
  restart_bluetooth || true
  echo "Tincan Bluetooth system setup removed."
}

show_status() {
  echo "Experimental in ${MAIN_CONF}: $(has_experimental && echo yes || echo no)"
  echo "Class unit (${UNIT_DEST}): $([[ -f "$UNIT_DEST" ]] && echo installed || echo missing)"
  echo "Udev rule (${UDEV_DEST}): $([[ -f "$UDEV_DEST" ]] && echo installed || echo missing)"
}

ACTION="${1:-status}"
shift || true
for arg in "$@"; do
  case "$arg" in
    -y | --yes) ASSUME_YES=1 ;;
    *)
      echo "Unknown option: $arg" >&2
      exit 2
      ;;
  esac
done

case "$ACTION" in
  install) install_setup ;;
  uninstall) uninstall_setup ;;
  status) show_status ;;
  *)
    echo "Usage: $0 <install|uninstall|status> [--yes]" >&2
    exit 2
    ;;
esac
