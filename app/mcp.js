'use strict';

/* ================================================================== */
/*  MCP SERVER                                                         */
/* ================================================================== */

// File → MCP Server… (the MCP server feature in Options), and the answers to
// what an AI app on this computer asks through it (mcp.js in the main process). Every
// answer is read from the page or the library: nothing here writes, moves or
// deletes, and nothing is shown to the writer while it answers. The open book
// answers from the page, so its unsaved words are there too.

const MCP_MAX_CHARS = 100000;

// a chapter NEO isn't showing, as text, without the marks that aren't words
// (a template's contents are inert: no image in the HTML is fetched)
function mcpHtmlText(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html || '';
  tpl.content.querySelectorAll(UNCOUNTED).forEach((n) => n.remove());
  return plainText(tpl.content);
}
// a paragraph to a line, a blank line between them
const mcpTidy = (text) => String(text || '').split('\n').map((s) => s.replace(/^[ \t\r]+|[ \t\r]+$/g, '')).filter(Boolean).join('\n\n');
const mcpPause = () => new Promise((resolve) => setTimeout(resolve, 0));

// the book a question means: the open one when it names none
async function mcpSource(ref) {
  if (ref == null || String(ref).trim() === '') {
    if (book) return { id: book.id, meta: book, open: true };
    throw new Error('No book is open in NEO. Name one with "book" (list_books has them).');
  }
  const want = String(ref).trim();
  if (book && want === book.id) return { id: book.id, meta: book, open: true };
  const books = await window.neo.listBooks();
  const low = want.toLowerCase();
  const titled = (b) => shownTitle(b.title || '').toLowerCase();
  let hits = books.filter((b) => b.id === want);
  if (!hits.length) hits = books.filter((b) => titled(b) === low);
  if (!hits.length) hits = books.filter((b) => titled(b).includes(low));
  if (!hits.length) throw new Error(`No book called "${want}". list_books has them.`);
  if (hits.length > 1) throw new Error(`"${want}" could be ${hits.map((b) => `"${shownTitle(b.title)}" (${b.id})`).join(', ')}. Name one by id.`);
  const id = hits[0].id;
  if (book && id === book.id) return { id, meta: book, open: true };
  const meta = await window.neo.readBookMeta(id);
  if (!meta) throw new Error(`"${shownTitle(hits[0].title)}" is still in iCloud, not on this computer yet.`);
  return { id, meta, open: false };
}

// the book's contents as NEO shows them
function mcpEntries(src) {
  const meta = src.meta;
  return (meta.chapterOrder || []).map((id, i) => {
    const name = chapterName(id, meta);
    const title = ((meta.chapterTitles || {})[id] || '').trim();
    return {
      position: i + 1, id, name, title,
      heading: title && title !== name ? `${name}: ${title}` : name,
      kind: chapterKind(id, meta),
      story: isStory(id, meta)
    };
  });
}
function mcpChapter(src, ref) {
  const entries = mcpEntries(src);
  if (ref == null || String(ref).trim() === '') throw new Error('Which chapter? list_chapters shows them.');
  const want = String(ref).trim();
  if (/^\d+$/.test(want)) {
    const e = entries[Number(want) - 1];
    if (e) return e;
    throw new Error(`This book has ${entries.length} entries in its contents; there is no number ${want}.`);
  }
  const low = want.toLowerCase();
  const english = /^chapter\s+(\d+)$/i.exec(want);
  const e = entries.find((x) => x.id === want)
    || entries.find((x) => x.name.toLowerCase() === low || x.heading.toLowerCase() === low)
    || entries.find((x) => x.title && x.title.toLowerCase() === low)
    || (english && entries.find((x) => x.kind === 'chapter' && chapterNumber(x.id, src.meta) === Number(english[1])));
  if (!e) throw new Error(`No chapter "${want}" in "${shownTitle(src.meta.title)}". list_chapters shows them.`);
  return e;
}
async function mcpText(src, id) {
  return src.open ? chapterText(id) : mcpHtmlText(await window.neo.readChapter(src.id, id));
}
async function mcpWords(src, id) {
  return src.open ? chapterWords(id) : countWords(await mcpText(src, id));
}
const mcpDay = (c) => (c ? Math.max(0, (c.end || 0) - (c.start || 0)) : 0);
// "Anonymous" stands in for no author on the page; it is never a byline
const mcpAuthor = (a) => (a && a !== 'Anonymous' && a !== t('Anonymous') ? a : '');
const mcpBookInfo = (meta) => ({
  id: meta.id, title: shownTitle(meta.title || ''), subtitle: meta.subtitle || undefined,
  series: meta.series || undefined, author: mcpAuthor(meta.author), format: meta.format === 'screenplay' ? 'screenplay' : 'book'
});

