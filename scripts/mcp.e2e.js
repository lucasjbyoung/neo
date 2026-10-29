// End-to-end tests for the MCP server (File → MCP Server…). NEO runs on a
// throwaway library with two books, the server is turned on, and every
// question is asked over HTTP the way an AI app asks it. The answers must
// match what the writer sees, and nothing may be written by asking.
// Run with `npm run test:mcp`.

'use strict';

const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

for (const name of fs.readdirSync(os.tmpdir())) {
  const pid = /^neo-mcp-test-(\d+)-/.exec(name);
  if (!pid || +pid[1] === process.pid) continue;
  try { process.kill(+pid[1], 0); continue; } catch (err) { if (err.code === 'EPERM') continue; }
  fs.rmSync(path.join(os.tmpdir(), name), { recursive: true, force: true });
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `neo-mcp-test-${process.pid}-`));
const LIB = path.join(tmp, 'NEO Library');
app.setPath('userData', path.join(tmp, 'app'));
app.setPath('documents', tmp);
fs.mkdirSync(LIB);
fs.mkdirSync(path.join(tmp, 'app'));
fs.writeFileSync(path.join(LIB, 'library.json'), JSON.stringify({
  authorName: '', penNames: [], firstRunDone: true, moreFeatures: true, pageTheme: 'night', dailyGoal: 375,
  shelves: [{ id: 'shelf-1', name: 'Works in Progress', bookIds: [] }]
}));
const loadFile = BrowserWindow.prototype.loadFile;
BrowserWindow.prototype.loadFile = function (file, opts) {
  return loadFile.call(this, path.resolve(__dirname, '..', file), opts);
};

let wc;
let port = 0;
let token = '';
const js = (code) => wc.executeJavaScript(code, true);
const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

let rpcId = 0;
async function post(body, { auth = token, headers = {} } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(auth ? { Authorization: 'Bearer ' + auth } : {}), ...headers },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
async function rpc(method, params) {
  const { status, body } = await post({ jsonrpc: '2.0', id: ++rpcId, method, params });
  assert.equal(status, 200);
  assert.ok(!body.error, body.error && body.error.message);
  return body.result;
}
// a tool's answer: its text, parsed when it's JSON
async function call(name, args = {}) {
  const result = await rpc('tools/call', { name, arguments: args });
  const text = result.content[0].text;
  if (result.isError) throw Object.assign(new Error(text), { toolError: true });
  try { return JSON.parse(text); } catch { return text; }
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/* ---------- the door ---------- */

test('no token, a wrong token: refused', async () => {
  const msg = { jsonrpc: '2.0', id: 1, method: 'ping' };
  assert.equal((await post(msg, { auth: '' })).status, 401);
  assert.equal((await post(msg, { auth: token + 'x' })).status, 401);
});

test('a web page on another site: refused, even with the token', async () => {
  const msg = { jsonrpc: '2.0', id: 1, method: 'ping' };
  assert.equal((await post(msg, { headers: { Origin: 'https://example.com' } })).status, 403);
  assert.equal((await post(msg, { headers: { Origin: 'http://127.0.0.1:3000' } })).status, 200);
});

test('GET opens no stream', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, { headers: { Authorization: 'Bearer ' + token } });
  assert.equal(res.status, 405);
});

test('initialize: NEO, read-only tools, the client\'s protocol version', async () => {
  const r = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(r.protocolVersion, '2025-06-18');
  assert.equal(r.serverInfo.name, 'neo');
  assert.ok(r.capabilities.tools);
  const n = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(n.status, 202);
});

test('every tool says it only reads', async () => {
  const { tools } = await rpc('tools/list', {});
  assert.deepEqual(tools.map((t) => t.name).sort(),
    ['get_open_book', 'list_books', 'list_chapters', 'read_book', 'read_chapter', 'read_notes', 'search', 'word_count']);
  for (const t of tools) {
    assert.equal(t.annotations.readOnlyHint, true, t.name);
    assert.equal(t.annotations.destructiveHint, false, t.name);
  }
});

/* ---------- the answers ---------- */

test('list_books: both books, the open one marked, words as on the shelf', async () => {
  const { books } = await call('list_books');
  assert.equal(books.length, 2);
  const open = books.find((b) => b.open);
  assert.equal(open.title, 'Species Not Found');
  assert.equal(open.shelf, 'Works in Progress');
  assert.equal(open.words, await js('bookWordCount()'));
  const other = books.find((b) => !b.open);
  assert.equal(other.title, 'Another Book');
  assert.equal(other.words, 6);
});

