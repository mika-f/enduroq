FROM node:24-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME/bin:$PATH"
ENV NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@10.4.1 --activate

# ---- installer ----
FROM base AS installer
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/admin-console/package.json ./packages/admin-console/
RUN pnpm install --frozen-lockfile --filter=@enduroq/admin-console

# ---- builder ----
FROM installer AS builder
COPY packages/admin-console ./packages/admin-console
RUN pnpm --filter=@enduroq/admin-console run build

# ---- runner ----
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=9000
ENV HOSTNAME=0.0.0.0

# Next.js "standalone" output: a minimal server with only the traced
# dependencies. The monorepo layout is preserved under packages/admin-console.
COPY --from=builder /app/packages/admin-console/.next/standalone ./
COPY --from=builder /app/packages/admin-console/.next/static ./packages/admin-console/.next/static

WORKDIR /app/packages/admin-console
EXPOSE 9000
CMD ["node", "server.js"]
