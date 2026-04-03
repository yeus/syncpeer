#!/usr/bin/env bash
set -euo pipefail

APP_NAME="syncpeer"
SECRET_SCOPE="android-release-signing"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"

secret_lookup() {
  local key="$1"
  secret-tool lookup app "$APP_NAME" scope "$SECRET_SCOPE" key "$key" 2>/dev/null || true
}

load_from_secret_store_if_missing() {
  local env_name="$1"
  local secret_key="$2"

  if [[ -n "${!env_name:-}" ]]; then
    return 0
  fi

  local value
  value="$(secret_lookup "$secret_key")"
  if [[ -n "$value" ]]; then
    export "$env_name=$value"
  fi
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

temp_keystore_path=""
temp_keystore_properties_paths=()
cleanup_temp_keystore() {
  if [[ -n "$temp_keystore_path" && -f "$temp_keystore_path" ]]; then
    rm -f "$temp_keystore_path"
  fi
  for path in "${temp_keystore_properties_paths[@]}"; do
    if [[ -n "$path" && -f "$path" ]]; then
      rm -f "$path"
    fi
  done
}
trap cleanup_temp_keystore EXIT

materialize_keystore_from_base64() {
  local value="$1"
  local temp_dir="${TMPDIR:-/tmp}"
  temp_keystore_path="$(mktemp "$temp_dir/syncpeer-android-release.XXXXXX.jks")"
  if ! decode_base64_to_file "$value" "$temp_keystore_path"; then
    echo "Failed to decode ANDROID_KEYSTORE_BASE64 into temp keystore file." >&2
    exit 1
  fi
  chmod 600 "$temp_keystore_path"
  echo "$temp_keystore_path"
}

copy_keystore_to_temp() {
  local source_path="$1"
  local temp_dir="${TMPDIR:-/tmp}"
  temp_keystore_path="$(mktemp "$temp_dir/syncpeer-android-release.XXXXXX.jks")"
  cp "$source_path" "$temp_keystore_path"
  chmod 600 "$temp_keystore_path"
  echo "$temp_keystore_path"
}

normalize_keystore_path() {
  local path="$1"
  local normalized="$path"

  normalized="${normalized/#\~/$HOME}"
  normalized="${normalized//\$\{HOME\}/$HOME}"
  normalized="${normalized//\$HOME/$HOME}"

  if [[ "$normalized" =~ ^/home/[^/]+(/.*)$ ]]; then
    local rewritten="$HOME${BASH_REMATCH[1]}"
    if [[ -f "$rewritten" ]]; then
      echo "$rewritten"
      return 0
    fi
  fi

  if [[ "$normalized" =~ ^/Users/[^/]+(/.*)$ ]]; then
    local rewritten="$HOME${BASH_REMATCH[1]}"
    if [[ -f "$rewritten" ]]; then
      echo "$rewritten"
      return 0
    fi
  fi

  echo "$normalized"
}

create_gradle_keystore_properties() {
  local destination="$1"
  mkdir -p "$(dirname "$destination")"
  umask 077
  cat >"$destination" <<EOF
storeFile=$ANDROID_KEYSTORE_PATH
password=$ANDROID_KEYSTORE_PASSWORD
keyAlias=$ANDROID_KEY_ALIAS
keyPassword=$ANDROID_KEY_PASSWORD
EOF
}

find_apksigner() {
  if command -v apksigner >/dev/null 2>&1; then
    command -v apksigner
    return 0
  fi

  local sdk_root="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
  if [[ -n "$sdk_root" && -d "$sdk_root/build-tools" ]]; then
    local selected=""
    if [[ -n "${ANDROID_BUILD_TOOLS:-}" && -x "$sdk_root/build-tools/$ANDROID_BUILD_TOOLS/apksigner" ]]; then
      selected="$sdk_root/build-tools/$ANDROID_BUILD_TOOLS/apksigner"
    else
      selected="$(
        find "$sdk_root/build-tools" -mindepth 2 -maxdepth 2 -type f -name apksigner 2>/dev/null \
          | sort -V \
          | tail -n 1
      )"
    fi
    if [[ -n "$selected" && -x "$selected" ]]; then
      echo "$selected"
      return 0
    fi
  fi

  return 1
}

sign_unsigned_release_apk_if_needed() {
  local root="$1"
  local unsigned_candidates=(
    "$root/packages/tauri-shell/src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk"
    "$root/packages/tauri-shell/src-tauri/gen/android/app/build/outputs/apk/release/app-release-unsigned.apk"
  )

  local unsigned_apk=""
  for candidate in "${unsigned_candidates[@]}"; do
    if [[ -f "$candidate" ]]; then
      unsigned_apk="$candidate"
      break
    fi
  done

  if [[ -z "$unsigned_apk" ]]; then
    return 0
  fi

  local signed_apk="${unsigned_apk%-unsigned.apk}.apk"
  local apksigner_bin
  if ! apksigner_bin="$(find_apksigner)"; then
    echo "Found unsigned release APK but could not find apksigner on PATH or Android SDK build-tools." >&2
    echo "Unsigned APK: $unsigned_apk" >&2
    return 1
  fi

  cp "$unsigned_apk" "$signed_apk"
  "$apksigner_bin" sign \
    --ks "$ANDROID_KEYSTORE_PATH" \
    --ks-key-alias "$ANDROID_KEY_ALIAS" \
    --ks-pass env:ANDROID_KEYSTORE_PASSWORD \
    --key-pass env:ANDROID_KEY_PASSWORD \
    "$signed_apk"

  "$apksigner_bin" verify "$signed_apk"
  echo "Signed APK with apksigner fallback: $signed_apk"
}

