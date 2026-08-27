#!/usr/bin/env bash
set -euo pipefail
umask 022

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

mkdir -p "$repo_root/.tmp"
build_root="$(mktemp -d "$repo_root/.tmp/appimage-build.XXXXXX")"
cargo_target_dir="$build_root/cargo-target"

cleanup() {
  status="$?"
  chmod -R u+rwX "$build_root" 2>/dev/null || true
  rm -rf -- "$build_root"
  exit "$status"
}
trap cleanup EXIT

export CARGO_TARGET_DIR="$cargo_target_dir"
npm run icons:ensure -w @syncpeer/tauri-shell

if [ "$#" -gt 0 ]; then
  npm run build:bundle:appimage:internal \
    -w @syncpeer/tauri-shell -- "$@"
else
  npm run build:bundle:appimage:internal \
    -w @syncpeer/tauri-shell
fi

artifact="$(find "$cargo_target_dir/release/bundle/appimage" \
  -maxdepth 1 -type f -name '*.AppImage' -print -quit)"
test -n "$artifact"

output_dir="$repo_root/packages/tauri-shell/src-tauri/target/release/bundle/appimage"
dist_dir="$repo_root/dist"
if [ -d "$output_dir" ]; then
  chmod -R u+rwX "$output_dir" 2>/dev/null || true
  rm -rf -- "$output_dir"
fi
mkdir -p "$output_dir" "$dist_dir"

artifact_name="$(basename "$artifact")"
cp "$artifact" "$output_dir/$artifact_name"
cp "$artifact" "$dist_dir/$artifact_name"
echo "AppImage copied to $dist_dir/$artifact_name"
