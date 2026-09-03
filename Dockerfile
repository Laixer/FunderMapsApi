# FunderMapsApi — Bun + Hono. Two stages so the runtime image carries only
# production node_modules and src/. No build step: Bun runs TypeScript directly.
#
#   docker build -t fundermaps-api .
#   docker run --rm -p 3000:3000 --env-file .env fundermaps-api
#
# Not used by DigitalOcean App Platform (api-prod has no dockerfile_path and
# builds with buildpacks); this is the portable image for the v5 hosting move.

ARG BUN_VERSION=1.3
FROM oven/bun:${BUN_VERSION}-slim AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:${BUN_VERSION}-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
USER bun
EXPOSE 3000
# PORT defaults to 3000 in src/config.ts; override with -e PORT=... and match EXPOSE/-p.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["bun", "-e", "fetch(`http://127.0.0.1:${process.env.PORT ?? 3000}/health`).then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["bun", "run", "src/index.ts"]
