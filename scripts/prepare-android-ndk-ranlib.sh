#!/usr/bin/env bash
set -euo pipefail

: "${ANDROID_NDK_HOME:?ANDROID_NDK_HOME must be set}"
: "${GITHUB_PATH:?GITHUB_PATH must be set}"

ndk_bin="$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64/bin"
test -x "$ndk_bin/llvm-ranlib"

if [[ ! -x "$ndk_bin/aarch64-linux-android-ranlib" ]]; then
  ln -sf "$ndk_bin/llvm-ranlib" "$ndk_bin/aarch64-linux-android-ranlib"
fi

test -x "$ndk_bin/aarch64-linux-android-ranlib"
printf '%s\n' "$ndk_bin" >> "$GITHUB_PATH"
