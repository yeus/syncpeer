#!/usr/bin/env bash
set -euo pipefail

APK_PATH="${1:-dist/syncpeer-android-release-arm64-v8a.apk}"
PACKAGE_NAME="${2:-dev.syncpeer.app}"

if ! command -v adb >/dev/null 2>&1; then
  echo "Missing required command: adb" >&2
  exit 1
fi

if [[ ! -f "$APK_PATH" ]]; then
  echo "APK not found: $APK_PATH" >&2
  exit 1
fi

echo "Using APK: $APK_PATH"
echo "Package: $PACKAGE_NAME"
echo

echo "Connected devices:"
adb devices
echo

if command -v keytool >/dev/null 2>&1; then
  echo "APK signing certificate (keytool -printcert -jarfile):"
  keytool -printcert -jarfile "$APK_PATH" | sed -n '1,80p'
  echo
fi

installed_path="$(adb shell pm path "$PACKAGE_NAME" 2>/dev/null | tr -d '\r' || true)"
if [[ -n "$installed_path" ]]; then
  echo "Package is already installed:"
  echo "$installed_path"
  echo
  echo "Installed package summary:"
  adb shell dumpsys package "$PACKAGE_NAME" | rg -n "versionCode=|versionName=|signing|Signing|signatures|Package \\[$PACKAGE_NAME\\]" -i || true
  echo
else
  echo "Package is not currently installed."
  echo
fi

echo "Clearing logcat buffer..."
adb logcat -c || true

echo "Running install command: adb install -r -d \"$APK_PATH\""
set +e
install_output="$(adb install -r -d "$APK_PATH" 2>&1)"
install_exit=$?
set -e
echo "$install_output"
echo

if [[ $install_exit -eq 0 && "$install_output" != *"Failure"* ]]; then
  echo "Install succeeded."
  exit 0
fi

echo "Install failed. Filtered logcat (PackageManager/install-related):"
adb logcat -d -v time | rg -i "INSTALL_FAILED|PackageManager|PackageInstaller|pm_install|installPackage|installd|dexopt|verifier" | tail -n 250 || true
exit 1
