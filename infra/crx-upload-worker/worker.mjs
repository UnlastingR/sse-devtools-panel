const PREFIX = "sse-devtools-panel/";
const MAX_BYTES = 20 * 1024 * 1024;
const ALLOWED_SUFFIXES = [".crx", ".zip", ".xml", ".txt"];

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === "GET") {
      return json({ ok: true, service: "crx-r2-deploy" });
    }

    if (request.method !== "PUT") {
      return json({ ok: false, error: "method_not_allowed" }, 405);
    }

    const expected = env.R2_DEPLOY_KEY ? `Bearer ${env.R2_DEPLOY_KEY}` : "";
    if (!expected || request.headers.get("authorization") !== expected) {
      return json({ ok: false, error: "forbidden" }, 403);
    }

    const url = new URL(request.url);
    const key = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
    if (
      !key.startsWith(PREFIX) ||
      key.includes("..") ||
      !ALLOWED_SUFFIXES.some((suffix) => key.endsWith(suffix))
    ) {
      return json({ ok: false, error: "invalid_key" }, 400);
    }

    const contentLength = Number(request.headers.get("content-length") || "0");
    if (Number.isFinite(contentLength) && contentLength > MAX_BYTES) {
      return json({ ok: false, error: "too_large" }, 413);
    }

    const contentType = request.headers.get("content-type") || "application/octet-stream";
    const cacheControl = request.headers.get("x-object-cache-control") || "no-cache";
    const object = await env.CRX_BUCKET.put(key, request.body, {
      httpMetadata: { contentType, cacheControl },
    });

    return json({ ok: true, key, etag: object.etag, size: object.size });
  },
};
