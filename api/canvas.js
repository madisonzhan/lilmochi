// Read-only relay to the bCourses (Canvas) API.
// Why it exists: bCourses does not allow browsers on other sites to call its API directly.
// What it does NOT do: store, log, or cache tokens or responses. GET only, three fixed endpoints.
const BASE = "https://bcourses.berkeley.edu";
const ALLOWED_PATHS = [/^\/api\/v1\/users\/self$/, /^\/api\/v1\/courses$/, /^\/api\/v1\/planner\/items$/];
const ALLOWED_PARAMS = new Set(["per_page", "page", "start_date", "end_date", "enrollment_state", "include[]", "order"]);

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method !== "GET") return res.status(405).json({ error: "method_not_allowed" });

  const token = req.headers["x-canvas-token"];
  if (typeof token !== "string" || !/^[A-Za-z0-9~_\-.]{20,256}$/.test(token)) {
    return res.status(400).json({ error: "missing_or_malformed_token" });
  }
  const incoming = new URL(req.url, "http://relay.local");
  const path = incoming.searchParams.get("path") || "";
  if (!ALLOWED_PATHS.some((r) => r.test(path))) return res.status(400).json({ error: "path_not_allowed" });

  const target = new URL(BASE + path);
  for (const [k, v] of incoming.searchParams) {
    if (k !== "path" && ALLOWED_PARAMS.has(k)) target.searchParams.append(k, String(v).slice(0, 600));
  }

  let upstream;
  try {
    upstream = await fetch(target, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      redirect: "manual",
    });
  } catch {
    return res.status(502).json({ error: "bcourses_unreachable" });
  }
  if (upstream.status >= 300 && upstream.status < 400) return res.status(401).json({ error: "token_rejected" });
  if (upstream.status === 401) return res.status(401).json({ error: "token_rejected" });

  const link = upstream.headers.get("link") || "";
  const next = /<[^>]*[?&]page=([^&>]+)[^>]*>;\s*rel="next"/.exec(link);
  if (next) res.setHeader("X-Next-Page", decodeURIComponent(next[1]));
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  return res.status(upstream.status).send(await upstream.text());
}
