import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "RetroDeck — Play NES in your browser",
  description: "A private, browser-based NES arcade with an original mini-game and local ROM uploads.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