test('get_open_book: NEO\'s count, today\'s goal, the contents', async () => {
  const b = await call('get_open_book');
  assert.equal(b.open, true);
  assert.equal(b.title, 'Species Not Found');
  assert.equal(b.words, await js('bookWordCount()'));
  assert.equal(b.daily_goal, 375);
  assert.deepEqual(b.contents.map((c) => c.heading), ['Chapter 1: Arrival', 'Chapter 2: The Scroll', 'Chapter 3: Vesuvius']);
});

test('list_chapters: positions, names, titles and words', async () => {
  const { chapters } = await call('list_chapters');
  assert.deepEqual(chapters.map((c) => [c.position, c.name, c.title, c.words]),
    [[1, 'Chapter 1', 'Arrival', 9], [2, 'Chapter 2', 'The Scroll', 15], [3, 'Chapter 3', 'Vesuvius', 4]]);
});

test('read_chapter: by position, by name, by title, a paragraph to a line', async () => {
  const byPos = await call('read_chapter', { chapter: 2 });
  assert.equal(byPos, 'Chapter 2: The Scroll\n\nThe scroll was carbonised in 79.\n\nIt had been waiting for someone to read it.');
  assert.equal(await call('read_chapter', { chapter: 'Chapter 2' }), byPos);
  assert.equal(await call('read_chapter', { chapter: 'the scroll' }), byPos);
  assert.equal(await call('read_chapter', { chapter: '2' }), byPos);
});

test('read_chapter: one that isn\'t there says so, and the model can ask again', async () => {
  await assert.rejects(call('read_chapter', { chapter: 9 }), /no number 9/);
  await assert.rejects(call('read_chapter', { chapter: 'Epilogue' }), /list_chapters/);
});

test('another book, by title, read from the disk', async () => {
  assert.equal(await call('read_chapter', { book: 'another', chapter: 1 }), 'Chapter 1: Only\n\nSix words in the other book.');
  const wc6 = await call('word_count', { book: 'Another Book' });
  assert.equal(wc6.words, 6);
});

test('word_count: the book, a chapter, some text', async () => {
  const all = await call('word_count');
  assert.equal(all.words, await js('bookWordCount()'));
  assert.equal(all.chapters.length, 3);
  assert.equal((await call('word_count', { chapter: 'Vesuvius' })).words, 4);
  assert.equal((await call('word_count', { text: 'One two « three » — four' })).words, 4);
});

test('search: the chapter and the words around it, here and in every book', async () => {
  const r = await call('search', { query: 'scroll' });
  assert.equal(r.matches_found, 1);
  assert.equal(r.matches[0].chapter, 'Chapter 2: The Scroll');
  assert.match(r.matches[0].context, /The scroll was carbonised/);
  const whole = await call('search', { query: 'book', all_books: true, whole_word: true });
  assert.equal(whole.matches_found, 1);
  assert.equal(whole.matches[0].book, 'Another Book');
});

