/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Disable TypeScript type checking during build
  typescript: {
    ignoreBuildErrors: true,
  },
  // Disable ESLint during build
  eslint: {
    ignoreDuringBuilds: true,
  },
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        net: false,
        tls: false,
        child_process: false,
        canvas: false,
      };
    }

    config.module = {
      ...config.module,
      exprContextCritical: false,
    };

    // Add path aliases
    config.resolve.alias = {
      ...config.resolve.alias,
      '@': '.',
      '@/src': './src',
      '@/lib': './lib'
    };

    return config;
  },
  experimental: {
    serverComponentsExternalPackages: ['puppeteer', 'x-crawl'],
    esmExternals: 'loose'
  }
}

module.exports = nextConfig 