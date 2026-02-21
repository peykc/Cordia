#!/usr/bin/env node
/**
 * Cordia Beacon stress-tester (Node.js).
 * Opens N WebSocket connections and sends PresenceHello so the beacon counts them.
 * No browser limit — use this for 500+ connections.
 *
 * Usage: node stress-test.mjs <beacon-url> [count]
 * Example: node stress-test.mjs https://beacon.pkcollection.net 500
 *
 * Requires: npm install ws
 */

import { WebSocket } from 'ws';

const args = process.argv.slice(2);
const baseUrl = args[0] || 'http://localhost:3030';
const count = Math.max(1, parseInt(args[1], 10) || 100);

const wsBase = baseUrl
  .replace(/^http:\/\//i, 'ws://')
  .replace(/^https:\/\//i, 'wss://')
  .replace(/\/+$/, '');
const wsUrl = wsBase + '/ws';

const instanceId = Math.random().toString(36).slice(2, 10);
const sockets = [];

function sendPresenceHello(ws, index) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(
    JSON.stringify({
      type: 'PresenceHello',
      user_id: `stress-${instanceId}-${index}`,
      signing_pubkeys: ['stress-house'],
      active_signing_pubkey: null,
    })
  );
}

function openCount() {
  return sockets.filter((s) => s.readyState === WebSocket.OPEN).length;
}

function log(msg) {
  const t = new Date().toLocaleTimeString();
  console.log(`[${t}] ${msg}`);
}

log(`Opening ${count} connections to ${wsUrl} (instance: ${instanceId})…`);

for (let i = 0; i < count; i++) {
  const ws = new WebSocket(wsUrl);
  const index = i;
  ws.on('open', () => {
    sendPresenceHello(ws, index);
    if ((index + 1) % 100 === 0 || index === count - 1) {
      log(`Open: ${openCount()} / ${count}`);
    }
  });
  ws.on('close', () => {
    if (sockets.length > 0 && openCount() < sockets.length) {
      log(`Open: ${openCount()} / ${count}`);
    }
  });
  ws.on('error', () => {});
  sockets.push(ws);
}

process.on('SIGINT', () => {
  log(`Closing ${sockets.length} connections…`);
  sockets.forEach((ws) => {
    try {
      ws.close();
    } catch (_) {}
  });
  process.exit(0);
});
