const express = require('express');
const path = require('path');
const { Readable } = require('stream');

const app = express();
const PORT = process.env.PORT || 8788;

// Hosts que o proxy tem permissão de repassar. Evita virar um proxy aberto
// que qualquer site poderia usar para bater em endereços arbitrários.
const ALLOWED_HOSTS = null; // null = sem restrição (uso local); troque por um array em produção.

app.use(express.static(path.join(__dirname, 'public')));

function isAllowed(targetUrl) {
  if (!ALLOWED_HOSTS) return true;
  try {
    const { hostname } = new URL(targetUrl);
    return ALLOWED_HOSTS.includes(hostname);
  } catch {
    return false;
  }
}

function proxied(targetUrl) {
  return `/api/proxy?url=${encodeURIComponent(targetUrl)}`;
}

function isPlaylist(contentType, targetUrl) {
  return (
    /mpegurl|m3u/i.test(contentType || '') ||
    /\.m3u8(\?|$)/i.test(targetUrl)
  );
}

// Uma playlist M3U "crua" (diretório de canais, ex.: index.m3u do iptv-org) só
// tem #EXTINF apontando pra streams inteiros. Um manifesto HLS de verdade
// (master ou media playlist) sempre tem alguma tag #EXT-X-. Só reescrevemos
// linhas no segundo caso — no primeiro, o cliente precisa das URLs absolutas
// originais para guardar como canal; ele mesmo aplica o proxy na hora de tocar.
function isHlsManifest(body) {
  return /^#EXT-X-/m.test(body);
}

function rewritePlaylist(body, targetUrl) {
  const base = new URL(targetUrl);
  return body
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return line;
      try {
        const resolved = new URL(trimmed, base).toString();
        return proxied(resolved);
      } catch {
        return line;
      }
    })
    .join('\n');
}

app.get('/api/proxy', async (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).send('Parâmetro "url" ausente.');
  if (!isAllowed(target)) return res.status(403).send('Host não permitido.');

  try {
    const upstreamHeaders = { 'User-Agent': 'Mozilla/5.0 (IPTV-Player-Proxy)' };
    // <video> pede Range pra saber se o recurso é buscável (seek) e, no caso
    // de MP4, geralmente lê o fim do arquivo primeiro (átomo moov). Sem
    // repassar isso e sem devolver 206/Content-Range, o elemento trava em
    // "carregando" pra sempre — mesmo que o download em si funcione.
    if (req.headers.range) upstreamHeaders.Range = req.headers.range;

    const upstream = await fetch(target, { headers: upstreamHeaders });

    res.set('Access-Control-Allow-Origin', '*');

    if (!upstream.ok) {
      return res.status(upstream.status).send(`Upstream respondeu ${upstream.status}`);
    }

    const contentType = upstream.headers.get('content-type') || '';
    // upstream.url é a URL final após redirects (comum em CDNs de IPTV que
    // mandam o manifesto real para outro host/porta com token assinado) —
    // os caminhos relativos dentro do manifesto são relativos a ELA, não à
    // URL original pedida.
    const finalUrl = upstream.url || target;

    if (isPlaylist(contentType, finalUrl)) {
      const text = await upstream.text();
      res.set('Content-Type', 'application/vnd.apple.mpegurl');
      return res.send(isHlsManifest(text) ? rewritePlaylist(text, finalUrl) : text);
    }

    res.status(upstream.status); // propaga 200 ou 206 (partial content)
    res.set('Content-Type', contentType || 'application/octet-stream');
    const contentLength = upstream.headers.get('content-length');
    const contentRange = upstream.headers.get('content-range');
    const acceptRanges = upstream.headers.get('accept-ranges');
    if (contentLength) res.set('Content-Length', contentLength);
    if (contentRange) res.set('Content-Range', contentRange);
    if (acceptRanges) res.set('Accept-Ranges', acceptRanges);

    // Streams de TV ao vivo (.ts) nunca terminam — repassa em tempo real
    // em vez de bufferizar tudo antes de responder.
    Readable.fromWeb(upstream.body)
      .on('error', () => res.end())
      .pipe(res);
    return;
  } catch (err) {
    return res.status(502).send(`Erro ao acessar upstream: ${err.message}`);
  }
});

app.listen(PORT, () => {
  console.log(`Player IPTV rodando em http://localhost:${PORT}`);
});
