#!/usr/bin/env node
/**
 * Setup private Screeps server for testing
 * Creates user and spawns them in W0N0 with initial structures
 */
const http = require('http');

const config = {
  host: 'localhost',
  port: 21025,
  username: 'screeps',
  password: 'screeps',
  room: 'W0N0'
};

function request(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const req = http.request({
      hostname: config.host,
      port: config.port,
      path: path,
      method: method,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        ...headers
      }
    }, (res) => {
      let responseBody = '';
      res.on('data', chunk => responseBody += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(responseBody));
        } catch (e) {
          resolve({ raw: responseBody });
        }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function authenticate() {
  const auth = await request('POST', '/api/auth/signin', {
    email: config.username,
    password: config.password
  });

  if (!auth.token) {
    throw new Error(`Auth failed: ${JSON.stringify(auth)}`);
  }
  return auth.token;
}

async function registerUser() {
  try {
    const result = await request('POST', '/api/register/submit', {
      username: config.username,
      password: config.password,
      email: `${config.username}@localhost`
    });
    console.log('User registered:', result);
  } catch (e) {
    // User might already exist
    console.log('User registration (may already exist)');
  }
}

async function getUserInfo(token) {
  return await request('GET', '/api/auth/me', null, {
    'X-Token': token,
    'X-Username': config.username
  });
}

async function placeSpawn(token, userId) {
  // Use the admin-utils API to place spawn
  // The API endpoint is /api/game/place-spawn for screepsmod-admin-utils
  const result = await request('POST', '/api/game/place-spawn', {
    room: config.room,
    x: 25,
    y: 25,
    name: 'Spawn1'
  }, {
    'X-Token': token,
    'X-Username': config.username
  });
  return result;
}

async function getRoomObjects(room) {
  return await request('GET', `/api/game/room-objects?room=${room}`, null);
}

async function main() {
  console.log('Setting up Screeps private server...\n');

  // Register user
  await registerUser();

  // Authenticate
  console.log('Authenticating...');
  const token = await authenticate();
  console.log('Authenticated\n');

  // Get user info
  const user = await getUserInfo(token);
  console.log('User ID:', user._id);

  // Check room objects
  const roomObjects = await getRoomObjects(config.room);
  const spawns = (roomObjects.objects || []).filter(o => o.type === 'spawn');

  if (spawns.length > 0) {
    console.log(`Room ${config.room} already has ${spawns.length} spawn(s)`);
  } else {
    console.log(`No spawns in ${config.room}, attempting to place one...`);

    // Try to place spawn using admin API
    const spawnResult = await placeSpawn(token, user._id);
    console.log('Place spawn result:', spawnResult);
  }

  // Verify final state
  const finalObjects = await getRoomObjects(config.room);
  const finalSpawns = (finalObjects.objects || []).filter(o => o.type === 'spawn');
  console.log(`\nFinal state: ${finalSpawns.length} spawn(s) in ${config.room}`);

  if (finalSpawns.length === 0) {
    console.log('\nWARNING: No spawn was created.');
    console.log('You may need to manually spawn via the CLI:');
    console.log('  docker-compose exec screeps screeps-launcher cli');
    console.log('  > utils.addSpawnToRoom("W0N0", 25, 25, "Spawn1", "screeps")');
  }
}

main().catch(err => {
  console.error('Setup failed:', err);
  process.exit(1);
});
