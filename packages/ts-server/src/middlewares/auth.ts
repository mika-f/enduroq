import { timingSafeEqual } from "node:crypto";
import { createMiddleware } from "hono/factory";
import type pino from "pino";

const BEARER_PREFIX = "Bearer ";

// constant-time comparison that does not leak length via early return
const safeEqual = (a: string, b: string): boolean => {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) {
    // still run a comparison to keep timing roughly uniform, then fail
    timingSafeEqual(aBuf, aBuf);
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
};

/**
 * Creates a Bearer-token authentication middleware.
 *
 * When `token` is `undefined` (i.e. `ENDUROQ_AUTH_TOKEN` is not configured),
 * authentication is disabled and every request passes through unchanged. This
 * keeps existing deployments backward compatible.
 */
export const bearerAuth = (
  token: string | undefined,
  logger: pino.Logger,
) => {
  const log = logger.child({ module: "auth" });

  return createMiddleware(async (c, next) => {
    if (!token) {
      return next();
    }

    const header = c.req.header("Authorization");
    if (!header || !header.startsWith(BEARER_PREFIX)) {
      log.warn(
        { path: c.req.path },
        "auth rejected: missing or malformed Authorization header",
      );
      return c.json({ error: "unauthorized" }, 401, {
        "WWW-Authenticate": "Bearer",
      });
    }

    const presented = header.slice(BEARER_PREFIX.length).trim();
    if (!safeEqual(presented, token)) {
      log.warn({ path: c.req.path }, "auth rejected: invalid token");
      return c.json({ error: "unauthorized" }, 401, {
        "WWW-Authenticate": "Bearer",
      });
    }

    return next();
  });
};
