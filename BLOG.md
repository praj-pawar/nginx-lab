# Load balancer, reverse proxy, API gateway: one machine wearing three job titles

They say if you throw a stone in Bangalore you will probably hit a backend engineer. But how many of them can actually explain the difference between a load balancer, a reverse proxy and an API gateway in a real production system?

Most of the writing on the internet is generic - a load balancer distributes traffic, a reverse proxy sits in front of your server and an API gateway handles auth and rate limiting. All three are true and all three are true of the same piece of software! Then the same cloud vendor sells you all three as separate products so naturally we assume there are three things.

There is actually one thing and there are three problems people were trying to solve when they named it.

So in this post I want to build all three up from first principles and show you how they are actually used in production. The way I get comfortable with a system is by taking it apart until it stops surprising me so I spent a few nights doing exactly that with nginx on my laptop, fronting three tiny backends that report exactly what they receive. What follows is what the machine does rather than what the docs say.

And at the end of the post, I get into how these pieces are actually wired together in the production systems I have worked with: the chains real traffic flows through, the patterns that never make it into the docs and the lessons that are usually learned the hard way, during an outage.

Every config is in [this repo](https://github.com/praj-pawar/nginx-lab). I would recommend running the labs yourself and getting your hands dirty because that is the part that makes any of this stick.

## First, let's get the basics cleared

A **reverse proxy** is the underlying capability. It accepts a client's connection, reads the request and then opens its own separate connection to a backend to fetch the response.

A **load balancer** IS a reverse proxy whose defining job is choosing which of several backends should handle each request.

An **API gateway** IS a reverse proxy whose defining job is enforcing policy; things like authentication, rate limits, quotas and request shaping.

> Reverse proxying is the capability. The other two are descriptions of what you are mostly using that capability for.

```
                    ┌─────────────────────────────┐
   clients  ───────►│      one reverse proxy      │───────►  backends
                    │                             │
                    │  picks a backend?  → we call it a load balancer
                    │  enforces policy?  → we call it an API gateway
                    └─────────────────────────────┘
```

This is why nginx can be all three. There is no load balancer mode to switch on. You write configuration that determines which of the three words the proxy falls under.

## Building a reverse proxy and watching it destroy information

Here is the smallest reverse proxy that works.

```nginx
server {
    listen 8080;
    location / {
        proxy_pass http://127.0.0.1:3001;
    }
}
```

`proxy_pass` is the whole thing. It changes this location from "serve something myself" into "open a connection to that address, ask it for this and relay the answer back". nginx is a server on the connection facing the client and a client on the connection facing the backend which is the most useful way to hold it in your head.

The part that matters is that these are **two independent TCP connections**. The proxy does not forward your packets. It terminates your connection, reads the request out of it and writes a fresh request into a socket of its own.

To see what survives that gap, I put a tiny backend on port 3001 that does nothing but report the request it receives, and point the config above at it from port 8080. Then I ask the same question twice, once bypassing nginx and once going through it.

```bash
curl localhost:3001/hello    # straight to the backend
curl localhost:8080/hello    # through nginx
```

Same path, same machine, two different answers about who is asking.

| What the backend sees | Direct | Through nginx |
|---|---|---|
| path | `/hello` | `/hello` |
| client IP | `::1` | `::ffff:127.0.0.1` |
| `Host` header | `localhost:3001` | `127.0.0.1:3001` |
| `X-Forwarded-For` | none | none |

Three things in that table are worth sitting with.

**The client IP changes and so does its address family.** The direct request arrives over IPv6 because that is what my resolver prefers. The proxied one arrives over IPv4 because the config names `127.0.0.1` explicitly. Two different protocol families is a clear demonstration that these are two different connections.

**The `Host` header is overwritten.** The client asks for `localhost:8080`. The backend is told `127.0.0.1:3001`. nginx rewrites `Host` to describe the upstream it is dialing so the hostname the user typed is gone by the time your application sees the request. Anything that builds a URL from `Host` now builds the wrong one.

**nginx adds no forwarding headers at all.** A reverse proxy is the thing that hides the client so you might expect it to compensate automatically. It does not. `X-Forwarded-For`, `X-Real-IP` and `X-Forwarded-Proto` are all opt-in.

The fix is the familiar block from every production nginx config, best understood as a repair kit for information the proxy destroys by design:

```nginx
location / {
    proxy_pass http://127.0.0.1:3001;

    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

With those four lines the backend finally learns the hostname the client asked for, the client's address and whether the original request used TLS.

I need you to understand this part. Adding those headers does **not** restore the client's IP address. The backend's socket still reports the proxy because the proxy genuinely is the thing connected to it. The headers are annotations written onto the request by a machine you happen to trust.

That matters because an IP address is a property of a TCP connection rather than part of an HTTP request. HTTP has no field for the sender's address which is why a convention had to be invented.

> Think of the HTTP request as a letter and the IP header as the envelope. A reverse proxy opens the envelope, takes out the letter, puts it in a new envelope with its own return address and sends it on. The letter arrives unchanged and the recipient sees the proxy's return address because the envelope was never forwarded in the first place.

`X-Forwarded-For` is the proxy copying the original return address onto the letter since the letter is the only part that travels the whole distance.

### Where this bites in real code

Express has a setting called `trust proxy` and it is `false` by default. While off, `req.ip` comes from the socket and you already know what the socket reports: the proxy. So when your app runs behind a load balancer, every user on the internet appears to have the same IP address, the load balancer's. Now look at a rate limiter on an OTP endpoint keyed on `req.ip` which is the obvious thing to write and what most examples show:

```js
const otpSendLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => req.ip ?? "unknown-ip",
});
```

Since every user shows up as the same IP, they all share one rate limit bucket. The limit you wrote as five requests per fifteen minutes per user is actually five requests per fifteen minutes **for the entire service**. Real users start receiving 429s caused by strangers.

The fix is one line and the value needs care:

```js
app.set("trust proxy", 2);   // the number of proxies in front, not `true`
```

`true` tells Express to trust the whole chain which lets a client forge `X-Forwarded-For` and defeat rate limiting on purpose. A hop count only trusts the proxies you actually operate.

The same setting governs two other things which is worth knowing because the symptoms look unrelated. An application that checks its own connection to decide whether the request was secure always sees plaintext because TLS ended at the proxy. So it emits `http://` links on a page served over HTTPS and it refuses to set the `Secure` flag on cookies. Three bugs caused due to one misconfig.

