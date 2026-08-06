/**
 * Theme: turning drawing *intent* into paint.
 *
 * `StrokeStyle` carries `tone`, `ink` and `pressureProfile` -- semantic choices
 * the planner makes without knowing what a colour is. Resolving them is the
 * renderer's job and it happens here, once, so every backend paints the same
 * diagram the same way.
 *
 * `tone` is an open string (the agent may invent one, AD-5). An unknown tone that
 * looks like a CSS colour is passed through; anything else falls back to the
 * default rather than failing, because a diagram drawn in the wrong colour is
 * still a diagram and a diagram that refused to render is not.
 */
import type { StrokeStyle } from "@sketchmind/shared-types";

export interface RendererTheme {
  readonly background: string;
  readonly tones: Readonly<Record<string, string>>;
  readonly defaultTone: string;
  readonly fontFamily: string;
  readonly fontSizePx: number;
  /** Per-ink opacity and width multiplier -- chalk is soft and fat, pen is neither. */
  readonly inkOpacity: Readonly<Record<StrokeStyle["ink"], number>>;
  readonly inkWidthScale: Readonly<Record<StrokeStyle["ink"], number>>;
}

export const DEFAULT_THEME: RendererTheme = {
  background: "#ffffff",
  tones: {
    default: "#1f2933",
    ink: "#1f2933",
    muted: "#7b8794",
    accent: "#2f6feb",
    highlight: "#e8a33d",
    warning: "#d97706",
    danger: "#c0392b",
    success: "#1f9d55",
  },
  defaultTone: "default",
  fontFamily: "Inter, Segoe UI, system-ui, sans-serif",
  fontSizePx: 13,
  inkOpacity: { pen: 1, pencil: 0.78, marker: 0.9, chalk: 0.82 },
  inkWidthScale: { pen: 1, pencil: 0.85, marker: 1.9, chalk: 1.5 },
};

export function mergeTheme(overrides?: Partial<RendererTheme>): RendererTheme {
  if (!overrides) return DEFAULT_THEME;
  return {
    ...DEFAULT_THEME,
    ...overrides,
    tones: { ...DEFAULT_THEME.tones, ...(overrides.tones ?? {}) },
    inkOpacity: { ...DEFAULT_THEME.inkOpacity, ...(overrides.inkOpacity ?? {}) },
    inkWidthScale: { ...DEFAULT_THEME.inkWidthScale, ...(overrides.inkWidthScale ?? {}) },
  };
}

const CSS_COLOUR = /^(#[0-9a-f]{3,8}|rgba?\(|hsla?\()/i;

export function resolveTone(tone: string | undefined, theme: RendererTheme): string {
  if (tone === undefined) return theme.tones[theme.defaultTone] ?? DEFAULT_THEME.tones["default"]!;
  const named = theme.tones[tone];
  if (named !== undefined) return named;
  if (CSS_COLOUR.test(tone)) return tone;
  return theme.tones[theme.defaultTone] ?? DEFAULT_THEME.tones["default"]!;
}

export type LineCap = "butt" | "round" | "square";

/**
 * `pressureProfile` describes a width that varies along the path, which a single
 * polyline primitive cannot express on either backend. Rendering it as a line cap
 * is an honest approximation -- a tapered stroke reads as rounded at its ends --
 * and it is recorded here rather than buried in a backend so that a future
 * variable-width path implementation has one place to replace.
 */
export function capForPressure(profile: StrokeStyle["pressureProfile"]): LineCap {
  return profile === "uniform" ? "butt" : "round";
}
