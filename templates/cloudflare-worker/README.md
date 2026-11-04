# A Cloudflare Worker that charges agents

Two priced routes, paid over x402 and settled through Bursar on Robinhood Chain:
`GET /quote?symbol=NVDA` sells the Chainlink price of a tokenized stock, and `POST /render` is a
stub to replace with your own service. An agent that calls one without paying gets a 402 with the
price. One that pays from its mandate gets the result, and the payment lands in escrow for your
address.

## Deploy

```
npm install
npx wrangler secret put BURSAR_FACILITATOR_TOKEN
npx wrangler deploy
```

Before you deploy, set three variables in `wrangler.toml`:

| Variable | What it is |
|---|---|
| `BURSAR_PROVIDER` | The address the escrow pays. List it with a stake on the [provider desk](https://app.bursar.world/providers) first; the escrow refuses a payee the registry does not list. |
| `BURSAR_CAPABILITY` | The capability each call falls under, such as `service:render:1`. A payer's mandate has to allow it. |
| `BURSAR_PRICES` | The priced routes, in USDG: `POST /render=0.01, GET /quote=0.001`. |

`GET /quote` reads the chain, and the keyless endpoints rate-limit Cloudflare's shared addresses. Set
`BURSAR_RPC_URL` to an endpoint of your own, or drop the route from `BURSAR_PRICES`. A quote it cannot
read answers 503 and costs the buyer nothing.

`BURSAR_FACILITATOR_TOKEN` is the bearer token the facilitator issued you. The worker sends every
payment it receives to the facilitator to verify and settle, and the hosted one at
`https://facilitator.bursar.world` answers providers that hold a token. Ask for one, or run your own
and point `BURSAR_FACILITATOR_URL` at it.

## Listing on Agentic.Market

Set `BURSAR_BASE_PAY_TO` to your address on Base and add your CDP API key as the secrets
`CDP_API_KEY_ID` and `CDP_API_KEY_SECRET`. Every priced route then also takes its price in USDC on
Base, settled by Coinbase to that address. `discovery` in `src/index.ts` describes `GET /quote`, and
Coinbase indexes it into the Bazaar behind [Agentic.Market](https://agentic.market) after the first
payment it settles. The [package README](https://github.com/bursar-world/bursar/tree/main/packages/provider-worker#listed-on-agenticmarket)
has the details.

## Collecting

A mandate pays by locking the price in escrow for your address. Releasing the lock is what moves
the money to you. Two ways:

- Give the worker your provider key as a secret, `npx wrangler secret put BURSAR_PROVIDER_KEY`,
  and it releases each lock after it answers, committed to the bytes it served. The key signs
  releases of funds the escrow already holds for you and nothing else. Keep ETH at the address for
  the fee.
- Leave the key out and release from the [provider desk](https://app.bursar.world/providers) or
  with the sidecar. Until released, a lock returns to the payer at its deadline.

## Try it

Locally, `npx wrangler dev` serves the worker on `http://localhost:8787` and reads secrets from
`.dev.vars`. Then pay it from a mandate whose principal allows your capability:

```
MANDATE=0x… AGENT_KEY=0x… npx tsx scripts/pay.ts http://localhost:8787/render
```

`scripts/pay.ts` is the agent side: `@bursar/sdk`'s `mandate.fetch` reads the 402, pays the quoted
price through the mandate's own escrow, retries the call, and prints the lock and the settlement.

## What the handler sees

`paymentOf(request)` inside the handler names what was paid: the payer, the amount, and on the
escrow scheme the lock. Routes that are not in `BURSAR_PRICES` pass through free. See
[`@bursar/provider-worker`](https://www.npmjs.com/package/@bursar/provider-worker) for the rest.
