# syntax=docker/dockerfile:1

# --- build: compile the app and run the tests ------------------------------
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm test

# --- run: just Node, the server and the built app --------------------------
# The server has no npm dependencies, so there is no node_modules here.
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8787 DATA_DIR=/data
COPY --from=build /app/package.json ./
COPY --from=build /app/server/index.ts ./server/index.ts
COPY --from=build /app/dist ./dist
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/healthz" || wget -q --no-check-certificate -O /dev/null "https://127.0.0.1:${PORT}/healthz" || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.ts"]
