# syntax = docker/dockerfile:1

# Adjust NODE_VERSION as desired
ARG NODE_VERSION=22.8.0
FROM node:${NODE_VERSION}-slim as base

LABEL fly_launch_runtime="Next.js"

# Next.js app lives here
WORKDIR /app

# Set production environment
ENV NODE_ENV="production"

# Throw-away build stage to reduce size of final image
FROM base as build

# Install packages needed to build node modules
RUN apt-get update -qq && \
    apt-get install --no-install-recommends -y build-essential node-gyp pkg-config python-is-python3

# Install node modules
COPY package.json ./
RUN yarn install

# Copy application code
COPY . .

# Build application
RUN yarn build

# Remove development dependencies
RUN yarn install --production --ignore-scripts --prefer-offline

# Final stage for app image
FROM base

# Install Chrome and its dependencies
RUN apt-get update -qq && \
    apt-get install -y wget gnupg2 dbus xvfb x11-xserver-utils && \
    wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add - && \
    sh -c 'echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list' && \
    apt-get update && \
    apt-get install -y google-chrome-stable fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 && \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*

# Set up Xvfb and dbus
RUN mkdir -p /var/run/dbus && \
    dbus-uuidgen > /var/lib/dbus/machine-id

# Copy built application
COPY --from=build /app /app

# Start the server by default, this can be overwritten at runtime
EXPOSE 3000
ENV DISPLAY=:99
ENV PUPPETEER_EXECUTABLE_PATH="/usr/bin/google-chrome-stable"

# Start Xvfb, dbus and the application
CMD /usr/bin/Xvfb :99 -screen 0 1024x768x24 > /dev/null 2>&1 & \
    service dbus start & \
    yarn start
