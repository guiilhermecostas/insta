const express = require("express");
const cors = require("cors");
const https = require("https");
const http = require("http");
const url = require("url");

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.set("trust proxy", true);

const PORT = process.env.PORT || 3000;
const APIFY_TOKEN = process.env.APIFY_TOKEN;
const APIFY_ACTOR_ID = process.env.APIFY_ACTOR_ID || "apify~instagram-profile-scraper";
const APIFY_FOLLOWERS_ACTOR_ID = process.env.APIFY_FOLLOWERS_ACTOR_ID || "barefoot_year~instagram-followers-scraper";
const FOLLOWERS_SAMPLE_POOL = Math.min(Math.max(Number(process.env.FOLLOWERS_SAMPLE_POOL || 30), 5), 100);
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_HOURS || 24) * 60 * 60 * 1000;
const REQUEST_COOLDOWN_MS = Number(process.env.REQUEST_COOLDOWN_SECONDS || 5) * 1000;

const cache = new Map();
const lastRequestByIp = new Map();

class ApiError extends Error {
  constructor(message, statusCode = 500, extra = {}) {
    super(message);
    this.statusCode = statusCode;
    Object.assign(this, extra);
  }
}

function validateUsername(username) {
  return /^[\w.]{1,30}$/.test(username);
}

function cacheGet(key) {
  const entry = cache.get(key.toLowerCase());
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) return null;
  return entry.value;
}

function cacheSet(key, value) {
  cache.set(key.toLowerCase(), {
    value,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
}

function antiSpam(req, res, next) {
  const ip = req.ip || req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const last = lastRequestByIp.get(ip) || 0;

  if (now - last < REQUEST_COOLDOWN_MS) {
    const wait = Math.ceil((REQUEST_COOLDOWN_MS - (now - last)) / 1000);
    return res.status(429).json({
      ok: false,
      error: `Aguarde ${wait}s antes de buscar novamente.`,
      retry_after_seconds: wait,
    });
  }

  lastRequestByIp.set(ip, now);
  next();
}

function pick(...values) {
  return values.find((v) => v !== undefined && v !== null && v !== "") ?? null;
}

function normalizeApifyProfile(item, fallbackUsername) {
  return {
    username: pick(item.username, item.userName, fallbackUsername),
    full_name: pick(item.fullName, item.full_name, item.name, ""),
    biography: pick(item.biography, item.bio, ""),
    is_private: Boolean(pick(item.isPrivate, item.private, false)),
    is_verified: Boolean(pick(item.isVerified, item.verified, false)),
    followers: pick(item.followersCount, item.followers_count, item.followers, null),
    following: pick(item.followsCount, item.followingCount, item.following_count, item.following, null),
    posts_count: pick(item.postsCount, item.posts_count, item.mediaCount, item.media_count, null),
    profile_pic_url: pick(item.profilePicUrl, item.profilePictureUrl, item.profile_pic_url, item.profilePicUrlHD, item.profile_pic_url_hd, null),
    profile_pic_url_hd: pick(item.profilePicUrlHD, item.profilePicUrl, item.profilePictureUrl, item.profile_pic_url_hd, item.profile_pic_url, null),
    external_url: pick(item.externalUrl, item.website, item.url, null),
    source: "apify",
  };
}
function normalizeApifyFollower(item) {
  const username = pick(
    item.username,
    item.userName,
    item.handle,
    item.ownerUsername,
    item.profileUsername,
    item.name
  );

  const clean = username ? String(username).replace(/^@+/, "") : null;

  return {
    username: clean,
    full_name: pick(item.fullName, item.full_name, item.name, item.displayName, ""),
    profile_pic_url: pick(
      item.profilePicUrl,
      item.profilePictureUrl,
      item.profile_pic_url,
      item.profilePicUrlHD,
      item.avatar,
      item.imageUrl,
      null
    ),
    profile_url: pick(item.profileUrl, item.profile_url, item.url, clean ? `https://www.instagram.com/${clean}` : null),
    is_private: Boolean(pick(item.isPrivate, item.private, false)),
    is_verified: Boolean(pick(item.isVerified, item.verified, false)),
  };
}

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

async function fetchFollowersFromApify(username, poolLimit = FOLLOWERS_SAMPLE_POOL) {
  const normalizedUsername = username.toLowerCase();
  const cacheKey = `followers:${normalizedUsername}:${poolLimit}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  if (!APIFY_TOKEN) {
    throw new ApiError("APIFY_TOKEN não configurado no ambiente.", 500);
  }

  const endpoint = `https://api.apify.com/v2/acts/${APIFY_FOLLOWERS_ACTOR_ID}/run-sync-get-dataset-items?token=${encodeURIComponent(APIFY_TOKEN)}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: normalizedUsername,
        profileUrl: "",
        maxFollowers: poolLimit,
      }),
      signal: controller.signal,
    });

    const data = await response.json().catch(() => null);

    if (!response.ok) {
      const message = data?.error?.message || data?.message || `Apify Followers retornou status ${response.status}`;
      throw new ApiError(message, response.status);
    }

    const items = Array.isArray(data) ? data : [];
    const followers = items
      .map(normalizeApifyFollower)
      .filter((f) => f.username);

    cacheSet(cacheKey, followers);
    return followers;
  } catch (err) {
    if (err.name === "AbortError") {
      throw new ApiError("Timeout ao consultar seguidores na Apify.", 504);
    }
    if (err instanceof ApiError) throw err;
    throw new ApiError(err.message || "Erro ao consultar seguidores na Apify.", 500);
  } finally {
    clearTimeout(timeout);
  }
}


