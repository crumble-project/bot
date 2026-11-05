import { useEffect, useSyncExternalStore } from "react";
import { THEMES, type Theme } from "@crumble/server/contract/user-preferences";
import { authClient } from "@/lib/auth-client";

/** Also read by the inline script in index.html, which applies the theme before first paint. */
const STORAGE_KEY = "crumble-theme";

/** The page background per scheme, for the browser chrome; matches --background in styles.css. */
const THEME_COLOR = { light: "#f9fafb", dark: "#07080a" };

const systemDark = matchMedia("(prefers-color-scheme: dark)");
const listeners = new Set<() => void>();

const isTheme = (value: unknown): value is Theme =>
  THEMES.some((theme) => theme === value);

function stored(): Theme {
  const value = localStorage.getItem(STORAGE_KEY);

  return isTheme(value) ? value : "system";
}

let current = stored();

export const isDark = () =>
  current === "dark" || (current === "system" && systemDark.matches);

export function setThemeColor(color = THEME_COLOR) {
  for (const meta of document.querySelectorAll<HTMLMetaElement>(
    'meta[name="theme-color"]',
  ))
    meta.content = isDark() ? color.dark : color.light;
}

function apply() {
  const dark = isDark();
  const root = document.documentElement;

  root.classList.toggle("dark", dark);
  root.style.colorScheme = dark ? "dark" : "light";

  setThemeColor();
  listeners.forEach((listener) => listener());
}

function adopt(theme: Theme) {
  if (theme === current) return;

  current = theme;
  localStorage.setItem(STORAGE_KEY, theme);
  apply();
}

systemDark.addEventListener("change", () => {
  if (current === "system") apply();
});

apply();

function subscribe(listener: () => void) {
  listeners.add(listener);

  return () => listeners.delete(listener);
}

export const useTheme = () => useSyncExternalStore(subscribe, () => current);

export async function setTheme(theme: Theme) {
  adopt(theme);
  await authClient.updateUser({ theme });
}

/** Takes the account's theme once the session loads, since another device may have changed it. */
export function useAccountTheme() {
  const session = authClient.useSession();
  const theme = session.data?.user.theme;

  useEffect(() => {
    if (isTheme(theme)) adopt(theme);
  }, [theme]);
}
