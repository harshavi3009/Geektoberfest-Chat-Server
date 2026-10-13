// Starts everything the integration tests need once, before any test file runs: an in-memory
// MongoDB, a minimal Redis, and the real backend (server.js) as a child process on a free port.
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { startRedisStub } = require('./helpers/redisStub.cjs');

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function waitForHealth(url, child, output) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Backend exited early (${child.exitCode}):\n${output.join('')}`);
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Backend did not become healthy:\n${output.join('')}`);
}

module.exports = async () => {
  const mongo = await MongoMemoryServer.create();
  const redis = await startRedisStub();
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;

  const output = [];
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      MONGO_URL: mongo.getUri('chat-test'),
      REDIS_URL: `redis://127.0.0.1:${redis.port}`,
      JWT_SECRET: 'test-secret-that-is-long-enough-for-hs256-0123456789',
      FRONTEND_ORIGIN: 'http://localhost:5173',
      // Read the client address from X-Forwarded-For, which the helpers set per request (see client.cjs).
      TRUST_PROXY: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => output.push(chunk.toString()));
  child.stderr.on('data', (chunk) => output.push(chunk.toString()));

  try {
    await waitForHealth(url, child, output);
  } catch (error) {
    child.kill();
    await redis.close();
    await mongo.stop();
    throw error;
  }

  // Test files run in separate workers, which inherit this environment variable.
  process.env.TEST_SERVER_URL = url;
  globalThis.__TEST_SERVICES__ = { mongo, redis, child };
};
