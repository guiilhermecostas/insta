const express  = require("express");
const https    = require("https");
const http     = require("http");
const net      = require("net");
const url      = require("url");
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
      console.warn(`↩️  Tentativa ${attempt + 1} falhou (${proxy.url}): ${err.message}`);

      // Delay crescente entre tentativas
      const delay = 1000 * (attempt + 1);
      await new Promise(r => setTimeout(r, delay));
    }
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
    const req = protocol.request(reqOptions, (res) => {
      let data = "";
      if (res.statusCode === 301 || res.statusCode === 302) {
        socket.destroy();
        return reject(new Error(`Redirecionado (${res.statusCode}) — bloqueado`));
      }
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
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
    console.warn("⚠️  Nenhum proxy disponível. Requisição direta.");
    const req = https.get(targetUrl, { headers: getBrowserHeaders(), timeout: 10000 }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    req.on("timeout", () => reject(new Error("Timeout direto")));
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
    https.get(imageUrl, { headers: getBrowserHeaders() }, (imgRes) => {
      res.setHeader("Content-Type", imgRes.headers["content-type"] || "image/jpeg");
      res.setHeader("Cache-Control", "public, max-age=3600");
      imgRes.pipe(res);
    });
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
