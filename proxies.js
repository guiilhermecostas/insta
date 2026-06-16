// ════════════════════════════════════════════════════════════════════════════
//  proxies.js  —  Sua lista de proxies
//  Adicione seus proxies aqui no formato:
//    "protocolo://usuario:senha@host:porta"
//    "protocolo://host:porta"  (sem autenticação)
//
//  Protocolos suportados: http, https, socks5
// ════════════════════════════════════════════════════════════════════════════

module.exports = [
  // Exemplos HTTP com autenticação:
  // "http://usuario:senha@192.168.1.100:8080",
  // "http://usuario:senha@192.168.1.101:8080",

  // Exemplos SOCKS5:
  // "socks5://usuario:senha@10.0.0.1:1080",
  // "socks5://usuario:senha@10.0.0.2:1080",

  // Sem autenticação:
  // "http://177.93.50.12:999",
  // "http://103.83.232.122:80",

  // ── Coloque seus proxies reais abaixo ──
  "http://user1:pass1@proxy1.exemplo.com:8080",
  "http://user2:pass2@proxy2.exemplo.com:8080",
  "socks5://user3:pass3@proxy3.exemplo.com:1080",
];
