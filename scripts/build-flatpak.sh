#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"
cd "$repo_root"
manifest="$repo_root/flatpak/dev.syncpeer.app.yml"
build_root="$repo_root/.tmp/flatpak"
state_dir="$build_root/state"
build_dir="$build_root/build"
repo_dir="$build_root/repo"
version="$(node -p "require('./packages/tauri-shell/src-tauri/tauri.conf.json').version")"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

require_command flatpak
require_command flatpak-builder

if ! flatpak remotes --columns=name | grep -Fxq flathub; then
  echo "Adding the Flathub user remote..."
  flatpak remote-add --user --if-not-exists flathub \
    https://dl.flathub.org/repo/flathub.flatpakrepo
fi

mkdir -p "$build_root" "$state_dir" "$repo_dir"
flatpak-builder \
  --force-clean \
  --disable-rofiles-fuse \
  --user \
  --install-deps-from=flathub \
  --repo="$repo_dir" \
  --state-dir="$state_dir" \
  "$build_dir" \
  "$manifest"

arch="$(flatpak --default-arch)"
artifact="$repo_root/dist/Syncpeer_${version}_${arch}.flatpak"
mkdir -p "$repo_root/dist"
flatpak build-bundle \
  "$repo_dir" \
  "$artifact" \
  dev.syncpeer.app \
  --runtime-repo=https://dl.flathub.org/repo/flathub.flatpakrepo

echo "Flatpak bundle created: $artifact"
