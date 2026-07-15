/**
 * Resolve `factory()` but never wait longer than `ms` and never reject: on
 * timeout (and on any rejection) resolve with `fallback`. Used to time-box
 * best-effort context retrievers so one slow dependency can't stall a turn.
 */
export function withBudget<T>(factory: () => Promise<T>, ms: number, fallback: T, onTimeout?: () => void): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    const finish = (value: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      onTimeout?.();
      resolve(fallback);
    }, ms);
    timer.unref?.();
    factory().then(finish, () => finish(fallback));
  });
}
