import type { Metadata, Viewport } from "next";
import { Fraunces, IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";

import { Disclaimer } from "@/components/Disclaimer";
import { DebugPanel } from "@/components/DebugPanel";
import { ConnectedGates } from "@/components/Gates";
import { SiteHeader } from "@/components/SiteHeader";

import "./globals.css";
import { Providers } from "./Providers";

// next/font downloads the font files at build time and serves them from this app (no runtime Google request).
const fraunces = Fraunces({ subsets: ["latin"], variable: "--font-fraunces", display: "swap" });
const plexSans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-plex-sans",
  display: "swap",
});
const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-plex-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: { default: "Bluff: confidential Liar's Dice", template: "%s | Bluff" },
  description:
    "Liar's Dice on Ethereum Sepolia with encrypted dice. Only you can read your cup, until someone calls Liar.",
};

export const viewport: Viewport = {
  themeColor: "#0E1219",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${fraunces.variable} ${plexSans.variable} ${plexMono.variable}`}>
      <body>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <Providers>
          <SiteHeader />
          <ConnectedGates />
          <main id="main" tabIndex={-1}>
            {children}
          </main>
          <DebugPanel />
          <Disclaimer />
        </Providers>
      </body>
    </html>
  );
}
