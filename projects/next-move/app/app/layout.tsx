import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Next Move — your chess practice room",
  description: "Build patterns, learn from completed games, and practise the positions that need another look.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
