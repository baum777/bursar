# @bursar/web

The Bursar console, served at [app.bursar.world](https://app.bursar.world). It is where a
principal creates and funds a mandate, sets its limits, and reviews what its agents spent; where
a provider sees the locks it is owed; where resolvers rule on disputed settlements; and where the
timelock signers and the guardian administer the deployment. Every page reads the live contracts
on Robinhood Chain. Nothing on screen comes from a Bursar database.

## Pages

| Route | Who it is for |
|---|---|
| `/console` | A principal's mandates. `/console/new` creates one. |
| `/console/[mandate]` | One mandate: balance, limits, permissions and activity, with `/approvals`, `/exceptions` and `/settlements` beside it. |
| `/providers`, `/providers/[payee]` | A provider's locks, releases and reputation cap. |
| `/resolvers` | Bonding, and committing and revealing a ruling on a dispute. |
| `/governance` | Timelock proposals, approvals and execution, and the guardian's pause. |
| `/ops` | Escrow fee sweeps and the treasury handover. |
| `/endowments`, `/endowments/[address]` | Endow an agent, add to an endowment, and read its principal, draws and earnings. `/endowments/new` creates one. |
| `/stats` | What agents have paid through Bursar, read from the contracts. |
| `/status` | The conditions a payment depends on, each reported separately. |
| `/token` | $BURSAR: its contract on Robinhood Chain and where it trades. |
| `/docs` | SDK, MCP and x402 quick starts for developers. |
| `/api/quotes` | Server route behind the paid quote route on Bursar's demo provider, read through this app's endpoint pool. Answers only its token. |
| `/api/index` | Server route that proxies the Blockscout index so its key never reaches a browser. |

`/` redirects to `/console`. The public site is [bursar.world](https://bursar.world) and lives in
a separate repository.

## Run it locally

From the repository root, after `pnpm install`:

```sh
pnpm --filter @bursar/core build
pnpm --filter @bursar/sdk build
pnpm --filter @bursar/web dev          # http://127.0.0.1:4310
```

With no configuration it reads chain 4663 through the recorded public RPC pair. Copy
`.env.example` to `.env.local` to change that. A production build is
`pnpm --filter @bursar/web build` followed by `pnpm --filter @bursar/web start`. Do not run
`next dev` and `next build` at the same time: they share `.next/` and each corrupts the other's
output.

Before compiling, `scripts/preflight.ts` checks the network configuration and stops with the name
of the variable at fault.

## Configuration

Every variable is optional. `.env.example` explains each one.

| Variable | Default | Meaning |
|---|---|---|
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | unset | Without it the WalletConnect option is hidden. Injected wallets and Safe still connect. |
| `NEXT_PUBLIC_RHC_RPC_PRIMARY` | `https://rpc.mainnet.chain.robinhood.com` | Primary RPC endpoint. |
| `NEXT_PUBLIC_RHC_RPC_FALLBACK` | `https://robinhood.drpc.org` | Fallback RPC endpoint. Must be at a different host from the primary; the build refuses otherwise. |
| `NEXT_PUBLIC_RHC_NETWORK` | mainnet | `testnet` is refused: USDG has no contract on chain 46630. |
| `NEXT_PUBLIC_RHC_EXPLORER` | the recorded explorer | Where transaction and address links point. |
| `NEXT_PUBLIC_SITE_URL` | unset | This app's origin, shown by wallets before they sign. Needed only in a deployment. |
| `BURSAR_MCP_HOST_URL` | unset | The hosted MCP endpoint (`services/mcp-host`). Server-side only. Unset, the mandate page says hosted assistant connections are not available. |
| `BLOCKSCOUT_API_KEY` | unset | Server-side key for the chain index. Without it `/api/index` answers `402` and the history views on the mandate pages say so; balances, limits and permissions still read from the contracts. |
| `BLOCKSCOUT_API_BASE` | the index for the chain | A different index host. Server-side. |

## Scripts

| Command | What it does |
|---|---|
| `pnpm --filter @bursar/web test` | Unit tests. |
| `pnpm --filter @bursar/web typecheck` | `tsc --noEmit`. |
| `pnpm --filter @bursar/web probe` | Reads the live deployment through the same code the browser uses and prints what each surface would render. |
| `pnpm --filter @bursar/web codegen:token` | Regenerates `src/chain/generated/token.ts` from the Foundry build and the token deployment record. |

## License

MIT. See [LICENSE](../../LICENSE).

## Optional setup assistant (experimental)

The console can expose a guided, draft-only AI assistant in Workspace and mandate pages.
It prepares local draft changes for explicit review, never signs or sends a transaction,
and never calls an MCP signer. Disabled by default; no model requests are made when off.

Set the server-only environment variables shown in `.env.example` and restart the web
app. You must provide an operator access token of at least 24 characters. Enter it into
the panel when prompted. It is kept in tab memory and sent only to the same-origin web
route; it is not stored in IndexedDB, localStorage or chat history.

The model receives only conversation text, public mandate details and (if separately
opted in) a limited summary of workspace draft names and limits. It never receives
private terms, passphrases, salts, notes or keys. A proposal is not an authorization:
applying it requires a human click on the local browser. The existing wallet UI owns
all on-chain writes. See [the security and routing design](../../docs/ASSISTANT-WORKBENCH.md).

The shared operator token and in-memory rate limiter are suitable for a restricted
self-hosted evaluation, **not** for an anonymous public multi-tenant deployment. A
public deployment would require per-user authentication, quotas and abuse protection.
