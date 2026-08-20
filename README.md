# nginx-lab

Companion labs for my post on load balancers, reverse proxies and API gateways:
one machine wearing three job titles. Every claim in the post was observed by
running these configs, and you can reproduce all of it on a laptop with nginx
and Node installed. No sudo needed anywhere.

## Setup

```bash
brew install nginx jq        # macOS; any nginx >= 1.25 works
```

Terminal A, start three tiny backends on :3001-:3003 that report exactly what
they receive:

```bash
labs/00-backends/run.sh
```

## Running a lab

Each lab is a self-contained nginx instance. Start it with the lab directory as
the prefix, and every path stays inside that directory:

```bash
LAB=labs/01-reverse-proxy
mkdir -p $LAB/logs $LAB/tmp
nginx -p $PWD/$LAB -c $PWD/$LAB/nginx.conf -t && nginx -p $PWD/$LAB -c $PWD/$LAB/nginx.conf
curl -s localhost:8080/hello | jq
```

Stop it with the same flags: `nginx -p $PWD/$LAB -c $PWD/$LAB/nginx.conf -s quit`.

## The labs

| Lab | What it demonstrates |
|---|---|
| `00-backends` | three backends that echo the request they received |
| `01-reverse-proxy` | `proxy_pass`, what the naive config destroys, and the repair-kit headers (`nginx.conf` vs `nginx-fixed.conf`) |
| `02-load-balancer` | one `upstream` block turns the proxy into a load balancer; round robin, failover, passive health checks |
| `03-l4-vs-l7` | the same backends behind `http` (:8080) and `stream` (:9090); L4 cannot see the path |
| `04-tls` | TLS terminates at the proxy, the backend hop stays plaintext (generate certs first, see below) |
| `05-api-gateway` | path routing, rate limiting, auth subrequest, response caching |
| `06-streaming` | read timeouts, SSE buffering, the WebSocket upgrade, graceful vs violent shutdown |

Lab 04 needs a self-signed certificate:

```bash
mkdir -p labs/04-tls/certs
openssl req -x509 -newkey rsa:2048 -nodes -days 365 -subj "/CN=localhost" \
  -keyout labs/04-tls/certs/key.pem -out labs/04-tls/certs/cert.pem
```

Only one lab runs at a time since they all use port 8080. Quit the previous
lab's nginx before starting the next.
