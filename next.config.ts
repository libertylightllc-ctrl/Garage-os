import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      // Photo uploads (Moulkia, check-in, tech, customer booking) flow through
      // Server Actions. Default is 1 MB — iPhone photos are 2–5 MB so every real
      // upload was failing with "Body exceeded 1 MB limit" (HTTP 413).
      //
      // Vercel Hobby caps the overall request body at 4.5 MB, so 4 MB leaves
      // headroom for multipart envelope overhead. Our client-side PhotoCapture
      // MAX_FILE_BYTES is set to the same 4 MB so the user gets a clean rejection
      // before the request leaves the phone.
      bodySizeLimit: "4mb",
    },
  },
};

export default nextConfig;
