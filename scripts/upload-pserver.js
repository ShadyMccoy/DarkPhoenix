#!/usr/bin/env node
/**
 * Upload code to private Screeps server
 */
const fs = require('fs');
const path = require('path');
const http = require('http');

const config = {
  host: 'localhost',
  port: 21025,
  username: 'testuser',
  password: 'testpass'
};

async function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: config.host,
      port: config.port,
      path: path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length
      }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          resolve({ raw: body });
        }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function main() {
  const mainJs = fs.readFileSync(path.join(__dirname, '..', 'dist', 'main.js'), 'utf8');

  console.log('Registering/signing in user...');

  // Try to register first (will fail if user exists, that's ok)
  try {
    await post('/api/register/submit', {
      username: config.username,
      password: config.password,
      email: `${config.username}@localhost`
    });
    console.log('User registered');
  } catch (e) {
    // User might already exist
  }

  // Sign in
  const auth = await post('/api/auth/signin', {
    email: config.username,
    password: config.password
  });

  if (!auth.token) {
    console.error('Auth failed:', auth);
    process.exit(1);
  }
  console.log('Authenticated');

  // Upload code
  const uploadReq = http.request({
    hostname: config.host,
    port: config.port,
    path: '/api/user/code',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Token': auth.token,
      'X-Username': config.username
    }
  }, (res) => {
    let body = '';
    res.on('data', chunk => body += chunk);
    res.on('end', () => {
      console.log('Upload response:', body);
      console.log('Code deployed successfully!');
    });
  });

  const uploadData = JSON.stringify({
    branch: 'default',
    modules: { main: mainJs }
  });

  uploadReq.write(uploadData);
  uploadReq.end();
}

main().catch(console.error);
