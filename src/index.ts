import { collectSnapshot } from "./collect";
import { aggregateAndCleanup } from "./aggregate";
import { handleHistory, handleLatest, handleRanking, handleReliability, corsPreflight } from "./api";

export interface Env {
  DB: D1Database;
  COLLECT_SECRET: string;
}

// Cloudflare's native Cron Trigger is currently not firing for this account
// (confirmed via wrangler tail + dashboard, ticket open with Cloudflare
// support). These two routes let an external cron service (cron-job.org,
// UptimeRobot, ...) drive collection/maintenance in the meantime by hitting
// them over HTTP. Remove once the native Cron Trigger is confirmed working
// again, or keep them as a redundant trigger path.
function isAuthorized(request: Request, env: Env): boolean {
  const provided = request.headers.get("X-Collect-Secret") ?? new URL(request.url).searchParams.get("secret");
  return !!env.COLLECT_SECRET && provided === env.COLLECT_SECRET;
}

const COLLECT_CRON = "*/15 * * * *";
const MAINTENANCE_CRON = "0 3 * * *";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return corsPreflight();
    }

    const url = new URL(request.url);

    if (request.method !== "GET") {
      return new Response(JSON.stringify({ error: "Method not allowed" }), {
        status: 405,
        headers: { "Content-Type": "application/json" },
      });
    }

    try {
      if (url.pathname === "/servers/history") {
        return await handleHistory(env.DB, url);
      }
      if (url.pathname === "/servers/latest") {
        return await handleLatest(env.DB);
      }
      if (url.pathname === "/servers/ranking") {
        return await handleRanking(env.DB, url);
      }
      if (url.pathname === "/servers/reliability") {
        return await handleReliability(env.DB, url);
      }
      if (url.pathname === "/internal/collect") {
        if (!isAuthorized(request, env)) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }
        await collectSnapshot(env.DB);
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.pathname === "/internal/maintenance") {
        if (!isAuthorized(request, env)) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }
        await aggregateAndCleanup(env.DB);
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    } catch (err) {
      console.error("Unhandled error in fetch handler", err);
      return new Response(JSON.stringify({ error: "Internal server error" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  },

  async scheduled(event: ScheduledEvent, env: Env): Promise<void> {
    try {
      if (event.cron === COLLECT_CRON) {
        await collectSnapshot(env.DB);
        return;
      }
      if (event.cron === MAINTENANCE_CRON) {
        await aggregateAndCleanup(env.DB);
        return;
      }
      console.error(`Unknown cron trigger: ${event.cron}`);
    } catch (err) {
      // collectSnapshot/aggregateAndCleanup already catch their own expected
      // failure modes; this is a last-resort net so a scheduled run never
      // throws an unhandled exception.
      console.error(`Unhandled error during scheduled run (${event.cron})`, err);
    }
  },
};
