import assert from "node:assert/strict";
import { createTemporaryNixosFirewall } from "./lan-test/firewall.ts";

const main = async (): Promise<void> => {
  const calls: string[][] = [];
  const firewall = createTemporaryNixosFirewall(true, (args) => {
    calls.push(args);
  });

  firewall.open({ protocol: "tcp", port: 38378 });
  firewall.open({ protocol: "udp", port: 38377 });
  await firewall.close();
  await firewall.close();

  assert.deepEqual(calls, [
    ["open", "tcp", "38378"],
    ["open", "udp", "38377"],
    ["reset"],
  ]);

  const disabledCalls: string[][] = [];
  const disabled = createTemporaryNixosFirewall(false, (args) => {
    disabledCalls.push(args);
  });
  disabled.open({ protocol: "tcp", port: 38378 });
  await disabled.close();
  assert.deepEqual(disabledCalls, []);
  console.log("Temporary NixOS firewall test passed.");
};

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
