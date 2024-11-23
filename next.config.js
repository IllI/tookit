/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    serverComponentsExternalPackages: [
      'puppeteer-core',
      'puppeteer',
      'puppeteer-extra',
      'puppeteer-extra-plugin-stealth'
    ]
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  webpack: (config, { isServer }) => {
    if (isServer) {
      config.externals.push(
        'puppeteer-core',
        'puppeteer',
        'puppeteer-extra',
        'puppeteer-extra-plugin-stealth'
      );
    }
    return config;
  }
}

module.exports = nextConfig 