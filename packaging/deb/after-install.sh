#!/bin/sh
set -e

# Link the desktop executable into /usr/bin (replaces electron-builder's default after-install.tpl).
ln -sf '/opt/Tincan/tincan-desktop' '/usr/bin/tincan-desktop'

# Install the `tincan` CLI launcher under /usr/bin (never touch /usr/local/bin from a .deb).
# ELECTRON_RUN_AS_NODE makes the Electron binary run as Node. Programs tincan starts (agent CLIs,
# sudo, clipboard tools) shouldn't inherit it, so the CLI and daemon drop it for them (`childEnv`).
cat <<'EOF' > /usr/bin/tincan
#!/bin/sh
export ELECTRON_RUN_AS_NODE=1
exec /opt/Tincan/tincan-desktop /opt/Tincan/resources/daemon/dist/bin.mjs "$@"
EOF
chmod 0755 /usr/bin/tincan

# SUID chrome-sandbox fallback for kernels without unprivileged user namespaces: either disabled
# outright (Debian's kernel.unprivileged_userns_clone=0) or limited to none (user.max_user_namespaces=0).
if [ -f '/opt/Tincan/chrome-sandbox' ]; then
  if { [ -e /proc/sys/kernel/unprivileged_userns_clone ] && [ "$(cat /proc/sys/kernel/unprivileged_userns_clone)" = "0" ]; } ||
    { [ -e /proc/sys/user/max_user_namespaces ] && [ "$(cat /proc/sys/user/max_user_namespaces)" = "0" ]; }; then
    chmod 4755 '/opt/Tincan/chrome-sandbox' || true
  fi
fi

# AppArmor profile for Ubuntu 24.04+ unprivileged userns restrictions.
if command -v apparmor_parser >/dev/null 2>&1 && [ -d /etc/apparmor.d ]; then
  cat <<'EOF' > /etc/apparmor.d/tincan-desktop
abi <abi/4.0>,
include <tunables/global>

profile tincan-desktop "/opt/Tincan/tincan-desktop" flags=(unconfined) {
  userns,
  include if exists <local/tincan-desktop>
}
EOF
  apparmor_parser -r -W -T /etc/apparmor.d/tincan-desktop 2>/dev/null || true
fi

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database -q /usr/share/applications || true
fi
if command -v update-mime-database >/dev/null 2>&1; then
  update-mime-database /usr/share/mime || true
fi

