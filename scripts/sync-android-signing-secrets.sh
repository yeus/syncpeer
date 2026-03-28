#!/usr/bin/env bash
set -euo pipefail

APP_NAME="syncpeer"
DEFAULT_SCOPE="android-release-signing"
DEFAULT_KEYSTORE_PATH="${XDG_CONFIG_HOME:-$HOME/.config}/syncpeer/android-release.jks"
DEFAULT_KEY_ALIAS="syncpeer-release-key"

usage() {
  cat <<'USAGE'
Usage:
  scripts/sync-android-signing-secrets.sh [owner/repo]

Wizard behavior:
  - Loads Android signing values from Linux Secret Service.
  - Missing values are auto-created with safe defaults (no free-text prompts).
  - Ensures keystore exists locally (restores from Secret Service base64 or creates default).
  - Secret Service is treated as source of truth and overwrites GitHub Actions secrets.

GitHub secrets written:
  ANDROID_KEYSTORE_BASE64
  ANDROID_KEYSTORE_PASSWORD
  ANDROID_KEY_ALIAS
  ANDROID_KEY_PASSWORD

Secret Service entries written:
  android_keystore_path
  android_keystore_base64
  android_keystore_password
  android_key_alias
  android_key_password
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing required command: $cmd" >&2
    exit 1
  fi
}

require_cmd secret-tool
require_cmd gh
require_cmd git
require_cmd base64
require_cmd keytool

secret_lookup() {
  local key="$1"
  secret-tool lookup app "$APP_NAME" scope "$DEFAULT_SCOPE" key "$key" 2>/dev/null || true
}

secret_store() {
  local key="$1"
  local label="$2"
  local value="$3"
  printf '%s' "$value" | \
    secret-tool store \
      --label "$label" \
      app "$APP_NAME" \
      scope "$DEFAULT_SCOPE" \
      key "$key" >/dev/null
}

decode_base64_to_file() {
  local value="$1"
  local destination="$2"

  if printf '%s' "$value" | base64 -d >"$destination" 2>/dev/null; then
    return 0
  fi
  if printf '%s' "$value" | base64 --decode >"$destination" 2>/dev/null; then
    return 0
  fi
  if printf '%s' "$value" | base64 -D >"$destination" 2>/dev/null; then
    return 0
  fi
  return 1
}

encode_file_base64() {
  local file_path="$1"
  if encoded="$(base64 -w 0 "$file_path" 2>/dev/null)"; then
    printf '%s' "$encoded"
  else
    base64 "$file_path" | tr -d '\n'
  fi
}

expand_home_path() {
  local path="$1"
  local expanded="$path"
  expanded="${expanded/#\~/$HOME}"
  expanded="${expanded//\$\{HOME\}/$HOME}"
  expanded="${expanded//\$HOME/$HOME}"
  printf '%s' "$expanded"
}

require_non_empty_secret() {
  local key="$1"
  local value="$2"
  if [[ -z "$value" ]]; then
    echo "Missing required Secret Service entry after reconciliation: $key" >&2
    exit 1
  fi
}

prompt_yes_no() {
  local prompt="$1"
  local answer=""
  while true; do
    read -r -p "$prompt [Y/n]: " answer
    case "${answer:-Y}" in
      Y|y|yes|YES) return 0 ;;
      N|n|no|NO) return 1 ;;
      *) echo "Please answer y or n." >&2 ;;
    esac
  done
}

generate_password() {
  head -c 48 /dev/urandom | base64 | tr -d '=+/' | cut -c1-32
}

get_or_create_default_secret() {
  local key="$1"
  local label="$2"
  local default_value="$3"

  local value
  value="$(secret_lookup "$key")"
  if [[ -n "$value" ]]; then
    printf '%s' "$value"
    return 0
  fi

  secret_store "$key" "$label" "$default_value"
  echo "Created Secret Service entry: $key" >&2
  printf '%s' "$default_value"
}

get_or_create_generated_secret() {
  local key="$1"
  local label="$2"

  local value
  value="$(secret_lookup "$key")"
  if [[ -n "$value" ]]; then
    printf '%s' "$value"
    return 0
  fi

  value="$(generate_password)"
  secret_store "$key" "$label" "$value"
  echo "Created Secret Service entry: $key" >&2
  printf '%s' "$value"
}

ensure_default_keystore() {
  local keystore_path="$1"
  local key_alias="$2"
  local store_password="$3"
  local key_password="$4"

  mkdir -p "$(dirname "$keystore_path")"

  if [[ -f "$keystore_path" ]]; then
    return 0
  fi

  keytool -genkeypair \
    -keystore "$keystore_path" \
    -storetype JKS \
    -alias "$key_alias" \
    -keyalg RSA \
    -keysize 2048 \
    -validity 10000 \
    -storepass "$store_password" \
    -keypass "$key_password" \
    -dname "CN=Syncpeer, OU=Syncpeer, O=Syncpeer, L=Unknown, ST=Unknown, C=US" >/dev/null

  echo "Created default keystore: $keystore_path"
}

keystore_has_alias() {
  local keystore_path="$1"
  local store_password="$2"
  local key_alias="$3"
  keytool -list -keystore "$keystore_path" -storepass "$store_password" -alias "$key_alias" >/dev/null 2>&1
}

