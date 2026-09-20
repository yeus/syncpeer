export type RuntimePort = Pick<MessagePort, "onmessage" | "postMessage">;

export const createPortRequest = (port: RuntimePort) => {
  let next = 0;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  port.onmessage = event => {
    const reply = JSON.parse(event.data);
    const task = pending.get(reply.id);
    if (!task) return;
    pending.delete(reply.id);
    if (reply.error) task.reject(new Error(reply.error)); else task.resolve(reply.result);
  };
  return (input: object): Promise<unknown> => new Promise((resolve, reject) => {
    const id = ++next;
    pending.set(id, { resolve, reject });
    port.postMessage(JSON.stringify({ id, ...input }));
  });
};
