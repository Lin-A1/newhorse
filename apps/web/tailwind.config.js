/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: ["selector", '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        // semantic tokens — values live in index.css (:root dark / [data-theme="light"])
        bg: "var(--bg)",
        bg2: "var(--bg2)",
        panel: "var(--panel)",
        side: "var(--sidebar)",
        card: "var(--card)",
        line: "var(--line)",
        linestrong: "var(--line-strong)",
        fg: "var(--txt)",
        dim: "var(--txt-dim)",
        faint: "var(--txt-faint)",
        ghost: "var(--txt-ghost)",
        accent: "var(--accent)",
        accentstrong: "var(--accent-strong)",
        ok: "var(--ok)",
        warn: "var(--warn)",
        bad: "var(--bad)",
        trajuser: "var(--traj-user)",
        trajassistant: "var(--traj-assistant)",
        trajreasoning: "var(--traj-reasoning)",
        trajtool: "var(--traj-tool)",
        trajresult: "var(--traj-tool-result)",
      },
      fontFamily: {
        sans: "var(--font-sans)",
        mono: "var(--font-mono)",
      },
      fontSize: {
        "2xs": ["0.6875rem", "1rem"], // 11px — dense meta rows
        xs: ["0.75rem", "1.1rem"], // 12px
        sm: ["0.8125rem", "1.25rem"], // 13px
        base: ["0.875rem", "1.5rem"], // 14px — UI base (ZCode --ui-font-size)
      },
      borderRadius: {
        sm: "0.25rem",
        DEFAULT: "0.375rem",
        lg: "0.5rem",
        xl: "0.75rem",
      },
    },
  },
  plugins: [],
}
