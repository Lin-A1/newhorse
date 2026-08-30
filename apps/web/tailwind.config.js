/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        ink: { 950: "#0b0f19", 900: "#101623", 800: "#161e30", 700: "#1e2941", 600: "#2a3653" },
        accent: { DEFAULT: "#6d8bff", soft: "#8ea5ff" },
      },
      boxShadow: { card: "0 1px 0 rgba(255,255,255,.04) inset, 0 8px 24px rgba(0,0,0,.35)" },
    },
  },
  plugins: [],
}
