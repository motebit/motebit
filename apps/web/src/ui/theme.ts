export type ThemePreference = "light" | "dark" | "system";

const THEME_KEY = "motebit-theme";

let currentPreference: ThemePreference = "system";
let mediaQuery: MediaQueryList | null = null;

function getEffectiveTheme(pref: ThemePreference): "light" | "dark" {
  if (pref === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return pref;
}

let onChangeCallback: ((effective: "light" | "dark") => void) | null = null;

function applyTheme(pref: ThemePreference): void {
  const effective = getEffectiveTheme(pref);
  if (effective === "dark") {
    document.documentElement.dataset.theme = "dark";
  } else {
    delete document.documentElement.dataset.theme;
  }
  if (onChangeCallback) onChangeCallback(effective);
}

function updateToggleUI(): void {
  document.querySelectorAll("#theme-toggle-group .theme-option").forEach((btn) => {
    const val = (btn as HTMLElement).dataset.theme;
    const selected = val === currentPreference;
    btn.classList.toggle("selected", selected);
    btn.setAttribute("aria-checked", String(selected));
  });
}

function persist(pref: ThemePreference, isTauri: boolean, invoke?: unknown): void {
  try {
    localStorage.setItem(THEME_KEY, pref);
  } catch {
    // localStorage unavailable
  }

  if (isTauri && invoke != null) {
    const invokeFn = invoke as (cmd: string, args: Record<string, unknown>) => Promise<string>;
    void invokeFn("read_config", {})
      .then((raw: string) => {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        parsed.theme = pref;
        return invokeFn("write_config", { json: JSON.stringify(parsed) });
      })
      .catch(() => {
        /* Non-fatal */
      });
  }
}

export interface ThemeAPI {
  getPreference(): ThemePreference;
  setPreference(pref: ThemePreference): void;
}

export function initTheme(
  isTauri: boolean,
  invoke?: unknown,
  onChange?: (effective: "light" | "dark") => void,
): ThemeAPI {
  onChangeCallback = onChange ?? null;

  // Only restore a persisted preference if the user explicitly chose one before
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === "light" || stored === "dark" || stored === "system") {
      currentPreference = stored;
    }
  } catch {
    // localStorage unavailable
  }

  // Apply immediately — "system" follows OS, explicit choice overrides
  applyTheme(currentPreference);
  updateToggleUI();

  // Listen for OS preference changes (for "system" mode)
  mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
  const onMediaChange = (): void => {
    if (currentPreference === "system") {
      applyTheme("system");
    }
  };
  mediaQuery.addEventListener("change", onMediaChange);

  // Wire up toggle buttons — only persist on explicit user action
  document.querySelectorAll("#theme-toggle-group .theme-option").forEach((btn) => {
    btn.addEventListener("click", () => {
      const pref = (btn as HTMLElement).dataset.theme as ThemePreference;
      if (pref) {
        currentPreference = pref;

        applyTheme(pref);
        updateToggleUI();
        persist(pref, isTauri, invoke);
      }
    });
  });

  return {
    getPreference() {
      return currentPreference;
    },
    setPreference(pref: ThemePreference) {
      currentPreference = pref;

      applyTheme(pref);
      updateToggleUI();
      persist(pref, isTauri, invoke);
    },
  };
}
