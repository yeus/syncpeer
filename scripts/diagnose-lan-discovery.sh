#!/usr/bin/env bash
# Read-only host diagnostic for Syncpeer LAN discovery.
#
# Run this on the host (outside the AI sandbox) while the other Syncthing or
# Syncpeer devices are running:
#
#   bash scripts/diagnose-lan-discovery.sh
#
# For the firewall rules and the tcpdump comparison, run it as root:
#
#   sudo bash scripts/diagnose-lan-discovery.sh
#
# The script only reads state and listens. It changes nothing and stores no
# packet payloads or peer identifiers; the report contains counters only.

set -euo pipefail

report="${SYNCPEER_LAN_DIAG_REPORT:-$PWD/lan-discovery-report-$(date +%Y%m%d-%H%M%S).txt}"
listen_seconds="${SYNCPEER_LAN_DIAG_SECONDS:-45}"
tcpdump_log="$(mktemp)"

cleanup() {
  rm -f "$tcpdump_log"
}
trap cleanup EXIT

{
  echo "# Syncpeer LAN discovery diagnostic"
  echo "time: $(date -Is)"
  echo "user: $(id -un) (uid $(id -u))"
  echo "host: $(uname -srm)"
  echo
  echo "## OS"
  grep -E "^(PRETTY_NAME|ID|VERSION_ID)=" /etc/os-release 2>/dev/null || true
  echo
  echo "## Interfaces"
  for iface in /sys/class/net/*; do
    name="$(basename "$iface")"
    [ "$name" = "lo" ] && continue
    echo "- $name state=$(cat "$iface/operstate" 2>/dev/null || echo unknown)"
  done
  echo
  echo "## Firewall state"
  if command -v ufw >/dev/null 2>&1; then
    echo "### ufw"
    ufw status verbose 2>&1 | head -20 || echo "ufw status needs root"
  fi
  if command -v firewall-cmd >/dev/null 2>&1; then
    echo "### firewalld"
    firewall-cmd --state 2>&1 || true
    firewall-cmd --list-all 2>&1 | head -30 || true
  fi
  if command -v nft >/dev/null 2>&1; then
    echo "### nftables (rules mentioning discovery or sync ports)"
    nft list ruleset 2>&1 | grep -E "21027|21037|22000|policy" | head -40 || echo "nft list needs root"
  fi
  if command -v iptables >/dev/null 2>&1; then
    echo "### iptables (legacy)"
    iptables -S 2>&1 | grep -E "21027|21037|22000|DROP|REJECT" | head -30 || echo "iptables needs root"
  fi
  echo
  echo "## Passive UDP 21027 listen (${listen_seconds}s)"
  node - "$listen_seconds" <<'NODE' 2>&1 || echo "listener failed"
    const dgram = require("node:dgram");
    const os = require("node:os");
    const seconds = Number(process.argv[2] || 45);
    const sockets = [];
    const counts = { udp4: 0, udp6: 0 };
    const errors = [];
    const add = (type, host) => {
      const socket = dgram.createSocket({
        type,
        reuseAddr: true,
        ...(type === "udp6" ? { ipv6Only: true } : {}),
      });
      socket.on("error", (error) => errors.push(`${type}:${error.code || error.message}`));
      socket.on("message", () => { counts[type] += 1; });
      socket.once("listening", () => {
        if (type === "udp6") {
          for (const name of Object.keys(os.networkInterfaces())) {
            try { socket.addMembership("ff12::8384", name); } catch { /* not multicast-capable */ }
          }
        }
      });
      socket.bind(21027, host);
      sockets.push(socket);
    };
    add("udp4", "0.0.0.0");
    add("udp6", "::");
    setTimeout(() => {
      console.log(`packets on 21027: udp4=${counts.udp4} udp6=${counts.udp6} total=${counts.udp4 + counts.udp6}`);
      if (errors.length) console.log(`listener notes: ${[...new Set(errors)].join(", ")}`);
      for (const socket of sockets) socket.close();
      process.exit(0);
    }, seconds * 1000);
NODE
  echo
  echo "## Packet capture comparison"
  if [ "$(id -u)" -ne 0 ]; then
    echo "skipped: run with sudo for the tcpdump comparison"
  elif ! command -v tcpdump >/dev/null 2>&1; then
    echo "skipped: tcpdump is not installed"
  else
    timeout -s INT "$listen_seconds" tcpdump -ni any "udp port 21027" >/dev/null 2>"$tcpdump_log" || true
    grep -oE "[0-9]+ packets captured" "$tcpdump_log" | head -1 || echo "no capture summary"
  fi
  echo
  echo "## Verdict guide"
  echo "- Listener packets > 0: LAN announcements reach this host; discovery should work."
  echo "- tcpdump > 0 but listener = 0: the host firewall drops inbound UDP 21027."
  echo "- Both 0: no LAN announcements reach this host (firewall, Wi-Fi client isolation, or the other devices are not announcing)."
} >"$report" 2>&1

chmod 600 "$report"
# When run through sudo, hand the report back to the invoking user so the
# sandboxed workspace copy stays readable.
if [ -n "${SUDO_UID:-}" ] && [ -n "${SUDO_GID:-}" ]; then
  chown "$SUDO_UID:$SUDO_GID" "$report" 2>/dev/null || true
fi
echo "Report written to $report"
echo "Please review it and share the firewall and packet-counter sections."
