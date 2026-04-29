// @license All Rights Reserved (see apps/dashboard/LICENSE)
import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "Junjo Dashboard",
  description: "Junjo cloud admin + analytics dashboard.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body className="min-h-screen bg-background text-foreground antialiased">{children}</body>
    </html>
  );
}
