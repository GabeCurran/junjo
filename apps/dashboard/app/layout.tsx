// @license All Rights Reserved (see apps/dashboard/LICENSE)
import { Archivo } from "next/font/google";
import type { ReactNode } from "react";

import { ThemeProvider } from "../components/theme-provider";
import "./globals.css";

// One family for the whole UI. The width axis gives headings their own
// voice (see `.font-condensed` in globals.css) without a second face.
const archivo = Archivo({
  subsets: ["latin"],
  axes: ["wdth"],
  variable: "--font-sans",
  display: "swap",
});

export const metadata = {
  title: "Junjo Dashboard",
  description: "Junjo cloud admin + analytics dashboard.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={archivo.variable} suppressHydrationWarning>
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
