export interface AppColors {
  background: string;
  surface: string;
  surfaceElevated: string;
  surfaceMuted: string;
  text: string;
  muted: string;
  subtle: string;
  border: string;
  borderStrong: string;
  accent: string;
  accentHover: string;
  accentSoft: string;
  onAccent: string;
  danger: string;
  dangerHover: string;
  dangerSoft: string;
  warning: string;
  warningSoft: string;
  success: string;
  successSoft: string;
  focus: string;
  overlay: string;
}

// ds-allow-hardcode:start -- semantic token definitions are the raw color source.
export const lightColors: AppColors = {
  background: "#f6f6f8",
  surface: "#ffffff",
  surfaceElevated: "#ffffff",
  surfaceMuted: "#eeeef2",
  text: "#18181d",
  muted: "#5c5d68",
  subtle: "#6d6f7b",
  border: "#dedee5",
  borderStrong: "#b8bac5",
  accent: "#5655c6",
  accentHover: "#4443ad",
  accentSoft: "#e8e8fb",
  onAccent: "#ffffff",
  danger: "#b4232d",
  dangerHover: "#941b24",
  dangerSoft: "#fbe9eb",
  warning: "#815500",
  warningSoft: "#fff3d6",
  success: "#18794e",
  successSoft: "#e3f5ec",
  focus: "#6b6af0",
  overlay: "rgba(15, 15, 20, 0.62)",
};

export const darkColors: AppColors = {
  background: "#0d0e12",
  surface: "#15161b",
  surfaceElevated: "#1b1d24",
  surfaceMuted: "#22242c",
  text: "#f4f4f6",
  muted: "#b4b5bf",
  subtle: "#92949f",
  border: "#2d3039",
  borderStrong: "#4b4f5c",
  accent: "#8a8cf6",
  accentHover: "#a5a7ff",
  accentSoft: "#292b50",
  onAccent: "#11121a",
  danger: "#ff9ba4",
  dangerHover: "#ffb4ba",
  dangerSoft: "#3d2026",
  warning: "#f1c56b",
  warningSoft: "#392f1c",
  success: "#66d6a3",
  successSoft: "#18382b",
  focus: "#a9aaff",
  overlay: "rgba(0, 0, 0, 0.76)",
};
// ds-allow-hardcode:end

export const space = {
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  "2xl": 24,
  "3xl": 32,
  "4xl": 40,
  "5xl": 48,
  "6xl": 64,
} as const;

export const radius = {
  sm: 6,
  md: 10,
  lg: 14,
  xl: 20,
  pill: 999,
} as const;

export const size = {
  controlSm: 36,
  controlMd: 44,
  controlLg: 52,
  navigationWide: 244,
  contentMax: 960,
  readable: 680,
} as const;

export const type = {
  family: "system-ui",
  displayLarge: 48,
  display: 40,
  heading: 28,
  title: 18,
  body: 15,
  label: 13,
  caption: 12,
  displayLargeLine: 52,
  displayLine: 44,
  headingLine: 34,
  bodyLine: 23,
  captionLine: 18,
} as const;

export const motion = {
  fast: 120,
  normal: 180,
} as const;