async function mcpListBooks() {
  const books = await window.neo.listBooks();
  const shelfOf = {};
  const shelfOrder = [];
  for (const s of (library && library.shelves) || []) {
    for (const id of s.bookIds || []) { shelfOf[id] = s.name; shelfOrder.push(id); }
  }
  const rank = (id) => { const i = shelfOrder.indexOf(id); return i < 0 ? Infinity : i; };
  books.sort((a, b) => rank(a.id) - rank(b.id));
  const out = [];
  for (const b of books) {
    const open = !!book && book.id === b.id;
    const meta = open ? book : await window.neo.readBookMeta(b.id).catch(() => null);
    out.push({
      ...mcpBookInfo(meta || b), id: b.id,
      shelf: shelfOf[b.id] || null,
      words: open ? bookWordCount() : (meta && meta.wordCount) || 0,
      word_goal: (meta && meta.wordGoal) || 0,
      modified: b.modified || '',
      open
    });
  }
  return { data: { books: out } };
}

async function mcpOpenBook() {
  if (!book) return { data: { open: false, showing: 'the bookshelf' } };
  const src = { id: book.id, meta: book, open: true };
  const entries = mcpEntries(src);
  const here = entries.find((e) => e.id === currentChapterId);
  return {
    data: {
      open: true,
      ...mcpBookInfo(book),
      tab: currentTab,
      current_chapter: here ? { position: here.position, heading: here.heading } : null,
      words: bookWordCount(),
      word_goal: book.wordGoal || 0,
      words_today: mcpDay((book.dailyCounts || {})[todayStr()]),
      daily_goal: (library && library.dailyGoal) || 0,
      contents: entries.map((e) => ({ position: e.position, heading: e.heading, kind: e.kind, words: chapterWords(e.id) }))
    }
  };
}

async function mcpListChapters(args) {
  const src = await mcpSource(args.book);
  const chapters = [];
  for (const e of mcpEntries(src)) {
    chapters.push({ position: e.position, id: e.id, name: e.name, title: e.title, kind: e.kind, counts_toward_words: e.story, words: await mcpWords(src, e.id) });
    if (!src.open) await mcpPause();
  }
  return { data: { book: mcpBookInfo(src.meta), chapters } };
}

async function mcpReadChapter(args) {
  const src = await mcpSource(args.book);
  const e = mcpChapter(src, args.chapter);
  const text = mcpTidy(await mcpText(src, e.id));
  return { text: `${e.heading}\n\n${text || '(this page is empty)'}` };
}

async function mcpReadBook(args) {
  const src = await mcpSource(args.book);
  const entries = mcpEntries(src);
  const from = args.from == null ? 1 : mcpChapter(src, args.from).position;
  const to = args.to == null ? entries.length : mcpChapter(src, args.to).position;
  const max = Math.max(1000, Number(args.max_chars) || MCP_MAX_CHARS);
  const meta = src.meta;
  let out = `# ${shownTitle(meta.title || '')}` + (mcpAuthor(meta.author) ? `\nby ${meta.author}` : '');
  for (const e of entries) {
    if (e.position < from || e.position > to) continue;
    if (!args.include_front_and_back && !e.story && e.kind !== 'part') continue;
    const text = mcpTidy(await mcpText(src, e.id));
    const piece = `\n\n## ${e.heading}` + (text ? `\n\n${text}` : '');
    if (out.length + piece.length > max) {
      out += `\n\n[Stopped before ${e.heading} at about ${max} characters. Ask again with from: ${e.position}.]`;
      return { text: out };
    }
    out += piece;
    if (!src.open) await mcpPause();
  }
  return { text: out };
}

