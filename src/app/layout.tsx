import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "FacturOCR — Gestión inteligente de facturas",
    template: "%s | FacturOCR",
  },
  description:
    "Automatiza la extracción, validación y exportación de facturas para asesorías contables con OCR e inteligencia artificial.",
  keywords: ["facturación", "OCR", "asesoría contable", "A3 Asesor", "facturas"],
  openGraph: {
    title: "FacturOCR — Gestión inteligente de facturas",
    description:
      "De la factura al asiento en menos de 2 minutos. OCR + IA para asesorías.",
    type: "website",
    locale: "es_ES",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="es"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
