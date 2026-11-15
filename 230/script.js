(() => {
  'use strict';

  const DATA_DIR = 'data/';
  const MANIFEST = DATA_DIR + 'manifest.json';
  const CONCURRENCY = 4;
  const ALL = 'ALL';

  const state = {
    datasets: [],
    failed: [],
    view: ALL,
    query: '',
    filters: [],
    sort: null,
    page: 1,
    pageSize: 25
  };
  const uniqueCache = new Map();
  const $ = id => document.getElementById(id);

  const fmt = n => Number(n).toLocaleString();
  const prettyName = f => f.replace(/\.csv$/i, '').replace(/[_]+/g, ' ').trim();
  const tokens = q => q.toLowerCase().split(/\s+/).filter(Boolean);
  const num = v => {
    if (v === undefined || v === null) return NaN;
    const s = String(v).replace(/,/g, '').trim();
    return s === '' ? NaN : Number(s);
  };
  const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function appendHighlighted(parent, text, toks) {
    text = String(text ?? '');
    if (!toks.length || !text) { parent.appendChild(document.createTextNode(text)); return; }
    const re = new RegExp('(' + toks.map(escRe).join('|') + ')', 'gi');
    text.split(re).forEach((part, i) => {
      if (i % 2 === 1) { const m = document.createElement('mark'); m.textContent = part; parent.appendChild(m); }
      else if (part) parent.appendChild(document.createTextNode(part));
    });
  }

  function debounce(fn, ms) {
    let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  }

  async function discoverFiles() {
    try {
      const r = await fetch(MANIFEST, { cache: 'no-store' });
      if (r.ok) {
        const j = await r.json();
        const list = Array.isArray(j) ? j : j.files;
        if (Array.isArray(list) && list.length) return list.map(String);
      }
    } catch (e) {}

    try {
      const r = await fetch(DATA_DIR, { cache: 'no-store' });
      if (r.ok) {
        const doc = new DOMParser().parseFromString(await r.text(), 'text/html');
        const names = [...doc.querySelectorAll('a[href]')]
          .map(a => decodeURIComponent(a.getAttribute('href').split('?')[0]))
          .filter(h => /\.csv$/i.test(h))
          .map(h => h.split('/').pop());
        const unique = [...new Set(names)];
        if (unique.length) return unique.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      }
    } catch (e) {}

    throw new Error('No CSV files were found in the data folder.');
  }

  async function loadCsv(file) {
    const res = await fetch(DATA_DIR + encodeURIComponent(file), { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + res.statusText);
    let text = await res.text();
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const parsed = Papa.parse(text, {
      header: true,
      skipEmptyLines: 'greedy',
      transformHeader: (h, i) => (h || '').trim() || '(column ' + (i + 1) + ')'
    });
    const headers = (parsed.meta.fields || []).slice();
    if (!headers.length || !parsed.data.length) throw new Error('The file is empty or has no data rows.');
    return { file, name: prettyName(file), headers, rows: parsed.data, hay: null };
  }

  async function loadAll(files) {
    let done = 0;
    const total = files.length;
    const results = new Array(total);
    const setProgress = () => {
      $('progressBar').style.width = Math.round(done / total * 100) + '%';
      $('progressCount').textContent = done + ' / ' + total;
      $('progressLabel').textContent = 'Loading datasets…';
    };
    setProgress();
    let next = 0;
    async function worker() {
      while (next < total) {
        const i = next++;
        try { results[i] = { ok: await loadCsv(files[i]) }; }
        catch (e) { results[i] = { err: { file: files[i], reason: e.message || String(e) } }; }
        done++; setProgress();
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, worker));
    return results;
  }

  function applyResults(results) {
    results.forEach(r => {
      if (r.ok) state.datasets.push(r.ok); else state.failed.push(r.err);
    });
    state.datasets.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  }

  async function retryFailed() {
    const files = state.failed.map(f => f.file);
    state.failed = [];
    $('progressBox').classList.remove('hidden');
    const results = await loadAll(files);
    applyResults(results);
    $('progressBox').classList.add('hidden');
    afterLoad();
  }

  async function init() {
    let files;
    try {
      files = await discoverFiles();
    } catch (e) {
      $('progressBox').classList.add('hidden');
      showFatal(e.message);
      return;
    }
    const results = await loadAll(files);
    applyResults(results);
    $('progressBox').classList.add('hidden');
    afterLoad();
  }

  function showFatal(msg) {
    const box = $('errorBox');
    box.classList.remove('hidden');
    box.replaceChildren();
    box.appendChild(el('p', 'font-semibold text-red-700', msg));
    const ul = el('ul', 'list-disc pl-5 mt-2 space-y-1 text-stone-700');
    [
      'Run the app through a local web server (for example: python -m http.server 8000). Opening index.html directly from disk blocks file loading.',
      'Put the CSV files in a folder named data next to index.html.',
      'If your server does not list folders, add data/manifest.json containing the file names, such as ["crops.csv", "yield.csv"].'
    ].forEach(t => ul.appendChild(el('li', '', t)));
    box.appendChild(ul);
    $('subtitle').textContent = 'No datasets loaded.';
  }

  function renderFailures() {
    const box = $('errorBox');
    if (!state.failed.length) { box.classList.add('hidden'); box.replaceChildren(); return; }
    box.classList.remove('hidden');
    box.replaceChildren();
    box.appendChild(el('p', 'font-semibold text-red-700',
      state.failed.length + (state.failed.length === 1 ? ' file' : ' files') + ' could not be loaded'));
    const ul = el('ul', 'mt-2 space-y-1 text-stone-700');
    state.failed.forEach(f => {
      const li = el('li');
      li.appendChild(el('span', 'font-mono text-xs bg-mist rounded px-1', f.file));
      li.appendChild(document.createTextNode(' — ' + f.reason));
      ul.appendChild(li);
    });
    box.appendChild(ul);
    const btn = el('button', 'mt-3 rounded-md border border-leaf text-leaf hover:bg-mist px-3 py-1.5 font-semibold', 'Try loading again');
    btn.addEventListener('click', retryFailed);
    box.appendChild(btn);
  }

  function afterLoad() {
    renderFailures();
    if (!state.datasets.length) { $('app').classList.add('hidden'); $('subtitle').textContent = 'No datasets loaded.'; return; }
    const total = state.datasets.reduce((s, d) => s + d.rows.length, 0);
    $('subtitle').textContent = state.datasets.length + ' datasets · ' + fmt(total) + ' rows. Search across all of them or open one to filter by column.';
    $('app').classList.remove('hidden');
    buildDatasetSelect();
    state.view = ALL;
    $('datasetSelect').value = ALL;
    render();
  }

  function ensureHay(ds) {
    if (!ds.hay) ds.hay = ds.rows.map(r => ds.headers.map(h => r[h] ?? '').join('\u0001').toLowerCase());
    return ds.hay;
  }

  function rowMatchesFilters(row, filters) {
    for (const f of filters) {
      const raw = row[f.col];
      const v = raw === undefined || raw === null ? '' : String(raw);
      if (f.op === 'contains') { if (!v.toLowerCase().includes(f.val.toLowerCase())) return false; }
      else if (f.op === 'equals') { if (v.trim().toLowerCase() !== f.val.trim().toLowerCase()) return false; }
      else {
        const a = num(v), b = num(f.val);
        if (Number.isNaN(a) || Number.isNaN(b)) return false;
        if (f.op === 'gte' && !(a >= b)) return false;
        if (f.op === 'lte' && !(a <= b)) return false;
      }
    }
    return true;
  }

  function filterDataset(ds) {
    const toks = tokens(state.query);
    const hay = toks.length ? ensureHay(ds) : null;
    const out = [];
    for (let i = 0; i < ds.rows.length; i++) {
      if (hay) { let ok = true; for (const t of toks) if (!hay[i].includes(t)) { ok = false; break; } if (!ok) continue; }
      if (state.filters.length && !rowMatchesFilters(ds.rows[i], state.filters)) continue;
      out.push(i);
    }
    return out;
  }

  function sortIndices(ds, idx) {
    if (!state.sort) return idx;
    const { col, dir } = state.sort;
    const m = dir === 'asc' ? 1 : -1;
    return idx.slice().sort((x, y) => {
      const a = ds.rows[x][col] ?? '', b = ds.rows[y][col] ?? '';
      const na = num(a), nb = num(b);
      if (!Number.isNaN(na) && !Number.isNaN(nb)) return (na - nb) * m;
      if (a === '' && b !== '') return 1;
      if (b === '' && a !== '') return -1;
      return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' }) * m;
    });
  }

  function buildDatasetSelect() {
    const sel = $('datasetSelect');
    sel.replaceChildren();
    const all = el('option', '', 'Search all datasets (' + state.datasets.length + ')');
    all.value = ALL; sel.appendChild(all);
    state.datasets.forEach((d, i) => {
      const o = el('option', '', d.name + ' (' + fmt(d.rows.length) + ' rows)');
      o.value = String(i); sel.appendChild(o);
    });
  }

  let filterColsFor = null;
  function buildFilterColumns() {
    const sel = $('fCol');
    if (filterColsFor === state.view) return;
    filterColsFor = state.view;
    sel.replaceChildren();
    $('fValList').replaceChildren();
    if (state.view === ALL) return;
    state.datasets[state.view].headers.forEach(h => { const o = el('option', '', h); o.value = h; sel.appendChild(o); });
    updateValueSuggestions();
  }

  function updateValueSuggestions() {
    const list = $('fValList');
    list.replaceChildren();
    if (state.view === ALL) return;
    const ds = state.datasets[state.view];
    const col = $('fCol').value;
    if (!col) return;
    const key = state.view + '|' + col;
    if (!uniqueCache.has(key)) {
      const set = new Set();
      for (const r of ds.rows) { const v = r[col]; if (v !== undefined && v !== '') { set.add(v); if (set.size > 300) break; } }
      uniqueCache.set(key, set.size > 300 ? null : [...set].sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true })));
    }
    const vals = uniqueCache.get(key);
    if (vals) vals.forEach(v => { const o = document.createElement('option'); o.value = v; list.appendChild(o); });
  }

  function renderChips() {
    const box = $('chips');
    box.replaceChildren();
    const opText = { contains: 'contains', equals: '=', gte: '≥', lte: '≤' };
    state.filters.forEach((f, i) => {
      const chip = el('span', 'inline-flex items-center gap-1 bg-mist border border-sage text-forest rounded-full pl-3 pr-1 py-1 text-sm');
      chip.appendChild(document.createTextNode(f.col + ' ' + opText[f.op] + ' ' + f.val));
      const x = el('button', 'w-6 h-6 rounded-full hover:bg-sage text-leaf leading-none', '×');
      x.setAttribute('aria-label', 'Remove filter on ' + f.col);
      x.addEventListener('click', () => { state.filters.splice(i, 1); state.page = 1; render(); });
      chip.appendChild(x);
      box.appendChild(chip);
    });
  }

  function card(label, value, sub) {
    const c = el('div', 'bg-white rounded-lg border border-sage p-4');
    c.appendChild(el('div', 'text-sm text-leaf', label));
    c.appendChild(el('div', 'font-display text-2xl font-bold text-forest mt-1', value));
    if (sub) c.appendChild(el('div', 'text-xs text-stone-500 mt-1', sub));
    return c;
  }

  function renderCards(info) {
    const box = $('cards');
    box.replaceChildren();
    box.hidden = false;
    if (state.view === ALL) {
      const total = state.datasets.reduce((s, d) => s + d.rows.length, 0);
      box.append(card('Datasets loaded', fmt(state.datasets.length), state.failed.length ? state.failed.length + ' failed' : 'all files loaded'));
      box.append(card('Total rows', fmt(total)));
      if (state.query.trim()) {
        box.append(card('Matching rows', fmt(info.total)));
        box.append(card('Datasets with matches', fmt(info.datasetsWithMatches)));
      }
    } else {
      const ds = state.datasets[state.view];
      box.append(card('Rows in dataset', fmt(ds.rows.length)));
      box.append(card('Columns', fmt(ds.headers.length)));
      box.append(card('Matching rows', fmt(info.total), info.total === ds.rows.length ? 'no narrowing applied' : 'of ' + fmt(ds.rows.length)));
      box.append(card('Active filters', fmt(state.filters.length), state.query.trim() ? 'plus a search' : undefined));
    }
  }

  function renderOverview() {
    const grid = $('overviewGrid');
    grid.replaceChildren();
    state.datasets.forEach((d, i) => {
      const b = el('button', 'text-left bg-white rounded-lg border border-sage p-4 hover:border-fern hover:shadow-sm transition');
      b.appendChild(el('div', 'font-display font-semibold text-forest', d.name));
      b.appendChild(el('div', 'text-sm text-stone-600 mt-1', fmt(d.rows.length) + ' rows · ' + d.headers.length + ' columns'));
      const cols = d.headers.slice(0, 5).join(', ') + (d.headers.length > 5 ? '…' : '');
      b.appendChild(el('div', 'text-xs text-stone-500 mt-2 truncate', cols));
      b.addEventListener('click', () => openDataset(i));
      grid.appendChild(b);
    });
  }

  function openDataset(i) {
    state.view = i;
    state.filters = [];
    state.sort = null;
    state.page = 1;
    $('datasetSelect').value = String(i);
    render();
    $('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function renderPager(totalRows) {
    const pager = $('pager');
    pager.replaceChildren();
    const pages = Math.max(1, Math.ceil(totalRows / state.pageSize));
    if (state.page > pages) state.page = pages;
    const start = totalRows ? (state.page - 1) * state.pageSize + 1 : 0;
    const end = Math.min(totalRows, state.page * state.pageSize);
    pager.appendChild(el('div', 'text-stone-600', 'Showing ' + fmt(start) + '–' + fmt(end) + ' of ' + fmt(totalRows)));

    const nav = el('div', 'flex items-center gap-1');
    const mk = (label, page, disabled) => {
      const b = el('button', 'px-3 py-1.5 rounded-md border border-sage text-forest hover:bg-mist disabled:opacity-40 disabled:hover:bg-transparent', label);
      b.disabled = disabled;
      b.addEventListener('click', () => { state.page = page; renderTable(); $('tableWrap').scrollTop = 0; });
      return b;
    };
    nav.append(mk('First', 1, state.page === 1), mk('Previous', state.page - 1, state.page === 1));
    nav.appendChild(el('span', 'px-2 text-stone-700', 'Page ' + fmt(state.page) + ' of ' + fmt(pages)));
    nav.append(mk('Next', state.page + 1, state.page >= pages), mk('Last', pages, state.page >= pages));
    pager.appendChild(nav);
  }

  let current = { ds: null, idx: [], allHits: [] };

  function renderTable() {
    const thead = $('thead'), tbody = $('tbody');
    thead.replaceChildren(); tbody.replaceChildren();
    const toks = tokens(state.query);
    const from = (state.page - 1) * state.pageSize;
    const to = from + state.pageSize;

    if (state.view === ALL) {
      const tr = el('tr');
      ['Dataset', 'Matching row'].forEach(t => tr.appendChild(el('th', 'text-left font-semibold px-3 py-2 whitespace-nowrap', t)));
      thead.appendChild(tr);
      const slice = current.allHits.slice(from, to);
      slice.forEach(({ di, ri }) => {
        const ds = state.datasets[di];
        const row = ds.rows[ri];
        const r = el('tr', 'hover:bg-mist/60 align-top');
        const c1 = el('td', 'px-3 py-2 whitespace-nowrap');
        const link = el('button', 'text-leaf hover:text-forest underline underline-offset-2 text-left', ds.name);
        link.addEventListener('click', () => { state.query = $('searchInput').value; openDataset(di); });
        c1.appendChild(link);
        const c2 = el('td', 'px-3 py-2');
        const wrap = el('div', 'flex flex-wrap gap-x-4 gap-y-1');
        ds.headers.forEach(h => {
          const v = row[h];
          if (v === undefined || v === '') return;
          const item = el('span', 'text-xs');
          item.appendChild(el('span', 'text-stone-500', h + ': '));
          const val = el('span', 'text-stone-800');
          appendHighlighted(val, v, toks);
          item.appendChild(val);
          wrap.appendChild(item);
        });
        c2.appendChild(wrap);
        r.append(c1, c2);
        tbody.appendChild(r);
      });
      return renderPager(current.allHits.length);
    }

    const ds = current.ds;
    const tr = el('tr');
    ds.headers.forEach(h => {
      const th = el('th', 'sortable text-left font-semibold px-3 py-2 whitespace-nowrap');
      th.appendChild(document.createTextNode(h));
      const arrow = state.sort && state.sort.col === h ? (state.sort.dir === 'asc' ? ' ▲' : ' ▼') : '';
      if (arrow) th.appendChild(el('span', 'text-fern', arrow));
      th.tabIndex = 0;
      th.setAttribute('role', 'button');
      th.title = 'Sort by ' + h;
      const toggle = () => {
        if (!state.sort || state.sort.col !== h) state.sort = { col: h, dir: 'asc' };
        else if (state.sort.dir === 'asc') state.sort = { col: h, dir: 'desc' };
        else state.sort = null;
        state.page = 1; render();
      };
      th.addEventListener('click', toggle);
      th.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
      tr.appendChild(th);
    });
    thead.appendChild(tr);

    current.idx.slice(from, to).forEach(ri => {
      const row = ds.rows[ri];
      const r = el('tr', 'hover:bg-mist/60');
      ds.headers.forEach(h => {
        const v = row[h] ?? '';
        const td = el('td', 'px-3 py-2 max-w-xs truncate');
        td.title = v;
        appendHighlighted(td, v, toks);
        r.appendChild(td);
      });
      tbody.appendChild(r);
    });
    renderPager(current.idx.length);
  }

  function render() {
    const isAll = state.view === ALL;
    const hasQuery = state.query.trim().length > 0;

    $('filterPanel').classList.toggle('hidden', false);
    $('filterHint').classList.toggle('hidden', !isAll);
    ['fCol', 'fOp', 'fVal', 'fAdd'].forEach(id => { $(id).disabled = isAll; $(id).classList.toggle('opacity-50', isAll); });
    buildFilterColumns();
    renderChips();

    const info = { total: 0, datasetsWithMatches: 0 };
    const results = $('results'), overview = $('overview'), matchCounts = $('matchCounts');
    const emptyMsg = $('emptyMsg'), tableWrap = $('tableWrap'), pager = $('pager');

    if (isAll) {
      if (!hasQuery) {
        overview.classList.remove('hidden'); renderOverview();
        matchCounts.classList.add('hidden');
        results.classList.add('hidden');
        renderCards(info);
        return;
      }
      overview.classList.add('hidden');
      const hits = [], perDs = [];
      state.datasets.forEach((ds, di) => {
        const idx = filterDataset(ds);
        if (idx.length) perDs.push({ di, count: idx.length });
        for (const ri of idx) hits.push({ di, ri });
      });
      current = { ds: null, idx: [], allHits: hits };
      info.total = hits.length; info.datasetsWithMatches = perDs.length;
      renderCards(info);

      const chips = $('matchChips'); chips.replaceChildren();
      perDs.forEach(({ di, count }) => {
        const b = el('button', 'bg-white border border-sage hover:border-fern rounded-full px-3 py-1 text-sm text-forest', state.datasets[di].name + ' · ' + fmt(count));
        b.addEventListener('click', () => openDataset(di));
        chips.appendChild(b);
      });
      matchCounts.classList.toggle('hidden', perDs.length === 0);

      results.classList.remove('hidden');
      $('resultsTitle').textContent = 'Results across all datasets';
      const none = hits.length === 0;
      emptyMsg.classList.toggle('hidden', !none);
      tableWrap.classList.toggle('hidden', none);
      pager.classList.toggle('hidden', none);
      if (none) emptyMsg.textContent = 'No rows match “' + state.query.trim() + '”. Try fewer or different words, or check the spelling.';
      else renderTable();
      return;
    }

    overview.classList.add('hidden');
    matchCounts.classList.add('hidden');
    const ds = state.datasets[state.view];
    let idx = filterDataset(ds);
    info.total = idx.length;
    idx = sortIndices(ds, idx);
    current = { ds, idx, allHits: [] };
    renderCards(info);
    results.classList.remove('hidden');
    $('resultsTitle').textContent = ds.name;
    const none = idx.length === 0;
    emptyMsg.classList.toggle('hidden', !none);
    tableWrap.classList.toggle('hidden', none);
    pager.classList.toggle('hidden', none);
    if (none) emptyMsg.textContent = 'No rows match your search and filters. Remove a filter or clear the search to see rows again.';
    else renderTable();
  }

  $('datasetSelect').addEventListener('change', e => {
    state.view = e.target.value === ALL ? ALL : Number(e.target.value);
    state.filters = []; state.sort = null; state.page = 1;
    render();
  });

  const onSearch = debounce(() => { state.query = $('searchInput').value; state.page = 1; render(); }, 200);
  $('searchInput').addEventListener('input', onSearch);

  $('pageSize').addEventListener('change', e => { state.pageSize = Number(e.target.value); state.page = 1; if (state.view === ALL && !state.query.trim()) return; renderTable(); });

  $('fCol').addEventListener('change', updateValueSuggestions);

  function addFilter() {
    if (state.view === ALL) return;
    const col = $('fCol').value, op = $('fOp').value, val = $('fVal').value.trim();
    if (!col || val === '') { $('fVal').focus(); return; }
    if ((op === 'gte' || op === 'lte') && Number.isNaN(num(val))) {
      $('fVal').setCustomValidity('Enter a number for this condition.');
      $('fVal').reportValidity();
      setTimeout(() => $('fVal').setCustomValidity(''), 0);
      return;
    }
    state.filters.push({ col, op, val });
    $('fVal').value = '';
    state.page = 1;
    render();
  }
  $('fAdd').addEventListener('click', addFilter);
  $('fVal').addEventListener('keydown', e => { if (e.key === 'Enter') addFilter(); });

  $('clearAll').addEventListener('click', () => {
    state.query = ''; state.filters = []; state.sort = null; state.page = 1;
    $('searchInput').value = '';
    render();
  });

  init();
})();