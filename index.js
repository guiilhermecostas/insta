const express = require("express");
const https = require("https");

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Headers que imitam um navegador real ────────────────────────────────────
const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/124.0.0.0 Safari/537.36",
  Accept: "*/*",
  "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8",
  "Accept-Encoding": "gzip, deflate, br",
  Referer: "https://www.instagram.com/",
  "x-ig-app-id": "936619743392459",
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-origin",
};

// ─── Função utilitária: faz uma requisição HTTPS e retorna Promise ───────────
function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: { ...BROWSER_HEADERS, ...headers },
      timeout: 10000,
    };

    https
      .get(url, options, (res) => {
        let data = "";

        // Rejeita redirecionamentos para login (significa que foi bloqueado)
        if (res.statusCode === 302 || res.statusCode === 301) {
          return reject(
            new Error(
              `Redirecionado (${res.statusCode}) — Instagram pode estar bloqueando a requisição`
            )
          );
        }

        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      })
      .on("error", reject)
      .on("timeout", () => reject(new Error("Timeout na requisição")));
  });
}

// ─── Busca dados do perfil pelo endpoint interno do Instagram ────────────────
async function fetchInstagramProfile(username) {
  const url = `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(
    username
  )}`;

  const { status, body } = await httpsGet(url);

  if (status !== 200) {
    throw new Error(`Instagram retornou status ${status}`);
  }

  let json;
  try {
    json = JSON.parse(body);
  } catch {
    throw new Error("Resposta do Instagram não é um JSON válido — provavelmente bloqueado");
  }

  const user = json?.data?.user;
  if (!user) {
    throw new Error("Usuário não encontrado ou perfil privado");
  }

  return {
    username: user.username,
    full_name: user.full_name,
    biography: user.biography,
    is_private: user.is_private,
    is_verified: user.is_verified,
    followers: user.edge_followed_by?.count ?? null,
    following: user.edge_follow?.count ?? null,
    posts_count: user.edge_owner_to_timeline_media?.count ?? null,
    profile_pic_url: user.profile_pic_url,         // thumbnail (baixa qualidade)
    profile_pic_url_hd: user.profile_pic_url_hd,   // alta qualidade (quando disponível)
    external_url: user.external_url ?? null,
  };
}

// ════════════════════════════════════════════════════════════════════════════
//  ROTAS
// ════════════════════════════════════════════════════════════════════════════

// GET /profile/:username  →  retorna JSON completo do perfil
app.get("/profile/:username", async (req, res) => {
  const { username } = req.params;

  // Valida o username (só letras, números, ponto e underscore)
  if (!/^[\w.]{1,30}$/.test(username)) {
    return res.status(400).json({
      error: "Username inválido. Use apenas letras, números, _ e .",
    });
  }

  try {
    const profile = await fetchInstagramProfile(username);

    if (profile.is_private) {
      return res.status(403).json({
        error: "Este perfil é privado. Não é possível acessar os dados.",
        username: profile.username,
      });
    }

    return res.json({ ok: true, data: profile });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /pic/:username  →  redireciona direto para a URL da foto de perfil (HD)
app.get("/pic/:username", async (req, res) => {
  const { username } = req.params;

  if (!/^[\w.]{1,30}$/.test(username)) {
    return res.status(400).json({ error: "Username inválido." });
  }

  try {
    const profile = await fetchInstagramProfile(username);

    if (profile.is_private) {
      return res.status(403).json({ error: "Perfil privado." });
    }

    const imageUrl = profile.profile_pic_url_hd || profile.profile_pic_url;

    // Opção 1: redireciona o browser direto para a imagem
    return res.redirect(imageUrl);
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /pic-proxy/:username  →  faz proxy da imagem (evita problema de CORS)
app.get("/pic-proxy/:username", async (req, res) => {
  const { username } = req.params;

  if (!/^[\w.]{1,30}$/.test(username)) {
    return res.status(400).json({ error: "Username inválido." });
  }

  try {
    const profile = await fetchInstagramProfile(username);

    if (profile.is_private) {
      return res.status(403).json({ error: "Perfil privado." });
    }

    const imageUrl = profile.profile_pic_url_hd || profile.profile_pic_url;

    // Faz o download da imagem e repassa como resposta (útil para front-end)
    https.get(imageUrl, { headers: BROWSER_HEADERS }, (imgRes) => {
      res.setHeader("Content-Type", imgRes.headers["content-type"] || "image/jpeg");
      res.setHeader("Cache-Control", "public, max-age=3600");
      imgRes.pipe(res);
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /  →  página de ajuda
app.get("/", (req, res) => {
  res.json({
    name: "Instagram Profile Pic API",
    endpoints: {
      "GET /profile/:username": "Retorna JSON com dados do perfil",
      "GET /pic/:username": "Redireciona para a foto de perfil em HD",
      "GET /pic-proxy/:username": "Faz proxy da foto (resolve CORS)",
    },
    examples: [
      "/profile/cristiano",
      "/pic/cristiano",
      "/pic-proxy/cristiano",
    ],
    aviso:
      "⚠️  Este projeto é apenas educacional. O Instagram pode bloquear requisições a qualquer momento. Não use em produção.",
  });
});

// ─── Inicializa o servidor ───────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 Servidor rodando em http://localhost:${PORT}`);
  console.log(`📸 Teste: http://localhost:${PORT}/profile/cristiano\n`);
});
