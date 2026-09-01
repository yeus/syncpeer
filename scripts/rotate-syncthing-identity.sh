#!/usr/bin/env bash
set -euo pipefail
umask 077

usage() {
  cat <<'EOF'
Usage:
  rotate-syncthing-identity.sh rotate CONFIG_DIR
  rotate-syncthing-identity.sh restore CONFIG_DIR BACKUP_DIR

Run this as the user that owns the Syncthing identity files.
Syncthing must be stopped before either operation.
Syncthing v2.1.2 or newer is required.

rotate:
  Backs up config.xml, cert.pem, and key.pem, then generates and installs
  a new local identity. It does not modify folders or remote devices.

restore:
  Backs up the current identity, then restores cert.pem and key.pem from
  a backup previously created by this script.
EOF
}

fail() {
  echo "Error: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"
}

resolve_config_dir() {
  local requested_dir="$1"
  test -d "$requested_dir" || fail "Configuration directory not found: $requested_dir"
  (cd -- "$requested_dir" && pwd -P)
}

assert_syncthing_stopped() {
  if pgrep -x syncthing >/dev/null 2>&1; then
    fail "Syncthing is running. Stop every Syncthing process on this machine first."
  fi
}

assert_owned_regular_file() {
  local file_path="$1"
  test -f "$file_path" || fail "Required file not found: $file_path"
  test ! -L "$file_path" || fail "Refusing to replace symbolic link: $file_path"
  test -O "$file_path" || fail "Run this script as the owner of: $file_path"
}

assert_existing_identity() {
  local config_dir="$1"
  assert_owned_regular_file "$config_dir/config.xml"
  assert_owned_regular_file "$config_dir/cert.pem"
  assert_owned_regular_file "$config_dir/key.pem"
  test -w "$config_dir" || fail "Configuration directory is not writable: $config_dir"
}

create_backup() {
  local config_dir="$1"
  local reason="$2"
  local backup_root="$config_dir/identity-backups"
  local timestamp backup_dir
  timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  backup_dir="$backup_root/$timestamp-$reason-$$"

  mkdir -p -- "$backup_dir"
  chmod 700 -- "$backup_root" "$backup_dir"
  cp -p -- "$config_dir/config.xml" "$backup_dir/config.xml"
  cp -p -- "$config_dir/cert.pem" "$backup_dir/cert.pem"
  cp -p -- "$config_dir/key.pem" "$backup_dir/key.pem"
  printf '%s\n' "$backup_dir"
}

install_identity() {
  local source_dir="$1"
  local config_dir="$2"
  local fallback_dir="$3"
  local staged_cert="$config_dir/.syncpeer-cert.pem.new.$$"
  local staged_key="$config_dir/.syncpeer-key.pem.new.$$"

  cp -- "$source_dir/cert.pem" "$staged_cert"
  cp -- "$source_dir/key.pem" "$staged_key"
  chmod 600 -- "$staged_cert" "$staged_key"

  if mv -f -- "$staged_cert" "$config_dir/cert.pem" &&
     mv -f -- "$staged_key" "$config_dir/key.pem"; then
    return 0
  fi

  cp -p -- "$fallback_dir/cert.pem" "$config_dir/cert.pem"
  cp -p -- "$fallback_dir/key.pem" "$config_dir/key.pem"
  rm -f -- "$staged_cert" "$staged_key"
  fail "Identity installation failed; the previous identity was restored."
}

cleanup_generation_dir() {
  local generation_dir="$1"
  if test -f "$generation_dir/.syncpeer-temporary-identity"; then
    rm -rf -- "$generation_dir"
  fi
}

read_device_id() {
  local syncthing_bin="$1"
  local config_dir="$2"
  "$syncthing_bin" device-id --home="$config_dir"
}

rotate_identity() {
  local config_dir="$1"
  local syncthing_bin generation_dir backup_dir cleanup_trap
  local old_device_id new_device_id
  syncthing_bin="$(command -v syncthing)"
  old_device_id="$(read_device_id "$syncthing_bin" "$config_dir")"
  generation_dir="$(mktemp -d)"
  touch "$generation_dir/.syncpeer-temporary-identity"
  printf -v cleanup_trap 'cleanup_generation_dir %q' "$generation_dir"
  trap "$cleanup_trap" EXIT

  "$syncthing_bin" generate \
    --home="$generation_dir" \
    --no-port-probing
  assert_owned_regular_file "$generation_dir/cert.pem"
  assert_owned_regular_file "$generation_dir/key.pem"
  new_device_id="$(read_device_id "$syncthing_bin" "$generation_dir")"

  backup_dir="$(create_backup "$config_dir" before-rotation)"
  install_identity "$generation_dir" "$config_dir" "$backup_dir"
  cleanup_generation_dir "$generation_dir"
  trap - EXIT

  echo "New Syncthing identity installed."
  echo "Old device ID: $old_device_id"
  echo "New device ID: $new_device_id"
  echo "Rollback backup: $backup_dir"
  echo "Start Syncthing and inspect the local folders before adding the new ID to a peer."
  echo "After verification, remove the old ID from this device and its peers."
}

restore_identity() {
  local config_dir="$1"
  local requested_backup="$2"
  local backup_dir current_backup
  test -d "$requested_backup" || fail "Backup directory not found: $requested_backup"
  backup_dir="$(cd -- "$requested_backup" && pwd -P)"

  case "$backup_dir" in
    "$config_dir"/identity-backups/*) ;;
    *) fail "Backup must be inside $config_dir/identity-backups" ;;
  esac

  assert_owned_regular_file "$backup_dir/cert.pem"
  assert_owned_regular_file "$backup_dir/key.pem"
  current_backup="$(create_backup "$config_dir" before-restore)"
  install_identity "$backup_dir" "$config_dir" "$current_backup"

  echo "Syncthing identity restored from: $backup_dir"
  echo "Replaced identity backed up at: $current_backup"
}

main() {
  local action="${1:-}"
  local requested_config="${2:-}"
  if test "$action" = -h || test "$action" = --help; then
    usage
    exit 0
  fi
  test -n "$action" && test -n "$requested_config" || {
    usage >&2
    exit 2
  }

  require_command pgrep
  require_command syncthing
  assert_syncthing_stopped

  local config_dir
  config_dir="$(resolve_config_dir "$requested_config")"
  assert_existing_identity "$config_dir"

  case "$action" in
    rotate)
      test "$#" -eq 2 || fail "rotate expects CONFIG_DIR"
      rotate_identity "$config_dir"
      ;;
    restore)
      test "$#" -eq 3 || fail "restore expects CONFIG_DIR and BACKUP_DIR"
      restore_identity "$config_dir" "$3"
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
}

main "$@"
