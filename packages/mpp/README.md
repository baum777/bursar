# @bursar/mpp

Robinhood Chain for the [Machine Payments Protocol](https://mpp.dev). MPP is the HTTP 402 payment
protocol from Stripe and Tempo: a server answers `402` with a challenge, the client retries with a
signed credential, the server returns a receipt. Its SDK, `mppx`, runs EIP-3009 stablecoin charges on
any EVM chain it is told about. This package tells it about USDG on Robinhood Chain and points it at
Bursar's facilitator, so a server holds no key and a payer holds no ETH.

One route serves both protocols. The 402 carries an MPP challenge and an x402 one, and the server
takes either credential back: a client built on `mppx` and a client built on the reference x402
packages pay the same endpoint.

## Charge agents

```ts
import express from 'express';
import { Mppx } from 'mppx/express';
import { usdgCharge } from '@bursar/mpp/server';

const mppx = Mppx.create({
  methods: [usdgCharge({ recipient: '0xYourAddress' })],
  secretKey: process.env.MPP_SECRET_KEY,
});

const app = express();
app.get('/quote', mppx.evm.charge({ amount: '0.01' }), (_request, response) => {
  response.json({ quote: 'the koi swims upstream' });
});
```

`usdgCharge` is `mppx`'s `evm.charge` with the chain, the token and its signing domain filled in
and Bursar's keyless facilitator behind it. Everything else `evm.charge` accepts, it accepts.
`mppx` has the same middleware for Hono, Next.js and Elysia, and an MCP transport for paid tool
calls.

## Pay as an agent

```ts
import { Fetch } from 'mppx/client';
import { usdgPayer } from '@bursar/mpp/client';

const fetch = Fetch.from({ methods: [usdgPayer({ account, maxAmount: '1.00' })] });
const response = await fetch('https://api.example.com/quote');
```

The account signs an EIP-3009 authorization under USDG's domain; the server's facilitator
broadcasts it and pays the gas. `maxAmount` is the most one charge may take, in dollars.

## What is in it

| Export | What it is |
|---|---|
| `USDG` | USDG on Robinhood Chain as an `mppx` asset: address, six decimals, `eip155:4663`, and the EIP-712 domain `Global Dollar` version `1`, proved against the token's own separator in `@bursar/core`. |
| `FACILITATOR` | `https://facilitator.bursar.world/x402`, the keyless facilitator for the `exact` scheme in USDG. |
| `usdgCharge` | The server method, from `@bursar/mpp/server`. |
| `usdgPayer` | The client method, from `@bursar/mpp/client`. |

A runnable pair, server and client, is in
[`examples/mpp-rhc`](https://github.com/bursar-world/bursar/tree/main/examples/mpp-rhc).

## Limits

The facilitator settles the `exact` scheme in USDG on Robinhood Chain and nothing else; an MPP
charge in another token or on another chain goes to that chain's own facilitator. x402 route
binding defaults to `resource`, which is what admits clients built on the reference x402 packages;
pass `x402: { routeBinding: 'required' }` to serve `mppx` clients alone.
