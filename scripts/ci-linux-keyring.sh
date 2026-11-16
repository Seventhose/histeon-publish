#!/usr/bin/env bash
# CI only: runs a command inside a throwaway D-Bus session with an unlocked GNOME Keyring, so the packaged
# smoke test can save credentials in a real Secret Service (the app refuses Electron's plain-text backend).
set -euo pipefail
eval "$(dbus-launch --sh-syntax)"
trap 'kill "$DBUS_SESSION_BUS_PID" 2>/dev/null || true' EXIT
# A disposable keyring password for a disposable session; nothing real is stored in it.
eval "$(printf 'histos-ci\n' | gnome-keyring-daemon --unlock --replace --daemonize --components=secrets)"
eval "$(gnome-keyring-daemon --start --components=secrets)"
export XDG_CURRENT_DESKTOP=GNOME
export HISTOS_TEST_PASSWORD_STORE=gnome-libsecret
"$@"
