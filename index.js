const express  = require("express");
const https    = require("https");
const http     = require("http");
const net      = require("net");
const url      = require("url");
const zlib     = require("zlib");
const cors     = require("cors");

const ProxyManager = require("./proxy-manager");
const proxyList    = require("./proxies");

const app  = express();
app.use(cors());
const PORT = process.env.PORT || 3000;

// ─── Cache em memória (1 hora de TTL) ───────────────────────────────────────
const cache = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000;

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { cache.delete(key); return null; }
  console.log(`✅ Cache hit: ${key}`);
  return entry.value;
}

function cacheSet(key, value) {
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  console.log(`💾 Cache set: ${key} (expira em 1h)`);
}

// ─── Inicializa o pool de proxies ────────────────────────────────────────────
const proxyManager = new ProxyManager(proxyList);
console.log(`🔌 Pool de proxies inicializado com ${proxyList.length} proxies`);

// ─── User-Agents para rotacionar ─────────────────────────────────────────────
const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
];

function randomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function maskProxyUrl(proxyUrl = "") {
  return proxyUrl.replace(/\/\/[^@]+@/, "//***:***@");
}

function readResponseBody(res) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    res.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    res.on("end", () => {
      const buffer = Buffer.concat(chunks);
      const encoding = String(res.headers["content-encoding"] || "").toLowerCase();

      const finish = (err, output) => {
        if (err) return reject(err);
        resolve(output.toString("utf8"));
      };

      if (encoding.includes("br")) return zlib.brotliDecompress(buffer, finish);
      if (encoding.includes("gzip")) return zlib.gunzip(buffer, finish);
      if (encoding.includes("deflate")) return zlib.inflate(buffer, finish);

      resolve(buffer.toString("utf8"));
    });

    res.on("error", reject);
  });
}

function getBrowserHeaders() {
  return {
    "User-Agent": randomUA(),
    Accept: "*/*",
    "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8",
    "Accept-Encoding": "gzip, deflate, br",
    Referer: "https://www.instagram.com/",
    "x-ig-app-id": "936619743392459",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
  };
}

// ════════════════════════════════════════════════════════════════════════════
//  TUNNEL HTTP/HTTPS ATRAVÉS DO PROXY
// ════════════════════════════════════════════════════════════════════════════

function createTunnel(proxyUrl, targetHost, targetPort) {
  return new Promise((resolve, reject) => {
    const parsed = new url.URL(proxyUrl);
    const isSocks5 = parsed.protocol === "socks5:";

    if (isSocks5) {
      return createSocks5Tunnel(parsed, targetHost, targetPort)
        .then(resolve)
        .catch(reject);
    }

    const proxyPort = parseInt(parsed.port) || 8080;
    const proxyHost = parsed.hostname;
    const auth = parsed.username
      ? Buffer.from(`${parsed.username}:${parsed.password}`).toString("base64")
      : null;

    const connectHeaders = [
      `CONNECT ${targetHost}:${targetPort} HTTP/1.1`,
      `Host: ${targetHost}:${targetPort}`,
      auth ? `Proxy-Authorization: Basic ${auth}` : "",
      "Connection: keep-alive",
      "", "",
    ].filter(Boolean).join("\r\n");

    const socket = net.connect(proxyPort, proxyHost, () => {
      socket.write(connectHeaders);
    });

    socket.once("data", (data) => {
      const response = data.toString();
      if (response.includes("200")) {
        resolve(socket);
      } else {
        socket.destroy();
        reject(new Error(`Proxy CONNECT falhou: ${response.split("\r\n")[0]}`));
      }
    });

    socket.on("error", reject);
    socket.setTimeout(10000, () => {
      socket.destroy();
      reject(new Error("Timeout ao conectar no proxy HTTP"));
    });
  });
}

function createSocks5Tunnel(parsed, targetHost, targetPort) {
  return new Promise((resolve, reject) => {
    const proxyPort = parseInt(parsed.port) || 1080;
    const proxyHost = parsed.hostname;
    const hasAuth   = !!parsed.username;

    const socket = net.connect(proxyPort, proxyHost, () => {
      const authMethod = hasAuth ? 0x02 : 0x00;
      socket.write(Buffer.from([0x05, 0x01, authMethod]));
    });

    let step = "auth-negotiation";

    socket.on("data", (data) => {
      if (step === "auth-negotiation") {
        if (data[0] !== 0x05) return reject(new Error("Resposta SOCKS5 inválida"));
        if (data[1] === 0x02 && hasAuth) {
          const user = Buffer.from(parsed.username);
          const pass = Buffer.from(parsed.password);
          const authBuf = Buffer.concat([
            Buffer.from([0x01, user.length]),
            user,
            Buffer.from([pass.length]),
            pass,
          ]);
          socket.write(authBuf);
          step = "auth-response";
        } else if (data[1] === 0x00) {
          step = "connect";
          sendConnect();
        } else {
          reject(new Error("SOCKS5: método de autenticação não aceito"));
        }
        return;
      }
      if (step === "auth-response") {
        if (data[1] !== 0x00) return reject(new Error("SOCKS5: autenticação falhou"));
        step = "connect";
        sendConnect();
        return;
      }
      if (step === "connect") {
        if (data[1] !== 0x00) return reject(new Error(`SOCKS5 CONNECT falhou: código ${data[1]}`));
        resolve(socket);
      }
    });

    function sendConnect() {
      const hostBuf = Buffer.from(targetHost);
      const portBuf = Buffer.alloc(2);
      portBuf.writeUInt16BE(targetPort);
      socket.write(Buffer.concat([
        Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
        hostBuf,
        portBuf,
      ]));
    }

    socket.on("error", reject);
    socket.setTimeout(10000, () => {
      socket.destroy();
      reject(new Error("Timeout ao conectar no proxy SOCKS5"));
    });
  });
}

