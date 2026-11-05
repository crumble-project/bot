import { Semaphore } from "effect";

export const keyedListeners = () => {
  const listeners = new Map<string, Set<() => void>>();

  return {
    add: (key: string, callback: () => void) => {
      const set = listeners.get(key) ?? new Set();
      set.add(callback);
      listeners.set(key, set);

      return () => {
        set.delete(callback);

        if (!set.size) listeners.delete(key);
      };
    },
    notify: (key: string) => {
      for (const listener of listeners.get(key) ?? []) listener();
    },
  };
};

export const keyedLocks = () => {
  const locks = new Map<string, Semaphore.Semaphore>();

  return (key: string) => {
    const lock = locks.get(key) ?? Semaphore.makeUnsafe(1);
    locks.set(key, lock);

    return lock;
  };
};
