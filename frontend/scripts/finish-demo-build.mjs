/**
 * Adds static-hosting config to the demo build (dist-demo/) so it can be
 * deployed as-is to Vercel: SPA fallback for client-side routes, no indexing,
 * basic security headers and long-lived caching for hashed assets.
 */
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const out = join(import.meta.dirname, '..', 'dist-demo');

// The demo runs on mock data; the deploy-config template isn't needed.
rmSync(join(out, 'config.example.json'), { force: true });

const vercelConfig = {
  rewrites: [{ source: '/(.*)', destination: '/index.html' }],
  headers: [
    {
      source: '/(.*)',
      headers: [
        { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      ],
    },
    { source: '/assets/(.*)', headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }] },
  ],
};

writeFileSync(join(out, 'vercel.json'), `${JSON.stringify(vercelConfig, null, 2)}\n`);
writeFileSync(join(out, 'robots.txt'), 'User-agent: *\nDisallow: /\n');
console.log('Demo build ready in frontend/dist-demo (vercel.json + robots.txt added)');
