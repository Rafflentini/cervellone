import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: false,
  serverExternalPackages: ['pdf-parse', '@napi-rs/canvas', 'pdfjs-dist'],
  // FIX Bug 4: Vercel file tracing non segue dynamic import .mjs di pdfjs-dist
  // → pdf.worker.mjs non viene bundlato → pdf.mjs crasha con "Cannot find module".
  // Forziamo l'inclusione esplicita per le route che chiamano drive_read_pdf.
  outputFileTracingIncludes: {
    '/api/telegram': ['./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs'],
    '/api/chat': ['./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs'],
    '/api/projects': ['./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs'],
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