async function fetchInstagramProfile(username) {
  const normalizedUsername = username.toLowerCase();

  const cached = cacheGet(normalizedUsername);
  if (cached) return cached;

  if (!APIFY_TOKEN) {
    throw new ApiError("APIFY_TOKEN não configurado no ambiente.", 500);
  }

  const endpoint = `https://api.apify.com/v2/acts/${APIFY_ACTOR_ID}/run-sync-get-dataset-items?token=${encodeURIComponent(APIFY_TOKEN)}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ usernames: [normalizedUsername] }),
      signal: controller.signal,
    });

    const data = await response.json().catch(() => null);

    if (!response.ok) {
      const message = data?.error?.message || data?.message || `Apify retornou status ${response.status}`;
      throw new ApiError(message, response.status);
    }

    const item = Array.isArray(data) ? data[0] : data?.[0];

    if (!item) {
      throw new ApiError("Perfil não encontrado pelo Actor da Apify.", 404);
    }

    const profile = normalizeApifyProfile(item, normalizedUsername);
    cacheSet(normalizedUsername, profile);
    return profile;
  } catch (err) {
    if (err.name === "AbortError") {
      throw new ApiError("Timeout ao consultar Apify. Tente novamente.", 504);
    }
    if (err instanceof ApiError) throw err;
    throw new ApiError(err.message || "Erro ao consultar Apify.", 500);
  } finally {
    clearTimeout(timeout);
  }
}

function sendError(res, err) {
  const status = err.statusCode || 500;
  return res.status(status).json({
    ok: false,
    error: err.message || "Erro interno.",
    retry_after_seconds: err.retry_after_seconds,
  });
}

function streamImage(imageUrl, res, redirects = 0) {
  if (!imageUrl) return res.status(404).json({ ok: false, error: "Imagem não encontrada." });
  if (redirects > 5) return res.status(508).json({ ok: false, error: "Muitos redirects ao buscar imagem." });

  const parsed = new url.URL(imageUrl);
  const protocol = parsed.protocol === "http:" ? http : https;

  const req = protocol.get(imageUrl, { timeout: 15000 }, (imgRes) => {
    if ([301, 302, 303, 307, 308].includes(imgRes.statusCode)) {
      const location = imgRes.headers.location;
      imgRes.resume();
      if (!location) return res.status(502).json({ ok: false, error: "Redirect sem location." });
      return streamImage(new url.URL(location, imageUrl).toString(), res, redirects + 1);
    }

    if (imgRes.statusCode !== 200) {
      imgRes.resume();
      return res.status(imgRes.statusCode || 502).json({
        ok: false,
        error: `Servidor da imagem retornou status ${imgRes.statusCode || "desconhecido"}.`,
      });
    }

    res.setHeader("Content-Type", imgRes.headers["content-type"] || "image/jpeg");
    res.setHeader("Cache-Control", "public, max-age=86400");
    imgRes.pipe(res);
  });

  req.on("error", (err) => {
    if (!res.headersSent) res.status(502).json({ ok: false, error: `Erro ao buscar imagem: ${err.message}` });
  });
  req.on("timeout", () => req.destroy(new Error("Timeout ao buscar imagem")));
}

app.get("/", (req, res) => {
  res.json({
    name: "Instagram Profile API via Apify",
    endpoints: {
      "GET /profile/:username": "Consulta perfil via Apify com cache",
      "GET /followers-sample/:username?limit=5": "Retorna até 5 seguidores públicos aleatórios como amostra",
      "GET /pic/:username": "Redirect para foto do perfil",
      "GET /pic-proxy/:username": "Proxy da foto",
      "GET /cache/status": "Status do cache",
      "DELETE /cache": "Limpa cache",
      "GET /health": "Status da API",
    },
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    apify_token_configured: Boolean(APIFY_TOKEN),
    actor: APIFY_ACTOR_ID,
    followers_actor: APIFY_FOLLOWERS_ACTOR_ID,
    followers_sample_pool: FOLLOWERS_SAMPLE_POOL,
    cache_entries: cache.size,
    cache_ttl_hours: CACHE_TTL_MS / 1000 / 60 / 60,
  });
});

app.get("/profile/:username", antiSpam, async (req, res) => {
  const username = req.params.username.replace(/^@/, "");
  if (!validateUsername(username)) return res.status(400).json({ ok: false, error: "Username inválido." });

  try {
    const profile = await fetchInstagramProfile(username);
    return res.json({ ok: true, data: profile });
  } catch (err) {
    return sendError(res, err);
  }
});

app.get("/followers-sample/:username", async (req, res) => {
  const username = req.params.username.replace(/^@/, "");
  if (!validateUsername(username)) return res.status(400).json({ ok: false, error: "Username inválido." });

  const limit = Math.min(Math.max(Number(req.query.limit || 5), 1), 5);
  const requestedPool = Number(req.query.pool || FOLLOWERS_SAMPLE_POOL);
  const poolLimit = Math.min(Math.max(requestedPool, limit), 100);

  try {
    const followers = await fetchFollowersFromApify(username, poolLimit);
    const sample = shuffle([...followers]).slice(0, limit);

    return res.json({
      ok: true,
      data: {
        username,
        sample_count: sample.length,
        pool_count: followers.length,
        followers: sample,
      },
    });
  } catch (err) {
    return sendError(res, err);
  }
});

app.get("/pic/:username", async (req, res) => {
  const username = req.params.username.replace(/^@/, "");
  if (!validateUsername(username)) return res.status(400).json({ ok: false, error: "Username inválido." });

  try {
    const profile = await fetchInstagramProfile(username);
    const imageUrl = profile.profile_pic_url_hd || profile.profile_pic_url;
    if (!imageUrl) return res.status(404).json({ ok: false, error: "Foto não encontrada." });
    return res.redirect(imageUrl);
  } catch (err) {
    return sendError(res, err);
  }
});

app.get("/pic-proxy/:username", async (req, res) => {
  const username = req.params.username.replace(/^@/, "");
  if (!validateUsername(username)) return res.status(400).json({ ok: false, error: "Username inválido." });

  try {
    const profile = await fetchInstagramProfile(username);
    return streamImage(profile.profile_pic_url_hd || profile.profile_pic_url, res);
  } catch (err) {
    return sendError(res, err);
  }
});

app.get("/cache/status", (req, res) => {
  const now = Date.now();
  const entries = [...cache.entries()].map(([username, entry]) => ({
    username,
    expiresInSeconds: Math.max(0, Math.ceil((entry.expiresAt - now) / 1000)),
  }));
  res.json({ total: cache.size, entries });
});

app.delete("/cache", (req, res) => {
  cache.clear();
  res.json({ ok: true, message: "Cache limpo." });
});

app.listen(PORT, () => {
  console.log(`🚀 API via Apify rodando em http://localhost:${PORT}`);
  console.log(`🔑 APIFY_TOKEN configurado: ${Boolean(APIFY_TOKEN)}`);
  console.log(`🎭 Actor: ${APIFY_ACTOR_ID}`);
});
