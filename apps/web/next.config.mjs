/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  // The dev-tools badge defaults to bottom-left, right on top of the sidebar's
  // collapse toggle — and the desktop app runs the dev server too, so the
  // overlap is real there, not just in a browser tab. Move it to bottom-right.
  devIndicators: {
    position: 'bottom-right',
  },
  // The cockpit talks to the API directly (CORS with credentials), so there is
  // no rewrite proxy here — one fewer hop to reason about when a cookie or an
  // SSE stream misbehaves.
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000',
  },
};
