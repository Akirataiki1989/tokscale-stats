const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { execFile } = require('child_process');

const PORT = 8965;
const MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_ROUTES_FILE = '/volume1/docker/Tokscale/webhook.routes.json';
const LEGACY_ROUTE_NAME = 'tokscale';
const LEGACY_ROUTE_HOST = 'webhook.tokscale.guieunuch.cc';
const LEGACY_ROUTE_REPO = 'guieunuch/tokscale-stats';
const LEGACY_ROUTE_SECRET_ENV = 'GITHUB_WEBHOOK_SECRET';
const LEGACY_ROUTE_COMMAND = ['node', 'merge.js'];
const LEGACY_ROUTE_CWD = '/volume1/docker/Tokscale';

const schedulerState = new Map();

function normalizeRoute(route, index = 0) {
  const name = (route.name || `${LEGACY_ROUTE_NAME}-${index}`).trim();
  const host = (route.host || '').trim().toLowerCase();
  const repoFullName = (route.repoFullName || route.repositoryFullName || '').trim();
  const secretEnv = (route.secretEnv || '').trim();
  const secret = typeof route.secret === 'string' ? route.secret.trim() : '';
  const command = Array.isArray(route.command) ? route.command.map((part) => String(part)) : [];
  const cwd = (route.cwd || LEGACY_ROUTE_CWD).trim();
  const maxBodyBytes = Number.isInteger(route.maxBodyBytes) ? route.maxBodyBytes : MAX_BODY_BYTES;

  if (!host) {
    throw new Error(`Route ${name} is missing host`);
  }

  if (!repoFullName) {
    throw new Error(`Route ${name} is missing repoFullName`);
  }

  if (!command.length) {
    throw new Error(`Route ${name} is missing command`);
  }

  if (!secret && !secretEnv) {
    throw new Error(`Route ${name} is missing secret or secretEnv`);
  }

  return {
    name,
    host,
    repoFullName,
    secretEnv,
    secret,
    command,
    cwd,
    maxBodyBytes,
  };
}

function readRoutesConfigFile(routesFilePath = DEFAULT_ROUTES_FILE) {
  if (!fs.existsSync(routesFilePath)) {
    return [];
  }

  const raw = fs.readFileSync(routesFilePath, 'utf8');
  const parsed = JSON.parse(raw);
  const routes = Array.isArray(parsed) ? parsed : parsed.routes;

  if (!Array.isArray(routes) || routes.length === 0) {
    throw new Error(`No webhook routes found in ${routesFilePath}`);
  }

  return routes.map((route, index) => normalizeRoute(route, index));
}

function readConfig(env = process.env) {
  const routesFilePath = (env.WEBHOOK_ROUTES_FILE || DEFAULT_ROUTES_FILE).trim();
  const routes = readRoutesConfigFile(routesFilePath);

  if (routes.length > 0) {
    return { routes, routesFilePath };
  }

  const secret = (env.GITHUB_WEBHOOK_SECRET || '').trim();
  const repoFullName = (env.GITHUB_REPO_FULL_NAME || '').trim();
  const host = (env.GITHUB_WEBHOOK_HOST || LEGACY_ROUTE_HOST).trim().toLowerCase();
  const command = (env.GITHUB_WEBHOOK_COMMAND || LEGACY_ROUTE_COMMAND.join(' ')).trim().split(/\s+/);
  const cwd = (env.GITHUB_WEBHOOK_CWD || LEGACY_ROUTE_CWD).trim();

  if (!secret) {
    throw new Error('GITHUB_WEBHOOK_SECRET is not set');
  }
  if (!repoFullName) {
    throw new Error('GITHUB_REPO_FULL_NAME is not set');
  }

  return {
    routes: [
      normalizeRoute(
        {
          name: LEGACY_ROUTE_NAME,
          host,
          repoFullName,
          secretEnv: LEGACY_ROUTE_SECRET_ENV,
          secret,
          command,
          cwd,
        },
        0
      ),
    ],
    routesFilePath: null,
  };
}

function isGitHubSignatureHeader(value) {
  return /^sha256=[0-9a-f]{64}$/.test(value);
}

function timingSafeSignatureEquals(actualHeader, expectedDigestHex) {
  const actual = Buffer.from(actualHeader, 'utf8');
  const expected = Buffer.from(`sha256=${expectedDigestHex}`, 'utf8');
  if (actual.length !== expected.length) {
    return false;
  }
  return crypto.timingSafeEqual(actual, expected);
}

function collectRawBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;

    const settle = (fn, value) => {
      if (settled) {
        return;
      }
      settled = true;
      fn(value);
    };

    req.on('data', (chunk) => {
      if (settled) {
        return;
      }

      total += chunk.length;
      if (total > maxBytes) {
        req.destroy();
        const error = new Error('payload too large');
        error.code = 'PAYLOAD_TOO_LARGE';
        settle(reject, error);
        return;
      }

      chunks.push(chunk);
    });

    req.on('end', () => {
      if (settled) {
        return;
      }
      settle(resolve, Buffer.concat(chunks, total));
    });

    req.on('error', (error) => {
      if (settled) {
        return;
      }
      settle(reject, error);
    });

    req.on('close', () => {
      if (settled) {
        return;
      }
      const error = new Error('request closed');
      error.code = 'REQUEST_CLOSED';
      settle(reject, error);
    });
  });
}

async function runRouteCommand(route) {
  return new Promise((resolve, reject) => {
    const child = execFile(route.command[0], route.command.slice(1), { cwd: route.cwd }, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });

    child.stdout?.on('data', (chunk) => {
      process.stdout.write(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      process.stderr.write(chunk);
    });
  });
}

function getSchedulerState(routeName) {
  if (!schedulerState.has(routeName)) {
    schedulerState.set(routeName, { mergeRunning: false, mergePending: false });
  }
  return schedulerState.get(routeName);
}

function scheduleMerge(route, runMerge = () => runRouteCommand(route)) {
  const state = getSchedulerState(route.name);

  if (state.mergeRunning) {
    state.mergePending = true;
    return { started: false, completion: Promise.resolve(false) };
  }

  state.mergeRunning = true;
  const completion = (async () => {
    try {
      await runMerge();
      return true;
    } finally {
      state.mergeRunning = false;
      if (state.mergePending) {
        state.mergePending = false;
        void scheduleMerge(route, runMerge);
      }
    }
  })();

  return { started: true, completion };
}

function resetSchedulerState() {
  schedulerState.clear();
}

function buildWebhookHandler({ env = process.env, runMerge = runMergeScript, logger = console } = {}) {
  const config = readConfig(env);
  const routesByHost = new Map(config.routes.map((route) => [route.host, route]));

  return async function webhookHandler(req, res) {
    if (req.method !== 'POST') {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }

    const hostHeader = String(req.headers.host || '').split(':')[0].toLowerCase();
    const route = routesByHost.get(hostHeader);
    if (!route) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }

    let rawBody;
    try {
      rawBody = await collectRawBody(req, route.maxBodyBytes);
    } catch (error) {
      if (error.code === 'PAYLOAD_TOO_LARGE') {
        res.writeHead(413, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Payload Too Large');
        return;
      }

      logger.error('Failed to read webhook body:', error);
      if (!res.headersSent) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Bad Request');
      }
      return;
    }

    const signature = req.headers['x-hub-signature-256'];
    if (typeof signature !== 'string' || !isGitHubSignatureHeader(signature)) {
      res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Unauthorized');
      return;
    }

    const expectedDigest = crypto
      .createHmac('sha256', route.secret || (env[route.secretEnv] || '').trim())
      .update(rawBody)
      .digest('hex');

    if (!timingSafeSignatureEquals(signature, expectedDigest)) {
      res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Unauthorized');
      return;
    }

    let payload;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Bad Request');
      return;
    }

    const event = req.headers['x-github-event'];
    const fullName = payload?.repository?.full_name;
    if (event !== 'push' || fullName !== route.repoFullName) {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Ignored');
      return;
    }

    const job = scheduleMerge(route, () => runMerge(route));
    try {
      if (job.started) {
        await job.completion;
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Merge triggered successfully');
        return;
      }

      res.writeHead(202, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Merge already running; queued follow-up');
    } catch (error) {
      logger.error('Failed to execute merge script:', error);
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Merge failed');
    }
  };
}

function createServer(options = {}) {
  return http.createServer(buildWebhookHandler(options));
}

if (require.main === module) {
  try {
    readConfig();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }

  const server = createServer();
  server.listen(PORT, () => {
    console.log(`Tokscale Webhook receiver listening on port ${PORT}`);
  });
}

module.exports = {
  MAX_BODY_BYTES,
  DEFAULT_ROUTES_FILE,
  PORT,
  buildWebhookHandler,
  collectRawBody,
  createServer,
  isGitHubSignatureHeader,
  readConfig,
  scheduleMerge,
  resetSchedulerState,
  timingSafeSignatureEquals,
  normalizeRoute,
  readRoutesConfigFile,
  runRouteCommand,
};
