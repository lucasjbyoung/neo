// NEO — the MCP server (File → MCP Server…, behind Show More Features)
//
// Lets an AI app on this computer (Claude, say) read the library while NEO
// is open: the shelves, chapters, notes and outline, word counts, a search.
// It is read-only. No tool writes, moves or deletes anything, and none is
// ever offered: the list below is the whole of what a client can ask for.
//
// The Model Context Protocol's Streamable HTTP transport, answered with
// plain JSON (no event stream, no sessions), on 127.0.0.1 only. Every
// request carries the token the writer copies out of the dialog. A page in
// a browser can't reach it: a request from another origin is refused, and
// so is one whose Host isn't this computer (DNS rebinding).
//
// The questions themselves are answered by the window (MCP in app.js), which
// already holds the open book, its unsaved words and NEO's own word count.
// This file only speaks the protocol; it needs nothing from Electron, so the
// tests run it under plain Node (scripts/mcp.test.js).

'use strict';

const http = require('http');
const crypto = require('crypto');

const DEFAULT_PORT = 47811;
// newest first: a client asking for one of these gets it, any other the newest
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_BODY = 1024 * 1024;

const BOOK = {
  type: 'string',
  description: 'The book: its id from list_books, or its title. Leave out for the book open in NEO.'
};
const CHAPTER = {
  type: ['string', 'integer'],
  description: 'A chapter: its position in the contents (1 is the first entry), its id, its name as NEO shows it ("Chapter 3", "Prologue"), or its title.'
};
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const TOOLS = [
  {
    name: 'list_books',
    title: 'List books',
    description: 'Every book in the NEO library: id, title, author, shelf, story word count, last modified, and which one is open.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'get_open_book',
    title: 'Open book',
    description: 'The book open in NEO right now, if any: title, author, the chapter the writer is in, word count, goals and today\'s words, and its contents.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'list_chapters',
    title: 'List chapters',
    description: 'A book\'s contents in order: position, id, name, title, kind (chapter, part, prologue, dedication…), whether it counts toward the story\'s words, and its word count.',
    inputSchema: { type: 'object', properties: { book: BOOK }, additionalProperties: false }
  },
  {
    name: 'read_chapter',
    title: 'Read a chapter',
    description: 'One chapter as plain text, a paragraph to a line. For the open book this includes words not yet saved.',
    inputSchema: { type: 'object', properties: { book: BOOK, chapter: CHAPTER }, required: ['chapter'], additionalProperties: false }
  },
  {
    name: 'read_book',
    title: 'Read the manuscript',
    description: 'The manuscript as plain text with a heading per chapter. The story only (chapters, parts, prologue, epilogue) unless include_front_and_back is true. A long book is cut at max_chars; read the rest with from and to.',
    inputSchema: {
      type: 'object',
      properties: {
        book: BOOK,
        from: { ...CHAPTER, description: 'First chapter to include (as for read_chapter). Default: the start.' },
        to: { ...CHAPTER, description: 'Last chapter to include. Default: the end.' },
        include_front_and_back: { type: 'boolean', description: 'Also the copyright, dedication, epigraph, contents, acknowledgments and about pages.' },
        max_chars: { type: 'integer', minimum: 1000, description: 'Stop after this many characters (default 100000).' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'word_count',
    title: 'Word count',
    description: 'NEO\'s own word count. With text: the words in that text. With a chapter: that chapter. Otherwise the whole book: story words, the book\'s goal, words per chapter, today\'s words against the daily goal, and the last 30 writing days.',
    inputSchema: {
      type: 'object',
      properties: { book: BOOK, chapter: CHAPTER, text: { type: 'string', description: 'Count this text instead of a book.' } },
      additionalProperties: false
    }
  },
  {
    name: 'read_notes',
    title: 'Read notes',
    description: 'A book\'s notes: the Notes tab\'s page (or one chapter\'s notes page), the outline (a line per chapter and its sections), and the sticky notes on its chapters.',
    inputSchema: {
      type: 'object',
      properties: {
        book: BOOK,
        chapter: { ...CHAPTER, description: 'Only this chapter\'s notes page, outline lines and sticky notes.' },
        which: { type: 'string', enum: ['all', 'notes', 'outline', 'stickies'], description: 'Default: all.' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'search',
    title: 'Search',
    description: 'Find a word or phrase in a book\'s chapters (or every book\'s), with the chapter and the words around each match.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1 },
        book: BOOK,
        all_books: { type: 'boolean', description: 'Search the whole library instead of one book.' },
        match_case: { type: 'boolean' },
        whole_word: { type: 'boolean' },
        limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Most matches to return (default 50).' }
      },
      required: ['query'],
      additionalProperties: false
    }
  }
].map((tool) => ({ ...tool, annotations: { title: tool.title, ...READ_ONLY } }));

const TOOL_NAMES = new Set(TOOLS.map((tool) => tool.name));

const INSTRUCTIONS = 'NEO is a word processor for books. These tools read the writer\'s library and never change it. ' +
  'Leave out "book" to mean the book open in NEO; list_books gives the others. Chapters can be named by position, ' +
  'by NEO\'s name for them ("Chapter 3") or by title. Word counts are NEO\'s own, the same numbers the writer sees.';

const newToken = () => crypto.randomBytes(24).toString('base64url');

function sameToken(given, token) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(String(token || ''));
  return a.length === b.length && b.length > 0 && crypto.timingSafeEqual(a, b);
}

const LOCAL_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;
const LOCAL_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

// one JSON-RPC message in, its answer out (null for a notification)
async function answer(msg, { ask, version }) {
  const id = msg && Object.prototype.hasOwnProperty.call(msg, 'id') ? msg.id : undefined;
  const reply = (result) => (id === undefined ? null : { jsonrpc: '2.0', id, result });
  const fail = (code, message) => (id === undefined ? null : { jsonrpc: '2.0', id, error: { code, message } });
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return { jsonrpc: '2.0', id: id === undefined ? null : id, error: { code: -32600, message: 'Invalid request' } };
  }
  const params = msg.params || {};
  switch (msg.method) {
    case 'initialize': {
      const asked = params.protocolVersion;
      return reply({
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'neo', title: 'NEO', version: String((typeof version === 'function' ? version() : version) || '') },
        instructions: INSTRUCTIONS
      });
    }
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'tools/call': {
      const name = params.name;
      if (!TOOL_NAMES.has(name)) return fail(-32602, `Unknown tool: ${name}`);
      const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
      try {
        const out = await ask(name, args);
        const text = typeof out === 'string' ? out
          : out && typeof out.text === 'string' ? out.text
            : JSON.stringify(out && 'data' in out ? out.data : out, null, 2);
        return reply({ content: [{ type: 'text', text }], isError: false });
      } catch (err) {
        // a tool that can't answer (no book open, a chapter that isn't
        // there) says so to the model, which can try again
        return reply({ content: [{ type: 'text', text: String((err && err.message) || err) }], isError: true });
      }
    }
    default:
      if (msg.method.startsWith('notifications/')) return null;
      return fail(-32601, `Method not found: ${msg.method}`);
  }
}

function send(res, status, body, headers = {}) {
  const data = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { ...(data ? { 'Content-Type': 'application/json' } : {}), 'Cache-Control': 'no-store', ...headers });
  res.end(data);
}

