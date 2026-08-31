/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        /* semantic, theme-driven (see index.css :root / [data-theme="light"]) */
        fg: "var(--txt)",
        dim: "var(--txt-dim)",
        faint: "var(--txt-faint)",
        surface: "var(--panel)",
        surface2: "var(--panel-strong)",
        line: "var(--line)",
        linestrong: "var(--line-strong)",
        chrome: "var(--chrome)",
        scrim: "var(--scrim)",
        inset: "var(--inset)",
        accent: { DEFAULT: "rgb(var(--accent-rgb) / <alpha-value>)", strong: "rgb(var(--accent-strong-rgb) / <alpha-value>)", 2: "rgb(var(--accent-2-rgb) / <alpha-value>)", soft: "var(--accent-soft)" },
        ok: "rgb(var(--ok-rgb) / <alpha-value>)",
        warn: "rgb(var(--warn-rgb) / <alpha-value>)",
        bad: "rgb(var(--bad-rgb) / <alpha-value>)",
      },
      boxShadow: {
        card: "var(--shadow-card)",
        raise: "var(--shadow-raise)",
        modal: "var(--shadow-modal)",
        glow: "0 0 24px var(--accent-glow)",
      },
    },
  },
  plugins: [],
}
