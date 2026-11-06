// @license All Rights Reserved (see apps/dashboard/LICENSE)
"use client";

import { ThemeProvider as NextThemesProvider, type ThemeProviderProps } from "next-themes";
import { useEffect } from "react";

// Turns on the theme fade (see `.theme-ready` in globals.css) only once
// the first frame has painted, so loading a page never fades from the
// light defaults into the stored theme.
function ThemeReady() {
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      document.documentElement.classList.add("theme-ready");
    });
    return () => cancelAnimationFrame(id);
  }, []);
  return null;
}

export function ThemeProvider({ children, ...props }: ThemeProviderProps) {
  return (
    <NextThemesProvider {...props}>
      <ThemeReady />
      {children}
    </NextThemesProvider>
  );
}
