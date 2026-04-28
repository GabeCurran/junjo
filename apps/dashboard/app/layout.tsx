import type { ReactNode } from "react";

export const metadata = {
  title: "Junjo Dashboard",
  description: "Junjo cloud admin + analytics dashboard.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