// options: ask(tool, args) → Promise of { text } or { data }; version (or a
// function giving it); log(err)
function createServer({ ask, version, log = () => {} }) {
  let server = null;
  let token = '';
  let state = { running: false, port: 0, error: '' };

  async function handle(req, res) {
    const url = (req.url || '').split('?')[0];
    if (!LOCAL_HOST.test(req.headers.host || '')) return send(res, 403, { error: 'Not this computer' });
    if (req.headers.origin && !LOCAL_ORIGIN.test(req.headers.origin)) return send(res, 403, { error: 'Origin not allowed' });
    if (url !== '/mcp') return send(res, 404, { error: 'Not found. The MCP endpoint is /mcp' });
    const auth = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
    if (!auth || !sameToken(auth[1].trim(), token)) return send(res, 401, { error: 'Missing or wrong token (NEO: File → MCP Server…)' });
    // no event stream to open, and no session to end
    if (req.method !== 'POST') return send(res, 405, { error: 'POST only' }, { Allow: 'POST' });

    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) return send(res, 413, { error: 'Too large' });
      chunks.push(chunk);
    }
    let msg;
    try { msg = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {
      return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    }
    const one = (m) => answer(m, { ask, version }).catch((err) => {
      log(err);
      return { jsonrpc: '2.0', id: m && m.id !== undefined ? m.id : null, error: { code: -32603, message: 'Internal error' } };
    });
    const out = Array.isArray(msg) ? (await Promise.all(msg.map(one))).filter(Boolean) : await one(msg);
    if (!out || (Array.isArray(out) && !out.length)) return send(res, 202);
    return send(res, 200, out);
  }

  function stop() {
    return new Promise((resolve) => {
      const s = server;
      server = null;
      state = { running: false, port: 0, error: '' };
      if (!s) return resolve();
      s.close(() => resolve());
      if (s.closeAllConnections) s.closeAllConnections();
    });
  }

  // resolves with the state either way: a port in use is the writer's to
  // change in the dialog, not a crash
  async function start({ port = DEFAULT_PORT, token: tk }) {
    await stop();
    token = tk;
    return new Promise((resolve) => {
      const s = http.createServer((req, res) => {
        handle(req, res).catch((err) => { log(err); try { send(res, 500, { error: 'Internal error' }); } catch { /* gone */ } });
      });
      s.on('error', (err) => {
        state = { running: false, port, error: err && err.code === 'EADDRINUSE' ? 'in-use' : String((err && err.message) || err) };
        if (server === s) server = null;
        resolve({ ...state });
      });
      s.listen(port, '127.0.0.1', () => {
        server = s;
        state = { running: true, port: s.address().port, error: '' };
        resolve({ ...state });
      });
    });
  }

  // a new token takes effect at once: the old one stops working
  const setToken = (tk) => { token = tk; };

  return { start, stop, setToken, status: () => ({ ...state }) };
}

module.exports = { createServer, answer, newToken, TOOLS, DEFAULT_PORT, PROTOCOL_VERSIONS };
