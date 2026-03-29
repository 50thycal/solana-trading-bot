import assert from 'node:assert/strict';
import { fetchWithRetry } from '../pipeline/research-score-client';

async function run(): Promise<void> {
  const originalFetch = global.fetch;
  let attempts = 0;

  global.fetch = (async () => {
    attempts += 1;
    if (attempts < 3) {
      throw new Error('temporary failure');
    }
    return new Response(JSON.stringify({ mint: 'abc', opportunityScore: 75, riskScore: 30 }), { status: 200 });
  }) as typeof fetch;

  const result = await fetchWithRetry('https://example.com', 1000, 2);
  assert.equal(result.attempts, 3);
  assert.ok(result.latencyMs >= 0);

  global.fetch = originalFetch;
  console.log('research-score-client retry tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
