'use strict';

// The MCP server's protocol and its door (mcp.js), under plain Node: what it
// answers, what it refuses, and that a port in use is reported, not thrown.
// The answers themselves come from the window: `npm run test:mcp`.

const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { describe, test, before, after } = require('node:test');

const NeoMcp = require(path.join(__dirname, '..', 'mcp.js'));

const asked = [];
const ask = async (tool, args) => {
  asked.push([tool, args]);
  if (tool === 'word_count') return { data: { words: 3 } };
  if (tool === 'read_chapter') return { text: 'Chapter 1\n\nThree words here.' };
  throw new Error('No book is open in NEO.');
};

describe('the protocol', () => {
  const answer = (msg) => NeoMcp.answer(msg, { ask, version: '9.9.9' });

  test('initialize: the client\'s version when NEO knows it, else the newest', async () => {
    const known = await answer({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
    assert.equal(known.result.protocolVersion, '2025-03-26');
    assert.equal(known.result.serverInfo.version, '9.9.9');
    const unknown = await answer({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
    assert.equal(unknown.result.protocolVersion, NeoMcp.PROTOCOL_VERSIONS[0]);
  });

  test('every tool reads, none writes', async () => {
    const { result } = await answer({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.equal(result.tools.length, 8);
    for (const t of result.tools) {
      assert.equal(t.annotations.readOnlyHint, true);
      assert.equal(t.annotations.destructiveHint, false);
      assert.equal(t.inputSchema.type, 'object');
      assert.doesNotMatch(t.name, /write|edit|set|delete|move|rename|create|update/);
    }
  });

  test('a tool\'s answer: text as it is, data as JSON', async () => {
    const text = await answer({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read_chapter', arguments: { chapter: 1 } } });
    assert.deepEqual(text.result, { content: [{ type: 'text', text: 'Chapter 1\n\nThree words here.' }], isError: false });
    const data = await answer({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'word_count', arguments: { text: 'a b c' } } });
    assert.deepEqual(JSON.parse(data.result.content[0].text), { words: 3 });
    assert.deepEqual(asked.at(-1), ['word_count', { text: 'a b c' }]);
  });

  test('a tool that can\'t answer says why, as a tool error the model reads', async () => {
    const r = await answer({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_books' } });
    assert.equal(r.result.isError, true);
    assert.match(r.result.content[0].text, /No book is open/);
  });

  test('an unknown tool or method is a protocol error; a notification has no answer', async () => {
    const before = asked.length;
    assert.equal((await answer({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'write_chapter' } })).error.code, -32602);
    assert.equal(asked.length, before, 'never reaches the window');
    assert.equal((await answer({ jsonrpc: '2.0', id: 2, method: 'resources/list' })).error.code, -32601);
    assert.equal(await answer({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
    assert.equal((await answer({ id: 3, method: 'ping' })).error.code, -32600);
  });
});

describe('the door', () => {
  let server;
  let port;
  const token = NeoMcp.newToken();
  const req = (opts, body) => new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', ...opts }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
    });
    r.on('error', reject);
    r.end(body === undefined ? '' : JSON.stringify(body));
  });
  const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };
  const auth = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };

  before(async () => {
    server = NeoMcp.createServer({ ask, version: () => '1.0.0' });
    const st = await server.start({ port: 0, token });
    assert.equal(st.running, true);
    port = st.port;
  });
  after(() => server.stop());

  test('the token, and nothing else, lets a request in', async () => {
    assert.equal((await req({ headers: auth }, ping)).status, 200);
    assert.equal((await req({ headers: { 'Content-Type': 'application/json' } }, ping)).status, 401);
    assert.equal((await req({ headers: { ...auth, Authorization: 'Bearer ' + token.slice(1) } }, ping)).status, 401);
  });

  test('another site\'s page, or a name that isn\'t this computer, is refused', async () => {
    assert.equal((await req({ headers: { ...auth, Origin: 'https://evil.example' } }, ping)).status, 403);
    assert.equal((await req({ headers: { ...auth, Host: 'evil.example:' + port } }, ping)).status, 403);
    assert.equal((await req({ headers: { ...auth, Host: 'localhost:' + port } }, ping)).status, 200);
  });

  test('only /mcp, only POST, only JSON', async () => {
    assert.equal((await req({ headers: auth, path: '/' }, ping)).status, 404);
    assert.equal((await req({ headers: auth, method: 'GET' })).status, 405);
    assert.equal((await req({ headers: auth, method: 'DELETE' })).status, 405);
    const bad = await new Promise((resolve) => {
      const r = http.request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: auth }, (res) => resolve(res.statusCode));
      r.end('{not json');
    });
    assert.equal(bad, 400);
  });

  test('a notification is accepted with no body; a batch gets its answers', async () => {
    assert.equal((await req({ headers: auth }, { jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
    const batch = await req({ headers: auth }, [ping, { jsonrpc: '2.0', method: 'notifications/initialized' }, { ...ping, id: 2 }]);
    assert.deepEqual(batch.body.map((r) => r.id), [1, 2]);
  });

  test('a new token takes over at once', async () => {
    const next = NeoMcp.newToken();
    server.setToken(next);
    assert.equal((await req({ headers: auth }, ping)).status, 401);
    assert.equal((await req({ headers: { ...auth, Authorization: 'Bearer ' + next } }, ping)).status, 200);
    server.setToken(token);
  });

  test('a port in use is reported, not thrown', async () => {
    const other = net.createServer();
    await new Promise((resolve) => other.listen(0, '127.0.0.1', resolve));
    const taken = other.address().port;
    const second = NeoMcp.createServer({ ask });
    const st = await second.start({ port: taken, token });
    assert.deepEqual(st, { running: false, port: taken, error: 'in-use' });
    await second.stop();
    await new Promise((resolve) => other.close(resolve));
  });

  test('stopped: nothing listens', async () => {
    const s = NeoMcp.createServer({ ask });
    const st = await s.start({ port: 0, token });
    await s.stop();
    assert.equal(s.status().running, false);
    await assert.rejects(new Promise((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port: st.port, path: '/mcp', method: 'POST' }, resolve);
      r.on('error', reject);
      r.end();
    }));
  });
});
