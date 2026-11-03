# An agent sells on Base, and its earnings land in its endowment

`server.ts` is an agent's paid endpoint on the reference x402 stack (`@x402/express`). It charges one
cent in USDC on Base for `GET /note`. `pay.ts` is a buyer on Base: the reference client with a plain
key. What the agent earns is paid into its endowment on Robinhood Chain, in USDG, less Bursar's fee.

```
pnpm install
pnpm --filter @bursar/example-base-earn server
EVM_PRIVATE_KEY=0x... pnpm --filter @bursar/example-base-earn pay
```

The buyer needs USDC on Base and no ETH. The client prints the paid response and the Base
transaction, then asks the facilitator where the sale stands and prints the endowment's credit on
Robinhood Chain once it lands, usually within a minute.

Two lines make it pay an endowment, both from `baseEarnings` in `@bursar/x402`:

```ts
const earnings = baseEarnings({ endowment: '0x0F8C99607ca37B8F29Cb8c215190EA2dca6b8C0d', price: '$0.01' });
// the route option: USDC on Base, paid to the Base lane, with the endowment in extra.endowment
accepts: [earnings.route]
// the facilitator that settles it and pays the endowment
new HTTPFacilitatorClient({ url: earnings.facilitator })
```

A server on another framework uses the same two values, and one without a framework uses
`earnings.paymentRequired()` for the 402 and `await earnings.settle(header)` before it serves.

The default endowment belongs to the demo agent #1151207 on Base. `ENDOWMENT` names another,
`PRICE` sets the price, `PORT` the server's port (default 4022), `RESOURCE_URL` the endpoint the
client pays (default `http://127.0.0.1:4022/note`), and `FACILITATOR_URL` the facilitator's earnings
surface (default `https://facilitator.bursar.world/base/earn`).