This is the practical reason to understand the two connection model rather than treating the proxy as a black box. The bug is invisible in application code, invisible in tests and invisible in local development where there is no proxy at all.

## Making it a load balancer

Turning that reverse proxy into a load balancer takes one block of config.

```nginx
upstream backend_pool {
    server 127.0.0.1:3001;
    server 127.0.0.1:3002;
    server 127.0.0.1:3003;
}

location / {
    proxy_pass http://backend_pool;
}
```

No new module and no different mode. `proxy_pass` now names a pool instead of an address. I run three copies of the same backend on ports 3001 to 3003, each replying with its own number, and send nine requests in a row. They come back `1 2 3 1 2 3 1 2 3`.

Round robin is the default and needs no directive which is why nothing in that config says so. Those nine requests come from nine separate processes over nine separate TCP connections and they still cycle in order. So the counter (in nginx memory) belongs to the pool rather than to any individual client which leads to the sentence worth remembering.

> Round robin distributes requests, not users.

One user making three requests reaches three different backends. That is exactly right for a stateless API and fatal for anything keeping session state in one process's memory.

Selection also happens per request rather than per connection. With keepalive enabled, one client connection carrying ten requests can have those ten spread across every backend in the pool.

### Choosing an algorithm

Round robin sends an equal number of requests to each backend and a request is a poor unit of load. When durations vary widely which they do the moment you have file uploads, slow queries or LLM calls in the mix, long requests accumulate on a server that keeps getting its turn regardless.

| Directive | Behavior | Reach for it when |
|---|---|---|
| none | round robin | requests are short and roughly uniform |
| `least_conn` | fewest active connections wins | request durations vary a lot |
| `ip_hash` | same client IP reaches the same backend | you need stickiness and can live with the caveats |
| `hash $key consistent` | consistent hashing on a key you choose | stickiness plus a pool that changes size |
| `random two least_conn` | pick two at random, use the less busy | large pools, cheap and effective |

The distinction between the two sticky options is the one worth knowing. `ip_hash` maps a key to a server by taking a hash modulo the number of servers so adding a fourth server to a pool of three changes the modulus and sends most keys somewhere new. Consistent hashing places servers around a ring so adding one moves roughly a quarter of the keys and leaves the rest alone.

