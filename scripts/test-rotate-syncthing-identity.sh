#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
test_root="$(mktemp -d)"
trap 'rm -rf -- "$test_root"' EXIT

config_dir="$test_root/config"
fake_bin="$test_root/bin"
mkdir -p "$config_dir" "$fake_bin"
printf '%s\n' '<configuration />' >"$config_dir/config.xml"
printf '%s\n' 'old certificate' >"$config_dir/cert.pem"
printf '%s\n' 'old private key' >"$config_dir/key.pem"

cat >"$fake_bin/pgrep" <<'EOF'
#!/usr/bin/env bash
test "${FAKE_SYNCTHING_RUNNING:-0}" = 1
EOF

cat >"$fake_bin/syncthing" <<'EOF'
#!/usr/bin/env bash
device_id() {
  for argument in "$@"; do
    case "$argument" in
      --home=*) home_dir="${argument#--home=}" ;;
    esac
  done
  if grep -q '^old certificate$' "$home_dir/cert.pem"; then
    echo 'OLD-SYNTHETIC-DEVICE-ID'
  else
    echo 'NEW-SYNTHETIC-DEVICE-ID'
  fi
}

case "${1:-}" in
  generate)
    if test "${2:-}" = --help; then
      echo '      --no-port-probing'
      exit 0
    fi
    for argument in "$@"; do
      case "$argument" in
        --home=*) home_dir="${argument#--home=}" ;;
      esac
    done
    test -n "${home_dir:-}"
    mkdir -p "$home_dir"
    printf '%s\n' '<configuration />' >"$home_dir/config.xml"
    printf '%s\n' 'new certificate' >"$home_dir/cert.pem"
    printf '%s\n' 'new private key' >"$home_dir/key.pem"
    ;;
  serve)
    exit 2
    ;;
  device-id)
    device_id "$@"
    ;;
  --help)
    echo '  device-id'
    ;;
  *) exit 2 ;;
esac
EOF
chmod +x "$fake_bin/pgrep" "$fake_bin/syncthing"

rotation_output="$(PATH="$fake_bin:$PATH" \
  "$repo_root/scripts/rotate-syncthing-identity.sh" \
  rotate "$config_dir")"
grep -q 'Old device ID: OLD-SYNTHETIC-DEVICE-ID' <<<"$rotation_output"
grep -q 'New device ID: NEW-SYNTHETIC-DEVICE-ID' <<<"$rotation_output"

test "$(cat "$config_dir/cert.pem")" = 'new certificate'
test "$(cat "$config_dir/key.pem")" = 'new private key'
test "$(cat "$config_dir/config.xml")" = '<configuration />'

backup_dir="$(find "$config_dir/identity-backups" \
  -mindepth 1 -maxdepth 1 -type d -print -quit)"
test -n "$backup_dir"
test "$(cat "$backup_dir/cert.pem")" = 'old certificate'
test "$(cat "$backup_dir/key.pem")" = 'old private key'

if FAKE_SYNCTHING_RUNNING=1 PATH="$fake_bin:$PATH" \
  "$repo_root/scripts/rotate-syncthing-identity.sh" \
  rotate "$config_dir" >/dev/null 2>&1; then
  echo 'Rotation unexpectedly ran while Syncthing was active' >&2
  exit 1
fi

PATH="$fake_bin:$PATH" \
  "$repo_root/scripts/rotate-syncthing-identity.sh" \
  restore "$config_dir" "$backup_dir"

test "$(cat "$config_dir/cert.pem")" = 'old certificate'
test "$(cat "$config_dir/key.pem")" = 'old private key'

echo 'Syncthing identity rotation diagnostics passed.'
