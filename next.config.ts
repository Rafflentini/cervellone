import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: false,
  serverExternalPackages: ['pdf-parse', '@napi-rs/canvas', 'pdfjs-dist', '@sparticuz/chromium', 'puppeteer-core'],
  // FIX Bug 4: Vercel file tracing non segue dynamic import .mjs di pdfjs-dist
  // → pdf.worker.mjs non viene bundlato → pdf.mjs crasha con "Cannot find module".
  // Forziamo l'inclusione esplicita per le route che chiamano drive_read_pdf.
  //
  // FIX V18 PDF Puppeteer: serverExternalPackages esclude @sparticuz/chromium dal bundle
  // ma il binary chromium.br (~50MB) NON viene tracciato → executablePath() fallisce in prod.
  // Forziamo l'inclusione esplicita di node_modules/@sparticuz/chromium/bin/** per le route
  // che invocano genera_pdf (telegram/chat/projects).
  outputFileTracingIncludes: {
    '/api/telegram': [
      './node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs',
      './node_modules/@sparticuz/chromium/bin/**',
    ],
    '/api/chat': [
      './node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs',
      './node_modules/@sparticuz/chromium/bin/**',
    ],
    '/api/projects': [
      './node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs',
      './node_modules/@sparticuz/chromium/bin/**',
    ],
    '/api/import-prezziario': ['./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs'],
  },
  experimental: {
    proxyClientMaxBodySize: '100mb',
    serverActions: {
      bodySizeLimit: '100mb',
    },
  },
};

export default nextConfig;