That difference only shows up when the pool changes size which is precisely when you can least afford it. If the stickiness was backing a local cache, a plain modulo hash means one scaling event invalidates nearly everything at once, every backend stampedes the database together and the scale-up that was meant to help you causes the outage instead.

`ip_hash` has two further weaknesses. Clients behind a shared NAT, a corporate proxy or a mobile carrier all arrive as one address so distribution gets lumpy. And a phone switching from wifi to cellular changes IP and silently loses its stickiness mid session.

### What happens when a backend dies

I kill one of the three backends and send nine more requests. Backend two disappears from the results and traffic splits between the other two. The interesting part is in nginx's access log which I configured to record which upstream served each request:

```
upstream=127.0.0.1:3002, 127.0.0.1:3003   upstream_status=502, 200
```

One client request, two upstreams tried, a 502 followed by a 200 and the client receives a successful response without ever learning that anything went wrong.

Read that line closely because it tells you how nginx finds out. **Open source nginx discovers the dead backend by failing a real user's request.** There is no background prober. `max_fails` defaults to 1 and `fail_timeout` to ten seconds so a single failure sidelines a server for ten seconds after which nginx tries it again with somebody's real traffic.

This has a consequence people meet during deploys. Restarting a healthy backend does not bring traffic back immediately because nginx is not watching for recovery. It waits out the timer.

Active health checks, where the proxy probes backends independently and finds failures before a user does, are an NGINX Plus feature. The `health_check` directive appears in a great many blog posts without that caveat attached and if you have copied it into an open source config it has been doing nothing.

## The load balancers that never read your request

Everything so far assumes the proxy reads HTTP. Some load balancers never do and those are the ones that make the vocabulary confusing.

An HTTP request does not travel on its own. It sits inside a TCP segment which sits inside an IP packet:

```
IP packet          ← addresses
  TCP segment      ← ports, connection state
    HTTP request   ← method, path, headers
```

> A proxy chooses how far into that stack to look and the choice has a name. L4 reads the TCP layer and forwards the payload unopened. L7 opens the payload and reads the HTTP inside.

Both layers are present in every single request so "L4 traffic" and "L7 traffic" are not real categories. Only the depth of inspection is.

To see what the difference costs, I point nginx at the same three backends twice in one config. Port 8080 goes through the `http` block and port 9090 goes through the `stream` block which is nginx's L4 mode. Then I request the same URL on both.

On the L7 port, a `location /only-backend-1` rule sends every request to a specific backend and the backend receives an `X-Forwarded-For` header.

On the L4 port, the identical URL round robins across all three backends and no forwarding header arrives. The path has no influence on routing at all.

The detail that makes this click is what **did** arrive. Here is the backend's own log for one of those L4 requests:

```
GET /only-backend-1   host=localhost:9090   xff=(none)
```

The path is intact. The `Host` header is exactly what the client sent, the very header we watched the bare `proxy_pass` config rewrite earlier. The less capable proxy preserves the client's original request more faithfully and only because it copies the bytes without interpreting them.

So an L4 balancer is oblivious rather than destructive. The request is fully present the whole time. Nothing looks at it.

**This is why an L4 load balancer is not a reverse proxy.** A reverse proxy terminates an HTTP conversation and starts a new one. An L4 balancer terminates a TCP connection and starts a new one and never learns that HTTP was involved. Only one of them can route on a path, rewrite a header, terminate TLS or cache a response.

And that is the vocabulary problem: when somebody says "load balancer", they might mean a thing that reads your requests and makes decisions about them or a thing that simply moves bytes between sockets. One word covers two barely overlapping capabilities and that ambiguity is most of the confusion this post set out to clear up.

So why choose the less capable option? Three reasons come up in practice.

The first is **non HTTP protocols** because a database or a mail server has no headers to route on.

The second is **TLS you would rather not decrypt** because reading HTTP means holding the private key while an L4 balancer can forward encrypted traffic it cannot read. The layer choice is often decided by where you are willing to put your keys.

The third is **real time streams**, where an L7 proxy's parsing and buffering degrades live audio so being understood is a liability rather than a feature.

The client IP problem follows an L4 balancer too and the header trick is unavailable since there are no headers. The fix lives one layer down, in the PROXY protocol which sends a short preamble ahead of the application data carrying the original addresses. Both ends must agree, with no negotiation, so enabling it is a coordinated change.

