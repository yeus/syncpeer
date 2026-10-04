import polyfillStructuredClone from "@ungap/structured-clone";

export const installWebViewCompatibility = (scope: typeof globalThis): void => {
  const objectConstructor = scope.Object;
  const arrayConstructor = scope.Array;
  const promiseConstructor = scope.Promise;

  if (typeof scope.structuredClone !== "function") {
    scope.structuredClone = polyfillStructuredClone as typeof scope.structuredClone;
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
