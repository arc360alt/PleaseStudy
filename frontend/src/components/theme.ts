import { useEffect, useState } from "react";
import { store } from "../api";

export type Theme = "system" | "light" | "dark";
const KEY = "ps_theme";

export function applyTheme(t: Theme) {
  const root = document.documentElement;
  if (t === "system") delete root.dataset.theme;
  else root.dataset.theme = t;
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => (store.get(KEY) as Theme) || "system");
  useEffect(() => {
    applyTheme(theme);
    store.set(KEY, theme === "system" ? null : theme);
  }, [theme]);
  return [theme, setTheme] as const;
}
