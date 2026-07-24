import type { Mock } from "bun:test";

import { jest } from "bun:test";

/**
 * Deep-proxy mock factory: `createMock<T>()` returns a
 * fully-typed mock of T where every method is lazily auto-created as a real
 * `jest.fn()` on first access — so `repo.findById.mockResolvedValue(x)` and
 * `expect(repo.save).toHaveBeenCalledWith(...)` both work with no casts.
 * Pass a partial to pre-wire behavior: its functions are wrapped in
 * `jest.fn(fn)`, so they run AND record their calls.
 */
type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends (infer U)[]
    ? DeepPartial<U>[]
    : T[P] extends readonly (infer U)[]
      ? readonly DeepPartial<U>[]
      : unknown extends T[P]
        ? T[P]
        : DeepPartial<T[P]>;
};

type PartialFuncReturn<T> = {
  [K in keyof T]?: T[K] extends (...args: infer A) => infer U
    ? (...args: A) => PartialFuncReturn<U>
    : DeepPartial<T[K]>;
};

type IsExactlyUnknown<T> = unknown extends T
  ? // biome-ignore lint/complexity/noBannedTypes: {} is intentional for conditional type distribution
    T extends {}
    ? false
    : true
  : false;

export type DeepMocked<T> = {
  [K in keyof T]: IsExactlyUnknown<T[K]> extends true
    ? // biome-ignore lint/suspicious/noExplicitAny: deep mock utility
      any
    : NonNullable<T[K]> extends (...args: infer A) => infer U
      ? Mock<(...args: A) => U> & ((...args: A) => DeepMocked<U>)
      : NonNullable<T[K]> extends object
        ? undefined extends T[K]
          ? DeepMocked<NonNullable<T[K]>> | undefined
          : DeepMocked<T[K]>
        : T[K];
} & T;

const createObjectProxy = <T extends object>(partial: T): T => {
  // biome-ignore lint/suspicious/noExplicitAny: deep mock utility
  const cache = new Map<string | number | symbol, any>();
  return new Proxy(partial, {
    get: (obj, prop) => {
      // Guards: never look like a thenable or a custom-inspectable, so mocks
      // are safe to await-adjacent code and to expect() matchers.
      if (
        prop === "inspect" ||
        prop === "then" ||
        prop === "asymmetricMatch" ||
        (typeof prop === "symbol" &&
          prop.toString() === "Symbol(util.inspect.custom)")
      ) {
        return;
      }

      if (cache.has(prop)) {
        return cache.get(prop);
      }

      // biome-ignore lint/suspicious/noExplicitAny: deep mock utility
      let value: any;

      if (prop in obj) {
        const existing = Reflect.get(obj, prop);
        if (typeof existing === "function") {
          // biome-ignore lint/suspicious/noExplicitAny: deep mock utility
          value = jest.fn(existing as (...args: any[]) => any);
        } else if (typeof existing === "object" && existing !== null) {
          value = createObjectProxy(existing);
        } else {
          value = existing;
        }
      } else if (prop === "constructor") {
        value = () => undefined;
      } else {
        // Auto-create jest.fn() for unknown properties (methods on the mocked
        // interface). A real jest.fn() — not a Proxy — so expect matchers work.
        value = jest.fn();
      }

      cache.set(prop, value);
      return value;
    },
    set: (_obj, prop, newValue) => {
      cache.set(prop, newValue);
      return true;
    },
  });
};

export const createMock = <T extends object>(
  partial: PartialFuncReturn<T> = {},
): DeepMocked<T> => createObjectProxy(partial as T) as DeepMocked<T>;
