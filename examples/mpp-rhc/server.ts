import express from 'express';
import { Mppx } from 'mppx/express';
import { EXPLORER, NETWORK, usdgCharge } from '@bursar/mpp/server';

/**
 * A Robinhood Chain endpoint that charges one cent in USDG over the Machine Payments Protocol.
 *
 * One line makes it Robinhood Chain: `usdgCharge`, which is `mppx`'s EVM charge method with USDG,
 * the chain and the token's signing domain filled in, settled through Bursar's keyless
 * facilitator. The route answers a 402 with an MPP challenge and an x402 one, and takes either
 * credential back, so a client built on `mppx` and a stock x402 client both pay it.
 *
 *   PAY_TO=0x... pnpm --filter @bursar/example-mpp-rhc server
 */
const payTo = process.env['PAY_TO'];
if (payTo === undefined || !/^0x[0-9a-fA-F]{40}$/.test(payTo)) {
  console.error('PAY_TO must be the address that is paid, as 0x followed by 40 hex characters.');
  process.exit(1);
}
const secretKey = process.env['MPP_SECRET_KEY'] ?? 'local-dev-secret-change-me-before-serving-anyone';
const port = Number(process.env['PORT'] ?? 4022);

const facilitator = process.env['FACILITATOR_URL'];
const mppx = Mppx.create({
  methods: [usdgCharge({ recipient: payTo as `0x${string}`, ...(facilitator ? { x402: { facilitator } } : {}) })],
  secretKey,
});

mppx.onPaymentSuccess(({ receipt, payer }) => {
  console.log(`paid by ${payer ?? 'unknown'}: ${EXPLORER}/tx/${receipt.reference}`);
});

const app = express();
app.get('/quote', mppx.evm.charge({ amount: '0.01', description: 'One quote, one cent, in USDG on Robinhood Chain.' }), (_request, response) => {
  response.json({ quote: 'the koi swims upstream', asset: 'USDG', network: NETWORK });
});

app.listen(port, () => {
  console.log(`charging $0.01 in USDG for GET /quote on http://127.0.0.1:${port}, over MPP and x402`);
});
