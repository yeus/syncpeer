import polyfillStructuredClone from "@ungap/structured-clone";

export const installWebViewCompatibility = (scope: typeof globalThis): void => {
  const objectConstructor = scope.Object;
  const arrayConstructor = scope.Array;
  const promiseConstructor = scope.Promise;

  if (typeof scope.structuredClone !== "function") {
    scope.structuredClone = polyfillStructuredClone as typeof scope.structuredClone;
  }

  if (typeof objectConstructor.fromEntries !== "function") objectConstructor.defineProperty(
    objectConstructor,
    "fromEntries",
    {
      configurable: true,
      writable: true,
      value: <T>(entries: Iterable<readonly [PropertyKey, T]>) => {
        const result: Record<PropertyKey, T> = {};
        for (const entry of entries) {
          const pair = arrayConstructor.from(entry as ArrayLike<PropertyKey | T>);
          if (pair.length !== 2) throw new scope.TypeError("Iterator value is not an entry object.");
          result[pair[0] as PropertyKey] = pair[1] as T;
        }
        return result;
      },
    },
  );

  if (typeof scope.queueMicrotask !== "function") objectConstructor.defineProperty(scope, "queueMicrotask", {
    configurable: true,
    writable: true,
    value: (callback: () => void) => { void promiseConstructor.resolve().then(callback); },
  });

  const cryptoInstance = (scope as typeof globalThis & { crypto?: Crypto }).crypto;
  if (cryptoInstance && typeof cryptoInstance.randomUUID !== "function") {
    objectConstructor.defineProperty(cryptoInstance, "randomUUID", {
      configurable: true,
      writable: true,
      value: () => {
        const bytes = new Uint8Array(16);
        cryptoInstance.getRandomValues(bytes);
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        const hex = arrayConstructor.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      },
    });
  }

  if (typeof objectConstructor.hasOwn !== "function") objectConstructor.defineProperty(objectConstructor, "hasOwn", {
    configurable: true,
    writable: true,
    value: (value: object, key: PropertyKey) => objectConstructor.prototype.hasOwnProperty.call(value, key),
  });

  if (typeof arrayConstructor.prototype.at !== "function") objectConstructor.defineProperty(arrayConstructor.prototype, "at", {
    configurable: true,
    writable: true,
    value: function at<T>(this: readonly T[], index: number): T | undefined {
      const value = scope.Number(index);
      const relativeIndex = scope.Number.isNaN(value) ? 0 : scope.Math.trunc(value);
      const targetIndex = relativeIndex < 0 ? this.length + relativeIndex : relativeIndex;
      return targetIndex < 0 || targetIndex >= this.length ? undefined : this[targetIndex];
    },
  });

  if (typeof scope.String.prototype.replaceAll !== "function") objectConstructor.defineProperty(
    scope.String.prototype,
    "replaceAll",
    {
      configurable: true,
      writable: true,
      value: function replaceAll(this: string, search: string | RegExp, replacement: string): string {
        if (search instanceof scope.RegExp) {
          if (!search.global) throw new scope.TypeError("replaceAll requires a global regular expression.");
          return this.replace(search, replacement);
        }
        const escaped = scope.String(search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return this.replace(new scope.RegExp(escaped, "g"), replacement);
      },
    },
  );

  if (typeof scope.AggregateError !== "function") objectConstructor.defineProperty(scope, "AggregateError", {
    configurable: true,
    writable: true,
    value: class AggregateErrorPolyfill extends scope.Error {
      errors: unknown[];

      constructor(errors: Iterable<unknown>, message = "") {
        super(message);
        this.name = "AggregateError";
        this.errors = arrayConstructor.from(errors);
      }
    },
  });

  if (typeof promiseConstructor.allSettled !== "function") objectConstructor.defineProperty(
    promiseConstructor,
    "allSettled",
    {
      configurable: true,
      writable: true,
      value: <T>(values: Iterable<T | PromiseLike<T>>) => promiseConstructor.all(arrayConstructor.from(values, value =>
        promiseConstructor.resolve(value).then<PromiseSettledResult<T>, PromiseSettledResult<T>>(
          result => ({ status: "fulfilled", value: result }),
          reason => ({ status: "rejected", reason }),
        ))),
    },
  );

  if (typeof promiseConstructor.any !== "function") objectConstructor.defineProperty(promiseConstructor, "any", {
    configurable: true,
    writable: true,
    value: <T>(values: Iterable<T | PromiseLike<T>>) => new promiseConstructor<Awaited<T>>((resolve, reject) => {
      const candidates = arrayConstructor.from(values);
      const errors = new arrayConstructor<unknown>(candidates.length);
      let rejected = 0;
      if (candidates.length === 0) {
        reject(new scope.AggregateError(errors, "All promises were rejected."));
        return;
      }
      candidates.forEach((candidate, index) => promiseConstructor.resolve(candidate).then(resolve, error => {
        errors[index] = error;
        rejected += 1;
        if (rejected === candidates.length) {
          reject(new scope.AggregateError(errors, "All promises were rejected."));
        }
      }));
    }),
  });

  if (typeof scope.AbortSignal === "function" &&
    typeof scope.AbortSignal.prototype.throwIfAborted !== "function") objectConstructor.defineProperty(
    scope.AbortSignal.prototype,
    "throwIfAborted",
    {
      configurable: true,
      writable: true,
      value(this: AbortSignal) {
        if (!this.aborted) return;
        const reason = (this as AbortSignal & { reason?: unknown }).reason;
        if (reason !== undefined) throw reason;
        const error = new scope.Error("The operation was aborted.");
        error.name = "AbortError";
        throw error;
      },
    },
  );
};