// ════════════════════════════════════════════════════════════════════════════
//  REQUISIÇÃO COM PROXY + RETRY
// ════════════════════════════════════════════════════════════════════════════

async function fetchViaProxy(targetUrl, maxRetries = 3) {
  const parsed  = new url.URL(targetUrl);
  const isHttps = parsed.protocol === "https:";
  const host    = parsed.hostname;
  const port    = parseInt(parsed.port) || (isHttps ? 443 : 80);
  const path    = parsed.pathname + parsed.search;

  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const proxy = proxyManager.getNext();

    if (!proxy) return directFetch(targetUrl);

    try {
      const result = await fetchWithProxy(proxy, host, port, path, isHttps);
      proxyManager.markSuccess(proxy);
      return result;
    } catch (err) {
      lastError = err;
      proxyManager.markFailure(proxy, err.message);
      console.warn(`↩️  Tentativa ${attempt + 1} falhou (${maskProxyUrl(proxy.url)}): ${err.message}`);

      // Delay crescente entre tentativas
      const delay = 1000 * (attempt + 1);
      await new Promise(r => setTimeout(r, delay));
    }
  }

  // Se os proxies estiverem fora do ar, tenta direto por padrão.
  // Para desativar: DIRECT_FALLBACK=false npm start
  if (process.env.DIRECT_FALLBACK !== "false") {
    console.warn("⚠️  Todos os proxies falharam. Tentando requisição direta como fallback.");
    return directFetch(targetUrl);
  }

  throw new Error(`Falhou após ${maxRetries + 1} tentativas. Último erro: ${lastError?.message}`);
}

function fetchWithProxy(proxy, host, port, path, isHttps) {
  return new Promise(async (resolve, reject) => {
    let socket;
    try {
      socket = await createTunnel(proxy.url, host, port);
    } catch (err) {
      return reject(new Error(`Tunnel falhou: ${err.message}`));
    }

    const headers = getBrowserHeaders();
    const reqOptions = {
      host, path, headers, method: "GET",
      createConnection: () => {
        if (isHttps) {
          const tls = require("tls");
          return tls.connect({ socket, servername: host, rejectUnauthorized: true });
        }
        return socket;
      },
    };

    const protocol = isHttps ? https : http;
    const req = protocol.request(reqOptions, async (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        socket.destroy();
        return reject(new Error(`Redirecionado (${res.statusCode}) — location: ${res.headers.location || "sem location"}`));
      }

      try {
        const body = await readResponseBody(res);
        resolve({ status: res.statusCode, body });
      } catch (err) {
        reject(new Error(`Falha ao ler/descompactar resposta: ${err.message}`));
      }
    });

    req.on("error", (err) => { socket.destroy(); reject(err); });
    req.setTimeout(12000, () => {
      req.destroy(); socket.destroy();
      reject(new Error("Timeout na requisição"));
    });
    req.end();
  });
}

function directFetch(targetUrl) {
  return new Promise((resolve, reject) => {
    console.warn("⚠️  Requisição direta.");

    const parsed = new url.URL(targetUrl);
    const protocol = parsed.protocol === "http:" ? http : https;

    const req = protocol.get(targetUrl, { headers: getBrowserHeaders(), timeout: 12000 }, async (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        return reject(new Error(`Redirecionado (${res.statusCode}) — location: ${res.headers.location || "sem location"}`));
      }

      try {
        const body = await readResponseBody(res);
        resolve({ status: res.statusCode, body });
      } catch (err) {
        reject(new Error(`Falha ao ler/descompactar resposta: ${err.message}`));
      }
    });

    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("Timeout direto")));
  });
}

// ════════════════════════════════════════════════════════════════════════════
//  LÓGICA DO INSTAGRAM
// ════════════════════════════════════════════════════════════════════════════

