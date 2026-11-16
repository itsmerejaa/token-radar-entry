// Token Radar dashboard. Reads window.RADAR, written beside this page as data.js by main.ts.
// Pure DOM API, no framework, no fetch: it renders offline with no network address anywhere.
(function () {
  'use strict';
  var DATA = window.RADAR;
  var app = document.getElementById('app');
  if (!DATA || !Array.isArray(DATA.rows)) {
    app.textContent = 'No board data: data.js was not found beside this page.';
    app.setAttribute('aria-busy', 'false'); return;
  }
  // state.sort is a column key; state.dir is 1 ascending, -1 descending. The filters start blank.
  var state = { sort: 'implied', dir: -1, q: '', cat: '', status: '', selected: null };
  var int = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
  var NEG = -1e12;

  // el('tr', { class: 'x', onclick: fn }, child, [children]) -> a node with attributes, text, children.
  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = String(v);
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : String(v));
    });
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c === null || c === undefined || c === false) continue;
      if (Array.isArray(c)) c.forEach(function (x) { if (x) node.appendChild(x); });
      else node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
  }

  function usd(n) { return isFinite(n) && n !== null ? '$' + int.format(n) : 'n/a'; }
  function pctSign(n) { return isFinite(n) && n !== null ? (n > 0 ? '+' : '') + n.toFixed(2) + '%' : 'n/a'; }
  function ageText(d) { return d == null ? 'unknown' : d >= 365 ? (d / 365).toFixed(1) + 'y' : d + 'd'; }
  function categoryOf(r) { return r.category || 'Other'; }

  var COLUMNS = [
    { key: 'rank', label: 'Rank' }, { key: 'name', label: 'Protocol' }, { key: 'category', label: 'Category' },
    { key: 'tvl', label: 'TVL', right: 1 }, { key: 'age', label: 'Age', right: 1 },
    { key: 'growth', label: '7d', right: 1 }, { key: 'implied', label: 'Implied value', right: 1 }
  ];

  // Every protocol the page carries: the ranked pre-token board, then the live-token set aside with it.
  var POOL = DATA.rows.concat(DATA.live || []);

  // A live protocol shows the market's own number; a pre-token one shows the model's implied value.
  function valueOf(r) { return r.token_status === 'live' ? r.mcap_usd : r.implied_value_usd; }

  // The value a column sorts on: a missing age or growth sorts below every real one.
  function sortKey(r, k) {
    if (k === 'name') return r.name.toLowerCase();
    if (k === 'category') return categoryOf(r).toLowerCase();
    if (k === 'tvl') return r.tvl_usd;
    if (k === 'age') return r.age_days == null ? NEG : r.age_days;
    if (k === 'growth') return r.change_7d == null ? NEG : r.change_7d;
    return k === 'rank' ? r.rank : (valueOf(r) == null ? NEG : valueOf(r));
  }

  // The rows the filters leave, in the order the current sort asks for; ties fall back to slug.
  function visibleRows() {
    var q = state.q.trim().toLowerCase();
    var list = POOL.filter(function (r) {
      if (state.status && r.token_status !== state.status) return false;
      if (state.cat && categoryOf(r) !== state.cat) return false;
      return !q || [r.name, r.slug, r.category, (r.chains || []).join(' ')].join(' ').toLowerCase().indexOf(q) >= 0;
    });
    list.sort(function (a, b) {
      var av = sortKey(a, state.sort), bv = sortKey(b, state.sort);
      return av < bv ? -state.dir : av > bv ? state.dir : a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
    return list;
  }

  var ringkas = el('div', { id: 'ringkas', class: 'tally', role: 'status', 'aria-live': 'polite' });
  var tableBody = el('tbody');

  // The summary line: how many protocols the filters show, and how many of them are pre-token.
  function renderRingkasan(list) {
    var shown = list || visibleRows();
    ringkas.textContent = shown.length + ' protokol - ' + shown.filter(function (r) { return r.token_status === 'pre-token'; }).length + ' pra-token';
  }
  // A sortable column header: a click sorts by the column; a second click flips the direction.
  function headerCell(col) {
    var on = state.sort === col.key;
    return el('th', { scope: 'col', class: col.right ? 'right' : null }, el('button', {
      type: 'button', class: 'sort', 'aria-sort': on ? (state.dir < 0 ? 'descending' : 'ascending') : null,
      onclick: function () {
        if (on) state.dir = -state.dir;
        else { state.sort = col.key; state.dir = col.key === 'name' || col.key === 'category' ? 1 : -1; }
        renderTabel();
      }
    }, col.label, on ? el('span', { class: 'caret', text: state.dir < 0 ? '\u25BC' : '\u25B2' }) : null));
  }
  // One board row; selecting it opens the detail drawer.
  function boardRow(r) {
    var cls = r.change_7d == null ? 'dim' : r.change_7d >= 0 ? 'pos' : 'neg';
    return el('tr', { tabindex: '0', 'data-slug': r.slug, 'data-selected': state.selected === r.slug ? 'true' : null, onclick: function () { openDetail(r.slug); } },
      el('td', { class: 'rank' }, el('b', { text: String(r.rank) })),
      el('td', null, el('div', { class: 'proto' }, el('b', { text: r.name }), el('span', { class: 'sub', text: r.slug }))),
      el('td', { class: 'dim' }, categoryOf(r)),
      el('td', { class: 'num right', text: usd(r.tvl_usd) }), el('td', { class: 'num right', text: ageText(r.age_days) }),
      el('td', { class: 'num right ' + cls, text: pctSign(r.change_7d) }),
      el('td', { class: 'num right', text: r.token_status === 'live' ? usd(r.mcap_usd) : usd(r.implied_value_usd) }), el('td', null, statusTag(r)));
  }

  function renderTabel() {
    var list = visibleRows();
    renderRingkasan(list);
    tableBody.textContent = '';
    list.forEach(function (r) { tableBody.appendChild(boardRow(r)); });
  }

  // ------------------------------------------------------------------ part 2

  // A tag for a row's token status: the board separates protocols that already trade from the rest.
  function statusTag(r) {
    var pre = r.token_status === 'pre-token';
    var extra = pre && r.on_watchlist === false && r.below_floor ? ' early' : '';
    return el('span', { class: 'tag ' + (pre ? 'pre' : 'live') + extra, text: pre ? 'pre-token' : 'live' });
  }

  // One labelled figure of the detail drawer: a name and its value.
  function figure(k, v, hero) {
    return el('div', { class: 'figure' + (hero ? ' hero' : null) }, el('span', { class: 'k', text: k }), el('span', { class: 'v', text: v }));
  }

  var drawer = el('dialog', { class: 'drawer', 'aria-labelledby': 'detail-title' });

  // The detail drawer for one row: every field the board carries, then the full farm plan.
  function renderDetail(row) {
    state.selected = row.slug;
    var live = row.token_status === 'live';
    var chainList = row.chains && row.chains.length ? row.chains.join(', ') : 'an unnamed chain';
    var growth = row.change_7d == null ? 'unreported' : pctSign(row.change_7d);
    var rankLine = live ? 'Live token - snapshot ' + DATA.as_of : 'Rank ' + row.rank + ' of ' + DATA.board_size + ' - snapshot ' + DATA.as_of;
    var body = el('div', { class: 'drawer-body' },
      el('div', { class: 'drawer-head' },
        el('div', { class: 'drawer-title' },
          el('span', { class: 'rankline', text: rankLine }),
          el('h2', { id: 'detail-title', text: row.name }),
          el('p', { class: 'sub', text: categoryOf(row) + ' on ' + chainList })),
        el('button', { type: 'button', class: 'close', 'aria-label': 'Close details', text: '\u2715', onclick: closeDetail })),
      el('section', { class: 'section' },
        el('h3', null, live ? 'Market value' : 'Implied value'),
        el('div', { class: 'figures' },
          figure(live ? 'Market cap' : 'Implied value', usd(live ? row.mcap_usd : row.implied_value_usd), true),
          figure('TVL', usd(row.tvl_usd)),
          figure('Seven-day growth', growth),
          live ? figure('Symbol', row.symbol || 'none on record') : figure('Age with no token', ageText(row.age_days) + (row.age_days != null ? ' (' + row.age_days + ' days)' : '')),
          live ? null : figure('Growth multiplier', row.growth_multiplier == null ? 'n/a' : 'x' + row.growth_multiplier),
          live ? null : figure('Maturity multiplier', row.maturity_multiplier == null ? 'n/a' : 'x' + row.maturity_multiplier),
          live ? null : figure('Base value', usd(row.base_usd)))),
      el('section', { class: 'section' },
        el('h3', null, 'Protocol record'),
        el('div', { class: 'figures' },
          figure('Slug', row.slug),
          figure('Name', row.name),
          figure('Category', categoryOf(row)),
          figure('Chains', chainList),
          figure('Token status', row.token_status),
          figure('On watchlist', row.on_watchlist === true ? 'yes' : 'no'),
          figure('Below the floor', row.below_floor === true ? 'yes' : 'no'),
          figure('Listed at', row.listed_at || 'unknown'),
          figure('Age', ageText(row.age_days)),
          figure('Rank', live ? 'not ranked' : String(row.rank)))),
      el('section', { class: 'section' },
        el('div', { class: 'section-head' }, el('h3', null, 'Farm plan'), el('span', { class: 'sub', text: (row.farm_steps || []).length + ' steps' })),
        el('ol', { class: 'steps' }, (row.farm_steps || []).map(stepItem)),
        el('p', { class: 'sub', text: 'This is a plan and an estimate, not advice and not a promise of a token. Costs are in dollars of gas and capital.' })));
    drawer.textContent = '';
    drawer.appendChild(body);
    if (typeof drawer.showModal === 'function') { if (!drawer.open) drawer.showModal(); }
    else drawer.setAttribute('open', '');
    drawer.scrollTop = 0;
    renderTabel();
  }

  // One farm step: the action, then its cost and time as separate chips when the text carries them.
  function stepItem(text) {
    var at = String(text).indexOf(' Cost: ');
    var action = at >= 0 ? String(text).slice(0, at) : String(text);
    var rest = at >= 0 ? String(text).slice(at + 1) : '';
    var meta = [];
    rest.replace(/Cost: (.*?)\.(?: Time:|$)/, function (_, c) { meta.push(el('span', { class: 'cost', text: 'cost: ' + c })); return ''; });
    rest.replace(/Time: (.*?)\.?$/, function (_, t) { if (t) meta.push(el('span', { class: 'time', text: 'time: ' + t })); return ''; });
    return el('li', null, el('div', { class: 'body' }, el('p', { text: action }), meta.length ? el('div', { class: 'meta' }, meta) : null));
  }

  function closeDetail() {
    state.selected = null;
    if (typeof drawer.close === 'function' && drawer.open) drawer.close();
    else drawer.removeAttribute('open');
    renderTabel();
  }

  // The row for a slug, then its detail. Selecting from the table runs this.
  function openDetail(slug) {
    for (var i = 0; i < POOL.length; i++) if (POOL[i].slug === slug) { renderDetail(POOL[i]); return; }
  }

  // The controls: search, category select and token-status select. Each rerenders on change.
  function controls() {
    var search = el('input', { type: 'search', id: 'cari', placeholder: 'Search name, slug or chain', 'aria-label': 'Search the board', value: state.q });
    search.addEventListener('input', function () { state.q = search.value; renderTabel(); });
    var cats = [];
    POOL.forEach(function (r) { var c = categoryOf(r); if (cats.indexOf(c) < 0) cats.push(c); });
    cats.sort();
    var cat = el('select', { id: 'kategori', 'aria-label': 'Filter by category' },
      [el('option', { value: '', text: 'All categories' })].concat(cats.map(function (c) { return el('option', { value: c, text: c }); })));
    cat.addEventListener('change', function () { state.cat = cat.value; renderTabel(); });
    var status = el('select', { id: 'status', 'aria-label': 'Filter by token status' },
      [el('option', { value: '', text: 'Semua' }), el('option', { value: 'pre-token', text: 'Pre-token' }), el('option', { value: 'live', text: 'Live' })]);
    status.addEventListener('change', function () { state.status = status.value; renderTabel(); });
    return el('div', { class: 'controls' },
      el('div', { class: 'control' }, el('label', { for: 'cari', text: 'Search' }), search),
      el('div', { class: 'control' }, el('label', { for: 'kategori', text: 'Category' }), cat),
      el('div', { class: 'control' }, el('label', { for: 'status', text: 'Token status' }), status),
      ringkas);
  }

  var table = el('table', null,
    el('caption', { class: 'sub', text: 'Pre-token DeFi protocols, ranked by implied value. Select a row to open its figures and farm plan.' }),
    el('thead', null, el('tr', null, COLUMNS.map(headerCell), el('th', { scope: 'col' }, 'Token'))), tableBody);

  // Mount the page: the controls, the board, and the drawer. Runs once the DOM is ready.
  function boot() {
    app.textContent = '';
    app.appendChild(el('div', { class: 'table-scroll' }, table));
    app.appendChild(drawer);
    app.insertBefore(controls(), app.firstChild);
    app.setAttribute('aria-busy', 'false');
    renderTabel();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
