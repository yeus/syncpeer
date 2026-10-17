#!/usr/bin/env bash
# End-to-end LAN discovery test on a private virtual network.
#
# Creates an isolated bridge with two network namespaces inside an
# unprivileged user namespace, runs the repository Syncthing fixture in one
# namespace and the Rust discovery runtime in the other, and asserts that the
# real Syncthing announcement is discovered. This is the receive direction
# that cannot run on a single host because Syncthing owns UDP 21027.
#
# Usage: bash scripts/test-lan-discovery-netns.sh
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

if [ "${SYNCPEER_LAN_NETNS_ACTIVE:-}" != "1" ]; then
  echo "[netns] building the native discovery test binary..."
  build_log="$(mktemp)"
  if ! cargo test --no-run --message-format=json \
    --manifest-path packages/tauri-shell/src-tauri/Cargo.toml >"$build_log" 2>&1; then
    echo "[netns] cargo test build failed:" >&2
    tail -20 "$build_log" >&2
    rm -f "$build_log"
    exit 1
  fi
  test_bin="$(python3 - "$build_log" <<'PY'
import json, sys
for line in open(sys.argv[1]):
    line = line.strip()
    if not line.startswith("{"):
        continue
    try:
        message = json.loads(line)
    except Exception:
        continue
    if message.get("executable") and message.get("target", {}).get("name") == "tauri_shell_lib":
        print(message["executable"])
        break
PY
)"
  rm -f "$build_log"
  if [ -z "$test_bin" ] || [ ! -x "$test_bin" ]; then
    echo "[netns] could not locate the tauri-shell test binary" >&2
    exit 1
  fi
  exec unshare -rmn env SYNCPEER_LAN_NETNS_ACTIVE=1 \
    SYNCPEER_LAN_TEST_BIN="$test_bin" bash "$0" "$@"
fi

test_bin="${SYNCPEER_LAN_TEST_BIN:?test binary path is missing}"
version="${SYNCTHING_VERSION:-v2.1.2}"
case "$(uname -m)" in
  x86_64) arch=amd64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) echo "[netns] unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac
syncthing="$repo_root/.tools/syncthing-linux-${arch}-${version}/syncthing"
if [ ! -x "$syncthing" ]; then
  echo "[netns] missing pinned Syncthing at $syncthing (run npm run download:syncthing)" >&2
  exit 1
fi

# A private /run lets iproute2 create named network namespaces.
mount -t tmpfs tmpfs /run
mkdir -p /run/netns
ip link add br0 type bridge
ip link set br0 up
ip addr add 10.99.0.1/24 dev br0
ip netns add a
ip netns add b
for spec in "a 2" "b 3"; do
  set -- $spec
  ns="$1"
  host="$2"
  ip link add "v$ns" type veth peer name "p$ns"
  ip link set "v$ns" master br0
  ip link set "v$ns" up
  ip link set "p$ns" netns "$ns"
  nsenter --net="/run/netns/$ns" ip addr add "10.99.0.$host/24" dev "p$ns"
  nsenter --net="/run/netns/$ns" ip link set "p$ns" up
  nsenter --net="/run/netns/$ns" ip link set lo up
  # A default route lets 255.255.255.255 probes route out the bridge,
  # matching a real LAN that has a gateway.
  nsenter --net="/run/netns/$ns" ip route add default via 10.99.0.1
done

home="$(mktemp -d)"
cleanup() {
  if [ -n "${syncthing_pid:-}" ]; then
    kill "$syncthing_pid" 2>/dev/null || true
  fi
  rm -rf "$home"
}
trap cleanup EXIT

# Syncpeer probe/reply across the bridge: run the same test in both
# namespaces with mirrored identities so each side discovers the other.
make_id() {
  python3 -c 'import base64, hashlib, sys
print(base64.b32encode(hashlib.sha256(sys.argv[1].encode()).digest()).decode().rstrip("="))' "$1"
}
id_a="$(make_id syncpeer-netns-a)"
id_b="$(make_id syncpeer-netns-b)"
probe_test="local_discovery::tests::local_discovery_discovers_syncpeer_peers_on_a_real_network"
echo "[netns] running the Syncpeer probe/reply test in both namespaces"
nsenter --net=/run/netns/a env SYNCPEER_LAN_INTEROP=1 \
  SYNCPEER_LOCAL_ID="$id_a" SYNCPEER_EXPECTED_PEER_ID="$id_b" \
  "$test_bin" "$probe_test" --exact --nocapture >"$home/probe-a.log" 2>&1 &
probe_a_pid=$!
sleep 1
set +e
nsenter --net=/run/netns/b env SYNCPEER_LAN_INTEROP=1 \
  SYNCPEER_LOCAL_ID="$id_b" SYNCPEER_EXPECTED_PEER_ID="$id_a" \
  "$test_bin" "$probe_test" --exact --nocapture >"$home/probe-b.log" 2>&1
probe_b_status=$?
wait "$probe_a_pid"
probe_a_status=$?
set -e
cat "$home/probe-a.log" "$home/probe-b.log"
if [ "$probe_a_status" -ne 0 ] || [ "$probe_b_status" -ne 0 ]; then
  echo "[netns] Syncpeer probe test failed (a=$probe_a_status b=$probe_b_status)" >&2
  exit 1
fi

"$syncthing" generate --home "$home" --no-port-probing >/dev/null
python3 - "$home/config.xml" <<'PY'
import sys
path = sys.argv[1]
text = open(path).read()
text = text.replace("<globalAnnounceEnabled>true</globalAnnounceEnabled>",
                    "<globalAnnounceEnabled>false</globalAnnounceEnabled>")
text = text.replace("<relaysEnabled>true</relaysEnabled>", "<relaysEnabled>false</relaysEnabled>")
text = text.replace("<natEnabled>true</natEnabled>", "<natEnabled>false</natEnabled>")
text = text.replace("<address>127.0.0.1:8384</address>", "<address>127.0.0.1:18399</address>")
open(path, "w").write(text)
PY
device_id="$("$syncthing" device-id --home "$home" | tr -d '[:space:]')"

echo "[netns] starting the Syncthing fixture in namespace a"
nsenter --net=/run/netns/a "$syncthing" serve --home "$home" --no-browser \
  --no-restart --no-upgrade >"$home/syncthing.log" 2>&1 &
syncthing_pid=$!
sleep 6

echo "[netns] running the discovery runtime in namespace b"
set +e
nsenter --net=/run/netns/b env \
  SYNCPEER_LAN_INTEROP=1 \
  SYNCPEER_EXPECTED_SYNCTHING_ID="$device_id" \
  "$test_bin" local_discovery::tests::local_discovery_receives_real_syncthing_announcements --exact --nocapture
status=$?
set -e
if [ "$status" -ne 0 ]; then
  echo "[netns] discovery test failed; Syncthing log tail:" >&2
  tail -20 "$home/syncthing.log" >&2
fi
exit "$status"
