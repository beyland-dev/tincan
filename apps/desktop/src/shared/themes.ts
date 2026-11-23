/** A named colour theme. "system", "light" and "dark" are the plain Tincan colours. */
export interface ThemeInfo {
  id: string;
  label: string;
  scheme: "light" | "dark";
  /** Window background before the page paints, and the settings swatch. */
  bg: string;
  accent: string;
  /** A second accent, blended into the swatch with the accent and background. */
  accent2: string;
}

/** Color palettes for the built-in themes; full CSS variables live in renderer/styles.css. */
export const NAMED_THEMES = [
  {
    id: "periwinkle",
    label: "Periwinkle",
    scheme: "light",
    bg: "#e9e8fb",
    accent: "#4b2a9a",
    accent2: "#8f7cf0",
  },
  {
    id: "fog",
    label: "Fog",
    scheme: "light",
    bg: "#eeeff1",
    accent: "#5d6675",
    accent2: "#a3b1c6",
  },
  {
    id: "sand",
    label: "Sand",
    scheme: "light",
    bg: "#f6f3ee",
    accent: "#b9542f",
    accent2: "#e3a46b",
  },
  {
    id: "mint",
    label: "Mint",
    scheme: "light",
    bg: "#f2f7f5",
    accent: "#0d8571",
    accent2: "#5cc9a7",
  },
  {
    id: "orchid",
    label: "Orchid",
    scheme: "light",
    bg: "#faf5fa",
    accent: "#b0397f",
    accent2: "#e48fc0",
  },
  {
    id: "sky",
    label: "Sky",
    scheme: "light",
    bg: "#f2f7ff",
    accent: "#0a6cff",
    accent2: "#6fb7ff",
  },
  {
    id: "coral",
    label: "Coral",
    scheme: "light",
    bg: "#fff6f2",
    accent: "#d4381c",
    accent2: "#ff8a5c",
  },
  {
    id: "graphite",
    label: "Graphite",
    scheme: "dark",
    bg: "#161616",
    accent: "#ededed",
    accent2: "#8a8a8a",
  },
  {
    id: "slate",
    label: "Slate",
    scheme: "dark",
    bg: "#1b1e24",
    accent: "#9fb0c8",
    accent2: "#5c6f8c",
  },
  {
    id: "forest",
    label: "Forest",
    scheme: "dark",
    bg: "#0f1712",
    accent: "#5fd18b",
    accent2: "#2f7d50",
  },
  {
    id: "midnight",
    label: "Midnight",
    scheme: "dark",
    bg: "#0d1220",
    accent: "#6ea8ff",
    accent2: "#3b4fd1",
  },
  {
    id: "plum",
    label: "Plum",
    scheme: "dark",
    bg: "#171219",
    accent: "#e879b9",
    accent2: "#8e3d8f",
  },
  {
    id: "ocean",
    label: "Ocean",
    scheme: "dark",
    bg: "#06222b",
    accent: "#2fd4c7",
    accent2: "#1b7f9e",
  },
  {
    id: "ember",
    label: "Ember",
    scheme: "dark",
    bg: "#1a100c",
    accent: "#ff7a3d",
    accent2: "#c2341b",
  },
  {
    id: "contrast-light",
    label: "Contrast Light",
    scheme: "light",
    bg: "#ffffff",
    accent: "#0000cc",
    accent2: "#6a6aff",
  },
  {
    id: "contrast-dark",
    label: "Contrast Dark",
    scheme: "dark",
    bg: "#000000",
    accent: "#3ff0ff",
    accent2: "#00a3b5",
  },
] as const satisfies readonly ThemeInfo[];

/** Swatches for the plain Tincan themes, in the same shape as the named ones. */
export const PLAIN_THEMES = [
  {
    id: "light",
    label: "Light",
    scheme: "light",
    bg: "#ffffff",
    accent: "#0a84ff",
    accent2: "#64d2ff",
  },
  {
    id: "dark",
    label: "Dark",
    scheme: "dark",
    bg: "#1c1c1e",
    accent: "#0a84ff",
    accent2: "#5e5ce6",
  },
] as const satisfies readonly ThemeInfo[];

export const THEMES = ["system", "light", "dark", ...NAMED_THEMES.map((t) => t.id)] as const;
export type Theme = "system" | "light" | "dark" | (typeof NAMED_THEMES)[number]["id"];

export function namedTheme(theme: Theme): ThemeInfo | undefined {
  return NAMED_THEMES.find((t) => t.id === theme);
}

/** What Electron's nativeTheme.themeSource should be for a theme. */
export function schemeOf(theme: Theme): "system" | "light" | "dark" {
  if (theme === "system" || theme === "light" || theme === "dark") return theme;
  return namedTheme(theme)?.scheme ?? "system";
}
