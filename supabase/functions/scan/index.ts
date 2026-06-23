// Panini sticker OCR proxy — holds the Gemini key server-side so the public
// GitHub Pages site never embeds a secret. Deploy:
//   supabase functions deploy scan --no-verify-jwt --project-ref <ref>
//   supabase secrets set GEMINI_API_KEY=<key> --project-ref <ref>
//
// Defense for a public endpoint: (1) Origin allowlist below, (2) a coarse
// per-IP rate limit, (3) the REAL backstop is the spend cap you set in Google
// Cloud Billing. ponytail: in-memory limiter resets per cold start — fine as a
// speed bump; move to a Supabase table if you ever need a hard guarantee.

const MODELS = ["gemini-2.5-flash-lite", "gemini-2.5-flash"]; // primary (cheapest) + fallback when overloaded
const RETRY_STATUS = new Set([429, 500, 503]); // transient — retry/fall back; other codes fail fast
const ALLOWED_ORIGINS = new Set([
  "https://mihneatabacu.github.io",
  "http://localhost:8848",
  "http://127.0.0.1:8848",
]);
const MAX_IMAGE_BYTES = 6_000_000; // ~6MB of base64; phone photos are well under
const RATE = { windowMs: 60_000, max: 20 }; // 20 scans/min/IP
const hits = new Map<string, number[]>();

const PROMPT =
  "These are Panini FIFA World Cup 2026 collectible football stickers — either " +
  "loose stickers or a page of the album. For every distinct sticker you can " +
  "clearly identify, return the player's full name exactly as printed, the " +
  "country/team name if visible, and the small printed sticker number if visible. " +
  "Only include stickers you can actually read — do NOT guess players who are not " +
  "clearly shown. Return an empty array if none are legible.";

const SCHEMA = {
  type: "ARRAY",
  items: {
    type: "OBJECT",
    properties: {
      name: { type: "STRING", description: "Player or item name as printed" },
      team: { type: "STRING", description: "Country/team name if visible, else empty" },
      number: { type: "INTEGER", description: "Printed sticker number if visible, else omit" },
    },
    required: ["name"],
  },
};

// Call Gemini with retry-on-transient (503/429/500) + model fallback.
async function callGemini(key: string, image: string, mimeType: string) {
  const body = JSON.stringify({
    contents: [{ parts: [{ inline_data: { mime_type: mimeType, data: image } }, { text: PROMPT }] }],
    generationConfig: { responseMimeType: "application/json", responseSchema: SCHEMA, temperature: 0 },
  });
  let lastStatus = 0, lastDetail = "";
  for (const model of MODELS) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const g = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": key }, body },
      );
      if (g.ok) {
        const data = await g.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "[]";
        let items: unknown;
        try { items = JSON.parse(text); } catch { items = []; }
        return { ok: true as const, items: Array.isArray(items) ? items : [] };
      }
      lastStatus = g.status; lastDetail = (await g.text()).slice(0, 200);
      if (!RETRY_STATUS.has(g.status)) return { ok: false as const, status: g.status, detail: lastDetail };
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1))); // 0.4s, 0.8s backoff
    }
  }
  return { ok: false as const, status: lastStatus || 503, detail: "overloaded after retries: " + lastDetail };
}

function cors(origin: string | null) {
  const allow = origin && ALLOWED_ORIGINS.has(origin) ? origin : "";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Vary": "Origin",
  };
}

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < RATE.windowMs);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > RATE.max;
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  const headers = { ...cors(origin), "content-type": "application/json" };

  if (req.method === "OPTIONS") return new Response("ok", { headers });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "POST only" }), { status: 405, headers });
  if (!origin || !ALLOWED_ORIGINS.has(origin)) return new Response(JSON.stringify({ error: "forbidden origin" }), { status: 403, headers });

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (rateLimited(ip)) return new Response(JSON.stringify({ error: "rate limited — slow down" }), { status: 429, headers });

  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) return new Response(JSON.stringify({ error: "server not configured" }), { status: 500, headers });

  let image: string, mimeType: string;
  try {
    const body = await req.json();
    image = String(body.image || "");
    mimeType = String(body.mimeType || "image/jpeg");
    if (!image) throw new Error("no image");
    if (image.length > MAX_IMAGE_BYTES) throw new Error("image too large");
  } catch (e) {
    return new Response(JSON.stringify({ error: "bad request: " + (e as Error).message }), { status: 400, headers });
  }

  try {
    const result = await callGemini(key, image, mimeType);
    if (!result.ok) {
      const msg = result.status === 503 ? "the AI model is busy — try again in a moment" : "vision error";
      return new Response(JSON.stringify({ error: msg, status: result.status, detail: result.detail }), { status: 502, headers });
    }
    return new Response(JSON.stringify({ items: result.items }), { headers });
  } catch (e) {
    return new Response(JSON.stringify({ error: "upstream failure: " + (e as Error).message }), { status: 502, headers });
  }
});