async function mcpWordCount(args) {
  if (typeof args.text === 'string') return { data: { words: countWords(args.text) } };
  const src = await mcpSource(args.book);
  const meta = src.meta;
  if (args.chapter != null && String(args.chapter).trim() !== '') {
    const e = mcpChapter(src, args.chapter);
    return { data: { book: shownTitle(meta.title || ''), chapter: e.heading, kind: e.kind, counts_toward_words: e.story, words: await mcpWords(src, e.id) } };
  }
  const chapters = [];
  let words = 0;
  for (const e of mcpEntries(src)) {
    const n = await mcpWords(src, e.id);
    if (e.story) words += n;
    chapters.push({ position: e.position, heading: e.heading, kind: e.kind, counts_toward_words: e.story, words: n });
    if (!src.open) await mcpPause();
  }
  const days = Object.entries(meta.dailyCounts || {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).slice(-30);
  return {
    data: {
      book: shownTitle(meta.title || ''),
      words,
      word_goal: meta.wordGoal || 0,
      words_to_goal: meta.wordGoal ? Math.max(0, meta.wordGoal - words) : undefined,
      words_today: mcpDay((meta.dailyCounts || {})[todayStr()]),
      daily_goal: (library && library.dailyGoal) || 0,
      recent_days: days.map(([day, c]) => ({ day, words: mcpDay(c) })),
      chapters
    }
  };
}

async function mcpReadNotes(args) {
  const src = await mcpSource(args.book);
  const meta = src.meta;
  const which = args.which || 'all';
  const only = args.chapter != null && String(args.chapter).trim() !== '' ? mcpChapter(src, args.chapter) : null;
  const entries = mcpEntries(src);
  const headingOf = (id) => (entries.find((e) => e.id === id) || { heading: 'a chapter no longer in the book' }).heading;
  const parts = [];
  if (which === 'all' || which === 'notes') {
    const page = only ? only.id : 'book';
    const text = htmlText(await readNotesPage(src.id, page));
    parts.push(`# Notes${only ? ` for ${only.heading}` : ` (${tabName('notes')} tab)`}\n\n${text || '(empty)'}`);
  }
  if (which === 'all' || which === 'outline') {
    const lines = [];
    for (const e of entries) {
      if (only && e.id !== only.id) continue;
      if (e.kind === 'part') { if (!only) lines.push(`${e.heading}`); continue; }
      if (!STORY_KINDS.includes(e.kind)) continue;
      const note = ((meta.chapterNotes || {})[e.id] || '').trim();
      lines.push(`- ${e.heading}${note ? `: ${note}` : ''}`);
      ((meta.sectionNotes || {})[e.id] || []).forEach((sec, j) => {
        if ((sec.text || '').trim()) lines.push(`  - ${secLetter(j)}. ${sec.text.trim()}`);
      });
    }
    parts.push(`# Outline\n\n${lines.join('\n') || '(empty)'}`);
  }
  if (which === 'all' || which === 'stickies') {
    const all = src.open ? stickies : await window.neo.readJSON(src.id, 'stickies', []);
    const list = (all || []).filter((s) => (!only || s.chapterId === only.id) && (s.text || '').trim());
    const lines = list.map((s) => `- ${headingOf(s.chapterId)}${s.resolved ? ' (resolved)' : ''}: ${s.text.trim()}`);
    parts.push(`# Sticky notes\n\n${lines.join('\n') || '(none)'}`);
  }
  return { text: parts.join('\n\n') };
}

async function mcpSearch(args) {
  const query = String(args.query || '');
  if (!query.trim()) throw new Error('Search for what?');
  const limit = Math.min(500, Math.max(1, Number(args.limit) || 50));
  const esc = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = args.whole_word ? `(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])` : esc;
  const re = new RegExp(pattern, 'gu' + (args.match_case ? '' : 'i'));
  let sources;
  if (args.all_books) {
    sources = [];
    for (const b of await window.neo.listBooks()) {
      try { sources.push(await mcpSource(b.id)); } catch { /* still in iCloud */ }
    }
  } else sources = [await mcpSource(args.book)];
  const matches = [];
  let total = 0;
  for (const src of sources) {
    for (const e of mcpEntries(src)) {
      const text = (await mcpText(src, e.id)).replace(/\s+/g, ' ');
      for (const m of text.matchAll(re)) {
        total++;
        if (matches.length >= limit) continue;
        const a = Math.max(0, m.index - 80), z = Math.min(text.length, m.index + m[0].length + 80);
        matches.push({
          book: shownTitle(src.meta.title || ''), chapter: e.heading, position: e.position,
          context: (a > 0 ? '…' : '') + text.slice(a, z).trim() + (z < text.length ? '…' : '')
        });
      }
      if (!src.open) await mcpPause();
    }
  }
  return { data: { query, matches_found: total, shown: matches.length, matches } };
}

const MCP_TOOLS = {
  list_books: mcpListBooks,
  get_open_book: mcpOpenBook,
  list_chapters: mcpListChapters,
  read_chapter: mcpReadChapter,
  read_book: mcpReadBook,
  word_count: mcpWordCount,
  read_notes: mcpReadNotes,
  search: mcpSearch
};
async function answerMcp(req) {
  let out;
  try {
    const tool = MCP_TOOLS[req && req.tool];
    if (!tool) throw new Error('NEO has no tool called ' + (req && req.tool));
    out = { ok: true, result: await tool((req && req.args) || {}) };
  } catch (err) {
    out = { ok: false, error: String((err && err.message) || err) };
  }
  window.neo.mcpAnswer(req.id, out);
}
// (Pocket has no MCP server: its bridge has no onMcpRequest)
if (window.neo && window.neo.onMcpRequest) window.neo.onMcpRequest(answerMcp);

async function openMcpServer() {
  let st = await window.neo.mcpStatus();
  const bd = document.createElement('div');
  bd.className = 'modal-backdrop';
  bd.innerHTML = `
    <div class="modal" style="width:560px">
      <h2 style="font-size:17px">${t('MCP server')}</h2>
      <p>${t('Lets an AI app on this computer, such as Claude, read your books while NEO is open: chapters, notes, the outline and word counts. It can’t change, add or delete anything. Only programs on this computer can reach it, and only with the token below.')}</p>
      <div class="stats-row">
        <label class="st-check"><input id="mcp-on" type="checkbox"${st.enabled ? ' checked' : ''}/> ${t('Turn on the MCP server')}</label>
        <label>${t('Port')} <input id="mcp-port" type="number" min="1024" max="65535" value="${st.port}" style="width:90px"/></label>
      </div>
      <div id="mcp-details">
        <div class="stats-row">
          <label>${t('Address')} <input id="mcp-url" type="text" readonly spellcheck="false" style="width:300px"/></label>
          <button class="btn-quiet" data-copy="mcp-url">${t('Copy')}</button>
        </div>
        <div class="stats-row">
          <label>${t('Token')} <input id="mcp-token" type="text" readonly spellcheck="false" style="width:300px"/></label>
          <button class="btn-quiet" data-copy="mcp-token">${t('Copy')}</button>
          <button class="btn-quiet" id="mcp-new">${t('New token')}</button>
        </div>
        <details class="st-advanced">
          <summary class="soft">${t('Claude Code')}</summary>
          <p class="soft" style="font-size:12px;margin:6px 0">${t('Run this in a terminal to add NEO to Claude Code:')}</p>
          <div class="stats-row">
            <input id="mcp-cc" type="text" readonly spellcheck="false" style="width:420px;font-size:12px"/>
            <button class="btn-quiet" data-copy="mcp-cc">${t('Copy')}</button>
          </div>
        </details>
      </div>
      <p class="soft" id="mcp-note" style="margin:6px 0 0;font-size:12px"></p>
      <div style="text-align:right;margin-top:14px">
        <button class="m-cancel btn-quiet" style="margin-right:10px">${t('Cancel')}</button>
        <button class="m-ok btn-gold">${t('Save')}</button>
      </div>
    </div>`;
  document.body.appendChild(bd);
  const note = bd.querySelector('#mcp-note');
  const on = bd.querySelector('#mcp-on');
  const show = (s) => {
    st = s;
    on.checked = s.enabled;
    bd.querySelector('#mcp-details').hidden = !s.enabled;
    bd.querySelector('#mcp-url').value = s.url;
    bd.querySelector('#mcp-token').value = s.token;
    bd.querySelector('#mcp-cc').value = `claude mcp add --transport http neo ${s.url} --header "Authorization: Bearer ${s.token}"`;
    if (!s.enabled) note.textContent = t('Off. Nothing outside NEO can read your books.');
    else if (s.running) note.textContent = t('On, at {url}. It stops while MCP server is off in Options.', { url: s.url });
    else if (s.error === 'in-use') note.textContent = t('Port {port} is in use by another program. Choose another and save.', { port: String(s.port) });
    else note.textContent = t('The server couldn’t start ({error}).', { error: s.error || '?' });
  };
  show(st);
  // ticked, the address and token show at once, to copy before saving
  on.onchange = () => {
    bd.querySelector('#mcp-details').hidden = !on.checked;
    if (on.checked !== st.enabled) note.textContent = on.checked ? t('Save to turn it on.') : t('Save to turn it off.');
    else show(st);
  };
  const done = () => bd.remove();
  bd.querySelector('.m-cancel').onclick = done;
  // Save closes the window, as Cover Art's does, and says what it did; a
  // server that couldn't start keeps it open with the reason
  bd.querySelector('.m-ok').onclick = async () => {
    const port = parseInt(bd.querySelector('#mcp-port').value, 10);
    if (!(port >= 1024 && port <= 65535)) { toast(t('A port is a number from 1024 to 65535')); return; }
    const s = await window.neo.mcpConfigure({ enabled: on.checked, port });
    if (s.enabled && !s.running) { show(s); return; }
    done();
    toast(s.enabled ? t('MCP server on, at {url}', { url: s.url }) : t('MCP server off'), 4000);
  };
  bd.querySelector('#mcp-new').onclick = async () => {
    show(await window.neo.mcpConfigure({ newToken: true }));
    toast(t('New token made. An app using the old one needs this one now.'), 5000);
  };
  bd.querySelectorAll('[data-copy]').forEach((b) => {
    b.onclick = () => {
      const v = bd.querySelector('#' + b.dataset.copy).value;
      navigator.clipboard.writeText(v).then(() => toast(t('Copied')), () => toast(t('Couldn’t copy')));
    };
  });
  bd.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(); } });
}