test('read_notes: the notes page, the outline, the sticky notes', async () => {
  const text = await call('read_notes');
  assert.match(text, /# Notes/);
  assert.match(text, /# Outline\n\n- Chapter 1: Arrival\n- Chapter 2: The Scroll\n- Chapter 3: Vesuvius/);
  assert.match(text, /# Sticky notes\n\n\(none\)/);
});

test('read_book: cut at max_chars, with where to go on from', async () => {
  const full = await call('read_book');
  assert.match(full, /^# Species Not Found\n\n## Chapter 1: Arrival\n\n/);
  assert.match(full, /## Chapter 3: Vesuvius\n\nThe mountain woke early.$/);
  const cut = await call('read_book', { max_chars: 1000, to: 1 });
  assert.ok(!cut.includes('Chapter 2'));
  const rest = await call('read_book', { from: 'Chapter 2' });
  assert.match(rest, /^# Species Not Found\n\n## Chapter 2: The Scroll/);
});

test('asking writes nothing in the library', async () => {
  const stamps = () => {
    const out = {};
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const f = path.join(dir, e.name);
        if (e.isDirectory()) walk(f);
        else { const st = fs.statSync(f); out[path.relative(LIB, f)] = st.mtimeMs + ':' + st.size; }
      }
    };
    walk(LIB);
    return out;
  };
  const before = stamps();
  await call('list_books');
  await call('get_open_book');
  await call('list_chapters', { book: 'Another Book' });
  await call('read_book', { book: 'Another Book' });
  await call('word_count', { book: 'Another Book' });
  await call('read_notes', { book: 'Another Book' });
  await call('search', { query: 'the', all_books: true });
  assert.deepEqual(stamps(), before);
});

test('words typed a moment ago, not yet saved, are in the answer', async () => {
  await js(`(() => {
    const body = document.querySelectorAll('.chapter-body')[2];
    body.focus();
    const r = document.createRange();
    r.selectNodeContents(body.lastElementChild);
    r.collapse(false);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
  })()`);
  await tick(200);
  for (const k of ' Ash fell.') {
    wc.sendInputEvent({ type: 'keyDown', keyCode: k });
    wc.sendInputEvent({ type: 'char', keyCode: k });
    wc.sendInputEvent({ type: 'keyUp', keyCode: k });
  }
  await tick(150); // well inside the 800 ms before NEO saves it
  assert.equal(await call('read_chapter', { chapter: 3 }), 'Chapter 3: Vesuvius\n\nThe mountain woke early. Ash fell.');
  assert.equal((await call('word_count', { chapter: 3 })).words, 6);
});

test('the shelf: no book open, and the open book is the one to name', async () => {
  await js('backToShelf()');
  await tick(300);
  assert.deepEqual(await call('get_open_book'), { open: false, showing: 'the bookshelf' });
  await assert.rejects(call('word_count'), /No book is open/);
  assert.equal((await call('word_count', { book: 'Species Not Found' })).words, await js(`(async () => {
    const id = library.shelves[0].bookIds[0];
    return (await window.neo.readBookMeta(id)).wordCount;
  })()`));
});

test('a new token: the old one stops working at once', async () => {
  const old = token;
  token = (await js('window.neo.mcpConfigure({ newToken: true })')).token;
  assert.notEqual(token, old);
  assert.equal((await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { auth: old })).status, 401);
  assert.equal((await post({ jsonrpc: '2.0', id: 1, method: 'ping' })).status, 200);
});

test('the dialog says it\'s on, and where', async () => {
  await js('openMcpServer()');
  await tick(200);
  assert.match(await js(`document.getElementById('mcp-note').textContent`), new RegExp(`On, at http://127.0.0.1:${port}/mcp`));
  assert.equal(await js(`document.getElementById('mcp-token').value`), token);
  await js(`document.querySelector('.modal-backdrop .m-cancel').click()`);
});

test('Show More Features off turns the server off; on brings it back', async () => {
  await js('setMoreFeatures(false)');
  await tick(400);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST' }));
  await js('setMoreFeatures(true)');
  await tick(400);
  assert.equal((await post({ jsonrpc: '2.0', id: 1, method: 'ping' })).status, 200);
});

test('turned off in the dialog: off, and it stays off', async () => {
  const st = await js(`window.neo.mcpConfigure({ enabled: false })`);
  assert.equal(st.running, false);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST' }));
  assert.equal(JSON.parse(fs.readFileSync(path.join(tmp, 'app', 'settings.json'), 'utf8')).mcp.enabled, false);
});

/* ---------- runner ---------- */

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

async function main() {
  port = await freePort();
  fs.writeFileSync(path.join(tmp, 'app', 'settings.json'), JSON.stringify({ mcp: { enabled: true, port } }));
  require('../main.js');
  await app.whenReady();
  let failed = 0;
  try {
    let win;
    while (!(win = BrowserWindow.getAllWindows()[0])) await tick(50);
    wc = win.webContents;
    while (!(await js(`typeof library !== 'undefined' && !!library`).catch(() => false))) await tick(50);
    await tick(300);
    const p = (text) => ({ text });
    await js(`(async () => {
      document.getElementById('firstrun').hidden = true;
      await addImportedBooks([
        { name: 'Species Not Found', chapters: [
          { title: 'Arrival', paras: [${JSON.stringify(p('The ship had been under the villa'))}, ${JSON.stringify(p('for ages.'))}] },
          { title: 'The Scroll', paras: [${JSON.stringify(p('The scroll was carbonised in 79.'))}, ${JSON.stringify(p('It had been waiting for someone to read it.'))}] },
          { title: 'Vesuvius', paras: [${JSON.stringify(p('The mountain woke early.'))}] }
        ] },
        { name: 'Another Book', chapters: [
          { title: 'Only', paras: [${JSON.stringify(p('Six words in the other book.'))}] }
        ] }
      ], library.shelves[0]);
      await openBook(library.shelves[0].bookIds[0]);
    })()`);
    await tick(400);
    win.focus();
    // the server comes up once the page says Show More Features is on
    for (let i = 0; i < 100; i++) {
      const st = await js('window.neo.mcpStatus()');
      if (st.running) { token = st.token; break; }
      await tick(50);
    }
    assert.ok(token, 'the server is running');
    for (const t of tests) {
      try {
        await t.fn();
        console.log('ok   ' + t.name);
      } catch (err) {
        failed++;
        console.log('FAIL ' + t.name + '\n     ' + String(err.message).replace(/\n/g, '\n     '));
      }
    }
    console.log(`\n${tests.length - failed} passed, ${failed} failed`);
  } catch (err) {
    failed++;
    console.error(err);
  } finally {
    app.exit(failed ? 1 : 0);
  }
}
main();
