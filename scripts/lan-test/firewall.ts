import { execFileSync } from "node:child_process";

export type FirewallProtocol = "tcp" | "udp";

export interface FirewallPort {
  protocol: FirewallProtocol;
  port: number;
}

type RunFirewallCommand = (args: string[]) => void;

export interface TemporaryNixosFirewall {
  open: (port: FirewallPort) => void;
  close: () => Promise<void>;
}

const runNixosFirewallCommand: RunFirewallCommand = (args) => {
  const isRoot = process.getuid?.() === 0;
  const command = isRoot ? "nixos-firewall-tool" : "sudo";
  const commandArgs = isRoot ? args : ["nixos-firewall-tool", ...args];
  try {
    execFileSync(command, commandArgs, { stdio: "inherit" });
  } catch (error) {
    throw new Error(
      "Could not run " + [command, ...commandArgs].join(" ") +
      ". Install nixos-firewall-tool or run the test with suitable sudo access.",
      { cause: error },
    );
  }
};

export const createTemporaryNixosFirewall = (
  enabled: boolean,
  runCommand: RunFirewallCommand = runNixosFirewallCommand,
): TemporaryNixosFirewall => {
  const opened = new Set<string>();
  let resetNeeded = false;

  return {
    open: (port) => {
      if (!enabled || !Number.isInteger(port.port) || port.port < 1 || port.port > 65535) return;
      const key = port.protocol + ":" + port.port;
      if (opened.has(key)) return;
      runCommand(["open", port.protocol, String(port.port)]);
      opened.add(key);
      resetNeeded = true;
    },
    close: async () => {
      if (!resetNeeded) return;
      runCommand(["reset"]);
      opened.clear();
      resetNeeded = false;
    },
  };
};

export const installFirewallSignalCleanup = (
  firewall: TemporaryNixosFirewall,
): (() => Promise<void>) => {
  let closed = false;
  const cleanup = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await firewall.close();
  };
  const onSignal = (signal: "SIGINT" | "SIGTERM"): void => {
    void cleanup().finally(() => process.kill(process.pid, signal));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  return cleanup;
};
