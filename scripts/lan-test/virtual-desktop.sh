#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" != "--inside-xvfb" ]]; then
  exec xvfb-run -a bash "$0" --inside-xvfb "$@"
fi
shift
if [[ $# -eq 0 ]]; then
  echo "Pass a command to run in the virtual desktop." >&2
  exit 2
fi

# Xvfb has no GPU, so keep WebKit on its supported software-rendering path.
export WEBKIT_DISABLE_DMABUF_RENDERER=1
export LIBGL_ALWAYS_SOFTWARE=1
export GALLIUM_DRIVER=llvmpipe

# Native window activation needs a window manager, even on a virtual display.
openbox --sm-disable &
virtual_desktop_wm_pid=$!
trap 'kill "$virtual_desktop_wm_pid" 2>/dev/null || true; wait "$virtual_desktop_wm_pid" 2>/dev/null || true' EXIT

virtual_desktop_ready=false
for ((virtual_desktop_attempt = 0; virtual_desktop_attempt < 100; virtual_desktop_attempt++)); do
  if ! kill -0 "$virtual_desktop_wm_pid" 2>/dev/null; then
    echo "The virtual desktop window manager failed to start." >&2
    exit 1
  fi
  if xprop -root _NET_SUPPORTING_WM_CHECK 2>/dev/null | grep -Eq 'window id # 0x[1-9a-fA-F]'; then
    virtual_desktop_ready=true
    break
  fi
  sleep 0.05
done
if [[ "$virtual_desktop_ready" != true ]]; then
  echo "The virtual desktop window manager did not become ready." >&2
  exit 1
fi

"$@"
