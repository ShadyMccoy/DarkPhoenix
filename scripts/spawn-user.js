#!/usr/bin/env node
/**
 * Spawn user in a room on private server using direct HTTP API calls
 */
const http = require('http');

const config = {
  host: 'localhost',
  port: 21025,
  username: 'testuser',
  password: 'testpass',
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

async function main() {
  console.log('Setting up Screeps private server...\n');

  // Register user
  console.log('Registering user...');
  const regResult = await request('POST', '/api/register/submit', {
    username: config.username,
    password: config.password,
    email: `${config.username}@localhost`
  });
  console.log('Register:', regResult.ok ? 'OK' : (regResult.error?.substring(0, 30) || 'error'));

  // Authenticate
  console.log('Authenticating...');
  const auth = await request('POST', '/api/auth/signin', {
    email: config.username,
    password: config.password
  });

  if (!auth.token) {
    console.error('Auth failed:', auth);
    process.exit(1);
  }
  console.log('Authenticated');

  const headers = {
    'X-Token': auth.token,
    'X-Username': config.username
  };

  // Get user info
  const me = await request('GET', '/api/auth/me', null, headers);
  console.log('User ID:', me._id);

  // Check room status
  const roomObjects = await request('GET', `/api/game/room-objects?room=${config.room}`, null, headers);
  const objects = roomObjects.objects || [];

  const spawns = objects.filter(o => o.type === 'spawn');
  const controllers = objects.filter(o => o.type === 'controller');
  const sources = objects.filter(o => o.type === 'source');

  console.log('\nRoom', config.room, 'status:');
  console.log('  Spawns:', spawns.length);
  console.log('  Controllers:', controllers.length);
  console.log('  Sources:', sources.length);

  if (spawns.length === 0) {
    console.log('\n=== NO SPAWN FOUND ===');
    console.log('The private server needs a map with controllers and sources.');
    console.log('');
    console.log('Options:');
    console.log('1. Use screepsmod-mongo to import a map');
    console.log('2. Manually create game objects via CLI');
    console.log('3. Use the screeps-server-mockup for integration tests');
    console.log('');
    console.log('For now, running the sim:deploy and scenario tests anyway...');
  } else {
    console.log('\nSpawn found! User is ready.');
  }
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
