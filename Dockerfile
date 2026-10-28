# syntax=docker/dockerfile:1

# The build stage runs on the builder's own platform: its output is plain JavaScript, and no dependency has a native
# part or an install script. The runtime stage only copies, so building it for another platform needs no emulation.
FROM --platform=$BUILDPLATFORM node:22.23.4-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev && mkdir /data

FROM node:22.23.4-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d
# Filled in by the release build from package.json, package-lock.json and git.
ARG SDK_VERSION
ARG LIBRARY_VERSION
ARG REVISION
# The repository GHCR links the package to; a build from this source keeps the default.
ARG IMAGE_SOURCE=https://github.com/dmarket/p2p-sdk
LABEL org.opencontainers.image.title="dmarket-p2p-sdk" \
      org.opencontainers.image.description="Headless seller client for DMarket P2P trading" \
      org.opencontainers.image.source="${IMAGE_SOURCE}" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${SDK_VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      com.dmarket.p2p-tracker-headless.version="${LIBRARY_VERSION}"
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY LICENSE THIRD_PARTY_NOTICES.md ./
# Owned by the image's user, so a named volume mounted here starts out writable by it.
COPY --from=build --chown=node:node /data /data
USER node
VOLUME /data
EXPOSE 8790
# The config file's path comes in DMARKET_SDK_CONFIG. The SDK handles SIGTERM itself: `docker stop` exits 0.
ENTRYPOINT ["node", "dist/main.js"]
