# syntax=docker/dockerfile:1

# The bundle is plain JavaScript, so it is built once on the builder's own platform for every target,
# and building for another architecture runs nothing under emulation
FROM --platform=$BUILDPLATFORM node:25-alpine@sha256:bdf2cca6fe3dabd014ea60163eca3f0f7015fbd5c7ee1b0e9ccb4ced6eb02ef4 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build:node

# The bundle has no dependencies, so the image is Node and one file
FROM node:25-alpine@sha256:bdf2cca6fe3dabd014ea60163eca3f0f7015fbd5c7ee1b0e9ccb4ced6eb02ef4
WORKDIR /app
COPY --from=build /app/dist/node/index.mjs ./
USER node
ENV PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --start-interval=1s \
    CMD wget --quiet --output-document=/dev/null "http://127.0.0.1:$PORT/healthz" || exit 1
CMD ["node", "index.mjs"]