## Making it a gateway

If a load balancer is a reverse proxy that chooses, an API gateway is a reverse proxy that **decides whether to forward at all**.

Everything below sits on top of the same `proxy_pass`. Nothing new is installed.

The first policy is **routing by path**, which puts one hostname in front of several services.

```nginx
location /v1/agents/ { proxy_pass http://127.0.0.1:3001/; }
location /v1/calls/  { proxy_pass http://127.0.0.1:3002/; }
```

Requesting `/v1/agents/list` reaches the backend as `/list` because both the `location` and the `proxy_pass` end in a slash and the prefix gets stripped. Drop that slash and the backend receives the full path instead. Which one your application expects is a real decision and getting it wrong gives you 404s that look like application bugs rather than routing bugs.

One thing worth being clear about: these location blocks are not your API routes. The gateway only matches coarse prefixes while your application resolves the exact route so a new endpoint ships without touching gateway config.

> A gateway knows about services, not endpoints.

Next comes **rate limiting**. I send twelve rapid requests and get six `200`s followed by six `429`s.

```nginx
limit_req_zone $binary_remote_addr zone=perip:10m rate=2r/s;

location /v1/auth/ {
    limit_req zone=perip burst=5 nodelay;
    limit_req_status 429;
}
```

Picture a bucket that drains at the configured rate, which here is two requests per second. `burst=5` is the size of the bucket, meaning five requests may wait inside it. When my twelve requests arrive together, the first one goes straight through because the rate permits it, the next five fill the bucket and the remaining six get a 429. That is where the six successes come from.

The `nodelay` flag is the part people copy without reading, and it decides what happens to the five requests sitting in the bucket. Without it nginx releases them slowly at the drain rate, so they succeed spread over a couple of seconds. With it nginx answers them immediately. The same six succeed either way, so the flag is really choosing between fast responses for your clients and a smooth, steady stream of requests for your backend.

Set `limit_req_status` explicitly because nginx defaults to **503** which tells the client your service is broken when the truth is that they sent too much.

One caveat that follows from earlier. Keying on `$binary_remote_addr` is correct only when the proxy is the edge. Behind a CDN every request carries the same address and you are back to a global limit wearing a per client costume. nginx has a module for that, `set_real_ip_from` plus `real_ip_header` which rewrites `$remote_addr` from a header but only for senders you list as trusted.

For **authentication**, nginx fires an internal subrequest before proxying anything.

```nginx
location /private/ {
    auth_request /_authcheck;
    proxy_pass http://api_pool;
}
```

`/_authcheck` is another location in the same config, proxying to a small auth service that returns 200 when the request carries a valid API key header and 401 when it does not. A 2xx from it means nginx proceeds to the real backend and anything else is returned to the client directly.

I send a request without the key and get a 401 and the backend logs nothing because it is never contacted. The service holding the data does not participate in requests that fail authorisation.

And finally **caching**, where three lines keep successful responses for thirty seconds with a response header exposing what the cache did:

```nginx
location /cached/ {
    proxy_cache apicache;
    proxy_cache_valid 200 30s;
    add_header X-Cache-Status $upstream_cache_status;
}
```

Two identical requests return `X-Cache-Status: MISS` then `HIT` and the backend log shows one request rather than two. The second response is produced entirely by the gateway.

That is a meaningful shift. A reverse proxy relays. A gateway that caches **answers** which means your backend's traffic and your gateway's traffic are no longer the same number.

### The order all this runs in

These directives do not execute in the order they appear in the file. nginx processes a request in fixed phases:

```
select server block      by Host
select location block    by URI
rate limiting            → can return 429 here
access control           → can return 401 here
cache lookup             → can answer from cache here
proxy to the backend     only if nothing above already answered
```

The ordering is deliberate. **Rate limiting runs before authentication** so somebody hammering your login endpoint is rejected without your auth service being consulted. That is what stops an attacker from exhausting auth capacity while being throttled.

Reading a config as a sequence of steps will mislead you here. It is a set of declarations and nginx decides when each applies.

## What this looks like in production

Almost nobody hand writes an nginx config as the front door any more. On a cloud platform you get a managed load balancer and on Kubernetes an ingress controller generates the config for you. So it is worth saying which parts of the above transfer.

The first difference is that **you rarely have one proxy, you have a chain**:

