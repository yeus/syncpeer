syncpeer_secret_service_ready() {
  local answer
  while ! command -v secret-tool >/dev/null 2>&1 ||
    ! secret-tool search --all --unlock app syncpeer scope android-release-signing >/dev/null 2>&1; do
    echo "Linux Secret Service is unavailable or locked; signing values were not changed." >&2
    if [[ ! -t 0 ]]; then
      return 1
    fi
    printf 'Unlock Secret Service, then press Enter to retry (q to cancel): ' >&2
    if ! IFS= read -r answer || [[ "$answer" == [qQ] ]]; then
      return 1
    fi
  done
}

syncpeer_secret_lookup() {
  local key="$1"
  local result
  if result="$(secret-tool lookup app syncpeer scope android-release-signing key "$key" 2>&1)"; then
    printf '%s' "$result"
    return 0
  fi
  if [[ -n "$result" ]]; then
    echo "Secret Service could not read Android signing entry $key. Unlock it and retry." >&2
    return 1
  fi
}

syncpeer_require_keytool() {
  if command -v keytool >/dev/null 2>&1; then
    return 0
  fi
  echo "Android release signing needs keytool from a JDK, but it is not on PATH." >&2
  echo "Enter SyncPeer's own Nix shell with 'nix develop', then retry." >&2
  return 1
}

syncpeer_validate_keystore() {
  local file="$1"
  local store_password="$2"
  local alias="$3"
  local key_password="$4"
  local listing
  local aliases
  local actual_alias=""
  local candidate
  local entry_type

  if [[ ! -r "$file" || ! -f "$file" ]]; then
    echo "Android release keystore is missing or unreadable." >&2
    return 1
  fi
  syncpeer_require_keytool || return 1
  if ! listing="$(KEYTOOL_STORE_PASSWORD="$store_password" LC_ALL=C keytool -list -v \
    -keystore "$file" -storepass:env KEYTOOL_STORE_PASSWORD 2>&1)"; then
    echo "android_keystore_password could not open the selected keystore; check the password and keystore backup." >&2
    return 1
  fi
  aliases="$(printf '%s\n' "$listing" | sed -n 's/^Alias name: //p')"
  while IFS= read -r candidate; do
    if [[ "${candidate,,}" == "${alias,,}" ]]; then
      actual_alias="$candidate"
      break
    fi
  done <<<"$aliases"
  if [[ -z "$actual_alias" ]]; then
    echo "android_key_alias was not found in the selected keystore." >&2
    return 1
  fi
  entry_type="$(printf '%s\n' "$listing" | awk -v alias="$actual_alias" '
    /^Alias name: / { current = substr($0, 13) }
    current == alias && /^Entry type: / { print substr($0, 13); exit }
  ')"
  if [[ "$entry_type" != PrivateKeyEntry ]]; then
    echo "android_key_alias is not a private-key entry." >&2
    return 1
  fi
  if ! KEYTOOL_STORE_PASSWORD="$store_password" KEYTOOL_KEY_PASSWORD="$key_password" \
    keytool -certreq -keystore "$file" -storepass:env KEYTOOL_STORE_PASSWORD \
    -alias "$actual_alias" -keypass:env KEYTOOL_KEY_PASSWORD -file /dev/null \
    >/dev/null 2>&1; then
    echo "android_key_password could not unlock the selected private-key alias." >&2
    return 1
  fi
}
