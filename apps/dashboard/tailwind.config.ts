// @license All Rights Reserved (see apps/dashboard/LICENSE)
import type { Config } from "tailwindcss";
import animate from "tailwindcss-animate";

const config: Config = {
  darkMode: "class",
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
    // Tremor primitives ship their own Tailwind classes; if Tremor classes
    // are not in the content list Tailwind purges them in production. The
    // chart-tinting color tokens (`tremor-brand`, `dark-tremor-content`,
    // etc.) are added in Phase 12.2 when the first chart actually renders;
    // until then Tremor falls back to its built-in Tailwind palette which
    // is sufficient for the empty shell shipped in 12.1.
    "./node_modules/@tremor/**/*.{js,ts,jsx,tsx}",
  ],
  // Tremor v3 chart components compute color classnames at render time
  // (e.g., `colors={["blue"]}` resolves to `fill-blue-500` / `stroke-blue-500`
  // / `text-blue-500` inside the SVG); without these in the safelist
  // production builds purge them and the chart renders without color. The
  // patterns mirror Tremor's official Next.js install guide so any color
  // name the chart props accept stays available. Variants are kept narrow
  // (hover only where Tremor uses it) to avoid bloating the production
  // CSS with unused state combinations.
  safelist: [
    {
      pattern:
        /^(bg-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(?:50|100|200|300|400|500|600|700|800|900|950))$/,
      variants: ["hover", "ui-selected"],
    },
    {
      pattern:
        /^(text-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(?:50|100|200|300|400|500|600|700|800|900|950))$/,
      variants: ["hover", "ui-selected"],
    },
    {
      pattern:
        /^(border-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(?:50|100|200|300|400|500|600|700|800|900|950))$/,
      variants: ["hover", "ui-selected"],
    },
    {
      pattern:
        /^(ring-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(?:50|100|200|300|400|500|600|700|800|900|950))$/,
    },
    {
      pattern:
        /^(stroke-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(?:50|100|200|300|400|500|600|700|800|900|950))$/,
    },
    {
      pattern:
        /^(fill-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(?:50|100|200|300|400|500|600|700|800|900|950))$/,
    },
  ],
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: {
        "2xl": "1400px",
      },
    },
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        // Tremor v3 chart text + axis line tokens. Resolved against the
        // CSS variables in `app/globals.css`; keeping them in lockstep
        // with shadcn's theme variables means a future tweak to the
        // dashboard's foreground / muted tones flows through to chart
        // text without a second edit. The light + dark variants both
        // resolve through the same Tailwind classnames; `next-themes`
        // toggles `.dark` on the html element and the variables flip.
        tremor: {
          brand: {
            faint: "hsl(var(--tremor-brand-faint))",
            muted: "hsl(var(--tremor-brand-muted))",
            subtle: "hsl(var(--tremor-brand-subtle))",
            DEFAULT: "hsl(var(--tremor-brand))",
            emphasis: "hsl(var(--tremor-brand-emphasis))",
            inverted: "hsl(var(--tremor-brand-inverted))",
          },
          background: {
            muted: "hsl(var(--tremor-background-muted))",
            subtle: "hsl(var(--tremor-background-subtle))",
            DEFAULT: "hsl(var(--tremor-background))",
            emphasis: "hsl(var(--tremor-background-emphasis))",
          },
          border: { DEFAULT: "hsl(var(--tremor-border))" },
          ring: { DEFAULT: "hsl(var(--tremor-ring))" },
          content: {
            subtle: "hsl(var(--tremor-content-subtle))",
            DEFAULT: "hsl(var(--tremor-content))",
            emphasis: "hsl(var(--tremor-content-emphasis))",
            strong: "hsl(var(--tremor-content-strong))",
            inverted: "hsl(var(--tremor-content-inverted))",
          },
        },
        "dark-tremor": {
          brand: {
            faint: "hsl(var(--tremor-brand-faint))",
            muted: "hsl(var(--tremor-brand-muted))",
            subtle: "hsl(var(--tremor-brand-subtle))",
            DEFAULT: "hsl(var(--tremor-brand))",
            emphasis: "hsl(var(--tremor-brand-emphasis))",
            inverted: "hsl(var(--tremor-brand-inverted))",
          },
          background: {
            muted: "hsl(var(--tremor-background-muted))",
            subtle: "hsl(var(--tremor-background-subtle))",
            DEFAULT: "hsl(var(--tremor-background))",
            emphasis: "hsl(var(--tremor-background-emphasis))",
          },
          border: { DEFAULT: "hsl(var(--tremor-border))" },
          ring: { DEFAULT: "hsl(var(--tremor-ring))" },
          content: {
            subtle: "hsl(var(--tremor-content-subtle))",
            DEFAULT: "hsl(var(--tremor-content))",
            emphasis: "hsl(var(--tremor-content-emphasis))",
            strong: "hsl(var(--tremor-content-strong))",
            inverted: "hsl(var(--tremor-content-inverted))",
          },
        },
      },
      // Tremor v3 also expects font-size, box-shadow, and border-radius
      // tokens for tooltip + legend chrome. The values mirror Tremor's
      // defaults so we get the chart's intended look without re-tuning.
      fontSize: {
        "tremor-label": ["0.75rem", { lineHeight: "1rem" }],
        "tremor-default": ["0.875rem", { lineHeight: "1.25rem" }],
        "tremor-title": ["1.125rem", { lineHeight: "1.75rem" }],
        "tremor-metric": ["1.875rem", { lineHeight: "2.25rem" }],
      },
      boxShadow: {
        "tremor-input": "0 1px 2px 0 rgb(0 0 0 / 0.05)",
        "tremor-card": "0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)",
        "tremor-dropdown": "0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)",
        "dark-tremor-input": "0 1px 2px 0 rgb(0 0 0 / 0.05)",
        "dark-tremor-card": "0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)",
        "dark-tremor-dropdown": "0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)",
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
        "tremor-small": "0.375rem",
        "tremor-default": "0.5rem",
        "tremor-full": "9999px",
      },
    },
  },
  plugins: [animate],
};

export default config;
