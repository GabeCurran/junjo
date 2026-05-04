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
    // Tremor uses these tokenized classes for chart chrome (axis text,
    // gridlines, tooltip backdrop, etc.). Tailwind's content scan
    // sometimes misses them inside Tremor's compiled JS (template
    // literals, conditional concat), so they're force-listed here to
    // guarantee the utility CSS rule exists in the compiled bundle.
    "text-tremor-content",
    "text-tremor-content-subtle",
    "text-tremor-content-emphasis",
    "text-tremor-content-strong",
    "text-tremor-content-inverted",
    "text-dark-tremor-content",
    "text-dark-tremor-content-subtle",
    "text-dark-tremor-content-emphasis",
    "text-dark-tremor-content-strong",
    "text-dark-tremor-content-inverted",
    "fill-tremor-content",
    "fill-tremor-content-subtle",
    "fill-tremor-content-emphasis",
    "fill-tremor-content-strong",
    "fill-dark-tremor-content",
    "fill-dark-tremor-content-subtle",
    "fill-dark-tremor-content-emphasis",
    "fill-dark-tremor-content-strong",
    "stroke-tremor-border",
    "stroke-dark-tremor-border",
    "bg-tremor-background",
    "bg-tremor-background-subtle",
    "bg-tremor-background-muted",
    "bg-dark-tremor-background",
    "bg-dark-tremor-background-subtle",
    "bg-dark-tremor-background-muted",
    {
      pattern:
        /^(bg-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|coral)-(?:50|100|200|300|400|500|600|700|800|900|950))$/,
      variants: ["hover", "ui-selected"],
    },
    {
      pattern:
        /^(text-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|coral)-(?:50|100|200|300|400|500|600|700|800|900|950))$/,
      variants: ["hover", "ui-selected"],
    },
    {
      pattern:
        /^(border-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|coral)-(?:50|100|200|300|400|500|600|700|800|900|950))$/,
      variants: ["hover", "ui-selected"],
    },
    {
      pattern:
        /^(ring-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|coral)-(?:50|100|200|300|400|500|600|700|800|900|950))$/,
    },
    {
      pattern:
        /^(stroke-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|coral)-(?:50|100|200|300|400|500|600|700|800|900|950))$/,
    },
    {
      pattern:
        /^(fill-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|coral)-(?:50|100|200|300|400|500|600|700|800|900|950))$/,
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
        // Brand coral palette anchored on `--primary` (#f76a6a at 500).
        // Tremor v3 charts accept a "coral" color name and resolve it to
        // `fill-coral-500` / `stroke-coral-500` etc., which is why every
        // shade is enumerated here AND the safelist above includes
        // `coral` in its patterns. Shades 50/100/200 cover the heatmap
        // + tooltip surfaces; 500 is the brand; 700/800/900/950 cover
        // hover states and dark-mode emphasis.
        coral: {
          50: "#fff5f5",
          100: "#ffe5e5",
          200: "#ffcccc",
          300: "#ffa3a3",
          400: "#fc8a8a",
          500: "#f76a6a",
          600: "#e04848",
          700: "#bd3838",
          800: "#9a2d2d",
          900: "#7d2828",
          950: "#430f0f",
        },
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
