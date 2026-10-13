const { io } = require('socket.io-client');

const baseUrl = () => process.env.TEST_SERVER_URL;
const PASSWORD = 'correct-horse-battery';

let addressCounter = 0;
// Every request and socket gets its own fake client address, so the per-IP connection and request
// limits apply to each test separately instead of to the whole test run.
const nextAddress = () => {
  addressCounter += 1;
  return `10.${Math.floor(addressCounter / 65536) % 256}.${Math.floor(addressCounter / 256) % 256}.${addressCounter % 256}`;
};

let counter = 0;
// Usernames are 3-24 characters, so keep them short and unique across the whole run.
const uniqueName = (prefix) => `${prefix}${Date.now().toString(36).slice(-5)}${(counter += 1)}`;

async function request(method, path, { body, token } = {}) {
  const response = await fetch(`${baseUrl()}${path}`, {
    method,
    headers: {
      'X-Forwarded-For': nextAddress(),
      ...(body && { 'Content-Type': 'application/json' }),
      ...(token && { Authorization: `Bearer ${token}` }),
    },
    body: body && JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
}

async function register(prefix = 'user') {
  const username = uniqueName(prefix);
  const { status, body } = await request('POST', '/api/auth/register', { body: { username, password: PASSWORD } });
  if (status !== 201) throw new Error(`register failed: ${status} ${JSON.stringify(body)}`);
  return { username, password: PASSWORD, token: body.token, id: body.user.id };
}

// A connected client that records everything the server sends, so tests can wait for events.
function connect(token) {
  const socket = io(baseUrl(), {
    transports: ['websocket'],
    forceNew: true,
    auth: { token },
    reconnection: false,
    extraHeaders: { 'X-Forwarded-For': nextAddress() },
  });
  const events = [];
  socket.onAny((name, ...args) => events.push({ name, args }));

  const client = {
    socket,
    events,
    of: (name) => events.filter((event) => event.name === name).map((event) => event.args[0]),
    last: (name) => client.of(name).at(-1),
    waitFor(name, predicate = () => true, timeoutMs = 5000) {
      const existing = events.find((event) => event.name === name && predicate(event.args[0]));
      if (existing) return Promise.resolve(existing.args[0]);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          socket.offAny(listener);
          reject(new Error(`Timed out waiting for "${name}"`));
        }, timeoutMs);
        const listener = (eventName, ...args) => {
          if (eventName === name && predicate(args[0])) {
            clearTimeout(timer);
            socket.offAny(listener);
            resolve(args[0]);
          }
        };
        socket.onAny(listener);
      });
    },
    // Resolves once the server acknowledges the event, or with { timedOut: true }.
    emitWithAck: (name, payload) => new Promise((resolve) => {
      socket.timeout(5000).emit(name, payload, (error, response) => resolve(error ? { timedOut: true } : response));
    }),
    close: () => socket.close(),
  };

  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve(client));
    socket.once('connect_error', (error) => {
      socket.close();
      reject(error);
    });
  });
}

// Connects, joins a room and waits for the history so the room is ready to use.
async function joinRoom(user, room) {
  const client = await connect(user.token);
  client.socket.emit('join_room', { room });
  await client.waitFor('chat_history');
  return client;
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = { baseUrl, request, register, connect, joinRoom, uniqueName, pause, PASSWORD };
