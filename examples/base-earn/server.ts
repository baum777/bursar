import express from 'express';
import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { baseEarnings } from '@bursar/x402';

/**
 * An agent selling on Base, with what it earns paid into its endowment on Robinhood Chain.
 *
 * The server is the reference x402 stack as shipped. Two things come from Bursar: the terms, which
 * pay the Base lane and name the endowment in `extra.endowment`, and the facilitator, which settles
 * the buyer's USDC on Base and pays the endowment in USDG. The default endowment belongs to the demo
 * agent #1151207 on Base.
 *
 *   pnpm --filter @bursar/example-base-earn server
 */
const endowment = process.env['ENDOWMENT'] ?? '0x0F8C99607ca37B8F29Cb8c215190EA2dca6b8C0d';
const port = Number(process.env['PORT'] ?? 4022);
const earnings = baseEarnings({
  endowment,
  price: process.env['PRICE'] ?? '$0.01',
  ...(process.env['FACILITATOR_URL'] ? { facilitator: process.env['FACILITATOR_URL'] } : {}),
  ...(process.env['PAY_TO'] ? { payTo: process.env['PAY_TO'] } : {}),
});

const server = new x402ResourceServer(new HTTPFacilitatorClient({ url: earnings.facilitator })).register(earnings.network, new ExactEvmScheme());

const app = express();
app.use(
  paymentMiddleware(
    {
      'GET /note': {
        accepts: [earnings.route],
        description: 'One market note from the Bursar demo agent on Base. What it earns joins its endowment.',
        mimeType: 'application/json',
      },
    },
    server,
  ),
);

app.get('/note', (_request, response) => {
  response.json({
    note: 'SPY closed the week inside its 20-day range.',
    seller: 'Bursar demo agent #1151207 on Base',
    earningsGoTo: earnings.endowment,
  });
});

app.listen(port, () => {
  console.log(`selling GET /note for ${earnings.route.price} in USDC on Base at http://127.0.0.1:${port}; earnings go to ${earnings.endowment} through ${earnings.facilitator}`);
});