```
client → anycast entry point (L4) → application load balancer (L7) → pod
```

Every hop makes its own decisions about headers, health checks, timeouts and retries. When something behaves strangely, the question is which hop did it and answering that requires the model rather than the config.

| Built by hand | Managed equivalent |
|---|---|
| `upstream` block listing servers | a target group, or a Kubernetes Service |
| passive health checks | **active** health checks, one probe path per service |
| marking a server down, then reloading | a readiness probe plus a deregistration delay |
| `proxy_set_header X-Forwarded-For` | added for you by the load balancer |
| certificate files on disk | a managed certificate, renewed automatically |
| `location /api/` prefix matching | ingress path rules with explicit rule priority |
| `limit_req` | a WAF rate rule, or an API gateway usage plan |
| `auth_request` subrequest | a built in OIDC integration, or an authorizer function |

The health check row is the biggest practical upgrade. Open source nginx finds a dead backend by failing somebody's request, while managed balancers probe independently and know before a user does. If you have only ever used a managed balancer, that behaviour is a feature you are being given rather than something inherent to load balancing.

Two patterns worth stealing, both of which follow directly from the sections above.

**One shared L7 balancer fronts many services, with explicit rule priority.** Rather than a balancer per service, one holds rules for every path prefix on the same hostname and each rule carries a priority number so evaluation order is deliberate. WebSocket paths usually sit highest because a generic prefix rule above them will swallow the upgrade requests.

**Streaming paths sometimes bypass the L7 balancer entirely.** This is the counterintuitive one. An L7 balancer parses and buffers HTTP which is correct for request and response APIs and harmful for live audio, where buffering shows up as degraded quality. So that traffic gets routed through an L4 balancer instead.

> You choose L4 when the intelligence is the problem.

## Which one do you need

The three words describe emphasis rather than products so the useful question is not "which of these three" but "which capabilities does my traffic need". Start from the situation.

| Your situation | What you need | Why |
|---|---|---|
| One backend and you want TLS, a single entry point, or a stable address in front of it | a **reverse proxy** | you need termination rather than selection |
| Several interchangeable backends and you want traffic spread across them | an **L7 load balancer** | selection, plus you keep header and path control |
| The protocol is not HTTP, for example a database or a message broker | an **L4 load balancer** | there is no HTTP to parse so L7 is not an option |
| Many services behind one hostname and you need auth, rate limits, or quotas | an **API gateway** | policy is the defining requirement |
| Real time streams, live audio, or long lived sockets | **L4**, or L7 with buffering off | parsing and buffering are liabilities here |
| Traffic must stay encrypted with no intermediary able to read it | **L4 passthrough**, routing on SNI | path routing requires decryption, hostname routing does not |

Most real platforms need several of these at once which is why you end up with a chain rather than a single box. Each hop exists because it does something the others cannot.

### One last thing that will save you an afternoon

The status codes you see tell you **who answered** and that points you in different directions:

| Code | Comes from | Look at |
|---|---|---|
| 502 | the proxy | your service which refused the connection or died |
| 504 | the proxy | your service which accepted and did not answer in time |
| 503 | the proxy's own policy | your config, usually a rate or connection limit |
| 429 | the proxy's own policy | your rate limit, if you set the status explicitly |

> A 502 or 504 sends you to the service. A 429 or 503 sends you to the gateway.

Being able to say "these are 503s so that is our own limiter rather than the service being down" saves you from restarting healthy pods at two in the morning.

### Three things worth keeping

**A reverse proxy terminates your connection and makes a new one.** Almost every surprise in this post follows from that one fact. The client's address, the original hostname and the protocol all belong to a connection the backend never touches.

**nginx preserves nothing by default.** The block of `proxy_set_header` lines in every production config is a repair kit rather than boilerplate and knowing what each line restores is the difference between copying it and understanding it.

**The layer is a choice about how deep to look.** L4 is oblivious rather than limited and oblivious is occasionally exactly what you want. The most counterintuitive lesson here is that the less capable option is sometimes the correct one because understanding your traffic is also the ability to interfere with it.

Every configuration in this post is in [the repo](https://github.com/praj-pawar/nginx-lab) along with the tiny backends that report what they actually received. I recommend you run it yourself. Reading that nginx rewrites your `Host` header is not the same as watching it happen to a request you sent yourself.