async function fetchInstagramProfile(username) {
  // Verifica cache primeiro
  const cached = cacheGet(username);
  if (cached) return cached;

  const igUrl = `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;
  const { status, body } = await fetchViaProxy(igUrl);

  if (status === 429) throw new Error("Instagram bloqueou temporariamente (429). Tente em alguns minutos.");
  if (status !== 200) throw new Error(`Instagram retornou status ${status}`);

  let json;
  try {
    json = JSON.parse(body);
  } catch {
    throw new Error("Resposta inválida do Instagram — provavelmente bloqueado");
  }

  const user = json?.data?.user;
  if (!user) throw new Error("Usuário não encontrado ou perfil privado");

  const profile = {
    username:           user.username,
    full_name:          user.full_name,
    biography:          user.biography,
    is_private:         user.is_private,
    is_verified:        user.is_verified,
    followers:          user.edge_followed_by?.count ?? null,
    following:          user.edge_follow?.count ?? null,
    posts_count:        user.edge_owner_to_timeline_media?.count ?? null,
    profile_pic_url:    user.profile_pic_url,
    profile_pic_url_hd: user.profile_pic_url_hd,
    external_url:       user.external_url ?? null,
  };

  // Salva no cache
  cacheSet(username, profile);
  return profile;
}

function validateUsername(username) {
  return /^[\w.]{1,30}$/.test(username);
}

function getImageHeaders() {
  const headers = getBrowserHeaders();
  delete headers["Accept-Encoding"];
  headers.Accept = "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8";
  return headers;
}

function streamImage(imageUrl, res, redirects = 0) {
  if (redirects > 5) {
    return res.status(508).json({ ok: false, error: "Muitos redirects ao buscar a imagem." });
  }

  const parsed = new url.URL(imageUrl);
  const protocol = parsed.protocol === "http:" ? http : https;

  const req = protocol.get(imageUrl, { headers: getImageHeaders(), timeout: 12000 }, (imgRes) => {
    if ([301, 302, 303, 307, 308].includes(imgRes.statusCode)) {
      const location = imgRes.headers.location;
      imgRes.resume();
      if (!location) return res.status(502).json({ ok: false, error: "Redirect da imagem sem location." });
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
    res.setHeader("Cache-Control", "public, max-age=3600");
    imgRes.pipe(res);
  });

  req.on("error", (err) => {
    if (!res.headersSent) res.status(502).json({ ok: false, error: `Erro ao buscar imagem: ${err.message}` });
  });
  req.on("timeout", () => req.destroy(new Error("Timeout ao buscar imagem")));
}

// ════════════════════════════════════════════════════════════════════════════
//  ROTAS
// ════════════════════════════════════════════════════════════════════════════

app.get("/", (req, res) => {
  res.json({
    name: "Instagram Profile Pic API",
    endpoints: {
      "GET /profile/:username":   "JSON completo do perfil",
      "GET /pic/:username":       "Redirect para foto em HD",
      "GET /pic-proxy/:username": "Proxy da foto (resolve CORS)",
      "GET /proxies/status":      "Status do pool de proxies",
      "GET /cache/status":        "Status do cache",
    },
  });
});

app.get("/profile/:username", async (req, res) => {
  const { username } = req.params;
  if (!validateUsername(username))
    return res.status(400).json({ error: "Username inválido." });

  try {
    const profile = await fetchInstagramProfile(username);
    if (profile.is_private)
      return res.status(403).json({ error: "Perfil privado.", username: profile.username });
    return res.json({ ok: true, data: profile });
  } catch (err) {
    const status = err.message.includes("429") ? 429 : 500;
    return res.status(status).json({ ok: false, error: err.message });
  }
});

app.get("/pic/:username", async (req, res) => {
  const { username } = req.params;
  if (!validateUsername(username))
    return res.status(400).json({ error: "Username inválido." });

  try {
    const profile = await fetchInstagramProfile(username);
    if (profile.is_private) return res.status(403).json({ error: "Perfil privado." });
    return res.redirect(profile.profile_pic_url_hd || profile.profile_pic_url);
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/pic-proxy/:username", async (req, res) => {
  const { username } = req.params;
  if (!validateUsername(username))
    return res.status(400).json({ error: "Username inválido." });

  try {
    const profile = await fetchInstagramProfile(username);
    if (profile.is_private) return res.status(403).json({ error: "Perfil privado." });

    const imageUrl = profile.profile_pic_url_hd || profile.profile_pic_url;
    return streamImage(imageUrl, res);
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/proxies/status", (req, res) => {
  res.json(proxyManager.getStatus());
});

// Novo: status do cache
app.get("/cache/status", (req, res) => {
  const now = Date.now();
  const entries = [...cache.entries()].map(([key, val]) => ({
    username: key,
    expiresIn: Math.ceil((val.expiresAt - now) / 1000) + "s",
  }));
  res.json({ total: cache.size, entries });
});

// Novo: limpar cache manualmente
app.delete("/cache", (req, res) => {
  cache.clear();
  res.json({ ok: true, message: "Cache limpo." });
});

app.listen(PORT, () => {
  console.log(`\n🚀 Servidor rodando em http://localhost:${PORT}`);
  console.log(`💾 Cache ativo — TTL: 1 hora`);
  console.log(`📸 Teste: http://localhost:${PORT}/profile/cristiano\n`);
});
