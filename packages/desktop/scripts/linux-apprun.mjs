export function createAppRunScript() {
  return [
    "#!/bin/sh",
    "unset HISTOS_PUBLISH_SANDBOX_FALLBACK",
    'HERE="$(CDPATH= cd -- "$(dirname -- "$(readlink -f -- "$0")")" && pwd)"',
    'export LD_LIBRARY_PATH="$HERE/usr/lib/histos-publish${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"',
    'APP="$HERE/usr/lib/histos-publish/histos-publish"',
    'if [ -L /proc/self/ns/user ] && command -v unshare >/dev/null 2>&1 && unshare --user --map-root-user --pid --fork true >/dev/null 2>&1; then',
    '  exec "$APP" "$@"',
    "fi",
    "export HISTOS_PUBLISH_SANDBOX_FALLBACK=1",
    'printf "%s\\n" "Histeon Publish: il sistema non consente user namespaces; avvio l’AppImage senza sandbox Chromium. Installa il pacchetto .deb per usare il sandbox setuid." >&2',
    'exec "$APP" --no-sandbox "$@"',
    "",
  ].join("\n");
}
