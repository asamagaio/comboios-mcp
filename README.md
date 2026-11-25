# comboios-mcp

An unofficial [Model Context Protocol](https://modelcontextprotocol.io) server for Portuguese trains run by
Comboios de Portugal (CP). It lets an assistant such as Claude or ChatGPT find stations, search journeys
with fares, read live departure boards and train positions, report service alerts and, optionally, sell a
ticket through CP's own payment system.

> **Not affiliated with CP – Comboios de Portugal.** The server uses the same undocumented back end as the
> cp.pt website, with the public credentials that website ships to every browser. It can stop working
> whenever CP changes that back end. Tickets are issued and charged by CP. Use it with respect for CP's
> services: the server caches aggressively and limits itself to one upstream request per second.

## What it can do

| Tool | Purpose |
|---|---|
| `procurar_estacao` | Find stations by name (fuzzy, accents optional) and return their CP codes (`94-xxxx`). |
| `info_estacao` | Line, address, step-free access and facilities of a station. |
| `horarios` | Journeys between two stations on a date: times, legs, changes and fares, with filters for time window, class, passengers, service and direct trains. |
| `mostrar_horarios` | The same search shown as interactive cards in the chat (MCP Apps), each with a buy button. The assistant uses it only when the user wants to compare trains or buy. |
| `precos` | Fares for 1st and 2nd class, optionally for one train. |
| `partidas_chegadas` | Live departures or arrivals for a station, including the first trains after midnight on late requests. |
| `estado_comboio` | Live status of a train: delay, last station passed and every stop. Falls back to Infraestruturas de Portugal if CP fails. |
| `perturbacoes` | Current alerts (strikes, works, disruptions) with a text filter. |
| `classes_e_regras` | Travel classes, booking horizon, passenger limits and service codes. |
| `comprar_bilhete` | With payments enabled: a link to the purchase page for a journey option. It reserves nothing by itself. |
| `link_compra` | With payments disabled: a link that opens the same search on cp.pt. |

Station arguments accept a name or a code; an ambiguous name such as "Lisboa" returns the candidates instead
of a guess. Dates are `YYYY-MM-DD` and times `HH:MM`, in Europe/Lisbon.

## Use the public instance

Add the server as a custom connector. No sign-in is needed.

- **Claude** (web, desktop, mobile): Settings → Connectors → Add custom connector →
  `https://comboios.noodg.com/mcp`
- **ChatGPT** and other MCP clients: add `https://comboios.noodg.com/mcp` as a remote MCP server
  (Streamable HTTP).

The landing page at https://comboios.noodg.com explains the service and what data goes where.

## Run your own

Requires Node.js 20 or later.

```bash
npm install
```

```bash
npm run build
```

### Local, over stdio

Claude Code:

```bash
claude mcp add comboios -- node /absolute/path/to/comboios-mcp/dist/index.js
```

Claude Desktop (`claude_desktop_config.json`); use the full path to `node`, because the app does not read
your shell's `PATH`:

```json
{
  "mcpServers": {
    "comboios": { "command": "/opt/homebrew/bin/node", "args": ["/absolute/path/to/comboios-mcp/dist/index.js"] }
  }
}
```

Locally, payments are disabled and buying goes through a cp.pt link.

### Local, over HTTP

HTTP mode binds to `127.0.0.1` and requires a bearer token of at least 16 characters.

```bash
CP_MCP_TOKEN="$(openssl rand -hex 24)" node dist/index.js --http --port 8787
```

### Hosted on Vercel

`vercel.json` deploys `api/mcp.js` (the MCP endpoint at `/mcp`), `api/pay.js` and `public/` (landing and
purchase pages). The "Other" framework preset is required; Vercel's "Node" preset would run the stdio CLI.

| Variable | Purpose |
|---|---|
| `PAYMENTS_ENABLED` | `1` turns on the purchase page and `comprar_bilhete`. Off by default. |
| `PAY_TOKEN_KEY` | 32 random bytes, base64. Encrypts purchase and pre-fill tokens. Required with payments. |
| `PUBLIC_BASE_URL` | Public origin, e.g. `https://comboios.example.com`. Defaults to the Vercel production URL. |
| `CP_LOG_LEVEL` | `debug`, `info` (default), `warn` or `error`. |

```bash
openssl rand -base64 32 | tr -d '\n' | vercel env add PAY_TOKEN_KEY production --sensitive
```

## Buying tickets

When `PAYMENTS_ENABLED=1`, `horarios` gives each option sold online a `buy_url`, and `comprar_bilhete`
returns the same link, optionally with the passenger names, email and phone pre-filled. The page then:

1. Shows the journey and price, and asks for the passenger names, an email for the ticket and consent.
   Nothing is reserved before the buyer clicks Continue.
2. Creates the sale at CP. On trains with seat reservation (Alfa Pendular, Intercidades), shows the seat CP
   assigned, the occupancy of each carriage and a seat map, and lets the buyer change seats.
3. Opens CP's own Checkout.com payment form (card, MB WAY or PayPal). Card details never reach this server.
4. Confirms the sale with CP and offers the PDF ticket, which CP also emails.

Safeguards: personal details are forwarded to CP and not stored or logged; the sale's identifiers travel in
an AES-256-GCM token, so the server keeps no state; writes to CP are never retried; a sale is released if
CP rejects the details; cancelling is refused whenever a payment may exist. Each direction of a return trip
is a separate ticket.

> **If you run a public instance with payments enabled,** you are operating an unofficial checkout for CP
> tickets on your own domain. You are responsible for that service, its users' data and its support.
> Consider asking CP for permission first, and keep `PAYMENTS_ENABLED` off if in doubt.

## Disclaimer

This software and the public instance are provided "as is", without warranty of any kind. To the extent
permitted by applicable law, the authors and operators accept no liability for any loss or damage arising from
their use, including wrong, incomplete or outdated information, failed, duplicated or incorrect purchases,
missed trains, or changes and outages of CP's services. Tickets, prices, refunds and travel conditions are
CP's responsibility; for any problem with a purchase, contact CP with the purchase reference. See also the
[license](LICENSE).

## Privacy

Searching, timetables, live information and alerts need no personal data. The purchase page sends the
details the buyer types to CP to issue the ticket and does not keep them. Hosting providers keep standard
request logs.

## How it works

- Credentials are the public values in `https://www.cp.pt/fe-config.json`, fetched at runtime, cached for
  6 hours and refreshed once on a 401. They are never logged or stored.
- All upstream calls share one token bucket (1 request per second, burst 3), a 20 s timeout and two retries
  on network errors and 502/503/504.
- Caches: stations and catalog data 24 h, alerts 10 min, journeys 2 min, live boards 15 s.
- Journey option ids are self-contained (`2026-11-30_94-30007_94-2006_c2_p1_out521`), so any server
  instance can resolve them.
- The in-chat view (`ui/horarios.ts`) uses [MCP Apps](https://github.com/modelcontextprotocol/ext-apps). It
  is bundled into a single HTML resource with no network access; the buy button asks the host to open the
  purchase page.

[docs/findings.md](docs/findings.md) records what was verified against the live back end,
[docs/deeplink.md](docs/deeplink.md) and [docs/payment-lab.md](docs/payment-lab.md) how the purchase flow was
worked out.

## Development

| Command | Purpose |
|---|---|
| `npm test` | Unit and protocol tests against recorded fixtures (no network). |
| `npm run test:live` | Live contract tests, one call per tool (`CP_LIVE=1`). |
| `npm run probe` | One call per upstream endpoint, printing `[OK ]` or `[ERR]`. |
| `npm run record-fixtures` | Re-record `test/fixtures/` from live responses. |
| `npm run inspector` | Open the MCP Inspector on the built server. |
| `node lab/mock/server.mjs` | Purchase page and in-chat view against fixtures, at `http://localhost:8791` (`/comprar?o=demo`, `/ui-host`). |

Contributions are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md). Report security issues as described in
[SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
