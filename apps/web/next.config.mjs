/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  // The cockpit talks to the API directly (CORS with credentials), so there is
  // no rewrite proxy here — one fewer hop to reason about when a cookie or an
  // SSE stream misbehaves.
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000',
  },
};
