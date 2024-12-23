/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  eslint: {
    // Warning: This allows production builds to successfully complete even if
    // your project has ESLint errors.
    ignoreDuringBuilds: true,
  },
  typescript: {
    // !! WARN !!
    // Dangerously allow production builds to successfully complete even if
    // your project has type errors.
    ignoreBuildErrors: true,
  },
  telemetry: false,
  webpack: (config, { isServer }) => {
    // Add .ts and .tsx to resolved extensions
    config.resolve.extensions = [
      '.js',
      '.jsx',
      '.ts',
      '.tsx',
      ...config.resolve.extensions
    ];

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

    return config;
  },
  experimental: {
    serverComponentsExternalPackages: ['puppeteer', 'x-crawl'],
    esmExternals: 'loose',
    disableOptimizedLoading: true,
    outputFileTracingRoot: undefined
  }
}

module.exports = nextConfig 