/**
 * BreatheLocal mock API — test upstream for the L402 gateway.
 */

import { Hono } from 'hono';
import { serve } from '@hono/node-server';

const app = new Hono();

app.get('/health', (c) => c.json({ status: 'ok' }));

app.get('/docs', (c) => c.json({
  endpoints: ['/v1/aqi'],
  description: 'BreatheLocal mock API',
}));

app.get('/v1/aqi', (c) => {
  const lat = c.req.query('lat') || '45.52';
  const lng = c.req.query('lng') || '-122.68';
  return c.json({
    aqi: 42,
    location: 'Portland, OR',
    lat: parseFloat(lat),
    lng: parseFloat(lng),
    forecast: 'Good',
    timestamp: new Date().toISOString(),
  });
});

const port = parseInt(process.env.BACKEND_PORT || '3001', 10);

serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, () => {
  console.log(`BreatheLocal mock API running on http://0.0.0.0:${port}`);
});
