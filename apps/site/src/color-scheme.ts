import { useSyncExternalStore } from "react";

type ColorScheme = "light" | "dark";

const query = "(prefers-color-scheme: dark)";

function subscribe(onChange: () => void) {
  const media = window.matchMedia(query);
  media.addEventListener("change", onChange);

  return () => media.removeEventListener("change", onChange);
}

function getSnapshot(): ColorScheme {
  return window.matchMedia(query).matches ? "dark" : "light";
}

function getServerSnapshot(): ColorScheme {
  return "light";
}

export function useColorScheme() {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
