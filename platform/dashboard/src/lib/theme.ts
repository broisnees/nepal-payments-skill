// Light, dark, or follow the system. The CSS follows prefers-color-scheme on its own; a saved choice sets data-theme.
import { useSyncExternalStore } from "react";

export type ThemeChoice = "light" | "dark" | "system";
const KEY = "paynp-theme";
const subs = new Set<() => void>();
const mq = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;
mq?.addEventListener("change", () => subs.forEach((fn) => fn()));

export function getChoice(): ThemeChoice {
  try {
    const t = localStorage.getItem(KEY);
    if (t === "light" || t === "dark") return t;
  } catch {
    /* storage blocked */
  }
  return "system";
}

export function resolved(): "light" | "dark" {
  const c = getChoice();
  if (c !== "system") return c;
  return mq?.matches ? "dark" : "light";
}

export function setChoice(c: ThemeChoice) {
  try {
    if (c === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, c);
  } catch {
    /* storage blocked: still apply for this page */
  }
  if (c === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = c;
  subs.forEach((fn) => fn());
}

export function useTheme() {
  const choice = useSyncExternalStore(
    (fn) => {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    () => `${getChoice()}:${resolved()}`,
  );
  const [c, r] = choice.split(":") as [ThemeChoice, "light" | "dark"];
  return { choice: c, resolved: r };
}
