// A deliberately tiny HTTP backend. Zero dependencies.
//
// Its whole job is to be honest about what it sees, because almost every
// reverse-proxy concept in these labs is really a question of "what did the
// backend actually receive?"  Run three of these and you have something worth
// putting a proxy in front of.

const http = require('http');

const id = process.env.BACKEND_ID || '0';
const port = Number(process.env.PORT || 3000);
// Optional artificial latency, used later to make least_conn observable.
const delayMs = Number(process.env.DELAY_MS || 0);

const server = http.createServer((req, res) => {
  const seen = {
    backend: id,
    port,
    method: req.method,
    path: req.url,
    // The three fields that teach Lab 1:
    clientIpAsSeenByMe: req.socket.remoteAddress,
    hostHeader: req.headers.host,
    xForwardedFor: req.headers['x-forwarded-for'] || null,
    xRealIp: req.headers['x-real-ip'] || null,
    xForwardedProto: req.headers['x-forwarded-proto'] || null,
    xForwardedHost: req.headers['x-forwarded-host'] || null,
    httpVersion: req.httpVersion,
    connectionHeader: req.headers['connection'] || null,
    // Everything, so the instrument can never hide something from us again.
    // The curated fields above are just conveniences for the common questions.
    allHeaders: req.headers,
  };

  console.log(
    `[backend ${id}] ${req.method} ${req.url}  from=${seen.clientIpAsSeenByMe}  host=${seen.hostHeader}  xff=${seen.xForwardedFor ?? '(none)'}`
  );

  // Lab 5: target of nginx's auth_request subrequest. 200 = allow, 401 = deny.
  if (req.url.startsWith('/authcheck')) {
    const allowed = Boolean(req.headers['x-api-key']);
    console.log(`[backend ${id}] authcheck -> ${allowed ? 200 : 401}`);
    res.writeHead(allowed ? 200 : 401).end();
    return;
  }

  // Lab 6: SSE stream, one event per second. Buffering makes these arrive in
  // clumps instead of live — the whole point of the streaming section.
  if (req.url.startsWith('/stream')) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    let n = 0;
    const timer = setInterval(() => {
      res.write(`data: tick ${++n} from backend ${id}\n\n`);
      if (n >= 30) { clearInterval(timer); res.end(); }
    }, 1000);
    req.on('close', () => clearInterval(timer));
    return;
  }

  // Lab 6: a request slow enough to still be in flight during a restart.
  if (req.url.startsWith('/slow')) {
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ backend: id, note: 'slow request completed' }) + '\n');
    }, 10000);
    return;
  }

  const respond = () => {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      // So we can see which backend served a response without reading the body.
      'X-Served-By': `backend-${id}`,
    });
    res.end(JSON.stringify(seen, null, 2) + '\n');
  };

  if (delayMs > 0) setTimeout(respond, delayMs);
  else respond();
});

server.listen(port, () => {
  console.log(`[backend ${id}] listening on http://127.0.0.1:${port}  (delay=${delayMs}ms)`);
});

// Lab 6 revisits this: how a process shuts down determines whether in-flight
// requests survive a deploy.
process.on('SIGTERM', () => {
  console.log(`[backend ${id}] SIGTERM - closing after in-flight requests drain`);
  server.close(() => process.exit(0));
});
