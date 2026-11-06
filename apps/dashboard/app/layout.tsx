// @license All Rights Reserved (see apps/dashboard/LICENSE)
import { Exo_2 } from "next/font/google";
import type { ReactNode } from "react";

import { ThemeProvider } from "../components/theme-provider";
import "./globals.css";

// One family for the whole UI, the same one as the portfolio.
const exo = Exo_2({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

export const metadata = {
  title: "Junjo Dashboard",
  description: "Junjo cloud admin + analytics dashboard.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={exo.variable} suppressHydrationWarning>
      <body className="min-h-screen bg-background text-foreground antialiased">
        {/* disableTransitionOnChange intentionally OFF: globals.css adds
         * color transitions so the theme toggle fades between modes. */}
        <ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