infer_repo_from_git() {
  local remote
  remote="$(git remote get-url origin 2>/dev/null || true)"
  if [[ -z "$remote" ]]; then
    echo ""
    return 0
  fi

  if [[ "$remote" =~ ^git@github.com:([^/]+)/([^/.]+)(\.git)?$ ]]; then
    echo "${BASH_REMATCH[1]}/${BASH_REMATCH[2]}"
    return 0
  fi

  if [[ "$remote" =~ ^https://github.com/([^/]+)/([^/.]+)(\.git)?$ ]]; then
    echo "${BASH_REMATCH[1]}/${BASH_REMATCH[2]}"
    return 0
  fi

  echo ""
}

upload_secret() {
  local repo="$1"
  local name="$2"
  local value="$3"
  gh secret set "$name" --repo "$repo" --body "$value"
  echo "Uploaded GitHub secret: $name"
}

TARGET_REPO="${1:-}"
if [[ -z "$TARGET_REPO" ]]; then
  TARGET_REPO="$(infer_repo_from_git)"
fi

if [[ -z "$TARGET_REPO" ]]; then
  echo "Could not infer GitHub repo from git remote. Pass it explicitly, e.g. scripts/sync-android-signing-secrets.sh owner/repo" >&2
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "GitHub CLI is not authenticated. Run: gh auth login" >&2
  exit 1
fi

stored_keystore_path="$(get_or_create_default_secret \
  "android_keystore_path" \
  "Syncpeer Android keystore path" \
  "$DEFAULT_KEYSTORE_PATH")"
keystore_path="$(expand_home_path "$stored_keystore_path")"
if [[ "$keystore_path" != "$stored_keystore_path" ]]; then
  secret_store "android_keystore_path" "Syncpeer Android keystore path" "$keystore_path"
  echo "Normalized Secret Service entry: android_keystore_path"
fi

key_alias="$(get_or_create_default_secret \
  "android_key_alias" \
  "Syncpeer Android key alias" \
  "$DEFAULT_KEY_ALIAS")"

keystore_password="$(get_or_create_generated_secret \
  "android_keystore_password" \
  "Syncpeer Android keystore password")"

key_password="$(get_or_create_generated_secret \
  "android_key_password" \
  "Syncpeer Android key password")"

keystore_b64_from_store="$(secret_lookup "android_keystore_base64")"

printf 'Wizard summary:\n'
printf '  Repo: %s\n' "$TARGET_REPO"
printf '  Keystore path: %s\n' "$keystore_path"
printf '  Key alias: %s\n' "$key_alias"
printf '  Missing values were auto-created in Secret Service.\n'
printf '  Secret Service is the source of truth and will overwrite GitHub secrets.\n'

if ! prompt_yes_no "Proceed to reconcile local Secret Service + keystore and overwrite GitHub secrets?"; then
  echo "Aborted by user."
  exit 0
fi

if [[ ! -f "$keystore_path" ]]; then
  mkdir -p "$(dirname "$keystore_path")"
  if [[ -n "$keystore_b64_from_store" ]]; then
    if decode_base64_to_file "$keystore_b64_from_store" "$keystore_path"; then
      chmod 600 "$keystore_path"
      echo "Restored keystore from Secret Service base64: $keystore_path"
    else
      echo "Stored 'android_keystore_base64' is not valid base64; cannot restore keystore." >&2
      exit 1
    fi
  else
    ensure_default_keystore "$keystore_path" "$key_alias" "$keystore_password" "$key_password"
  fi
fi

if ! keystore_has_alias "$keystore_path" "$keystore_password" "$key_alias"; then
  backup_path="${keystore_path}.bak.$(date +%s)"
  if prompt_yes_no "Default keystore exists but alias '$key_alias' is missing. Recreate default keystore (backup -> $backup_path)?"; then
    mv "$keystore_path" "$backup_path"
    ensure_default_keystore "$keystore_path" "$key_alias" "$keystore_password" "$key_password"
  else
    echo "Aborted because keystore alias is missing." >&2
    exit 1
  fi
fi
secret_store "android_keystore_path" "Syncpeer Android keystore path" "$keystore_path"

if [[ ! -f "$keystore_path" ]]; then
  echo "Keystore file does not exist: $keystore_path" >&2
  exit 1
fi

keystore_b64="$(encode_file_base64 "$keystore_path")"
secret_store "android_keystore_base64" "Syncpeer Android keystore base64" "$keystore_b64"

local_keystore_b64="$(secret_lookup "android_keystore_base64")"
local_keystore_password="$(secret_lookup "android_keystore_password")"
local_key_alias="$(secret_lookup "android_key_alias")"
local_key_password="$(secret_lookup "android_key_password")"

require_non_empty_secret "android_keystore_base64" "$local_keystore_b64"
require_non_empty_secret "android_keystore_password" "$local_keystore_password"
require_non_empty_secret "android_key_alias" "$local_key_alias"
require_non_empty_secret "android_key_password" "$local_key_password"

upload_secret "$TARGET_REPO" "ANDROID_KEYSTORE_BASE64" "$local_keystore_b64"
upload_secret "$TARGET_REPO" "ANDROID_KEYSTORE_PASSWORD" "$local_keystore_password"
upload_secret "$TARGET_REPO" "ANDROID_KEY_ALIAS" "$local_key_alias"
upload_secret "$TARGET_REPO" "ANDROID_KEY_PASSWORD" "$local_key_password"

echo
printf 'Done. Uploaded Android release signing secrets to %s\n' "$TARGET_REPO"
