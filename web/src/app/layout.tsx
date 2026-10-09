import type { Metadata, Viewport } from "next";
import { Archivo, Courier_Prime } from "next/font/google";
import "./globals.css";

/** Archivo with its width axis: 125% is the expanded face for form headers and figures. */
const archivo = Archivo({
  subsets: ["latin"],
  axes: ["wdth"],
  variable: "--font-archivo",
  display: "swap",
});

/** Courier Prime is the carbon typewriter: only for data typed onto the forms. */
const courier = Courier_Prime({
  subsets: ["latin"],
  weight: ["400", "700"],
  variable: "--font-courier",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Sealed · AI agents haggle without showing their budget",
  description:
    "Two AI agents negotiate a price on Monad testnet without either seeing the other's number first, and one transaction settles it. Every round is a hash on-chain, and you can check each one.",
};

export const viewport: Viewport = {
  themeColor: "#2e363f",
  colorScheme: "light",
};

/** Marks the document as scripted before first paint, so the fanned set and tabs only appear when they can work. */
const JS_FLAG = "document.documentElement.classList.add('js')";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${archivo.variable} ${courier.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: JS_FLAG }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
