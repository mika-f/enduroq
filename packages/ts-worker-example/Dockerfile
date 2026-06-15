FROM node:24-slim AS base

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME/bin:$PATH"
RUN corepack enable

WORKDIR /app

COPY . .
RUN pnpm install
RUN cd packages/ts-worker && pnpm run build
EXPOSE 8000

WORKDIR /app/packages/ts-worker-example
CMD ["pnpm", "run", "serve"]
