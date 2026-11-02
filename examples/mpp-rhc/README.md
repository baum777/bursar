# An MPP client pays a Robinhood Chain endpoint in USDG

Two processes built on `mppx`, the Machine Payments Protocol SDK, with Bursar as the facilitator.
`server.ts` is an Express endpoint that charges one cent in USDG for `GET /quote`. `pay.ts` is an MPP
client paying it. The server's 402 carries an MPP challenge and an x402 one, so an MPP client and a
stock x402 client both pay the same route.

```
pnpm install
PAY_TO=0xYourAddress pnpm --filter @bursar/example-mpp-rhc server
EVM_PRIVATE_KEY=0x... pnpm --filter @bursar/example-mpp-rhc pay
```

The payer needs USDG on Robinhood Chain and no ETH: the facilitator's relayer pays the gas. The
client prints the paid response, the receipt the server returned, and a link to the transaction on
the explorer.

`FACILITATOR_URL` overrides the facilitator (default `https://facilitator.bursar.world/x402`),
`PORT` the server's port (default 4022), `MPP_SECRET_KEY` the key the server signs its challenges
with, and `RESOURCE_URL` the endpoint the client pays (default `http://127.0.0.1:4022/quote`).

The chain, the token and its signing domain come from `@bursar/mpp`: `usdgCharge` on the server and
`usdgPayer` on the client are `mppx`'s EVM charge method with USDG on Robinhood Chain filled in.
