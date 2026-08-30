export type Observer<T> = (value: T) => void | Promise<void>;
export type Unsubscribe = () => void;

export interface Stream<T> {
  (observer: Observer<T>): Unsubscribe;
  unsubscribeAll(this: void): void;
  filter(this: void, predicate: (value: T) => boolean): Stream<T>;
  map<V>(this: void, fn: (value: T) => V): Stream<V>;
  wait(this: void, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<T>;
}

export type Port<TSend, TReceive = TSend> = {
  send: (message: TSend) => void;
  receive: Stream<TReceive>;
  connect: <OtherSend, OtherReceive extends TSend>(
    other: Port<OtherSend, OtherReceive>,
  ) => Unsubscribe;
};

export type DuplexChannel<Tx, Rx = Tx> = {
  x: Port<Tx, Rx>;
  y: Port<Rx, Tx>;
};

export type FrpBus<T> = {
  stream: Stream<T>;
  emit: (value: T) => void;
};

export const createStream = <T>(): FrpBus<T> => {
  const observers: Observer<T>[] = [];
  const stream = ((observer: Observer<T>): Unsubscribe => {
    observers.push(observer);
    return () => {
      const index = observers.indexOf(observer);
      if (index >= 0) observers.splice(index, 1);
    };
  }) as Stream<T>;

  stream.unsubscribeAll = () => {
    observers.length = 0;
  };
  stream.filter = (predicate) => {
    const next = createStream<T>();
    stream((value) => {
      if (predicate(value)) next.emit(value);
    });
    return next.stream;
  };
  stream.map = <V>(mapValue: (value: T) => V) => {
    const next = createStream<V>();
    stream((value) => next.emit(mapValue(value)));
    return next.stream;
  };
  stream.wait = (options = {}) => new Promise<T>((resolve, reject) => {
    if (options.signal?.aborted) {
      const error = new Error("Aborted");
      error.name = "AbortError";
      reject(error);
      return;
    }

    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe: Unsubscribe = () => undefined;
    const finish = (error?: Error, value?: T) => {
      if (done) return;
      done = true;
      unsubscribe();
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(value as T);
    };
    const onAbort = () => {
      const error = new Error("Aborted");
      error.name = "AbortError";
      finish(error);
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.timeoutMs !== undefined) {
      timer = setTimeout(
        () => finish(new Error(`Timeout after ${options.timeoutMs}ms`)),
        options.timeoutMs,
      );
    }
    unsubscribe = stream((value) => finish(undefined, value));
  });

  const emit = (value: T) => {
    [...observers].forEach((observer) => void observer(value));
  };
  return { stream, emit };
};

const connectChannels = <Tx, Rx, OtherTx, OtherRx>(
  first: Port<Tx, Rx>,
  second: Port<OtherTx, OtherRx>,
): Unsubscribe => {
  const unsubscribeFirst = first.receive((message) => second.send(message as unknown as OtherTx));
  const unsubscribeSecond = second.receive((message) => first.send(message as unknown as Tx));
  return () => {
    unsubscribeFirst();
    unsubscribeSecond();
  };
};

const makePort = <Tx, Rx>(send: (message: Tx) => void, receive: Stream<Rx>): Port<Tx, Rx> => {
  const port: Port<Tx, Rx> = {
    send,
    receive,
    connect: <OtherTx, OtherRx extends Tx>(other: Port<OtherTx, OtherRx>) =>
      connectChannels(port, other),
  };
  return port;
};

export const createDuplexChannel = <Tx, Rx = Tx>(): DuplexChannel<Tx, Rx> => {
  const outgoing = createStream<Tx>();
  const incoming = createStream<Rx>();
  return {
    x: makePort(outgoing.emit, incoming.stream),
    y: makePort(incoming.emit, outgoing.stream),
  };
};
