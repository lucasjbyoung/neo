#!/usr/bin/env node
// NEO's MCP server for apps that only start MCP servers themselves, over
// stdin and stdout (Claude Desktop's claude_desktop_config.json, say). It
// passes each message to NEO's own server (File → MCP Server…) and each
// answer back. NEO has to be open with the server on. No dependencies.
//
//   "neo": {
//     "command": "node",
//     "args": ["/path/to/neo/scripts/mcp-stdio.js"],
//     "env": { "NEO_MCP_TOKEN": "the token from File → MCP Server…" }
//   }
//
// NEO_MCP_URL is the address, if the port isn't NEO's default.

'use strict';

const http = require('http');
const readline = require('readline');

const URL_ = new URL(process.env.NEO_MCP_URL || 'http://127.0.0.1:47811/mcp');
const TOKEN = process.env.NEO_MCP_TOKEN || '';

const out = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const fail = (id, message) => { if (id !== undefined) out({ jsonrpc: '2.0', id, error: { code: -32000, message } }); };

function forward(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return out({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
  const id = msg && msg.id;
  const req = http.request({
    host: URL_.hostname, port: URL_.port || 80, path: URL_.pathname, method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: 'Bearer ' + TOKEN }
  }, (res) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (c) => { body += c; });
    res.on('end', () => {
      if (res.statusCode === 202 || !body) return;
      if (res.statusCode === 401) return fail(id, 'NEO refused the token. Copy it again from File → MCP Server… into NEO_MCP_TOKEN.');
      try {
        const answer = JSON.parse(body);
        if (res.statusCode !== 200 && !answer.jsonrpc) return fail(id, `NEO answered ${res.statusCode}: ${answer.error || body}`);
        (Array.isArray(answer) ? answer : [answer]).forEach(out);
      } catch { fail(id, `NEO answered ${res.statusCode}`); }
    });
  });
  req.on('error', () => fail(id, 'NEO isn’t answering. Open NEO, with File → Show More Features on and the server on in File → MCP Server….'));
  req.end(JSON.stringify(msg));
}

readline.createInterface({ input: process.stdin }).on('line', (line) => { if (line.trim()) forward(line); });
