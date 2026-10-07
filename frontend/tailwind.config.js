/** @type {import('tailwindcss').Config} */
const v = (name) => `rgb(var(--${name}) / <alpha-value>)`;
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: ["class"],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Inter Variable"', "system-ui", "sans-serif"],
        mono: ['"JetBrains Mono Variable"', "ui-monospace", "monospace"],
      },
      colors: {
        bg: v("bg"),
        surface: v("surface"),
        raised: v("raised"),
        line: v("line"),
        ink: v("ink"),
        ink2: v("ink2"),
        muted: v("muted"),
        accent: v("accent"),
        "accent-ink": v("accent-ink"),
        pos: v("pos"),
        neg: v("neg"),
        warn: v("warn"),
      },
      borderRadius: { xl: "14px", "2xl": "18px" },
      boxShadow: {
        card: "0 1px 0 rgb(var(--line) / 0.6), 0 8px 24px -12px rgb(0 0 0 / 0.25)",
      },
    },
  },
  plugins: [],
};