print_missing_guidance() {
  local missing=("$@")
  echo "Missing required Android signing configuration." >&2
  echo "Unset values: ${missing[*]}" >&2
  echo >&2
  echo "Populate Linux Secret Service entries first:" >&2
  echo "  scripts/sync-android-signing-secrets.sh <owner/repo>" >&2
  echo >&2
  echo "Or export these environment variables before building:" >&2
  echo "  ANDROID_KEYSTORE_PATH (or ANDROID_KEYSTORE_BASE64)" >&2
  echo "  ANDROID_KEYSTORE_BASE64" >&2
  echo "  ANDROID_KEYSTORE_PASSWORD" >&2
  echo "  ANDROID_KEY_ALIAS" >&2
  echo "  ANDROID_KEY_PASSWORD" >&2
}

needs_lookup=0
has_keystore_material=0
if [[ -n "${ANDROID_KEYSTORE_PATH:-}" || -n "${ANDROID_KEYSTORE_BASE64:-}" ]]; then
  has_keystore_material=1
fi
(( has_keystore_material == 1 )) || needs_lookup=1
[[ -n "${ANDROID_KEYSTORE_PASSWORD:-}" ]] || needs_lookup=1
[[ -n "${ANDROID_KEY_ALIAS:-}" ]] || needs_lookup=1
[[ -n "${ANDROID_KEY_PASSWORD:-}" ]] || needs_lookup=1

if (( needs_lookup == 1 )) && ! command -v secret-tool >/dev/null 2>&1; then
  echo "Warning: Linux Secret Service tooling is unavailable (missing 'secret-tool')." >&2
  echo "Cancelling Android production build before Gradle/Tauri starts." >&2
  echo "This build requires signing secrets from Secret Service or pre-exported ANDROID_* variables." >&2
  echo "If you usually store secrets in Secret Service, run this outside the sandbox:" >&2
  echo "  scripts/sync-android-signing-secrets.sh <owner/repo>" >&2
  exit 1
fi

load_from_secret_store_if_missing "ANDROID_KEYSTORE_PATH" "android_keystore_path"
load_from_secret_store_if_missing "ANDROID_KEYSTORE_BASE64" "android_keystore_base64"
load_from_secret_store_if_missing "ANDROID_KEYSTORE_PASSWORD" "android_keystore_password"
load_from_secret_store_if_missing "ANDROID_KEY_ALIAS" "android_key_alias"
load_from_secret_store_if_missing "ANDROID_KEY_PASSWORD" "android_key_password"

missing=()
if [[ -z "${ANDROID_KEYSTORE_PATH:-}" && -z "${ANDROID_KEYSTORE_BASE64:-}" ]]; then
  missing+=("ANDROID_KEYSTORE_PATH or ANDROID_KEYSTORE_BASE64")
fi
[[ -n "${ANDROID_KEYSTORE_PASSWORD:-}" ]] || missing+=("ANDROID_KEYSTORE_PASSWORD")
[[ -n "${ANDROID_KEY_ALIAS:-}" ]] || missing+=("ANDROID_KEY_ALIAS")
[[ -n "${ANDROID_KEY_PASSWORD:-}" ]] || missing+=("ANDROID_KEY_PASSWORD")

if (( ${#missing[@]} > 0 )); then
  print_missing_guidance "${missing[@]}"
  exit 1
fi

if [[ -n "${ANDROID_KEYSTORE_BASE64:-}" ]]; then
  export ANDROID_KEYSTORE_PATH
  ANDROID_KEYSTORE_PATH="$(materialize_keystore_from_base64 "$ANDROID_KEYSTORE_BASE64")"
  echo "Prepared temp keystore file from ANDROID_KEYSTORE_BASE64."
else
  resolved_keystore_path="$(normalize_keystore_path "$ANDROID_KEYSTORE_PATH")"
  if [[ "$resolved_keystore_path" != "$ANDROID_KEYSTORE_PATH" ]]; then
    echo "Normalized ANDROID_KEYSTORE_PATH to: $resolved_keystore_path"
    export ANDROID_KEYSTORE_PATH="$resolved_keystore_path"
  fi

  if [[ ! -f "$ANDROID_KEYSTORE_PATH" ]]; then
    echo "Keystore file does not exist: $ANDROID_KEYSTORE_PATH" >&2
    default_keystore_path="${XDG_CONFIG_HOME:-$HOME/.config}/syncpeer/android-release.jks"
    if [[ -f "$default_keystore_path" ]]; then
      echo "Found default keystore for this user at: $default_keystore_path" >&2
      echo "Export ANDROID_KEYSTORE_PATH=\"$default_keystore_path\" or re-sync secrets." >&2
    else
      echo "Update secret 'android_keystore_path' or secret 'android_keystore_base64'." >&2
      echo "If needed, create/sync defaults with: scripts/sync-android-signing-secrets.sh <owner/repo>" >&2
    fi
    exit 1
  fi

  export ANDROID_KEYSTORE_PATH
  ANDROID_KEYSTORE_PATH="$(copy_keystore_to_temp "$ANDROID_KEYSTORE_PATH")"
  echo "Prepared temp keystore file from ANDROID_KEYSTORE_PATH."
fi

cd "$repo_root"
temp_keystore_properties_paths=(
  "$repo_root/packages/tauri-shell/src-tauri/gen/android/keystore.properties"
  "$repo_root/packages/tauri-shell/src-tauri/gen/android/app/keystore.properties"
)
for path in "${temp_keystore_properties_paths[@]}"; do
  create_gradle_keystore_properties "$path"
done
echo "Prepared temporary Gradle keystore.properties for release signing (${temp_keystore_properties_paths[*]})."
npm run icons:ensure:android
npm run build:android:prod -w @syncpeer/tauri-shell
sign_unsigned_release_apk_if_needed "$repo_root"
node scripts/copy-android-apk.mjs release
