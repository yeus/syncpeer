const required = process.env.SYNCPEER_REQUIRE_EXTERNAL_CHECKS === "1";

try {
  const quic = await import("node:quic");
  if (typeof quic.connect !== "function") {
    throw new Error("node:quic does not expose connect().");
  }
  console.log(`Node QUIC runtime available (${process.version}).`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (required) {
    throw new Error(`Node QUIC runtime is required but unavailable: ${message}`, { cause: error });
  }
  console.log(`Node QUIC runtime unavailable; TCP/relay fallback remains active (${message}).`);
}
