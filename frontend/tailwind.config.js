/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: ["class", '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        bg: "rgb(var(--bg) / <alpha-value>)",
        panel: "rgb(var(--panel) / <alpha-value>)",
        subtle: "rgb(var(--subtle) / <alpha-value>)",
        line: "rgb(var(--line) / <alpha-value>)",
        ink: "rgb(var(--ink) / <alpha-value>)",
        muted: "rgb(var(--muted) / <alpha-value>)",
        faint: "rgb(var(--faint) / <alpha-value>)",
        accent: "rgb(var(--accent) / <alpha-value>)",
        "accent-soft": "rgb(var(--accent-soft) / <alpha-value>)",
        good: "rgb(var(--good) / <alpha-value>)",
        "good-soft": "rgb(var(--good-soft) / <alpha-value>)",
        bad: "rgb(var(--bad) / <alpha-value>)",
        "bad-soft": "rgb(var(--bad-soft) / <alpha-value>)",
        warn: "rgb(var(--warn) / <alpha-value>)",
        "warn-soft": "rgb(var(--warn-soft) / <alpha-value>)",
      },
      fontFamily: {
        sans: ['"Pretendard Variable"', "Pretendard", "-apple-system", "BlinkMacSystemFont", '"Apple SD Gothic Neo"', '"Malgun Gothic"', "sans-serif"],
        mono: ['"JetBrains Mono"', "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      borderRadius: { xl: "14px", "2xl": "18px" },
      boxShadow: { soft: "0 1px 2px rgb(16 24 40 / 0.04), 0 1px 3px rgb(16 24 40 / 0.06)" },
    },
  },
  plugins: [],
};
