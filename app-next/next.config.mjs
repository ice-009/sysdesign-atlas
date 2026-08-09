/** @type {import('next').NextConfig} */
const nextConfig = {
  // Emits .next/standalone — a self-contained server with only the
  // node_modules it actually needs. Keeps the container image small.
  // Only for the Docker/Kubernetes path: Vercel builds its own output and
  // standalone mode confuses it, so gate this on an explicit opt-in.
  ...(process.env.BUILD_STANDALONE === '1' ? { output: 'standalone' } : {}),
  serverExternalPackages: [
    '@prisma/client',
    '@prisma/adapter-pg',
    '@prisma/adapter-better-sqlite3',
    'better-sqlite3',
    'bcryptjs',
    'shiki',
  ],
  outputFileTracingRoot: import.meta.dirname,
  poweredByHeader: false,
};

export default nextConfig;
