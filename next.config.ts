import type { NextConfig } from "next";

const isProd = process.env.NODE_ENV === "production";

// CSP compatible con Next.js App Router. Nota: 'unsafe-inline' en script-src
// lo pide Next para su hidratacion; en App Router moderno se puede endurecer
// con nonces por ruta, pero eso queda para fase 2.
const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob: https:",
  "connect-src 'self' https: wss:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
  "upgrade-insecure-requests",
].join("; ");

// Los originales de las facturas los sube un tercero y se sirven desde este
// origen. Con sandbox el documento no ejecuta scripts ni comparte origen con
// la app aunque el navegador llegue a pintarlo (F-002). Chrome sigue
// mostrando los PDF con esta politica.
const rawFileCsp = "sandbox; default-src 'none'; frame-ancestors 'none'";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      bodySizeLimit: "25mb",
    },
  },
  // Next 16 exige declarar explicitamente que valores de `quality` se
  // permiten en <Image>. Default es solo [75]. Anadimos 95 para el hero
  // del login (foto editorial, queremos minima compresion).
  images: {
    qualities: [75, 95],
  },
  // Incluir los PDFs pre-construidos del seed de demo en el bundle de
  // funciones serverless de Vercel. Sin esto, scripts/seed-pdfs/ no se
  // empaqueta y el endpoint /api/admin/reset-demo falla con ENOENT.
  outputFileTracingIncludes: {
    "/api/admin/reset-demo": ["scripts/seed-pdfs/**/*"],
  },
  async headers() {
    const base = [
      { key: "X-Frame-Options", value: "DENY" },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
      { key: "Content-Security-Policy", value: csp },
    ];
    if (isProd) {
      base.push({
        key: "Strict-Transport-Security",
        value: "max-age=63072000; includeSubDomains; preload",
      });
    }
    return [
      { source: "/(.*)", headers: base },
      // Va despues de la general para sustituir su CSP: con la misma clave
      // gana la ultima entrada. Tiene que estar aqui y no en el route handler,
      // porque Next ignora las cabeceras del handler que ya trae esta config.
      {
        source: "/api/invoices/:id/raw",
        headers: [
          { key: "Content-Security-Policy", value: rawFileCsp },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
    ];
  },
};

export default nextConfig;
