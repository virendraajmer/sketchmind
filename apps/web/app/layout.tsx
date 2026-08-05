import type { ReactNode } from "react";

export const metadata = {
  title: "SketchMind",
  description: "An agent that reasons about a concept, then draws it like a teacher."
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
