// ════════════════════════════════════════════════════════════════════════════
//  proxy-manager.js
//  Gerencia um pool de proxies HTTP/SOCKS5 com rotação automática,
//  detecção de falha e cooldown por proxy bloqueado.
// ════════════════════════════════════════════════════════════════════════════

class ProxyManager {
  /**
   * @param {string[]} proxyList - Lista de proxies no formato:
   *   "http://user:pass@host:port"
   *   "socks5://user:pass@host:port"
   *   "http://host:port"  (sem autenticação)
   */
  constructor(proxyList = []) {
    this.proxies = proxyList.map((url) => ({
      url,
      failures: 0,          // contagem de falhas consecutivas
      blockedUntil: null,   // timestamp de quando pode ser usado novamente
      totalRequests: 0,
      totalFailures: 0,
    }));

    this.currentIndex = 0;
    this.COOLDOWN_MS = 5 * 60 * 1000;   // 5 min de cooldown após bloqueio
    this.MAX_FAILURES = 3;               // falhas consecutivas antes de cooldown
  }

  // ── Retorna o próximo proxy disponível (round-robin, pula os em cooldown) ──
  getNext() {
    if (this.proxies.length === 0) return null;

    const now = Date.now();
    let attempts = 0;

    while (attempts < this.proxies.length) {
      const proxy = this.proxies[this.currentIndex];
      this.currentIndex = (this.currentIndex + 1) % this.proxies.length;

      // Verifica se o proxy está em cooldown
      if (proxy.blockedUntil && now < proxy.blockedUntil) {
        attempts++;
        continue;
      }

      // Saiu do cooldown — reseta o estado
      if (proxy.blockedUntil && now >= proxy.blockedUntil) {
        proxy.blockedUntil = null;
        proxy.failures = 0;
      }

      return proxy;
    }

    // Todos em cooldown — retorna o que vai sair do cooldown primeiro
    const soonest = this.proxies.reduce((a, b) =>
      (a.blockedUntil || 0) < (b.blockedUntil || 0) ? a : b
    );
    console.warn(`⚠️  Todos os proxies em cooldown. Usando ${soonest.url} mesmo assim.`);
    return soonest;
  }

  // ── Marca um proxy como bem-sucedido ────────────────────────────────────────
  markSuccess(proxy) {
    proxy.failures = 0;
    proxy.totalRequests++;
  }

  // ── Marca um proxy como falho; coloca em cooldown se necessário ─────────────
  markFailure(proxy, reason = "") {
    proxy.failures++;
    proxy.totalRequests++;
    proxy.totalFailures++;

    if (proxy.failures >= this.MAX_FAILURES) {
      proxy.blockedUntil = Date.now() + this.COOLDOWN_MS;
      console.warn(
        `🚫 Proxy ${this.maskUrl(proxy.url)} em cooldown por ${this.COOLDOWN_MS / 1000}s. Razão: ${reason}`
      );
    }
  }

  maskUrl(proxyUrl = "") {
    return proxyUrl.replace(/\/\/[^@]+@/, "//***:***@");
  }

  // ── Status geral do pool (útil para o endpoint /proxies/status) ─────────────
  getStatus() {
    const now = Date.now();
    return {
      total: this.proxies.length,
      available: this.proxies.filter(
        (p) => !p.blockedUntil || now >= p.blockedUntil
      ).length,
      proxies: this.proxies.map((p) => ({
        url: this.maskUrl(p.url), // esconde usuário e senha
        status:
          p.blockedUntil && now < p.blockedUntil
            ? `cooldown (${Math.ceil((p.blockedUntil - now) / 1000)}s restantes)`
            : "ok",
        failures: p.failures,
        totalRequests: p.totalRequests,
        totalFailures: p.totalFailures,
        successRate:
          p.totalRequests > 0
            ? `${(((p.totalRequests - p.totalFailures) / p.totalRequests) * 100).toFixed(1)}%`
            : "n/a",
      })),
    };
  }
}

module.exports = ProxyManager;
