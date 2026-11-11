import { Semaphore } from "effect";

/** Callbacks by key; `notify` hands its value to every callback added under the key. */
export const keyedListeners = <T = void>() => {
  const listeners = new Map<string, Set<(value: T) => void>>();

  return {
    add: (key: string, callback: (value: T) => void) => {
      const set = listeners.get(key) ?? new Set();
      set.add(callback);
      listeners.set(key, set);

      return () => {
        set.delete(callback);

        if (!set.size) listeners.delete(key);
      };
    },
    notify: (key: string, value: T) => {
      for (const listener of listeners.get(key) ?? []) listener(value);
    },
  };
};

export type KeyedListeners<T = void> = ReturnType<typeof keyedListeners<T>>;

export const keyedLocks = () => {
  const locks = new Map<string, Semaphore.Semaphore>();

  return (key: string) => {
    const lock = locks.get(key) ?? Semaphore.makeUnsafe(1);
    locks.set(key, lock);

    return lock;
  };
};
