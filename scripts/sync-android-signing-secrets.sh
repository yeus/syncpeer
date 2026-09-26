#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$script_dir/android-signing-common.sh"

if [[ "${1:-}" == -h || "${1:-}" == --help ]]; then
  echo "Usage: scripts/sync-android-signing-secrets.sh owner/repo"
  echo "Validates the existing Android signing identity and uploads it to GitHub."
  echo "A new identity requires an empty Secret Service and typing CREATE."
  exit 0
fi

syncpeer_require_keytool || exit 1
for command in secret-tool gh base64; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Missing required command: $command" >&2
    exit 1
  fi
done

target_repo="${1:-}"
if [[ ! "$target_repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
  echo "Pass the target GitHub repository as owner/repo." >&2
  exit 1
fi
if ! gh auth status >/dev/null 2>&1; then
  echo "GitHub CLI is not authenticated." >&2
  exit 1
fi
syncpeer_secret_service_ready || exit 1

secret_store() {
  local key="$1"
  local value="$2"
  printf '%s' "$value" | secret-tool store \
    --label "Syncpeer Android $key" \
    app syncpeer scope android-release-signing key "$key" >/dev/null
}

decode_backup() {
  local value="$1"
  local destination="$2"
  if ! printf '%s' "$value" | base64 -d >"$destination" 2>/dev/null; then
    echo "android_keystore_base64 is not valid base64; nothing was changed." >&2
    return 1
  fi
  chmod 600 "$destination"
}

encode_keystore() {
  if base64 -w 0 "$1" 2>/dev/null; then
    return 0
  fi
  base64 "$1" | tr -d '\n'
}

generate_password() {
  head -c 48 /dev/urandom | base64 | tr -d '=+/' | cut -c1-32
}

upload_secret() {
  local name="$1"
  local value="$2"
  printf '%s' "$value" | gh secret set "$name" --repo "$target_repo"
}

default_path="${XDG_CONFIG_HOME:-$HOME/.config}/syncpeer/android-release.jks"
stored_path="$(syncpeer_secret_lookup android_keystore_path)" || exit 1
stored_backup="$(syncpeer_secret_lookup android_keystore_base64)" || exit 1
store_password="$(syncpeer_secret_lookup android_keystore_password)" || exit 1
key_alias="$(syncpeer_secret_lookup android_key_alias)" || exit 1
key_password="$(syncpeer_secret_lookup android_key_password)" || exit 1

keystore_path="${stored_path:-$default_path}"
keystore_path="${keystore_path/#\~/$HOME}"
keystore_path="${keystore_path//\$\{HOME\}/$HOME}"
keystore_path="${keystore_path//\$HOME/$HOME}"
if [[ "$keystore_path" != /* ]]; then
  echo "Android keystore path must be absolute." >&2
  exit 1
fi

temp_keystore="$(mktemp "${TMPDIR:-/tmp}/syncpeer-signing-check.XXXXXX.jks")"
cleanup() { rm -f -- "$temp_keystore"; }
trap cleanup EXIT

fresh=0
if [[ -n "$stored_backup" ]]; then
  decode_backup "$stored_backup" "$temp_keystore"
  echo "Signing source: Secret Service android_keystore_base64."
  if [[ -f "$keystore_path" ]] && ! cmp -s -- "$keystore_path" "$temp_keystore"; then
    echo "Local keystore differs from the stored backup; leaving it unchanged." >&2
  fi
elif [[ -f "$keystore_path" && ! -L "$keystore_path" ]]; then
  install -m 600 "$keystore_path" "$temp_keystore"
  echo "Signing source: existing local keystore."
elif [[ -n "$stored_path$store_password$key_alias$key_password" || -e "$keystore_path" || -L "$keystore_path" || -e "$default_path" || -L "$default_path" ]]; then
  echo "Incomplete existing Android signing identity; restore the original key and Secret Service values. No new key was created." >&2
  exit 1
else
  echo "No SyncPeer signing identity was found. A new key cannot update APKs signed with an old key." >&2
  printf 'Type CREATE to create a new identity and upload it to %s: ' "$target_repo" >&2
  answer=""
  if ! IFS= read -r answer || [[ "$answer" != CREATE ]]; then
    echo "Cancelled without changes." >&2
    exit 1
  fi
  fresh=1
  store_password="$(generate_password)"
  key_password="$(generate_password)"
  key_alias="syncpeer-release-key"
  rm -f -- "$temp_keystore"
  umask 077
  KEYTOOL_STORE_PASSWORD="$store_password" KEYTOOL_KEY_PASSWORD="$key_password" \
    keytool -genkeypair -keystore "$temp_keystore" -storetype JKS \
    -alias "$key_alias" -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass:env KEYTOOL_STORE_PASSWORD -keypass:env KEYTOOL_KEY_PASSWORD \
    -dname "CN=Syncpeer, OU=Syncpeer, O=Syncpeer, L=Unknown, ST=Unknown, C=US" >/dev/null
fi

if [[ -z "$store_password" || -z "$key_alias" || -z "$key_password" ]]; then
  echo "Existing keystore requires the original android_keystore_password, android_key_alias, and android_key_password entries." >&2
  exit 1
fi
syncpeer_validate_keystore "$temp_keystore" "$store_password" "$key_alias" "$key_password"
if [[ -n "$stored_backup" && -f "$keystore_path" ]] &&
  ! cmp -s -- "$keystore_path" "$temp_keystore" &&
  syncpeer_validate_keystore "$keystore_path" "$store_password" "$key_alias" "$key_password" >/dev/null 2>&1; then
  echo "Two valid but byte-different Android signing keystores were found; refusing to choose an identity. Compare their signing certificates first." >&2
  exit 1
fi

if (( fresh == 0 )); then
  printf 'Upload validated Android signing values to %s? Type YES to continue: ' "$target_repo" >&2
  answer=""
  if ! IFS= read -r answer || [[ "$answer" != YES ]]; then
    echo "Cancelled without changes." >&2
    exit 0
  fi
fi

keystore_b64="$(encode_keystore "$temp_keystore")"
if (( fresh == 1 )); then
  mkdir -p -- "$(dirname -- "$keystore_path")"
  staging_dir="$(mktemp -d "$(dirname -- "$keystore_path")/.syncpeer-signing.XXXXXX")"
  install -m 600 "$temp_keystore" "$staging_dir/android-release.jks"
  if ! ln -- "$staging_dir/android-release.jks" "$keystore_path"; then
    rm -f -- "$staging_dir/android-release.jks"
    rmdir -- "$staging_dir"
    echo "Keystore appeared at the destination; refusing to replace it." >&2
    exit 1
  fi
  rm -f -- "$staging_dir/android-release.jks"
  rmdir -- "$staging_dir"
  secret_store android_keystore_password "$store_password"
  secret_store android_key_alias "$key_alias"
  secret_store android_key_password "$key_password"
fi
if [[ -z "$stored_path" ]]; then
  secret_store android_keystore_path "$keystore_path"
fi
if [[ -z "$stored_backup" || "$stored_backup" != "$keystore_b64" ]]; then
  secret_store android_keystore_base64 "$keystore_b64"
fi

upload_secret ANDROID_KEYSTORE_BASE64 "$keystore_b64"
upload_secret ANDROID_KEYSTORE_PASSWORD "$store_password"
upload_secret ANDROID_KEY_ALIAS "$key_alias"
upload_secret ANDROID_KEY_PASSWORD "$key_password"
printf 'Validated Android signing identity uploaded to %s.\n' "$target_repo"
