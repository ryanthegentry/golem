/**
 * Demo helper — pay an L402 gateway from Voltage LND.
 *
 * Usage: npx tsx scripts/demo-pay.ts [gateway-url]
 * Default: http://localhost:8402/v1/aqi
 *
 * Requires VOLTAGE_MACAROON env var (base64-encoded LND macaroon).
 */

const LND_URL = 'https://golem-tester.u.voltageapp.io:8080';

const macaroonBase64 = process.env.VOLTAGE_MACAROON;
if (!macaroonBase64) {
  console.error('Error: VOLTAGE_MACAROON env var required (base64-encoded LND macaroon)');
  process.exit(1);
}

const LND_MACAROON_HEX = Buffer.from(macaroonBase64, 'base64').toString('hex');

function lndHeaders(): Record<string, string> {
  return { 'Grpc-Metadata-macaroon': LND_MACAROON_HEX, 'Content-Type': 'application/json' };
}

const targetUrl = process.argv[2] || 'http://localhost:8402/v1/aqi';

async function main() {
  // Step 1: Request the URL
  console.log(`Requesting ${targetUrl}...\n`);
  const res = await fetch(targetUrl);

  if (res.status === 200) {
    console.log('Status: 200 (already accessible, no payment needed)');
    console.log(await res.text());
    return;
  }

  if (res.status !== 402) {
    console.error(`Unexpected status: ${res.status}`);
    console.error(await res.text());
    process.exit(1);
  }

  // Step 2: Parse 402 challenge
  const challenge = await res.json() as {
    invoice: string;
    macaroon: string;
    price: number;
    paymentHash: string;
  };
  console.log(`402 Payment Required`);
  console.log(`  Price:        ${challenge.price} sats`);
  console.log(`  Payment hash: ${challenge.paymentHash}`);
  console.log(`  Invoice:      ${challenge.invoice.slice(0, 60)}...`);

  // Step 3: Pay via Voltage LND
  console.log(`\nPaying invoice via Voltage LND...`);
  const payRes = await fetch(`${LND_URL}/v1/channels/transactions`, {
    method: 'POST',
    headers: lndHeaders(),
    body: JSON.stringify({
      payment_request: challenge.invoice,
      fee_limit: { fixed: '100' },
    }),
  });

  if (!payRes.ok) {
    console.error(`LND API error: ${payRes.status} ${await payRes.text()}`);
    process.exit(1);
  }

  const payBody = await payRes.json() as { payment_preimage: string; payment_error: string };
  if (payBody.payment_error) {
    console.error(`Payment failed: ${payBody.payment_error}`);
    process.exit(1);
  }

  const preimage = Buffer.from(payBody.payment_preimage, 'base64').toString('hex');
  console.log(`  Preimage: ${preimage}`);

  // Step 4: Retry with L402 token
  console.log(`\nRetrying with L402 token...`);
  const authRes = await fetch(targetUrl, {
    headers: { 'Authorization': `L402 ${challenge.macaroon}:${preimage}` },
  });

  const data = await authRes.json();
  console.log(`  Status: ${authRes.status}`);
  console.log(`  Response:`);
  console.log(JSON.stringify(data, null, 2));

  if (authRes.status === 200) {
    console.log(`\nPaid ${challenge.price} sats. Data received.`);
  } else {
    console.error(`\nFailed: expected 200, got ${authRes.status}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('Error:', (e as Error).message);
  process.exit(1);
});
