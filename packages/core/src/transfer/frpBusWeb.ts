import { createPortFromTransport, type DuplexTransport } from "./frpTransport.js";
import type { Port } from "./frpBus.js";

export const createPortFromMessagePort = <TSend, TReceive = TSend>(
  messagePort: MessagePort,
): { port: Port<TSend, TReceive>; destroy: () => void } => {
  const transport: DuplexTransport<TSend, TReceive> = {
    send: (message) => messagePort.postMessage(message),
    subscribe: (receive) => {
      const listener = (event: MessageEvent<TReceive>) => receive(event.data);
      messagePort.addEventListener("message", listener);
      messagePort.start();
      return () => messagePort.removeEventListener("message", listener);
    },
    close: () => messagePort.close(),
  };
  return createPortFromTransport(transport);
};
