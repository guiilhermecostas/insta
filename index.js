const express  = require("express");
const https    = require("https");
const http     = require("http");
const net      = require("net");
const url      = require("url");

const ProxyManager = require("./proxy-manager");
const proxyList    = require("./proxies");

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Inicializa o pool de proxies ────────────────────────────────────────────
const proxyManager = new ProxyManager(proxyList);
console.log(`🔌 Pool de proxies inicializado com ${proxyList.length} proxies`);

// ─── User-Agents para rotacionar junto com os proxies ────────────────────────
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

/**
 * Cria um socket tunelado via proxy HTTP CONNECT (para requisições HTTPS).
 * Suporta proxies HTTP e SOCKS5.
 */
function createTunnel(proxyUrl, targetHost, targetPort) {
  return new Promise((resolve, reject) => {
    const parsed = new url.URL(proxyUrl);
    const isSocks5 = parsed.protocol === "socks5:";

    if (isSocks5) {
      return createSocks5Tunnel(parsed, targetHost, targetPort)
        .then(resolve)
        .catch(reject);
    }

    // ── Proxy HTTP via CONNECT ────────────────────────────────────────────
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
      "",
      "",
    ]
      .filter((l) => l !== undefined)
      .join("\r\n");

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

/**
 * Cria um túnel SOCKS5 manual (sem biblioteca externa).
 */
function createSocks5Tunnel(parsed, targetHost, targetPort) {
  return new Promise((resolve, reject) => {
    const proxyPort = parseInt(parsed.port) || 1080;
    const proxyHost = parsed.hostname;
    const hasAuth   = !!parsed.username;

    const socket = net.connect(proxyPort, proxyHost, () => {
      // Handshake SOCKS5 — negocia autenticação
      const authMethod = hasAuth ? 0x02 : 0x00;
      socket.write(Buffer.from([0x05, 0x01, authMethod]));
    });

    let step = "auth-negotiation";

    socket.on("data", (data) => {
      if (step === "auth-negotiation") {
        if (data[0] !== 0x05) return reject(new Error("Resposta SOCKS5 inválida"));

        if (data[1] === 0x02 && hasAuth) {
          // Envia usuário e senha
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
      const hostBuf  = Buffer.from(targetHost);
      const portBuf  = Buffer.alloc(2);
      portBuf.writeUInt16BE(targetPort);

      const connectBuf = Buffer.concat([
        Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
        hostBuf,
        portBuf,
      ]);
      socket.write(connectBuf);
    }

    socket.on("error", reject);
    socket.setTimeout(10000, () => {
      socket.destroy();
      reject(new Error("Timeout ao conectar no proxy SOCKS5"));
    });
  });
}

// ════════════════════════════════════════════════════════════════════════════
//  REQUISIÇÃO COM PROXY + RETRY AUTOMÁTICO
// ════════════════════════════════════════════════════════════════════════════

/**
 * Faz GET via proxy. Se falhar, tenta o próximo proxy automaticamente.
 * @param {string} targetUrl - URL de destino
 * @param {number} maxRetries - Quantas trocas de proxy tentar
 */
async function fetchViaProxy(targetUrl, maxRetries = 3) {
  const parsed  = new url.URL(targetUrl);
  const isHttps = parsed.protocol === "https:";
  const host    = parsed.hostname;
  const port    = parseInt(parsed.port) || (isHttps ? 443 : 80);
  const path    = parsed.pathname + parsed.search;

  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const proxy = proxyManager.getNext();

    // Se não houver proxies configurados, faz requisição direta
    if (!proxy) {
      return directFetch(targetUrl);
    }

    try {
      const result = await fetchWithProxy(proxy, host, port, path, isHttps);
      proxyManager.markSuccess(proxy);
      return result;
    } catch (err) {
      lastError = err;
      const isBlocked =
        err.message.includes("302") ||
        err.message.includes("401") ||
        err.message.includes("403") ||
        err.message.includes("CONNECT falhou");

      proxyManager.markFailure(proxy, err.message);
      console.warn(`↩️  Tentativa ${attempt + 1} falhou (proxy: ${proxy.url}): ${err.message}`);
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
      host,
      path,
      headers,
      method: "GET",
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
        return reject(new Error(`Redirecionado (${res.statusCode}) — proxy bloqueado ou Instagram detectou`));
      }

      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });

    req.on("error", (err) => {
      socket.destroy();
      reject(err);
    });

    req.setTimeout(12000, () => {
      req.destroy();
      socket.destroy();
      reject(new Error("Timeout na requisição"));
    });

    req.end();
  });
}

// Fallback: requisição direta sem proxy
function directFetch(targetUrl) {
  return new Promise((resolve, reject) => {
    console.warn("⚠️  Nenhum proxy disponível. Fazendo requisição direta.");
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
  const igUrl = `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;

  const { status, body } = await fetchViaProxy(igUrl);

  if (status !== 200) {
    throw new Error(`Instagram retornou status ${status}`);
  }

  let json;
  try {
    json = JSON.parse(body);
  } catch {
    throw new Error("Resposta inválida do Instagram — provavelmente bloqueado");
  }

  const user = json?.data?.user;
  if (!user) throw new Error("Usuário não encontrado ou perfil privado");

  return {
    username:         user.username,
    full_name:        user.full_name,
    biography:        user.biography,
    is_private:       user.is_private,
    is_verified:      user.is_verified,
    followers:        user.edge_followed_by?.count ?? null,
    following:        user.edge_follow?.count ?? null,
    posts_count:      user.edge_owner_to_timeline_media?.count ?? null,
    profile_pic_url:  user.profile_pic_url,
    profile_pic_url_hd: user.profile_pic_url_hd,
    external_url:     user.external_url ?? null,
  };
}

function validateUsername(username) {
  return /^[\w.]{1,30}$/.test(username);
}

// ════════════════════════════════════════════════════════════════════════════
//  ROTAS
// ════════════════════════════════════════════════════════════════════════════

// GET /  →  info + status dos proxies
app.get("/", (req, res) => {
  res.json({
    name: "Instagram Profile Pic API (com proxy rotation)",
    endpoints: {
      "GET /profile/:username":  "JSON completo do perfil",
      "GET /pic/:username":      "Redirect para foto em HD",
      "GET /pic-proxy/:username":"Proxy da foto (resolve CORS)",
      "GET /proxies/status":     "Status do pool de proxies",
    },
    examples: ["/profile/cristiano", "/pic/cristiano", "/proxies/status"],
  });
});

// GET /profile/:username
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
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /pic/:username  →  redirect para a imagem
app.get("/pic/:username", async (req, res) => {
  const { username } = req.params;
  if (!validateUsername(username))
    return res.status(400).json({ error: "Username inválido." });

  try {
    const profile = await fetchInstagramProfile(username);
    if (profile.is_private)
      return res.status(403).json({ error: "Perfil privado." });

    return res.redirect(profile.profile_pic_url_hd || profile.profile_pic_url);
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /pic-proxy/:username  →  serve a imagem diretamente (resolve CORS)
app.get("/pic-proxy/:username", async (req, res) => {
  const { username } = req.params;
  if (!validateUsername(username))
    return res.status(400).json({ error: "Username inválido." });

  try {
    const profile = await fetchInstagramProfile(username);
    if (profile.is_private)
      return res.status(403).json({ error: "Perfil privado." });

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

// GET /proxies/status  →  saúde do pool de proxies
app.get("/proxies/status", (req, res) => {
  res.json(proxyManager.getStatus());
});

// ─── Start ──────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 Servidor rodando em http://localhost:${PORT}`);
  console.log(`📸 Teste: http://localhost:${PORT}/profile/cristiano`);
  console.log(`🔌 Status dos proxies: http://localhost:${PORT}/proxies/status\n`);
});
