FROM node:24-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME/bin:$PATH"
RUN corepack enable && corepack prepare pnpm@10.4.1 --activate

# ---- installer ----
FROM base AS installer
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/ts-server/package.json ./packages/ts-server/
RUN pnpm install --frozen-lockfile --filter=@enduroq/enduroq

# ---- builder ----
FROM installer AS builder
COPY packages/ts-server/src ./packages/ts-server/src
COPY packages/ts-server/tsconfig.json ./packages/ts-server/
RUN pnpm --filter=@enduroq/enduroq run build

# ---- runner ----
FROM base AS runner
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/ts-server/package.json ./packages/ts-server/
RUN pnpm install --frozen-lockfile --filter=@enduroq/enduroq --prod
COPY --from=builder /app/packages/ts-server/dist ./packages/ts-server/dist

WORKDIR /app/packages/ts-server
EXPOSE 7225
CMD ["node", "dist/server.js"]
