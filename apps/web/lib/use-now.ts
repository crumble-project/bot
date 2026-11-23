import { useEffect, useState } from "react";

const DEFAULT_INTERVAL_MS = 30_000;

// Refresh long-lived labels and catch up after sleep without reading time during render.
export function useNow(intervalMs: number = DEFAULT_INTERVAL_MS) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const refresh = () => setNow(Date.now());
    const timer = setInterval(refresh, intervalMs);

    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);

    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [intervalMs]);

  return now;
}
