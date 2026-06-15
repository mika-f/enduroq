import { join } from "node:path";

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Emit a self-contained server bundle for the Docker image.
  output: "standalone",
  // Trace dependencies from the monorepo root so the standalone output
  // includes workspace-hoisted packages.
  outputFileTracingRoot: join(import.meta.dirname, "../../"),
};

export default nextConfig;
