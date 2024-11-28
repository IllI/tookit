/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
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

    return config;
  },
  experimental: {
    serverComponentsExternalPackages: ['puppeteer', 'x-crawl'],
    esmExternals: 'loose'
  }
}

module.exports = nextConfig 