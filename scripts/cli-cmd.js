#!/usr/bin/env node
/**
 * Execute CLI command on Screeps private server
 */
const net = require('net');

const command = process.argv[2] || 'help()';
const port = parseInt(process.env.CLI_PORT || '21026');
const host = process.env.CLI_HOST || 'localhost';

const client = new net.Socket();
let buffer = '';
let gotResponse = false;

client.connect(port, host, () => {
  // Send command immediately after connection
  client.write(command + '\n');
});

client.on('data', (data) => {
  buffer += data.toString();
  // Check if we have a complete response (ends with > prompt)
  if (buffer.includes('\n< ') || buffer.includes('\n> ')) {
    gotResponse = true;
  }
  process.stdout.write(data.toString());
});

client.on('error', (err) => {
  console.error('Connection error:', err.message);
  process.exit(1);
});

client.on('close', () => {
  process.exit(0);
});

// Give time for response
setTimeout(() => {
  client.end();
  process.exit(0);
}, 5000);
