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
  // The offline iPad edition is plain static files in public/ipad/ (built by
  // scripts/ipad/build.mjs). Next doesn't serve index.html for a directory, and
  // the app's relative URLs need the trailing path, so send /ipad to the file.
  async redirects() {
    return [{ source: '/ipad', destination: '/ipad/index.html', permanent: false }];
  },
  async headers() {
    return [
      {
        // The service worker must be revalidated on every check, or an update
        // can sit unnoticed behind a cached copy.
        source: '/ipad/sw.js',
        headers: [{ key: 'Cache-Control', value: 'no-cache' }],
      },
    ];
  },
};

export default nextConfig;
