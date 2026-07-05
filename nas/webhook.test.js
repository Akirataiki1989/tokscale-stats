const assert = require('assert/strict');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { beforeEach, test } = require('node:test');

const {
  MAX_BODY_BYTES,
  createServer,
  readConfig,
  resetSchedulerState,
  scheduleMerge,
} = require('./webhook');

const ENV = {
  GITHUB_WEBHOOK_SECRET: 'test-secret',
  GITHUB_REPO_FULL_NAME: 'guieunuch/tokscale-stats',
};

const LEGACY_ROUTE = {
  name: 'tokscale',
  command: ['node', 'merge.js'],
  cwd: '/volume1/docker/Tokscale',
  maxBodyBytes: MAX_BODY_BYTES,
};

function signBody(secret, body) {
  return `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
}

async function withServer(runMerge, env = ENV) {
  const server = createServer({
    env,
    runMerge,
    logger: { error() {} },
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function writeTempRoutesFile(routes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokscale-webhook-'));
  const filePath = path.join(dir, 'webhook.routes.json');
  fs.writeFileSync(filePath, JSON.stringify({ routes }, null, 2));
  return filePath;
}

function postWebhook(port, { host, body, signature, event }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/',
        method: 'POST',
        headers: {
          host,
          ...(signature ? { 'x-hub-signature-256': signature } : {}),
          ...(event ? { 'x-github-event': event } : {}),
        },
      },
      (res) => {
        let chunks = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          chunks += chunk;
        });
        res.on('end', () => {
          resolve({ status: res.statusCode, body: chunks });
        });
      }
    );

    req.on('error', reject);
    req.end(body);
  });
}

beforeEach(() => {
  resetSchedulerState();
});

test('readConfig requires startup secrets', () => {
  assert.throws(() => readConfig({}), /GITHUB_WEBHOOK_SECRET/);
  assert.throws(
    () =>
      readConfig({
        GITHUB_WEBHOOK_SECRET: 'x',
      }),
    /GITHUB_REPO_FULL_NAME/
  );
});

test('rejects missing and malformed signatures', async () => {
  let runs = 0;
  const { port, close } = await withServer(async () => {
    runs += 1;
  });

  try {
    const body = JSON.stringify({ repository: { full_name: ENV.GITHUB_REPO_FULL_NAME } });
    const missing = await postWebhook(port, {
      host: 'webhook.tokscale.guieunuch.cc',
      body,
    });
    const malformed = await postWebhook(port, {
      host: 'webhook.tokscale.guieunuch.cc',
      signature: 'sha256=bad',
      body,
    });

    assert.equal(missing.status, 401);
    assert.equal(malformed.status, 401);
    assert.equal(runs, 0);
  } finally {
    await close();
  }
});

test('rejects invalid signatures and wrong event or repository after verification', async () => {
  let runs = 0;
  const { port, close } = await withServer(async () => {
    runs += 1;
  });

  try {
    const body = JSON.stringify({ repository: { full_name: ENV.GITHUB_REPO_FULL_NAME } });
    const badSignature = await postWebhook(port, {
      host: 'webhook.tokscale.guieunuch.cc',
      signature: signBody('wrong-secret', body),
      body,
    });
    const wrongEvent = await postWebhook(port, {
      host: 'webhook.tokscale.guieunuch.cc',
      signature: signBody(ENV.GITHUB_WEBHOOK_SECRET, body),
      event: 'ping',
      body,
    });
    const wrongRepoBody = JSON.stringify({ repository: { full_name: 'someone/else' } });
    const wrongRepo = await postWebhook(port, {
      host: 'webhook.tokscale.guieunuch.cc',
      signature: signBody(ENV.GITHUB_WEBHOOK_SECRET, wrongRepoBody),
      event: 'push',
      body: wrongRepoBody,
    });

    assert.equal(badSignature.status, 401);
    assert.equal(wrongEvent.status, 200);
    assert.equal(wrongRepo.status, 200);
    assert.equal(runs, 0);
  } finally {
    await close();
  }
});

test('accepts a valid push and runs merge once', async () => {
  let runs = 0;
  const { port, close } = await withServer(async () => {
    runs += 1;
  });

  try {
    const body = JSON.stringify({
      repository: { full_name: ENV.GITHUB_REPO_FULL_NAME },
    });
    const response = await postWebhook(port, {
      host: 'webhook.tokscale.guieunuch.cc',
      signature: signBody(ENV.GITHUB_WEBHOOK_SECRET, body),
      event: 'push',
      body,
    });

    assert.equal(response.status, 200);
    assert.equal(runs, 1);
  } finally {
    await close();
  }
});

test('rejects malformed signed JSON', async () => {
  let runs = 0;
  const { port, close } = await withServer(async () => {
    runs += 1;
  });

  try {
    const body = '{not-json';
    const response = await postWebhook(port, {
      host: 'webhook.tokscale.guieunuch.cc',
      signature: signBody(ENV.GITHUB_WEBHOOK_SECRET, body),
      event: 'push',
      body,
    });

    assert.equal(response.status, 400);
    assert.equal(runs, 0);
  } finally {
    await close();
  }
});

test('rejects oversized payloads and never runs merge', async () => {
  let runs = 0;
  const { port, close } = await withServer(async () => {
    runs += 1;
  });

  try {
    const body = 'a'.repeat(MAX_BODY_BYTES + 1);
    const result = await postWebhook(port, {
      host: 'webhook.tokscale.guieunuch.cc',
      body,
    }).catch((error) => error);

    assert.ok(result instanceof Error);
    assert.equal(result.code, 'ECONNRESET');
    assert.equal(runs, 0);
  } finally {
    await close();
  }
});

test('coalesces concurrent pushes into one pending follow-up run', async () => {
  let runs = 0;
  let releaseFirst;
  let releaseSecond;
  let resolveSecondStarted;
  const firstRunGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const secondRunStarted = new Promise((resolve) => {
    resolveSecondStarted = resolve;
  });
  const secondRunGate = new Promise((resolve) => {
    releaseSecond = resolve;
  });

  const runMerge = async () => {
    runs += 1;
    if (runs === 1) {
      await firstRunGate;
      return;
    }
    if (runs === 2) {
      resolveSecondStarted();
      await secondRunGate;
    }
  };

  const firstJob = scheduleMerge(LEGACY_ROUTE, runMerge);
  const secondJob = scheduleMerge(LEGACY_ROUTE, runMerge);
  const thirdJob = scheduleMerge(LEGACY_ROUTE, runMerge);

  assert.equal(firstJob.started, true);
  assert.equal(secondJob.started, false);
  assert.equal(thirdJob.started, false);

  releaseFirst();
  await firstJob.completion;
  await secondRunStarted;
  releaseSecond();
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(runs, 2);
});

test('dispatches requests by host with isolated per-route state', async () => {
  const routesFile = writeTempRoutesFile([
    {
      name: 'tokscale',
      host: 'webhook.tokscale.guieunuch.cc',
      repoFullName: 'guieunuch/tokscale-stats',
      secret: 'tokscale-secret',
      command: ['node', 'merge.js'],
      cwd: '/volume1/docker/Tokscale',
    },
    {
      name: 'project-b',
      host: 'webhook.project-b.cc',
      repoFullName: 'team/project-b',
      secret: 'project-b-secret',
      command: ['node', 'merge.js'],
      cwd: '/volume1/docker/Tokscale',
    },
  ]);

  const env = {
    ...ENV,
    WEBHOOK_ROUTES_FILE: routesFile,
  };

  const counts = { tokscale: 0, 'project-b': 0 };
  const { port, close } = await withServer(async (route) => {
    counts[route.name] += 1;
  }, env);

  try {
    const tokscaleBody = JSON.stringify({
      repository: { full_name: 'guieunuch/tokscale-stats' },
    });
    const tokscaleResponse = await postWebhook(port, {
      host: 'webhook.tokscale.guieunuch.cc',
      signature: signBody('tokscale-secret', tokscaleBody),
      event: 'push',
      body: tokscaleBody,
    });

    const projectBody = JSON.stringify({
      repository: { full_name: 'team/project-b' },
    });
    const projectResponse = await postWebhook(port, {
      host: 'webhook.project-b.cc',
      signature: signBody('project-b-secret', projectBody),
      event: 'push',
      body: projectBody,
    });

    const unknownHostResponse = await postWebhook(port, {
      host: 'webhook.unknown.cc',
      body: '{}',
    });

    assert.equal(tokscaleResponse.status, 200);
    assert.equal(projectResponse.status, 200);
    assert.equal(unknownHostResponse.status, 404);
    assert.equal(counts.tokscale, 1);
    assert.equal(counts['project-b'], 1);
  } finally {
    await close();
  }
});
