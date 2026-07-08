import http from 'node:http';

const port = Number(process.env.AGENTIS_DEMO_MOCK_PORT ?? 4747);

const fixtures = {
  repos: [
    { name: 'agentis', language: 'TypeScript', tests: 'passing', blockers: 2 },
    { name: 'browser-ops-kit', language: 'TypeScript', tests: 'flaky', blockers: 4 },
    { name: 'personal-brain', language: 'Python', tests: 'missing', blockers: 3 },
  ],
  issues: [
    { repo: 'agentis', title: 'Document workspace bundle import flow', severity: 'medium' },
    { repo: 'browser-ops-kit', title: 'Stabilize Playwright screenshot harness', severity: 'high' },
    { repo: 'personal-brain', title: 'Add citation confidence display', severity: 'medium' },
  ],
  analytics: { visitors: 1840, signups: 143, conversionRate: 0.077, topSource: 'GitHub launch post' },
};

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body, null, 2));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  if (url.pathname === '/health') return json(res, 200, { ok: true, service: 'agentis-demo-mock' });
  if (url.pathname === '/github/repos') return json(res, 200, { repos: fixtures.repos });
  if (url.pathname === '/github/issues') return json(res, 200, { issues: fixtures.issues });
  if (url.pathname === '/analytics/launch') return json(res, 200, fixtures.analytics);
  if (url.pathname === '/email/outbox' && req.method === 'POST') return json(res, 202, { queued: true, id: `email_${Date.now()}` });
  if (url.pathname === '/ads/budget-check' && req.method === 'POST') return json(res, 200, { requiresApproval: true, thresholdUsd: 100, reason: 'demo policy' });
  json(res, 404, { error: 'not_found', path: url.pathname });
});

server.listen(port, () => {
  console.log(`Agentis demo mock services listening on http://127.0.0.1:${port}`);
});

