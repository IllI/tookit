# Use Node.js LTS (Long Term Support) version
FROM node:18-alpine AS builder

# Set working directory
WORKDIR /app

# Install necessary build tools
RUN apk add --no-cache python3 make g++ git

# Copy package files
COPY package*.json ./

# Install dependencies including dev dependencies
RUN npm install

# Copy necessary config files
COPY tsconfig.json .
COPY jsconfig.json .
COPY next.config.js .

# Copy source files
COPY src ./src
COPY lib ./lib
COPY pages ./pages

# Create .env file with build-time variables
RUN echo "NEXT_PUBLIC_SUPABASE_URL=${NEXT_PUBLIC_SUPABASE_URL}" > .env
RUN echo "NEXT_PUBLIC_SUPABASE_ANON_KEY=${NEXT_PUBLIC_SUPABASE_ANON_KEY}" >> .env
RUN echo "SUPABASE_SERVICE_KEY=${SUPABASE_SERVICE_KEY}" >> .env
RUN echo "FIRECRAWL_API_KEY=${FIRECRAWL_API_KEY}" >> .env
RUN echo "OPENAI_API_KEY=${OPENAI_API_KEY}" >> .env

# Build the application
RUN npm run build

# Production image
FROM node:18-alpine AS runner

WORKDIR /app

# Copy necessary files from builder
COPY --from=builder /app/next.config.js ./
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/.env ./.env

# Set environment variables
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Expose the port the app runs on
EXPOSE 3000

# Start the application
CMD ["npm", "start"]