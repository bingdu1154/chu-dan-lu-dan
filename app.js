/* =========================================================
   出单入单管理系统
   纯前端 + 本地存储(localStorage)，无需服务器，双击即用
   v4：应收收款 / 往来单位台账 / 退货单 / 批量操作 /
       手机端适配 / 备份合并导入 / 快捷键
   ========================================================= */

const LS_KEY = 'chu_dan_lu_dan_v1';
const LS_SNAP = 'chu_dan_lu_dan_snap';
const SNAP_GAP = 30 * 60 * 1000;
const LOG_MAX = 3000;

/* ---------- 基础工具 ---------- */
const $  = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
/* 必须用本地日期：toISOString 是 UTC，东八区凌晨 0-8 点会算成前一天 */
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const num = (v, d = 0) => { const n = parseFloat(v); return isFinite(n) ? n : d; };
const money = n => '¥' + (num(n)).toFixed(2);
const costOf = p => num(p && p.cost, 0);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nowText = ts => new Date(ts).toLocaleString('zh-CN', { hour12: false });
const round2 = n => Math.round(num(n) * 100) / 100;
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

function toast(msg, err = false) {
  const t = $('#toast');
  if (!t) return;
  t.textContent = msg;
  t.className = 'toast show' + (err ? ' err' : '');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => (t.className = 'toast'), 2200);
}

/* 手机端：把表格转成卡片（用表头文本做标签） */
function labelCells(sel) {
  const tbl = $(sel); if (!tbl) return;
  const heads = $$('thead th', tbl).map(th => th.textContent.trim());
  $$('tbody tr', tbl).forEach(tr => {
    if (tr.querySelector('.empty')) return;
    $$('td', tr).forEach((td, i) => { if (heads[i]) td.setAttribute('data-label', heads[i]); });
  });
}

/* ---------- 数据层 ---------- */
const defaultState = () => ({
  products: [],
  orders: [],
  logs: [],
  payments: [],
  seq: { out: 0, in: 0, refund: 0 },
  drafts: { out: [], in: [] },
  settings: {
    company: '', contact: '', phone: '', address: '', warn: 10, footer: '',
    docCode: false, docCost: false, docSign: true, docShip: true, priceMemory: true
  }
});

let state = load();

function load() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return defaultState();
    const s = JSON.parse(raw);
    return Object.assign(defaultState(), s, {
      settings: Object.assign(defaultState().settings, s.settings || {}),
      seq: Object.assign({ out: 0, in: 0, refund: 0 }, s.seq || {}),
      drafts: Object.assign({ out: [], in: [] }, s.drafts || {}),
      logs: Array.isArray(s.logs) ? s.logs : [],
      payments: Array.isArray(s.payments) ? s.payments : []
    });
  } catch (e) { return defaultState(); }
}
/* 写入失败会置位，界面上给出持续可见的红色告警 */
let saveBroken = false;
function showSaveAlert() {
  saveBroken = true;
  const bar = $('#saveAlert');
  if (bar) bar.style.display = '';
}
function save() {
  let json;
  try { json = JSON.stringify(state); }
  catch (e) { showSaveAlert(); return alert('⚠ 数据序列化失败，本次改动没有保存。请先「备份数据」。'); }

  try {
    /* 快照写失败不能拖累主数据，所以单独包一层 */
    try {
      const prev = localStorage.getItem(LS_KEY);
      if (prev) {
        let snap = null;
        try { snap = JSON.parse(localStorage.getItem(LS_SNAP) || 'null'); } catch (e) {}
        if (!snap || Date.now() - (snap.ts || 0) > SNAP_GAP) {
          localStorage.setItem(LS_SNAP, JSON.stringify({ ts: Date.now(), data: prev }));
        }
      }
    } catch (e) {}
    localStorage.setItem(LS_KEY, json);
    saveBroken = false;
    const bar = $('#saveAlert');
    if (bar) bar.style.display = 'none';
  } catch (e) {
    /* 多半是空间满了：先丢掉快照腾地方，再试一次 */
    let ok = false;
    try {
      localStorage.removeItem(LS_SNAP);
      localStorage.setItem(LS_KEY, json);
      ok = true;
    } catch (e2) {}
    if (ok) {
      saveBroken = false;
      const bar = $('#saveAlert');
      if (bar) bar.style.display = 'none';
      toast('存储空间紧张，已清理旧快照腾出空间，请及时备份');
    } else {
      showSaveAlert();
      alert('⚠ 本地存储已满，本次改动没能存进去！\n\n' +
        '现在立刻做两件事：\n' +
        '1. 点顶部「备份数据」导出文件留底\n' +
        '2. 删掉一些历史单据或库存流水\n\n' +
        '（不处理的话，关闭页面后这次之后的改动会全部丢失）');
    }
  }
}
/* 危险操作前留个回滚点 */
function snapshot() {
  try { localStorage.setItem(LS_SNAP, JSON.stringify({ ts: Date.now(), data: JSON.stringify(state) })); }
  catch (e) {}
}

/* ---------- 库存流水 ---------- */
function logStock(p, before, delta, src, no) {
  if (!delta) return;
  state.logs.unshift({
    id: uid(), ts: Date.now(), date: today(),
    pid: p.id, name: p.name, unit: p.unit || '',
    before: +num(before).toFixed(4), delta: +num(delta).toFixed(4), after: +num(before + delta).toFixed(4),
    src, no: no || ''
  });
  if (state.logs.length > LOG_MAX) state.logs.length = LOG_MAX;
}

/* ---------- 金额转中文大写 ---------- */
function rmbUpper(n) {
  n = Math.round(Math.abs(num(n)) * 100) / 100;
  if (n === 0) return '零元整';
  const N = '零壹贰叁肆伍陆柒捌玖';
  const U = ['', '拾', '佰', '仟'];
  const SEC = ['', '万', '亿', '万亿'];
  const sign = n < 0 ? '负' : '';
  let intStr = String(Math.floor(n));
  const dec = Math.round((n - Math.floor(n)) * 100);
  const groups = [];
  while (intStr.length) { groups.unshift(intStr.slice(-4)); intStr = intStr.slice(0, -4); }
  let out = '', zero = false;
  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi];
    for (let i = 0; i < g.length; i++) {
      const p = g.length - i;
      const d = +g[i];
      if (d === 0) { if (out) zero = true; continue; }
      if (zero && out) { out += '零'; zero = false; }
      out += N[d] + U[p - 1];
    }
    if (parseFloat(g) !== 0) out += SEC[groups.length - gi - 1];
  }
  out = (out || '零') + '元';
  const jiao = Math.floor(dec / 10), fen = dec % 10;
  if (dec === 0) out += '整';
  else {
    out += jiao > 0 ? N[jiao] + '角' : '零';
    out += fen > 0 ? N[fen] + '分' : '整';
  }
  return sign + out;
}

/* =========================================================
   应收 / 付款
   ========================================================= */
const paidOf = no => state.payments.filter(p => p.no === no).reduce((s, p) => s + num(p.amount), 0);

/* 出货单欠款 = 金额 − 已收；退货单为负数（冲减应收） */
function oweOfOrder(o) {
  if (o.type === 'refund') return -num(o.total);
  if (o.type !== 'out') return 0;
  return round2(num(o.total) - paidOf(o.no));
}
function partnerStats() {
  const map = new Map();
  const put = name => {
    if (!map.has(name)) map.set(name, { name, sale: 0, refund: 0, buy: 0, paid: 0, orders: 0, last: '' });
    return map.get(name);
  };
  state.orders.forEach(o => {
    const n = (o.partner || '').trim() || '（未填写单位）';
    const s = put(n);
    s.orders++;
    if (o.date > s.last) s.last = o.date;
    if (o.type === 'out') s.sale += num(o.total);
    else if (o.type === 'refund') s.refund += num(o.total);
    else if (o.type === 'in') s.buy += num(o.total);
  });
  state.payments.forEach(p => { put((p.partner || '').trim() || '（未填写单位）').paid += num(p.amount); });
  const list = [...map.values()].map(s => ({ ...s, owe: round2(s.sale - s.refund - s.paid) }));
  list.forEach(s => { s.isCustomer = s.sale > 0 || s.refund > 0; s.isSupplier = s.buy > 0; });
  return list;
}
const totalOwe = () => partnerStats().reduce((s, p) => s + Math.max(0, p.owe), 0);

/* =========================================================
   概览看板
   ========================================================= */
function orderProfit(o) { return o.items.reduce((s, it) => s + (it.price - num(it.cost)) * it.qty, 0); }

function renderDash() {
  const t = today(), mon = t.slice(0, 7);
  const sumBy = (type, fn) => state.orders.filter(o => o.type === type && fn(o)).reduce((s, o) => s + o.total, 0);
  const profitBy = fn => state.orders.filter(o => (o.type === 'out' || o.type === 'refund') && fn(o)).reduce((s, o) => s + orderProfit(o), 0);
  const stockValue = state.products.reduce((s, p) => s + p.price * p.stock, 0);
  const warn = state.settings.warn ?? 10;
  const low = state.products.filter(p => p.stock <= warn).length;

  const cards = [
    ['今日出货额', money(sumBy('out', o => o.date === t)), '#c2352f'],
    ['本月出货额', money(sumBy('out', o => (o.date || '').startsWith(mon))), '#c2352f'],
    ['本月毛利', money(profitBy(o => (o.date || '').startsWith(mon))), '#0d7a45'],
    ['本月入货额', money(sumBy('in', o => (o.date || '').startsWith(mon))), '#0d7a45'],
    ['客户欠款合计', money(totalOwe()), '#a35c00'],
    ['库存总价值', money(stockValue), '#2563eb'],
    ['低库存预警', low + ' 项', low ? '#a35c00' : '#1f2733'],
    ['单据总数', state.orders.length + ' 张', '#1f2733']
  ];
  $('#dashCards').innerHTML = cards.map(([k, v, c]) =>
    `<div class="stat-card"><div class="k">${k}</div><div class="v" style="color:${c}">${v}</div></div>`).join('');

  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const iso = isoDate(d);
    days.push({ iso, label: `${d.getMonth() + 1}/${d.getDate()}`, out: sumBy('out', o => o.date === iso), in: sumBy('in', o => o.date === iso) });
  }
  const max = Math.max(1, ...days.map(d => Math.max(d.out, d.in)));
  $('#dashBars').innerHTML = days.map(d => `
    <div class="bar-col" data-day="${d.iso}" style="cursor:pointer" title="点击查看 ${d.iso} 当天的单据">
      <div class="bar-val">${Math.max(d.out, d.in) > 0 ? Math.round(Math.max(d.out, d.in)) : ''}</div>
      <div class="bar-pair">
        <div class="bar b-out" style="height:${Math.round(d.out / max * 100)}%" title="出货 ${money(d.out)}"></div>
        <div class="bar b-in" style="height:${Math.round(d.in / max * 100)}%" title="入货 ${money(d.in)}"></div>
      </div>
      <div class="bar-lab">${d.label}</div>
    </div>`).join('');
  $$('[data-day]', $('#dashBars')).forEach(el => el.onclick = () => {
    $('#filterType').value = ''; $('#filterSettle').value = ''; $('#filterKey').value = '';
    $('#filterFrom').value = el.dataset.day; $('#filterTo').value = el.dataset.day;
    switchPage('records'); renderRecords();
  });

  // 需要关注：库存不足 + 超期未收款（超过 30 天）
  const alerts = [];
  state.products.filter(p => !p.disabled && p.stock <= warn)
    .sort((a, b) => a.stock - b.stock).slice(0, 5).forEach(p => alerts.push({
      kind: '库存不足', color: '#a35c00', val: `${p.stock}${esc(p.unit || '')}`,
      text: `<b>${esc(p.name)}</b>${p.spec ? '　' + esc(p.spec) : ''}`,
      act: '去补货', fn: 'products'
    }));
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 30);
  const cut = isoDate(cutoff);
  state.orders.filter(o => o.type === 'out' && oweOfOrder(o) > 0.005 && o.date <= cut)
    .sort((a, b) => (a.date < b.date ? -1 : 1)).slice(0, 5).forEach(o => alerts.push({
      kind: '超期未收', color: '#c2352f', val: oweOfOrder(o).toFixed(2),
      text: `<b>${esc(o.partner || '（未填单位）')}</b>　${o.no}　<span class="tip" style="margin:0">${o.date} 起 ${Math.round((Date.now() - new Date(o.date).getTime()) / 86400000)} 天</span>`,
      act: '去收款', fn: 'pay:' + o.no
    }));
  const bd = backupAge();
  if ((bd === null && (state.orders.length || state.products.length)) || (bd !== null && bd >= 7)) {
    alerts.push({
      kind: '未备份', color: '#c2352f', val: bd === null ? '从未备份' : bd + ' 天',
      text: `<b>数据还没留底</b>　${state.orders.length} 张单据、${state.products.length} 个商品只存在这台电脑，清缓存就没了`,
      act: '去备份', fn: 'backup'
    });
  }
  $('#dashAlert').innerHTML = alerts.length ? alerts.map(a => `
    <tr>
      <td><span class="badge ${a.kind === '库存不足' ? 'warn' : 'out'}">${a.kind}</span></td>
      <td>${a.text}</td>
      <td class="num"><b style="color:${a.color}">${a.val}</b></td>
      <td><button class="link" data-alert="${esc(a.fn)}">${a.act}</button></td>
    </tr>`).join('') : `<tr><td colspan="4" class="empty">暂无需要关注的事项，库存与回款都正常</td></tr>`;
  $$('[data-alert]').forEach(b => b.onclick = () => {
    const v = b.dataset.alert;
    if (v === 'backup') return backup();
    if (v.startsWith('pay:')) {
      const o = state.orders.find(x => x.no === v.slice(4));
      if (o) openPay(o.partner, o.no);
    } else switchPage(v);
  });

  // 出货排行（含退货冲减）
  const agg = new Map();
  state.orders.filter(o => o.type === 'out' || o.type === 'refund').forEach(o => {
    const sign = o.type === 'refund' ? -1 : 1;
    o.items.forEach(it => {
      const key = it.pid || it.name;
      const cur = agg.get(key) || { name: it.name, spec: it.spec, unit: it.unit, qty: 0, amt: 0, profit: 0 };
      cur.qty += sign * it.qty; cur.amt += sign * it.price * it.qty; cur.profit += sign * (it.price - num(it.cost)) * it.qty;
      agg.set(key, cur);
    });
  });
  const ts = $('#topSort') ? $('#topSort').value : 'amt';
  const top = [...agg.values()].filter(r => r.amt > 0)
    .sort((a, b) => ts === 'profit' ? b.profit - a.profit : ts === 'qty' ? b.qty - a.qty : b.amt - a.amt)
    .slice(0, 5);
  $('#dashTop').innerHTML = top.length ? top.map((r, i) => `
    <tr>
      <td><span class="rank r${i < 3 ? i + 1 : 0}">${i + 1}</span></td>
      <td><b>${esc(r.name)}</b></td>
      <td style="color:#5c6a80">${esc(r.spec || '-')}</td>
      <td class="num">${+r.qty.toFixed(2)}${esc(r.unit || '')}</td>
      <td class="num"><b>${r.amt.toFixed(2)}</b></td>
      <td class="num" style="color:#0d7a45">${r.profit.toFixed(2)}</td>
    </tr>`).join('') : `<tr><td colspan="6" class="empty">暂无出货记录</td></tr>`;

  renderReport();
}

/* ---------- 月度经营报表 ---------- */
function reportMonths() {
  const set = new Set([today().slice(0, 7)]);
  state.orders.forEach(o => { if (o.date) set.add(o.date.slice(0, 7)); });
  state.payments.forEach(p => { if (p.date) set.add(p.date.slice(0, 7)); });
  return [...set].sort().reverse();
}
function monthData(mon) {
  const inMonth = d => (d || '').startsWith(mon);
  const outs = state.orders.filter(o => o.type === 'out' && inMonth(o.date));
  const refs = state.orders.filter(o => o.type === 'refund' && inMonth(o.date));
  const ins = state.orders.filter(o => o.type === 'in' && inMonth(o.date));
  const pays = state.payments.filter(p => inMonth(p.date));
  const sale = outs.reduce((s, o) => s + num(o.total), 0);
  const refund = refs.reduce((s, o) => s + num(o.total), 0);
  const cost = outs.reduce((s, o) => s + num(o.cost), 0) - refs.reduce((s, o) => s + num(o.cost), 0);
  const profit = outs.reduce((s, o) => s + num(o.profit), 0) + refs.reduce((s, o) => s + num(o.profit), 0);
  const net = sale - refund;
  return {
    mon, sale, refund, net, cost, profit,
    rate: net ? profit / net * 100 : 0,
    buy: ins.reduce((s, o) => s + num(o.total), 0),
    paid: pays.reduce((s, p) => s + num(p.amount), 0),
    orders: outs.length + refs.length + ins.length,
    owe: outs.reduce((s, o) => s + Math.max(0, oweOfOrder(o)), 0)
  };
}
function renderReport() {
  const sel = $('#reportMonth');
  if (!sel) return;
  const months = reportMonths();
  const cur = sel.value && months.includes(sel.value) ? sel.value : months[0];
  sel.innerHTML = months.map(m => `<option value="${m}">${m.replace('-', ' 年 ')} 月</option>`).join('');
  sel.value = cur;
  const d = monthData(cur);
  const cells = [
    ['销售额', money(d.sale), '#c2352f'],
    ['退货额', money(d.refund), '#a35c00'],
    ['净销售额', money(d.net), '#c2352f'],
    ['销售成本', money(d.cost), '#5c6a80'],
    ['毛利', money(d.profit), '#0d7a45'],
    ['毛利率', d.net ? d.rate.toFixed(1) + '%' : '-', d.profit >= 0 ? '#0d7a45' : '#c2352f'],
    ['采购入库', money(d.buy), '#0d7a45'],
    ['当月收款', money(d.paid), '#0d7a45'],
    ['期末未收', money(d.owe), '#c2352f'],
    ['单据数', d.orders + ' 张', '#1f2733']
  ];
  $('#dashReport').innerHTML = cells.map(([k, v, c]) =>
    `<div class="rp-cell"><div class="k">${k}</div><div class="v" style="color:${c}">${v}</div></div>`).join('');
  $('#dashReport').dataset.mon = cur;
}

/* =========================================================
   商品管理
   ========================================================= */
function categories() { return [...new Set(state.products.map(p => (p.cate || '').trim()).filter(Boolean))].sort(); }

/* 最后一次出货日期；从未出过货返回空串 */
function lastOutDate(p) {
  let d = '';
  state.orders.forEach(o => {
    if (o.type !== 'out') return;
    if (!o.items.some(it => it.pid === p.id)) return;
    if (!d || (o.date || '') > d) d = o.date || '';
  });
  return d;
}
/* 距上次出货过了几天（从未出货则按建档时间算），用于判断呆滞 */
function idleDays(p) {
  const d = lastOutDate(p);
  const base = d ? new Date(d + 'T00:00:00').getTime() : (p.createdAt || Date.now());
  return Math.max(0, Math.floor((Date.now() - base) / 86400000));
}
/* 最近一次入库的进价，补货时作参考 */
function lastInPrice(p) {
  let price = 0, date = '';
  state.orders.forEach(o => {
    if (o.type !== 'in') return;
    if (date && (o.date || '') < date) return;
    const it = o.items.find(x => x.pid === p.id);
    if (!it) return;
    price = num(it.price); date = o.date || '';
  });
  return price || num(p.cost);
}

function renderProducts() {
  const key = $('#searchProduct').value.trim().toLowerCase();
  const sort = $('#sortProduct').value;
  const cate = $('#filterCate').value;
  const status = $('#filterStatus') ? $('#filterStatus').value : '';
  const warn = state.settings.warn ?? 10;

  let list = state.products.filter(p => {
    if (cate && (p.cate || '') !== cate) return false;
    if (status === 'on' && p.disabled) return false;
    if (status === 'off' && !p.disabled) return false;
    return !key || ((p.code || '') + ' ' + p.name + ' ' + (p.spec || '') + ' ' + (p.cate || '') + ' ' + (p.note || '')).toLowerCase().includes(key);
  });
  list = list.slice().sort((a, b) =>
    sort === 'name' ? a.name.localeCompare(b.name, 'zh') :
    sort === 'stock' ? a.stock - b.stock :
    sort === 'value' ? b.price * b.stock - a.price * a.stock :
    sort === 'idle' ? idleDays(b) - idleDays(a) || b.price * b.stock - a.price * a.stock :
    (b.createdAt || 0) - (a.createdAt || 0));

  const body = $('#productBody');
  body.innerHTML = list.length ? list.map(p => `
    <tr${p.disabled ? ' class="row-off"' : ''}>
      <td style="color:#5c6a80;font-family:ui-monospace,Consolas,monospace">${esc(p.code || '-')}</td>
      <td><b class="plink" data-pview="${p.id}" title="查看该商品履历（卖给谁、卖什么价）">${esc(p.name)}</b>${p.disabled ? ' <span class="badge off">已停用</span>' : ''}${idleDays(p) >= 90 && p.stock > 0 ? ' <span class="badge warn" title="超过 90 天没有出货">' + idleDays(p) + '天未动</span>' : ''}</td>
      <td style="color:#5c6a80">${esc(p.spec || '-')}</td>
      <td style="color:#5c6a80">${esc(p.cate || '-')}</td>
      <td>${esc(p.unit || '-')}</td>
      <td class="num"><input class="cell-input" data-pcost="${p.id}" type="number" min="0" step="0.01" value="${num(p.cost)}"></td>
      <td class="num"><input class="cell-input" data-pprice="${p.id}" type="number" min="0" step="0.01" value="${p.price}"></td>
      <td class="num">
        <div class="stk">
          <button class="mini" data-pminus="${p.id}" title="减 1">−</button>
          <input class="cell-input" data-pstock="${p.id}" type="number" step="any" value="${p.stock}">
          <button class="mini" data-pplus="${p.id}" title="加 1">＋</button>
        </div>
        ${p.stock <= warn ? '<span class="badge warn">库存偏低</span>' : ''}
      </td>
      <td class="num">${(p.price * p.stock).toFixed(2)}</td>
      <td>
        <button class="link" data-edit="${p.id}">编辑</button>
        <button class="link" data-toggle="${p.id}">${p.disabled ? '启用' : '停用'}</button>
        <button class="link red" data-del="${p.id}">删除</button>
      </td>
    </tr>`).join('')
    : `<tr><td colspan="10" class="empty">${state.products.length ? '没有匹配的商品（可能被筛选条件过滤了）' : '还没有商品，点右上角「添加商品」或「批量导入」'}</td></tr>`;

  const edit = (id, fn) => {
    const p = state.products.find(x => x.id === id);
    if (!p) return;
    const before = p.stock;
    fn(p);
    p.stock = +p.stock.toFixed(4);
    // 只有库存真的变了才写流水；改成本/售价不该污染库存流水
    const moved = Math.abs(p.stock - before) > 1e-9;
    if (moved) logStock(p, before, +(p.stock - before).toFixed(4), '手动调整', '');
    save(); renderProducts(); renderSelects(); renderDash();
    if (moved) renderLogs();
  };
  $$('[data-pview]', body).forEach(el => el.onclick = () => openProductView(el.dataset.pview));
  $$('[data-pcost]', body).forEach(el => el.onchange = () => edit(el.dataset.pcost, p => p.cost = Math.max(0, num(el.value))));
  $$('[data-pprice]', body).forEach(el => el.onchange = () => edit(el.dataset.pprice, p => p.price = Math.max(0, num(el.value))));
  $$('[data-pstock]', body).forEach(el => el.onchange = () => edit(el.dataset.pstock, p => p.stock = num(el.value)));
  $$('[data-pplus]', body).forEach(el => el.onclick = () => edit(el.dataset.pplus, p => p.stock += 1));
  $$('[data-pminus]', body).forEach(el => el.onclick = () => edit(el.dataset.pminus, p => p.stock -= 1));

  const cs = categories();
  const fc = $('#filterCate');
  fc.innerHTML = '<option value="">全部分类</option>' + cs.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
  if (cate && cs.includes(cate)) fc.value = cate;
  $('#cate-list').innerHTML = cs.map(c => `<option value="${esc(c)}"></option>`).join('');

  $('#btnDemo').style.display = state.products.length ? 'none' : '';
  const totalValue = state.products.reduce((s, p) => s + p.price * p.stock, 0);
  const lowCount = state.products.filter(p => p.stock <= warn).length;
  const offCount = state.products.filter(p => p.disabled).length;
  const idleList = state.products.filter(p => !p.disabled && p.stock > 0 && idleDays(p) >= 90);
  const idleVal = idleList.reduce((s, p) => s + p.price * p.stock, 0);
  $('#productStat').innerHTML = `
    <span>在售商品：<b>${state.products.length - offCount}</b> 种${offCount ? `（停用 ${offCount}）` : ''}</span>
    <span>库存总价值：<b>${money(totalValue)}</b></span>
    <span>低库存预警：<b style="color:${lowCount ? '#a35c00' : 'inherit'}">${lowCount}</b> 项（≤${warn}）</span>
    <span>呆滞占压：<b style="color:${idleList.length ? '#a35c00' : 'inherit'}">${money(idleVal)}</b>（${idleList.length} 项 90 天未动销）</span>
    <span>共 ${cs.length} 个分类</span>`;
  labelCells('#page-products table.grid');
}

/* ---------- 商品履历 ---------- */
let pvId = null;
function openProductView(id) {
  const p = state.products.find(x => x.id === id);
  if (!p) return;
  pvId = id;
  $('#pvTitle').textContent = `商品履历 · ${p.name}`;

  let outQty = 0, outAmt = 0, outProfit = 0, inQty = 0, inAmt = 0;
  const custMap = new Map();
  state.orders.forEach(o => {
    o.items.forEach(it => {
      if (it.pid !== p.id) return;
      if (o.type === 'out' || o.type === 'refund') {
        const sign = o.type === 'refund' ? -1 : 1;
        outQty += sign * it.qty; outAmt += sign * it.price * it.qty;
        outProfit += sign * (it.price - num(it.cost)) * it.qty;
        if (o.type === 'out') {
          const k = o.partner || '（未填单位）';
          const c = custMap.get(k) || { qty: 0, amt: 0, last: '', price: 0 };
          c.qty += it.qty; c.amt += it.price * it.qty;
          if (!c.last || (o.date || '') > c.last) { c.last = o.date || ''; c.price = it.price; }
          custMap.set(k, c);
        }
      } else if (o.type === 'in') { inQty += it.qty; inAmt += it.price * it.qty; }
    });
  });

  const last = lastOutDate(p), idle = idleDays(p);
  const stockVal = p.price * p.stock;
  const cells = [
    ['当前库存', `${+p.stock.toFixed(2)}${esc(p.unit || '')}`, p.stock <= (state.settings.warn ?? 10) ? '#a35c00' : '#1f2733'],
    ['库存金额', money(stockVal), '#2563eb'],
    ['成本 / 售价', `${num(p.cost).toFixed(2)} → ${num(p.price).toFixed(2)}`, '#5c6a80'],
    ['累计出货', `${+outQty.toFixed(2)}${esc(p.unit || '')}`, '#c2352f'],
    ['累计销售额', money(outAmt), '#c2352f'],
    ['累计毛利', money(outProfit), outProfit >= 0 ? '#0d7a45' : '#c2352f'],
    ['毛利率', outAmt ? (outProfit / outAmt * 100).toFixed(1) + '%' : '-', outProfit >= 0 ? '#0d7a45' : '#c2352f'],
    ['累计入库', `${+inQty.toFixed(2)}${esc(p.unit || '')}`, '#0d7a45'],
    ['最后出货', last || '从未出货', idle >= 90 ? '#a35c00' : '#1f2733'],
    ['未动天数', last ? idle + ' 天' : '建档 ' + idle + ' 天', idle >= 90 ? '#a35c00' : '#1f2733']
  ];
  $('#pvStats').innerHTML = cells.map(([k, v, c]) =>
    `<div class="rp-cell"><div class="k">${k}</div><div class="v" style="color:${c}">${v}</div></div>`).join('');

  const custs = [...custMap.entries()].map(([name, c]) => ({ name, ...c }))
    .sort((a, b) => b.amt - a.amt);
  $('#pvCust').innerHTML = custs.length ? custs.map(c => `
    <tr>
      <td><b>${esc(c.name)}</b></td>
      <td class="num">${+c.qty.toFixed(2)}</td>
      <td class="num">${c.amt.toFixed(2)}</td>
      <td class="num" style="color:#5c6a80">${c.qty ? (c.amt / c.qty).toFixed(2) : '-'}</td>
      <td class="num"><b>${num(c.price).toFixed(2)}</b></td>
      <td style="color:#5c6a80">${c.last || '-'}</td>
    </tr>`).join('')
    : `<tr><td colspan="6" class="empty">这个商品还没有出货记录</td></tr>`;

  const logs = state.logs.filter(l => l.pid === p.id).slice(0, 12);
  $('#pvLogs').innerHTML = logs.length ? logs.map(l => `
    <tr>
      <td style="color:#5c6a80">${nowText(l.ts)}</td>
      <td>${esc(l.src)}</td>
      <td style="color:#5c6a80;font-family:ui-monospace,Consolas,monospace">${esc(l.no || '-')}</td>
      <td class="num">${l.before}</td>
      <td class="num" style="color:${l.delta > 0 ? '#0d7a45' : '#c2352f'};font-weight:700">${l.delta > 0 ? '+' : ''}${l.delta}</td>
      <td class="num"><b>${l.after}</b></td>
    </tr>`).join('')
    : `<tr><td colspan="6" class="empty">暂无库存变动记录</td></tr>`;

  $('#pviewModal').classList.add('show');
}

/* ---------- 一键补货 ---------- */
function openRefill() {
  const warn = state.settings.warn ?? 10;
  const list = state.products.filter(p => !p.disabled && p.stock <= warn).sort((a, b) => a.stock - b.stock);
  $('#rfWarn').textContent = warn;
  $('#rfBody').innerHTML = list.length ? list.map(p => {
    const need = Math.max(1, warn * 2 - p.stock);
    return `<tr data-rf="${p.id}">
      <td style="text-align:center"><input type="checkbox" checked></td>
      <td><b>${esc(p.name)}</b>${p.spec ? `　<span style="color:#5c6a80">${esc(p.spec)}</span>` : ''}</td>
      <td class="num" style="color:${p.stock <= 0 ? '#c2352f' : '#a35c00'}">${+p.stock.toFixed(2)}${esc(p.unit || '')}</td>
      <td class="num"><input class="cell-input" data-rfq type="number" min="0" step="any" value="${+need.toFixed(2)}"></td>
      <td class="num"><input class="cell-input" data-rfp type="number" min="0" step="0.01" value="${lastInPrice(p).toFixed(2)}"></td>
    </tr>`;
  }).join('') : `<tr><td colspan="5" class="empty">当前没有低于预警线的在售商品，库存充足</td></tr>`;
  updateRfStat();
  $$('#rfBody input[type=checkbox]').forEach(c => c.onchange = updateRfStat);
  $$('#rfBody [data-rfq]').forEach(i => i.oninput = updateRfStat);
  $('#refillModal').classList.add('show');
}
function updateRfStat() {
  const rows = $$('#rfBody tr[data-rf]');
  let n = 0, amt = 0;
  rows.forEach(tr => {
    if (!tr.querySelector('input[type=checkbox]').checked) return;
    const qty = num(tr.querySelector('[data-rfq]').value);
    if (qty <= 0) return;
    n++; amt += qty * num(tr.querySelector('[data-rfp]').value);
  });
  $('#rfCount').textContent = `已选 ${n} 项`;
  $('#rfStat').innerHTML = `<span>勾选：<b>${n}</b> 项</span><span>预估采购金额：<b>${money(amt)}</b></span>`;
}
function applyRefill() {
  const rows = $$('#rfBody tr[data-rf]');
  if (!rows.length) return toast('没有需要补货的商品', true);
  let n = 0;
  rows.forEach(tr => {
    if (!tr.querySelector('input[type=checkbox]').checked) return;
    const p = state.products.find(x => x.id === tr.dataset.rf);
    if (!p) return;
    const qty = num(tr.querySelector('[data-rfq]').value);
    if (qty <= 0) return;
    addToDraft('in', p, qty, num(tr.querySelector('[data-rfp]').value));
    n++;
  });
  if (!n) return toast('请至少勾选一项并填写补货量', true);
  $('#refillModal').classList.remove('show');
  renderItems('in'); calcTotal('in'); save();
  switchPage('in');
  toast(`已把 ${n} 项加入入单草稿，确认后生成入库单`);
}

function openProductModal(product) {
  $('#productModalTitle').textContent = product ? '编辑商品' : '添加商品';
  $('#pfId').value = product ? product.id : '';
  $('#pfCode').value = product ? (product.code || '') : '';
  $('#pfName').value = product ? product.name : '';
  $('#pfSpec').value = product ? (product.spec || '') : '';
  $('#pfCate').value = product ? (product.cate || '') : '';
  $('#pfUnit').value = product ? (product.unit || '') : '件';
  $('#pfCost').value = product ? num(product.cost) : 0;
  $('#pfPrice').value = product ? product.price : '';
  $('#pfStock').value = product ? product.stock : 0;
  $('#pfNote').value = product ? (product.note || '') : '';
  // 编辑已有商品时这里其实是改当前库存，别再叫「初始库存」
  const sl = $('#pfStockLabel');
  if (sl) sl.firstChild.nodeValue = product ? '当前库存' : '初始库存';
  $('#productModal').classList.add('show');
  setTimeout(() => $('#pfName').focus(), 50);
}
function saveProduct() {
  const id = $('#pfId').value;
  const name = $('#pfName').value.trim();
  const code = $('#pfCode').value.trim();
  const price = num($('#pfPrice').value, NaN);
  if (!name) return toast('请填写商品名称', true);
  if (!isFinite(price) || price < 0) return toast('单价必填，且不能是负数', true);
  if (code) {
    const dup = state.products.find(p => (p.code || '').toLowerCase() === code.toLowerCase() && p.id !== id);
    if (dup) return toast(`货号「${code}」已被「${dup.name}」占用`, true);
  }
  const data = {
    code, name,
    spec: $('#pfSpec').value.trim(),
    cate: $('#pfCate').value.trim(),
    unit: $('#pfUnit').value.trim() || '件',
    cost: Math.max(0, num($('#pfCost').value)),
    price,
    stock: Math.max(0, num($('#pfStock').value)),
    note: $('#pfNote').value.trim()
  };
  if (id) {
    const p = state.products.find(p => p.id === id);
    const before = p.stock;
    Object.assign(p, data);
    logStock(p, before, p.stock - before, '手动调整', '');
  } else {
    const p = { id: uid(), createdAt: Date.now(), ...data };
    state.products.push(p);
    logStock(p, 0, p.stock, '初始库存', '');
  }
  save();
  renderProducts(); renderSelects(); renderDash(); renderLogs();
  $('#productModal').classList.remove('show');
  toast(id ? '商品已更新' : '商品已添加');
}

function loadDemo() {
  if (state.products.length && !confirm('已存在商品数据，仍要追加示例商品？')) return;
  [
    ['A001', '铜芯电线', '2.5mm² / 100m', '电线电缆', '卷', 150, 186.00, 50, '国标'],
    ['A002', 'PVC线管', 'Φ20 / 3m', '管材', '根', 3.2, 4.50, 300, ''],
    ['A003', '五孔插座', '86型 / 白色', '开关插座', '个', 8.5, 12.80, 200, ''],
    ['B001', 'LED球泡灯', '18W / 白光', '灯具', '个', 6.8, 9.90, 150, ''],
    ['B002', '空气开关', 'C63 / 2P', '开关插座', '个', 22, 32.00, 80, '正泰']
  ].forEach(([code, name, spec, cate, unit, cost, price, stock, note]) => {
    const p = { id: uid(), code, name, spec, cate, unit, cost, price, stock, note, createdAt: Date.now() };
    state.products.push(p);
    logStock(p, 0, stock, '初始库存', '');
  });
  save(); renderProducts(); renderSelects(); renderDash(); renderLogs(); toast('示例商品已载入');
}

/* ---------- CSV 批量导入 ---------- */
function parseCsv(text) {
  const sep = /\t/.test(text.split('\n')[0] || '') ? '\t' : ',';
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === sep) { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (c !== '\r') cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows.filter(r => r.some(x => String(x).trim() !== '')).map(r => r.map(x => String(x).trim()));
}
const CSV_FIELDS = {
  code: ['货号', '条码', '编号', 'code'], name: ['名称', '商品', '品名', 'name'],
  spec: ['规格', '型号', 'spec'], cate: ['分类', '类别', 'cate'], unit: ['单位', 'unit'],
  cost: ['成本价', '成本', '进价', 'cost'], price: ['单价', '售价', '价格', 'price'],
  stock: ['库存', '数量', 'stock'], note: ['备注', 'note']
};
function csvMap(header) {
  const map = {};
  Object.keys(CSV_FIELDS).forEach(k => {
    const idx = header.findIndex(h => CSV_FIELDS[k].some(w => h.toLowerCase().includes(w)));
    if (idx >= 0) map[k] = idx;
  });
  return map;
}
function importProducts(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) return toast('内容不足，至少需要表头 + 1 行数据', true);
  let map = csvMap(rows[0]);
  if (map.name == null) map = { code: 0, name: 1, spec: 2, cate: 3, unit: 4, cost: 5, price: 6, stock: 7, note: 8 };
  if (map.name == null) return toast('识别不出「名称」列，请确认表头', true);

  let added = 0, updated = 0, skipped = 0;
  rows.slice(1).forEach(r => {
    const name = r[map.name];
    if (!name) { skipped++; return; }
    const code = map.code != null ? r[map.code] : '';
    const data = {
      code, name,
      spec: map.spec != null ? r[map.spec] : '',
      cate: map.cate != null ? r[map.cate] : '',
      unit: (map.unit != null ? r[map.unit] : '') || '件',
      cost: Math.max(0, num(map.cost != null ? r[map.cost] : 0)),
      price: Math.max(0, num(map.price != null ? r[map.price] : 0)),
      stock: Math.max(0, num(map.stock != null ? r[map.stock] : 0)),
      note: map.note != null ? r[map.note] : ''
    };
    const exist = (code && state.products.find(p => (p.code || '').toLowerCase() === code.toLowerCase()))
               || state.products.find(p => p.name === name);
    if (exist) {
      const before = exist.stock;
      Object.assign(exist, data);
      logStock(exist, before, exist.stock - before, '批量导入', '');
      updated++;
    } else {
      const p = { id: uid(), createdAt: Date.now(), ...data };
      state.products.push(p);
      logStock(p, 0, p.stock, '初始库存', '');
      added++;
    }
  });
  save(); renderProducts(); renderSelects(); renderDash(); renderLogs();
  $('#importModal').classList.remove('show');
  toast(`导入完成：新增 ${added} 个，更新 ${updated} 个${skipped ? `，跳过 ${skipped} 行` : ''}`);
}

/* =========================================================
   出单 / 入单
   ========================================================= */
const TYPE_LABEL = {
  out:    { title: '出货单', partner: '客户名称',   total: '应收合计', color: '#c2352f' },
  in:     { title: '入库单', partner: '供应商名称', total: '应付合计', color: '#0d7a45' },
  refund: { title: '退货单', partner: '客户名称',   total: '退款合计', color: '#a35c00' }
};
const NO_PREFIX = { out: 'CK', in: 'RK', refund: 'TD' };

function billTemplate(type) {
  const L = TYPE_LABEL[type];
  return `
  <div class="card">
    <div class="card-head">
      <h2>${L.title}开单</h2>
      <span class="tip" style="margin:0">选商品 → 填数量 → 自动计价 → Ctrl+Enter 直接生成</span>
    </div>
    <div class="bill-meta">
      <label>单号<input class="input" id="${type}-no" readonly></label>
      <label>日期<i class="req">*</i><input class="input" type="date" id="${type}-date"></label>
      <label>${L.partner}<i class="req">*</i><input class="input" id="${type}-partner" list="plist-${type}" placeholder="必填，会自动记忆" autocomplete="off"></label>
      <label>联系人 / 电话<input class="input" id="${type}-tel" placeholder="选填"></label>
      ${type === 'out' ? `<label>物流公司<input class="input" id="${type}-shipco" list="shiplist" placeholder="选填，如 顺丰 / 德邦" autocomplete="off"></label>
      <label>运单号<input class="input" id="${type}-shipno" placeholder="选填，可在记录页搜索"></label>` : ''}
    </div>
    <div class="pick-row">
      <label>货号 / 扫码<input class="input" id="${type}-code" placeholder="输入货号后回车" style="min-width:145px"></label>
      <label>按名称搜索<input class="input" id="${type}-search" placeholder="名称 / 规格 / 货号" style="min-width:145px"></label>
      <label>选择商品<select class="input" id="${type}-select" style="min-width:255px"></select></label>
      <label>数量<input class="input" type="number" id="${type}-qty" min="0.01" step="any" value="1" style="min-width:90px"></label>
      <label>单价(¥)<input class="input" type="number" id="${type}-price" min="0" step="0.01" style="min-width:105px"></label>
      <button class="btn primary" id="${type}-add">加入单据 (Enter)</button>
      <button class="btn ghost" id="${type}-paste">批量加货</button>
    </div>
    <div class="quick-items" id="${type}-quick"></div>
    <div class="pick-hint" id="${type}-hint"></div>
    <div class="table-wrap">
      <table class="grid">
        <thead><tr>
          <th style="width:50px">#</th><th>商品名称</th><th>规格</th>
          <th style="width:70px">单位</th><th class="num" style="width:105px">单价(¥)</th>
          <th class="num" style="width:105px">数量</th><th class="num" style="width:115px">小计(¥)</th>
          <th style="width:60px">操作</th>
        </tr></thead>
        <tbody id="${type}-items"></tbody>
      </table>
    </div>
    <div class="summary">
      <div class="summary-grid">
        <label>折扣 / 优惠(¥)<input class="input" type="number" id="${type}-discount" step="0.01" value="0"></label>
        <label>其他费用(¥)<input class="input" type="number" id="${type}-extra" step="0.01" value="0"></label>
        <label>结算说明<input class="input" id="${type}-account" placeholder="现金 / 微信 / 银行转账"></label>
        <label>备注<textarea class="input" id="${type}-remark" rows="1" placeholder="选填"></textarea></label>
        <div class="total-box ${type === 'in' ? 'inmoney' : ''}">
          <div><small>合计数量</small><div id="${type}-totalqty" style="font-weight:600">0</div></div>
          ${type === 'out' ? '<div><small>毛利</small><div id="' + type + '-profit" style="color:#0d7a45;font-weight:600">¥0.00</div></div>' : ''}
          <div style="text-align:right"><small>${L.total}</small><div class="money" id="${type}-total">¥0.00</div></div>
        </div>
      </div>
    </div>
    <div class="actions">
      <button class="btn ok" id="${type}-submit">生成并保存${L.title}</button>
      <button class="btn ghost" id="${type}-clear">清空单据</button>
    </div>
  </div>
  <datalist id="plist-${type}"></datalist>${type === 'out' ? '<datalist id="shiplist"></datalist>' : ''}`;
}

function renderSelects() {
  ['out', 'in'].forEach(type => {
    const sel = $(`#${type}-select`);
    if (!sel) return;
    const key = ($(`#${type}-search`)?.value || '').trim().toLowerCase();
    const list = state.products.filter(p => !p.disabled &&
      (!key || ((p.code || '') + ' ' + p.name + ' ' + (p.spec || '')).toLowerCase().includes(key)));
    const cur = sel.value;
    sel.innerHTML = list.length
      ? list.map(p => `<option value="${p.id}">${p.code ? '[' + esc(p.code) + '] ' : ''}${esc(p.name)}${p.spec ? ' / ' + esc(p.spec) : ''}　${p.price.toFixed(2)}元　库存${p.stock}${esc(p.unit || '')}</option>`).join('')
      : '<option value="">（暂无可选商品，请先到「商品管理」添加）</option>';
    if (cur && list.some(p => p.id === cur)) sel.value = cur;
    syncPickPrice(type);
  });
  renderPartnerLists();
}
function renderPartnerLists() {
  ['out', 'in'].forEach(type => {
    const dl = $(`#plist-${type}`);
    if (!dl) return;
    const names = [...new Set(state.orders.filter(o => o.type === type && o.partner).map(o => o.partner))].slice(0, 40);
    dl.innerHTML = names.map(n => `<option value="${esc(n)}"></option>`).join('');
  });
  const pl = $('#payNoList');
  if (pl) pl.innerHTML = state.orders.filter(o => o.type === 'out').slice(0, 60).map(o => `<option value="${o.no}"></option>`).join('');
  const sl = $('#shiplist');
  if (sl) sl.innerHTML = [...new Set(state.orders.filter(o => o.type === 'out' && o.shipCo).map(o => o.shipCo))]
    .slice(0, 20).map(c => `<option value="${esc(c)}"></option>`).join('');
}
/* 该客户对该商品的最后一次成交价（orders 按时间倒序，第一个命中的即最新） */
function lastPriceFor(pid, partner) {
  if (!partner) return null;
  for (const o of state.orders) {
    if (o.type !== 'out' || (o.partner || '').trim() !== partner) continue;
    const hit = o.items.find(it => it.pid === pid);
    if (hit) return num(hit.price);
  }
  return null;
}
const priceMemOn = () => state.settings.priceMemory !== false;
function pickPriceFor(type, p) {
  if (!priceMemOn()) return p.price;
  const mem = lastPriceFor(p.id, ($(`#${type}-partner`)?.value || '').trim());
  return mem != null ? mem : p.price;
}
function syncPickPrice(type) {
  const p = state.products.find(x => x.id === $(`#${type}-select`).value);
  if (p) $(`#${type}-price`).value = pickPriceFor(type, p);
  updateHint(type);
}
/* 成本 / 库存 / 上次成交价提示 */
function updateHint(type) {
  const el = $(`#${type}-hint`); if (!el) return;
  const p = state.products.find(x => x.id === $(`#${type}-select`).value);
  if (!p) { el.innerHTML = ''; return; }
  let txt = `成本 ${num(p.cost).toFixed(2)} 元　当前库存 <b>${p.stock}</b>${esc(p.unit || '')}`;
  const partner = ($(`#${type}-partner`).value || '').trim();
  if (partner) {
    const mem = lastPriceFor(p.id, partner);
    if (mem != null) txt += `　|　上次售给「${esc(partner)}」：<b>${mem.toFixed(2)}</b> 元${priceMemOn() ? '（已自动带出）' : ''}`;
    else txt += `　|　「${esc(partner)}」暂无该商品成交记录`;
  }
  el.innerHTML = txt;
}

function addToDraft(type, product, qty, price) {
  const exist = state.drafts[type].find(it => it.pid === product.id);
  const unitCost = costOf(product);
  const fp = price != null ? price : pickPriceFor(type, product);
  if (exist) { exist.qty = +(exist.qty + qty).toFixed(4); exist.price = fp; exist.cost = unitCost; }
  else state.drafts[type].push({ pid: product.id, name: product.name, spec: product.spec, unit: product.unit, price: fp, cost: unitCost, qty });
}

function renderItems(type) {
  const items = state.drafts[type];
  const tbody = $(`#${type}-items`);
  tbody.innerHTML = items.length ? items.map((it, i) => `
    <tr>
      <td style="color:#8a94a6">${i + 1}</td>
      <td><b>${esc(it.name)}</b></td>
      <td style="color:#5c6a80">${esc(it.spec || '-')}</td>
      <td>${esc(it.unit || '-')}</td>
      <td class="num"><input class="input num" data-ip="${i}" value="${it.price}" type="number" min="0" step="0.01" style="padding:4px 6px"></td>
      <td class="num"><input class="input num" data-iq="${i}" value="${it.qty}" type="number" min="0.01" step="any" style="padding:4px 6px"></td>
      <td class="num"><b class="sub">${(it.price * it.qty).toFixed(2)}</b></td>
      <td><button class="link red" data-idel="${i}">删除</button></td>
    </tr>`).join('')
    : `<tr><td colspan="8" class="empty">单据为空，请在上方选择商品或扫货号加入</td></tr>`;

  const patchRow = (el, i) => {
    const it = state.drafts[type][i];
    $('.sub', el.closest('tr')).textContent = (it.price * it.qty).toFixed(2);
    calcTotal(type); save();
  };
  $$('[data-ip]', tbody).forEach(el => el.oninput = () => {
    const i = +el.dataset.ip; state.drafts[type][i].price = Math.max(0, num(el.value)); patchRow(el, i);
  });
  $$('[data-iq]', tbody).forEach(el => el.oninput = () => {
    const i = +el.dataset.iq; state.drafts[type][i].qty = Math.max(0, num(el.value)); patchRow(el, i);
  });
  $$('[data-idel]', tbody).forEach(el => el.onclick = () => { state.drafts[type].splice(+el.dataset.idel, 1); renderItems(type); });

  calcTotal(type); save();
  renderQuick(type);
}

function calcTotal(type) {
  const items = state.drafts[type];
  const goods = items.reduce((s, it) => s + it.price * it.qty, 0);
  const profit = items.reduce((s, it) => s + (it.price - num(it.cost)) * it.qty, 0);
  const qty = items.reduce((s, it) => s + it.qty, 0);
  const discount = num($(`#${type}-discount`).value);
  const extra = num($(`#${type}-extra`).value);
  const total = goods - discount + extra;
  $(`#${type}-totalqty`).textContent = String(+qty.toFixed(2));
  $(`#${type}-total`).textContent = money(total);
  if (type === 'out') { const el = $(`#${type}-profit`); if (el) el.textContent = money(profit); }
  return { goods, qty, discount, extra, total, profit };
}

function nextNo(type) {
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  return (NO_PREFIX[type] || 'NO') + stamp + '-' + String(num(state.seq[type]) + 1).padStart(3, '0');
}

function bindBill(type) {
  const add = () => {
    const p = state.products.find(x => x.id === $(`#${type}-select`).value);
    if (!p) return toast('请先选择商品', true);
    const qty = num($(`#${type}-qty`).value, 1);
    const rawPrice = $(`#${type}-price`).value.trim();
    const price = rawPrice === '' ? p.price : num(rawPrice, NaN);
    if (qty <= 0) return toast('数量必须大于 0', true);
    if (!isFinite(price) || price < 0) return toast('单价不能为空或负数', true);
    if (type === 'out' && qty > p.stock &&
        !confirm(`「${p.name}」库存仅 ${p.stock}${p.unit || ''}，本次出库 ${qty}${p.unit || ''}，是否继续（库存将为负）？`)) return;
    addToDraft(type, p, qty, price);
    renderItems(type);
    $(`#${type}-qty`).value = 1;
    $(`#${type}-search`).value = '';
    $(`#${type}-select`).focus();
  };

  $(`#${type}-search`).oninput = () => renderSelects();
  $(`#${type}-select`).onchange = () => syncPickPrice(type);
  /* 换客户 = 换价格体系，重新带出该客户的成交价 */
  $(`#${type}-partner`).oninput = () => syncPickPrice(type);
  $(`#${type}-add`).onclick = add;
  /* 从 Excel / 微信粘贴多行内容 → 批量加入 */
  $(`#${type}-code`).addEventListener('paste', e => {
    const txt = (e.clipboardData || window.clipboardData);
    const v = txt ? txt.getData('text') : '';
    if (!v || v.indexOf('\n') < 0) return;      // 单行走原来的回车逻辑
    e.preventDefault();
    $(`#${type}-code`).value = '';
    batchAdd(type, v);
  });
  $(`#${type}-paste`).onclick = () => {
    pasteType = type;
    $('#pasteText').value = '';
    $('#pastePreview').textContent = '';
    $('#pasteModal').classList.add('show');
    setTimeout(() => $('#pasteText').focus(), 50);
  };
  [$(`#${type}-qty`), $(`#${type}-price`)].forEach(el =>
    el.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); add(); } }));

  $(`#${type}-code`).addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const code = e.target.value.trim();
    if (!code) return;
    const p = state.products.find(x => (x.code || '').toLowerCase() === code.toLowerCase())
           || state.products.find(x => x.name === code);
    if (!p) return toast(`未找到货号/名称为「${code}」的商品`, true);
    const qty = num($(`#${type}-qty`).value, 1);
    if (qty <= 0) return toast('数量必须大于 0', true);
    addToDraft(type, p, qty, p.price);
    renderItems(type);
    e.target.value = ''; e.target.focus();
    toast(`已加入：${p.name} ×${qty}`);
  });

  ['discount', 'extra'].forEach(k => $(`#${type}-${k}`).oninput = () => calcTotal(type));
  $(`#${type}-clear`).onclick = () => {
    if (!state.drafts[type].length || confirm('确定清空当前单据内容？')) {
      state.drafts[type] = []; renderItems(type); toast('已清空');
    }
  };
  $(`#${type}-submit`).onclick = () => submitBill(type);
}

/* ---------- 批量加货：从 Excel / 微信粘贴多行 ---------- */
let pasteType = 'out';
function splitLine(line) {
  let parts;
  if (/\t/.test(line)) parts = line.split('\t');
  else if (line.includes(',')) parts = line.split(',');
  else parts = line.split(/\s+/);
  return parts.map(x => x.trim()).filter(x => x !== '');
}
function matchProduct(token) {
  const t = String(token).toLowerCase();
  return state.products.find(p => (p.code || '').toLowerCase() === t)
      || state.products.find(p => p.name.toLowerCase() === t)
      || state.products.find(p => p.name.toLowerCase().includes(t))
      || state.products.find(p => (p.code || '').toLowerCase().includes(t));
}
function parseBatch(text) {
  const lines = String(text).split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  const ok = [], fails = [];
  lines.forEach(line => {
    const parts = splitLine(line);
    if (!parts.length) return;
    let [a, b, c] = parts;
    let token = a, qtyRaw = b, priceRaw = c;
    /* 容错：允许「数量 货号」倒序写法 */
    if (b !== undefined && isFinite(num(a)) && !matchProduct(a)) { token = b; qtyRaw = a; priceRaw = c; }
    const p = matchProduct(token);
    if (!p) { fails.push(`「${token}」找不到对应商品`); return; }
    const qty = num(qtyRaw, 1);
    if (!(qty > 0)) { fails.push(`「${token}」数量无效（${qtyRaw ?? '空'}）`); return; }
    const price = (priceRaw !== undefined && priceRaw !== '' && isFinite(num(priceRaw))) ? num(priceRaw) : null;
    ok.push({ p, qty, price });
  });
  return { ok, fails, total: lines.length };
}
function batchAdd(type, text) {
  const { ok, fails, total } = parseBatch(text);
  if (!total) return toast('没有解析到内容', true);
  if (!ok.length) {
    alert(`一行都没能识别：\n\n${fails.slice(0, 8).join('\n')}`);
    return toast('没有可加入的商品', true);
  }
  let qtySum = 0;
  ok.forEach(({ p, qty, price }) => { addToDraft(type, p, qty, price); qtySum += qty; });
  renderItems(type); switchPage(type);
  toast(`已加入 ${ok.length} 行，共 ${+qtySum.toFixed(2)} 件${fails.length ? `，${fails.length} 行有问题` : ''}`);
  if (fails.length) alert(`${fails.length} 行没能加入：\n\n${fails.slice(0, 10).join('\n')}${fails.length > 10 ? `\n…还有 ${fails.length - 10} 行` : ''}`);
}
function doPaste() {
  const text = $('#pasteText').value;
  if (!text.trim()) return toast('请先粘贴内容', true);
  $('#pasteModal').classList.remove('show');
  batchAdd(pasteType, text);
}
function previewPaste() {
  const text = $('#pasteText').value;
  const { ok, fails, total } = parseBatch(text);
  $('#pastePreview').innerHTML = total
    ? `共 ${total} 行：可识别 <b>${ok.length}</b> 行${fails.length ? `　<b style="color:#c2352f">${fails.length} 行有问题</b>：${esc(fails.slice(0, 2).join('；'))}${fails.length > 2 ? ' …' : ''}` : ''}`
    : '';
}

/* 开单必填校验：返回 [[字段key, 提示], ...]，字段 key 用于定位并高亮 */
function billErrors(type) {
  const L = TYPE_LABEL[type];
  const errs = [];
  if (!$(`#${type}-partner`).value.trim())
    errs.push(['partner', `${L.partner}不能为空 —— 不填没法记欠款，也没法出对账单`]);
  if (!$(`#${type}-date`).value) errs.push(['date', '请选择单据日期']);

  const items = state.drafts[type];
  if (!items.length) errs.push(['select', '请先加入商品']);
  const live = items.filter(it => it.qty > 0);
  if (items.length && !live.length) errs.push(['select', '所有行的数量都是 0，请填写数量']);
  const badPrice = live.filter(it => !isFinite(num(it.price)) || num(it.price) < 0);
  if (badPrice.length) errs.push([null, `「${badPrice[0].name}」单价不能为空或负数`]);
  const badQty = live.filter(it => it.qty < 0);
  if (badQty.length) errs.push([null, `「${badQty[0].name}」数量不能为负数`]);

  const discount = num($(`#${type}-discount`).value);
  const extra = num($(`#${type}-extra`).value);
  if (discount < 0) errs.push(['discount', '折扣不能填负数']);
  if (extra < 0) errs.push(['extra', '其他费用不能填负数']);
  const goods = live.reduce((s, it) => s + num(it.price) * it.qty, 0);
  if (discount > goods + 0.005) errs.push(['discount', `折扣 ${discount.toFixed(2)} 比货款 ${goods.toFixed(2)} 还大，请核对`]);
  return errs;
}
/* 高亮并聚焦第一个出错的字段 */
function flagField(type, key) {
  $$('.invalid').forEach(el => el.classList.remove('invalid'));
  if (!key) return;
  const el = $(`#${type}-${key}`);
  if (!el) return;
  el.classList.add('invalid');
  el.focus();
  el.oninput = el.onchange = () => el.classList.remove('invalid');
}

function submitBill(type) {
  const errs = billErrors(type);
  if (errs.length) {
    flagField(type, errs[0][0]);
    return toast(errs[0][1], true);
  }
  const clean = state.drafts[type].filter(it => it.qty > 0);
  if (!clean.length) return toast('请先加入商品（且数量大于 0）', true);
  /* 商品被删了还在草稿里 → 提醒，避免"记了账但库存没动" */
  const orphan = clean.filter(it => !state.products.some(x => x.id === it.pid));
  if (orphan.length &&
      !confirm(`有 ${orphan.length} 行商品已被删除：${orphan.map(o => o.name).slice(0, 3).join('、')}\n\n这些行仍会写进单据，但不会扣减库存（商品已不存在）。\n\n点「确定」继续生成，点「取消」返回手动删掉这些行。`)) return;
  const L = TYPE_LABEL[type];
  if (!confirm(`确定生成${L.title}？库存将同步${type === 'out' ? '扣减' : '增加'}。`)) return;

  const { goods, qty, discount, extra, total, profit } = calcTotal(type);
  const order = {
    id: uid(), type, no: nextNo(type),
    date: $(`#${type}-date`).value || today(),
    partner: $(`#${type}-partner`).value.trim(),
    tel: $(`#${type}-tel`).value.trim(),
    account: $(`#${type}-account`).value.trim(),
    shipCo: type === 'out' ? ($(`#${type}-shipco`)?.value || '').trim() : '',
    shipNo: type === 'out' ? ($(`#${type}-shipno`)?.value || '').trim() : '',
    remark: $(`#${type}-remark`).value.trim(),
    items: clean.map(i => ({
      ...i, qty: +i.qty.toFixed(4), cost: num(i.cost),
      subtotal: +(i.price * i.qty).toFixed(2),
      profit: +((i.price - num(i.cost)) * i.qty).toFixed(2)
    })),
    goods: +goods.toFixed(2), qty: +qty.toFixed(2),
    cost: +clean.reduce((s, i) => s + num(i.cost) * i.qty, 0).toFixed(2),
    profit: +profit.toFixed(2),
    discount, extra, total: +Math.max(0, total).toFixed(2),
    createdAt: Date.now()
  };
  clean.forEach(it => {
    const p = state.products.find(x => x.id === it.pid);
    if (!p) return;
    const before = p.stock;
    const delta = type === 'out' ? -it.qty : it.qty;
    p.stock = +(p.stock + delta).toFixed(4);
    logStock(p, before, delta, L.title, order.no);
  });
  state.seq[type]++;
  state.orders.unshift(order);
  state.drafts[type] = [];
  ['partner', 'tel', 'account', 'remark'].forEach(k => $(`#${type}-${k}`).value = '');
  ['shipco', 'shipno'].forEach(k => { const el = $(`#${type}-${k}`); if (el) el.value = ''; });
  $(`#${type}-discount`).value = 0;
  $(`#${type}-extra`).value = 0;
  save();
  renderItems(type); renderProducts(); renderSelects(); renderRecords(); renderDash(); renderLogs(); renderPartners();
  $(`#${type}-no`).value = nextNo(type);
  openDoc(order);
  toast(`${L.title} ${order.no} 已生成`);
}

function editOrder(id) {
  const o = state.orders.find(x => x.id === id);
  if (!o) return;
  if (o.type === 'refund') return toast('退货单不支持修改，请直接删除后重新发起', true);
  if (!confirm(`把单号 ${o.no} 撤回为草稿重新修改？\n（原单库存变动会先还原，重新生成后按新内容重新计算）`)) return;
  o.items.forEach(it => {
    const p = state.products.find(x => x.id === it.pid);
    if (!p) return;
    const before = p.stock;
    const delta = o.type === 'out' ? it.qty : -it.qty;
    p.stock = +(p.stock + delta).toFixed(4);
    logStock(p, before, delta, '单据撤回', o.no);
  });
  state.orders = state.orders.filter(x => x.id !== id);
  const t = o.type;
  state.drafts[t] = o.items.map(it => ({ pid: it.pid, name: it.name, spec: it.spec, unit: it.unit, price: it.price, cost: num(it.cost), qty: it.qty }));
  $(`#${t}-partner`).value = o.partner || '';
  $(`#${t}-tel`).value = o.tel || '';
  $(`#${t}-account`).value = o.account || '';
  $(`#${t}-remark`).value = o.remark || '';
  ['shipco', 'shipno'].forEach(k => { const el = $(`#${t}-${k}`); if (el) el.value = o[k === 'shipco' ? 'shipCo' : 'shipNo'] || ''; });
  $(`#${t}-discount`).value = o.discount || 0;
  $(`#${t}-extra`).value = o.extra || 0;
  $(`#${t}-date`).value = o.date;
  save();
  renderItems(t); renderProducts(); renderSelects(); renderRecords(); renderDash(); renderLogs(); renderPartners();
  switchPage(t);
  toast('已撤回为草稿，核对后重新生成单据');
}

/* =========================================================
   退货单
   ========================================================= */
let refundSource = null;
/* 该出货单上某商品累计已退数量（同一张单可能分多次退） */
function refundedQty(no, pid) {
  return state.orders
    .filter(o => o.type === 'refund' && o.refundOf === no)
    .reduce((s, o) => s + o.items.filter(it => it.pid === pid).reduce((s2, it) => s2 + num(it.qty), 0), 0);
}
function openRefund(order) {
  if (!order || order.type !== 'out') return;
  refundSource = order;
  $('#rfNo').textContent = order.no;
  $('#rfRemark').value = '';
  $('#rfBody').innerHTML = order.items.map((it, i) => {
    const back = refundedQty(order.no, it.pid);
    const left = +Math.max(0, it.qty - back).toFixed(4);
    return `
    <tr>
      <td><b>${esc(it.name)}</b><br><span class="tip">${esc(it.spec || '')}　${it.price}元/${esc(it.unit || '')}${back ? `　已退 ${+back.toFixed(2)}` : ''}</span></td>
      <td class="num">${it.qty}</td>
      <td>${left > 0
        ? `<input class="input" data-rq="${i}" type="number" min="0" step="any" max="${left}" placeholder="0" style="padding:5px 8px">`
        : `<span class="tip">已全部退回</span>`}</td>
      <td class="num"><b class="rf-sub">0.00</b></td>
    </tr>`;
  }).join('');
  $$('[data-rq]', $('#rfBody')).forEach(el => el.oninput = () => {
    const i = +el.dataset.rq;
    const it = order.items[i];
    const left = Math.max(0, it.qty - refundedQty(order.no, it.pid));
    const q = Math.max(0, Math.min(num(el.value), left));
    if (num(el.value) > left) { el.classList.add('invalid'); el.oninput = () => el.classList.remove('invalid'); }
    el.value = q || '';
    $('.rf-sub', el.closest('tr')).textContent = (it.price * q).toFixed(2);
  });
  $('#refundModal').classList.add('show');
}
function saveRefund() {
  const o = refundSource;
  if (!o) return;
  const inputs = $$('[data-rq]', $('#rfBody'));
  const items = [];
  inputs.forEach(el => {
    const i = +el.dataset.rq;
    const left = Math.max(0, o.items[i].qty - refundedQty(o.no, o.items[i].pid));
    const q = Math.max(0, Math.min(num(el.value), left));
    if (q > 0) items.push({ ...o.items[i], qty: q, subtotal: +(o.items[i].price * q).toFixed(2) });
  });
  if (!items.length) return toast('请至少填写一项退货数量', true);
  if (!confirm(`确认为 ${o.no} 生成退货单？退回 ${items.length} 项，库存将增加。`)) return;

  const total = +items.reduce((s, it) => s + num(it.subtotal), 0).toFixed(2);
  const order = {
    id: uid(), type: 'refund', no: nextNo('refund'),
    date: today(), partner: o.partner, tel: o.tel,
    account: '', remark: $('#rfRemark').value.trim(),
    refundOf: o.no,
    items: items.map(it => ({ ...it, profit: -Math.abs(num(it.profit)) })),
    goods: total, qty: +items.reduce((s, it) => s + it.qty, 0).toFixed(2),
    cost: +items.reduce((s, it) => s + num(it.cost) * it.qty, 0).toFixed(2),
    profit: -items.reduce((s, it) => s + Math.abs(num(it.price) - num(it.cost)) * it.qty, 0).toFixed(2),
    discount: 0, extra: 0, total,
    createdAt: Date.now()
  };
  items.forEach(it => {
    const p = state.products.find(x => x.id === it.pid);
    if (!p) return;
    const before = p.stock;
    p.stock = +(p.stock + it.qty).toFixed(4);
    logStock(p, before, it.qty, '退货入库', order.no);
  });
  state.seq.refund = num(state.seq.refund) + 1;
  state.orders.unshift(order);
  save();
  $('#refundModal').classList.remove('show');
  renderProducts(); renderSelects(); renderRecords(); renderDash(); renderLogs(); renderPartners();
  openDoc(order);
  toast(`退货单 ${order.no} 已生成`);
}

/* =========================================================
   单据 / 对账单
   ========================================================= */
function docCss() {
  return `
  *{box-sizing:border-box}
  @page{size:A4;margin:14mm}
  body{font:13px/1.7 "Microsoft YaHei","PingFang SC",sans-serif;color:#111;background:#fff;margin:0;padding:24px}
  .paper{max-width:820px;margin:0 auto}
  h1{font-size:24px;text-align:center;letter-spacing:6px;margin:0 0 4px}
  .sub{text-align:center;color:#444;font-size:13px;margin-bottom:14px}
  .meta{display:grid;grid-template-columns:1fr 1fr;gap:5px 18px;border:2px solid #111;padding:10px 12px;margin-bottom:12px}
  table{width:100%;border-collapse:collapse;font-size:12.5px}
  th,td{border:1px solid #333;padding:6px 8px}
  th{background:#f0f0f0;text-align:left}
  .tfoot td{font-weight:700;background:#fafafa}
  .total{margin-top:12px;display:flex;justify-content:space-between;align-items:flex-end;gap:20px;font-size:14px}
  .total .big{font-size:20px;font-weight:700}
  .upper{margin-top:6px;font-size:12px;color:#333}
  .note{margin-top:14px;border-top:1px dashed #999;padding-top:8px;font-size:12px;color:#444;white-space:pre-wrap}
  .sign{margin-top:30px;display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px;font-size:12.5px}
  .sign div{border-top:1px solid #666;padding-top:6px}
  .foot-note{margin-top:18px;text-align:center;font-size:11.5px;color:#666}
  .code-tag{font-size:11px;color:#666}
  @media print{ body{padding:0} }`;
}

function docShell(title, body, extraCss) {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">
<title>${esc(title)}</title><style>${docCss()}${extraCss || ''}</style></head><body>${body}</body></html>`;
}

function buildDocHtml(order) {
  const s = state.settings;
  const isOut = order.type === 'out';
  const isRefund = order.type === 'refund';
  const L = TYPE_LABEL[order.type] || TYPE_LABEL.out;
  const showCode = !!s.docCode;
  const showCost = !!s.docCost && (isOut || isRefund);   // 成本毛利只给内部单据看
  const showSign = s.docSign !== false;

  const rows = order.items.map((it, i) => {
    const code = (state.products.find(p => p.id === it.pid) || {}).code || '';
    return `<tr>
      <td style="text-align:center">${i + 1}</td>
      <td>${esc(it.name)}${showCode && code ? `<br><span class="code-tag">货号 ${esc(code)}</span>` : ''}</td>
      <td>${esc(it.spec || '')}</td>
      <td style="text-align:center">${esc(it.unit || '')}</td>
      <td style="text-align:right">${num(it.price).toFixed(2)}</td>
      <td style="text-align:right">${it.qty}</td>
      <td style="text-align:right">${num(it.subtotal).toFixed(2)}</td>
      <td></td>
    </tr>`;
  }).join('');

  const costLines = showCost ? `
    <div class="upper">成本合计：${num(order.cost).toFixed(2)} 元　毛利：${num(order.profit).toFixed(2)} 元
      ${num(order.goods) ? `　毛利率 ${(num(order.profit) / num(order.goods) * 100).toFixed(1)}%` : ''}</div>` : '';
  const payLine = isOut ? `
    <div class="upper">已收金额：${paidOf(order.no).toFixed(2)} 元　${oweOfOrder(order) > 0.005 ? `尚欠：<b>${oweOfOrder(order).toFixed(2)}</b> 元` : '已结清'}</div>` : '';

  return docShell(`${order.no} ${L.title}`, `
<div class="paper">
  <h1>${esc(s.company || '出入库单据')}</h1>
  <div class="sub">${L.title}${isRefund && order.refundOf ? `（原单 ${order.refundOf}）` : ''}${s.contact || s.phone ? '　|　制单：' + esc(s.contact || s.phone) : ''}</div>
  <div class="meta">
    <div>单　　号：<b>${order.no}</b></div>
    <div>日　　期：${order.date}</div>
    <div>${isOut || isRefund ? '客　　户' : '供 应 商'}：${esc(order.partner || '')}</div>
    <div>联系电话：${esc(order.tel || '')}</div>
    ${isOut && s.docShip !== false && (order.shipCo || order.shipNo)
      ? `<div>物流公司：${esc(order.shipCo || '—')}</div><div>运单号：<b>${esc(order.shipNo || '—')}</b></div>` : ''}
    ${s.address ? `<div style="grid-column:1/3">地　　址：${esc(s.address)}</div>` : ''}
  </div>
  <table>
    <thead><tr>
      <th style="width:40px">序号</th><th>商品名称</th><th>规格</th><th style="width:56px">单位</th>
      <th style="width:82px;text-align:right">单价(元)</th><th style="width:70px;text-align:right">数量</th>
      <th style="width:90px;text-align:right">金额(元)</th><th style="width:80px">备注</th>
    </tr></thead>
    <tbody>${rows}</tbody>
    <tfoot><tr class="tfoot">
      <td colspan="5" style="text-align:right">合计</td>
      <td style="text-align:right">${order.qty}</td>
      <td style="text-align:right">${num(order.goods).toFixed(2)}</td>
      <td></td>
    </tr></tfoot>
  </table>
  <div class="total">
    <div class="upper">金额大写：${rmbUpper(order.total)}</div>
    <div>
      <div>折扣优惠：-${num(order.discount).toFixed(2)} 元　其他费用：${num(order.extra).toFixed(2)} 元</div>
      <div>${L.total}：<span class="big" style="color:${L.color}">¥${num(order.total).toFixed(2)}</span></div>
    </div>
  </div>
  ${costLines}${payLine}
  ${order.account ? `<div class="upper">结算方式：${esc(order.account)}</div>` : ''}
  ${order.remark ? `<div class="note">备注：${esc(order.remark)}</div>` : ''}
  ${showSign ? `<div class="sign">
    <div>制单人签字：</div><div>${isOut || isRefund ? '客户' : '供应商'}签字：</div><div>日期：</div>
  </div>` : ''}
  ${s.footer ? `<div class="foot-note">${esc(s.footer)}</div>` : ''}
</div>
`);
}

function buildStmtHtml(st) {
  const s = state.settings;
  const rows = st.rows.map((r, i) => `
    <tr>
      <td style="text-align:center">${i + 1}</td>
      <td>${r.date}</td><td>${r.no}</td>
      <td>${esc(r.name)}</td><td>${esc(r.spec || '')}</td>
      <td style="text-align:center">${esc(r.unit || '')}</td>
      <td style="text-align:right">${num(r.price).toFixed(2)}</td>
      <td style="text-align:right">${r.qty}</td>
      <td style="text-align:right">${num(r.amount).toFixed(2)}</td>
    </tr>`).join('');
  const owe = +(st.total - num(st.paid)).toFixed(2);
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">
<title>对账单_${esc(st.partner)}_${st.from}~${st.to}</title><style>${docCss()}
  .big-red{color:#c2352f}</style></head><body>
<div class="paper">
  <h1>${esc(s.company || '对账单')}</h1>
  <div class="sub">客 户 对 账 单</div>
  <div class="meta">
    <div>客户名称：<b>${esc(st.partner)}</b></div>
    <div>账单区间：${st.from} 至 ${st.to}</div>
    <div>单据张数：${st.orders} 张</div>
    <div>制单日期：${today()}</div>
    ${s.address ? `<div style="grid-column:1/3">地　　址：${esc(s.address)}</div>` : ''}
  </div>
  <table>
    <thead><tr>
      <th style="width:40px">序号</th><th style="width:80px">日期</th><th style="width:110px">单号</th>
      <th>商品名称</th><th>规格</th><th style="width:50px">单位</th>
      <th style="width:78px;text-align:right">单价(元)</th><th style="width:60px;text-align:right">数量</th>
      <th style="width:88px;text-align:right">金额(元)</th>
    </tr></thead>
    <tbody>${rows}</tbody>
    <tfoot><tr class="tfoot">
      <td colspan="7" style="text-align:right">合计</td>
      <td style="text-align:right">${+st.qty.toFixed(2)}</td>
      <td style="text-align:right">${num(st.total).toFixed(2)}</td>
    </tr></tfoot>
  </table>
  <div class="total">
    <div class="upper">金额大写：${rmbUpper(st.total)}</div>
    <div>
      <div>已收金额：${num(st.paid).toFixed(2)} 元</div>
      <div>尚欠金额：<span class="big big-red">¥${owe.toFixed(2)}</span></div>
    </div>
  </div>
  ${st.remark ? `<div class="note">备注：${esc(st.remark)}</div>` : ''}
  <div class="sign">
    <div>制单人签字：</div><div>客户确认签字：</div><div>日期：</div>
  </div>
  ${s.footer ? `<div class="foot-note">${esc(s.footer)}</div>` : ''}
</div>
</body></html>`;
}

/* ---------- 收款收据 ---------- */
function receiptNo(p) {
  const d = (p.date || '').replace(/-/g, '');
  const seq = state.payments.filter(x => x.date === p.date && x.ts <= p.ts).length;
  return `SK${d}${String(seq).padStart(3, '0')}`;
}
function buildReceiptHtml(p) {
  const s = state.settings;
  const amt = num(p.amount);
  const stat = partnerStats().find(x => x.name === p.partner);
  return docShell(`收款收据 ${receiptNo(p)}`, `
<div class="paper">
  <h1>收款收据</h1>
  <div class="sub">${esc(s.company || '')}${s.contact || s.phone ? '　|　收款：' + esc(s.contact || s.phone) : ''}</div>
  <div class="meta">
    <div>收据编号：<b>${receiptNo(p)}</b></div>
    <div>收款日期：${p.date}</div>
    <div>交款单位：<b>${esc(p.partner)}</b></div>
    <div>收款方式：${esc(p.method || '—')}</div>
    <div>对应单号：${esc(p.no || '—')}</div>
    <div>本次之前尚欠：${stat ? (stat.owe + amt).toFixed(2) : '—'} 元</div>
  </div>
  <table>
    <thead><tr><th>收款项目</th><th style="width:150px;text-align:right">金额（元）</th></tr></thead>
    <tbody>
      <tr>
        <td>${p.no ? `货款（单号 ${esc(p.no)}）` : '往来货款'}${p.remark ? `<br><span class="code-tag">${esc(p.remark)}</span>` : ''}</td>
        <td style="text-align:right">${amt.toFixed(2)}</td>
      </tr>
    </tbody>
    <tfoot class="tfoot">
      <tr><td>合计（大写）</td><td style="text-align:right"><b>${rmbUpper(amt)}</b></td></tr>
      <tr><td>合计（小写）</td><td style="text-align:right"><b>¥ ${amt.toFixed(2)}</b></td></tr>
      ${stat ? `<tr><td>本次收款后尚欠</td><td style="text-align:right"><b>${Math.max(0, stat.owe).toFixed(2)}</b></td></tr>` : ''}
    </tfoot>
  </table>
  <div class="total"><div class="upper">实收人民币：${rmbUpper(amt)}</div><div class="big">¥ ${amt.toFixed(2)}</div></div>
  <div class="sign">
    <div>收款人签字：</div><div>交款人签字：</div><div>日期：</div>
  </div>
  ${s.footer ? `<div class="foot-note">${esc(s.footer)}</div>` : ''}
</div>`);
}
function openReceipt(id) {
  const p = state.payments.find(x => x.id === id);
  if (!p) return;
  openHtml(`收款收据_${p.partner}_${p.date}_${receiptNo(p)}`, buildReceiptHtml(p), `收款收据 · ${p.partner}`);
}

function exportXls(tip, headers, rows, filename) {
  const html = `<html xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="UTF-8">
<style>table{border-collapse:collapse}td,th{border:1px solid #999;padding:4px 6px;font-size:12px}
th{background:#eee}</style></head><body><table>
<tr>${headers.map(h => `<th>${esc(h)}</th>`).join('')}</tr>
${rows.map(r => `<tr>${r.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}
</table></body></html>`;
  downloadBlob('\ufeff' + html, filename + '.xls', 'application/vnd.ms-excel;charset=utf-8');
  toast(tip + '已导出');
}

let currentDoc = null, currentHtml = '', currentName = '单据';
function showDoc(title) {
  $('#docTitle').textContent = title;
  $('#docPreview').innerHTML = currentHtml;
  $('#btnRefund').style.display = currentDoc && currentDoc.type === 'out' ? '' : 'none';
  $('#btnCopyOrder').style.display = currentDoc && currentDoc.type !== 'refund' ? '' : 'none';
  $('#docModal').classList.add('show');
}
function openDoc(order) {
  if (!order) return;
  currentDoc = order;
  currentHtml = buildDocHtml(order);
  currentName = `${order.no}_${TYPE_LABEL[order.type].title}`;
  showDoc(TYPE_LABEL[order.type].title + '预览');
}
function openHtml(name, html, title) {
  currentDoc = null;
  currentHtml = html;
  currentName = name;
  $('#btnRefund').style.display = 'none';
  $('#btnCopyOrder').style.display = 'none';
  $('#docTitle').textContent = title || '单据预览';
  $('#docPreview').innerHTML = html;
  $('#docModal').classList.add('show');
}
function downloadDoc() {
  if (!currentHtml) return;
  downloadBlob('\ufeff' + currentHtml, currentName + '.html', 'text/html;charset=utf-8');
  toast('已下载');
}
function printDoc() {
  if (!currentHtml) return;
  const old = $('#printFrame'); if (old) old.remove();
  const fr = document.createElement('iframe');
  fr.id = 'printFrame';
  fr.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
  fr.srcdoc = currentHtml;
  fr.onload = () => { try { fr.contentWindow.focus(); fr.contentWindow.print(); } catch (e) {} };
  document.body.appendChild(fr);
}

function openStatement() {
  $('#stFrom').value = $('#filterFrom').value || '';
  $('#stTo').value = $('#filterTo').value || today();
  $('#stmtModal').classList.add('show');
}
function makeStatement() {
  const partner = $('#stPartner').value.trim();
  if (!partner) return toast('请填写客户名称', true);
  const from = $('#stFrom').value || '', to = $('#stTo').value || '';
  const list = state.orders.filter(o =>
    (o.type === 'out' || o.type === 'refund') && (o.partner || '') === partner &&
    (!from || o.date >= from) && (!to || o.date <= to));
  if (!list.length) return toast('该客户在所选区间内没有出货记录', true);

  const rows = [];
  list.slice().sort((a, b) => (a.date < b.date ? -1 : 1)).forEach(o => {
    const sign = o.type === 'refund' ? -1 : 1;
    o.items.forEach(it => rows.push({
      date: o.date, no: o.no + (o.type === 'refund' ? '（退货）' : ''), name: it.name, spec: it.spec,
      unit: it.unit, price: it.price, qty: sign * it.qty, amount: sign * num(it.subtotal)
    }));
  });
  const stat = partnerStats().find(p => p.name === partner);
  const st = {
    partner, from: from || '全部', to: to || '全部',
    orders: list.length,
    qty: rows.reduce((s, r) => s + r.qty, 0),
    total: +rows.reduce((s, r) => s + num(r.amount), 0).toFixed(2),
    paid: num($('#stPaid').value, stat ? stat.paid : 0),
    remark: $('#stRemark').value.trim(),
    rows
  };
  openHtml(`对账单_${partner}_${today()}`, buildStmtHtml(st), '对账单预览');
  $('#stmtModal').classList.remove('show');
  toast('对账单已生成');
}

/* =========================================================
   单据记录（含批量）
   ========================================================= */
let selected = new Set();
function filteredOrders() {
  const key = ($('#filterKey').value || '').trim().toLowerCase();
  const type = $('#filterType').value;
  const settle = $('#filterSettle').value;
  const from = $('#filterFrom').value, to = $('#filterTo').value;
  return state.orders.filter(o => {
    if (type && o.type !== type) return false;
    if (settle && o.type !== 'out') return false;
    if (settle === 'done' && oweOfOrder(o) > 0.005) return false;
    if (settle === 'unpaid' && paidOf(o.no) > 0.005) return false;
    if (settle === 'part' && !(paidOf(o.no) > 0.005 && oweOfOrder(o) > 0.005)) return false;
    if (from && o.date < from) return false;
    if (to && o.date > to) return false;
    if (!key) return true;
    return (o.no + ' ' + (o.partner || '') + ' ' + (o.shipNo || '') + ' ' + (o.shipCo || '') + ' ' +
      o.items.map(i => i.name).join(' ')).toLowerCase().includes(key);
  });
}

/* 单据多了全量渲染会卡，默认只渲染最新 100 张，可按需展开 */
const REC_PAGE = 100;
let recLimit = REC_PAGE;
function renderRecords(keepLimit) {
  if (!keepLimit) recLimit = REC_PAGE;
  const all = filteredOrders();
  const list = all.slice(0, recLimit);
  $('#recordBody').innerHTML = list.length ? list.map(o => {
    const paid = paidOf(o.no), owe = oweOfOrder(o);
    const payCell = o.type === 'out'
      ? `<span class="num">${paid.toFixed(2)}</span>`
      : '<span style="color:#9aa5b8">—</span>';
    const oweCell = o.type === 'refund'
      ? `<span style="color:#0d7a45">-${num(o.total).toFixed(2)}</span>`
      : (o.type === 'out'
        ? (owe > 0.005 ? `<b style="color:#c2352f">${owe.toFixed(2)}</b>` : '<span style="color:#0d7a45">已结清</span>')
        : '<span style="color:#9aa5b8">—</span>');
    return `<tr>
      <td><input type="checkbox" data-chk="${o.id}" ${selected.has(o.id) ? 'checked' : ''}></td>
      <td><b>${o.no}</b>${o.refundOf ? `<br><span class="tip">退自 ${o.refundOf}</span>` : ''}${o.shipNo ? `<br><span class="tip">${esc(o.shipCo || '物流')} ${esc(o.shipNo)}</span>` : ''}</td>
      <td><span class="badge ${o.type}">${TYPE_LABEL[o.type].title}</span></td>
      <td>${o.date}</td>
      <td>${esc(o.partner || '-')}</td>
      <td class="num">${o.qty}</td>
      <td class="num"><b>${o.total.toFixed(2)}</b>${o.profit > 0 ? `<br><span class="profit-tag">毛利 ${o.profit.toFixed(2)}</span>` : ''}</td>
      <td class="num">${payCell}</td>
      <td class="num">${oweCell}</td>
      <td>
        <button class="link" data-view="${o.id}">查看 / 下载</button>
        ${o.type === 'out' ? `<button class="link" data-pay="${o.id}">收款</button>` : ''}
        <button class="link" data-redit="${o.id}">修改</button>
        <button class="link red" data-rdel="${o.id}">删除</button>
      </td>
    </tr>`;
  }).join('')
    : `<tr><td colspan="10" class="empty">${state.orders.length ? '没有符合筛选条件的单据' : '暂无单据记录'}</td></tr>`;

  $$('[data-chk]').forEach(c => c.onchange = () => {
    c.checked ? selected.add(c.dataset.chk) : selected.delete(c.dataset.chk);
    updateBatchBar();
  });
  const bind = (attr, fn) => $$(`[data-${attr}]`).forEach(b => b.onclick = () => {
    const o = state.orders.find(x => x.id === b.dataset[attr]);
    if (o) fn(o);
  });
  bind('view', o => openDoc(o));
  bind('pay', o => openPay(o.partner, o.no));
  bind('redit', o => editOrder(o.id));
  bind('rdel', o => removeOrder(o.id));

  const sum = t => all.filter(o => o.type === t).reduce((s, o) => s + o.total, 0);
  const prof = all.filter(o => o.type === 'out' || o.type === 'refund').reduce((s, o) => s + num(o.profit), 0);
  const oweSum = all.filter(o => o.type === 'out').reduce((s, o) => s + Math.max(0, oweOfOrder(o)), 0);
  $('#recordStat').innerHTML = `
    <span>筛选结果：<b>${all.length}</b> 张</span>
    <span>出货金额：<b style="color:#c2352f">${money(sum('out'))}</b></span>
    <span>退货金额：<b style="color:#a35c00">${money(sum('refund'))}</b></span>
    <span>入货金额：<b style="color:#0d7a45">${money(sum('in'))}</b></span>
    <span>未收金额：<b style="color:#c2352f">${money(oweSum)}</b></span>
    <span>毛利：<b style="color:#0d7a45">${money(prof)}</b></span>
    <span>全部单据：<b>${state.orders.length}</b> 张</span>`;

  const more = $('#recordMore');
  if (more) {
    if (all.length > list.length) {
      more.style.display = 'flex';
      more.innerHTML = `<span>为流畅只渲染最新 ${list.length} 张（共 ${all.length} 张）</span>
        <button class="btn ghost sm" id="btnRecMore">再显示 ${Math.min(REC_PAGE, all.length - list.length)} 张</button>
        <button class="btn ghost sm" id="btnRecAll">显示全部</button>`;
      $('#btnRecMore').onclick = () => { recLimit += REC_PAGE; renderRecords(true); };
      $('#btnRecAll').onclick = () => { recLimit = all.length; renderRecords(true); };
    } else more.style.display = 'none';
  }
  labelCells('#page-records table.grid');
  updateBatchBar();
}
function updateBatchBar() {
  const bar = $('#batchBar');
  if (!bar) return;
  bar.style.display = selected.size ? 'flex' : 'none';
  $('#batchInfo').textContent = `已选 ${selected.size} 张`;
  const all = $('#chkAll');
  if (all) {
    const ids = filteredOrders().map(o => o.id);
    all.checked = ids.length > 0 && ids.every(i => selected.has(i));
  }
}
function removeOrder(id) {
  const o = state.orders.find(x => x.id === id);
  if (!o) return;
  /* 这张单收过钱的话，只删单据会把收款留成孤儿、欠款变负数，所以连着一起处理 */
  const pays = state.payments.filter(p => p.no === o.no);
  const paid = pays.reduce((s, p) => s + num(p.amount), 0);
  let msg = `删除单号 ${o.no}？系统会同步还原库存。`;
  if (paid > 0) msg += `\n\n⚠ 这张单已经收过 ${paid.toFixed(2)} 元（${pays.length} 笔）。\n` +
    `删除单据的同时，这 ${pays.length} 笔收款也会一并删掉，两边账才能平。\n` +
    `（如果你想把这笔钱留作预收款，请点「取消」别删这张单。）`;
  if (!confirm(msg)) return;
  snapshot();
  o.items.forEach(it => {
    const p = state.products.find(x => x.id === it.pid);
    if (!p) return;
    const before = p.stock;
    const delta = o.type === 'out' ? it.qty : (o.type === 'refund' ? -it.qty : -it.qty);
    p.stock = +(p.stock + delta).toFixed(4);
    logStock(p, before, delta, '单据删除', o.no);
  });
  state.orders = state.orders.filter(x => x.id !== id);
  if (pays.length) state.payments = state.payments.filter(p => !pays.some(x => x.id === p.id));
  selected.delete(id);
  save(); renderRecords(); renderProducts(); renderSelects(); renderDash(); renderLogs(); renderPartners();
  toast(paid > 0 ? `单据已删除，库存已还原，同时撤销了 ${pays.length} 笔收款` : '单据已删除，库存已还原');
}

const EXP_HEAD = ['单号', '类型', '日期', '往来单位', '物流公司', '运单号', '商品名称', '规格', '单位', '成本价', '单价', '数量', '小计', '毛利', '整单合计', '已收', '备注'];
function orderRows(list) {
  const rows = [];
  list.forEach(o => o.items.forEach(it => rows.push([
    o.no, TYPE_LABEL[o.type].title, o.date, o.partner || '', o.shipCo || '', o.shipNo || '',
    it.name, it.spec || '',
    it.unit || '', num(it.cost).toFixed(2), num(it.price).toFixed(2), it.qty,
    num(it.subtotal).toFixed(2), num(it.profit).toFixed(2), num(o.total).toFixed(2),
    o.type === 'out' ? paidOf(o.no).toFixed(2) : '', o.remark || ''
  ])));
  return rows;
}
function exportCsv(list, head, rows, name) {
  if (!list.length) return toast('当前没有可导出的记录', true);
  const csv = [head || EXP_HEAD, ...(rows || orderRows(list))]
    .map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  downloadBlob('\ufeff' + csv, (name || '单据明细_' + today()) + '.csv', 'text/csv;charset=utf-8');
  toast('CSV 已导出');
}
function exportRecordsXls(list) {
  if (!list.length) return toast('当前没有可导出的单据', true);
  exportXls('单据明细', EXP_HEAD, orderRows(list), `单据明细_${today()}`);
}

/* =========================================================
   往来单位 + 收款
   ========================================================= */
function renderPartners() {
  const key = ($('#searchPartner').value || '').trim().toLowerCase();
  const kind = $('#partnerKind').value;
  let list = partnerStats();
  if (key) list = list.filter(p => p.name.toLowerCase().includes(key));
  if (kind === 'owe') list = list.filter(p => p.owe > 0.005);
  if (kind === 'customer') list = list.filter(p => p.isCustomer);
  if (kind === 'supplier') list = list.filter(p => p.isSupplier);
  list.sort((a, b) => b.owe - a.owe || b.sale - a.sale);

  $('#partnerBody').innerHTML = list.length ? list.map(p => `
    <tr>
      <td><b>${esc(p.name)}</b> ${p.isCustomer ? '<span class="badge out">客户</span>' : ''} ${p.isSupplier ? '<span class="badge in">供应商</span>' : ''}</td>
      <td class="num">${p.sale.toFixed(2)}</td>
      <td class="num">${p.refund ? p.refund.toFixed(2) : '0.00'}</td>
      <td class="num">${p.buy ? p.buy.toFixed(2) : '0.00'}</td>
      <td class="num">${p.paid.toFixed(2)}</td>
      <td class="num"><b style="color:${p.owe > 0.005 ? '#c2352f' : (p.owe < -0.005 ? '#0d7a45' : 'inherit')}">${p.owe.toFixed(2)}</b></td>
      <td class="num">${p.orders}</td>
      <td>${p.last || '-'}</td>
      <td>
        <button class="link" data-punit="${esc(p.name)}">明细</button>
        <button class="link" data-ppay="${esc(p.name)}">收款</button>
        <button class="link" data-pstmt="${esc(p.name)}">对账</button>
        <button class="link" data-prename="${esc(p.name)}">改名</button>
      </td>
    </tr>`).join('')
    : `<tr><td colspan="9" class="empty">${state.orders.length || state.payments.length ? '没有符合条件的单位' : '还没有往来单位，开单时填写客户名称即可自动生成'}</td></tr>`;

  $$('[data-prename]').forEach(b => b.onclick = () => openRename(b.dataset.prename));
  $$('[data-punit]').forEach(b => b.onclick = () => gotoUnit(b.dataset.punit));
  $$('[data-ppay]').forEach(b => b.onclick = () => openPay(b.dataset.ppay));
  $$('[data-pstmt]').forEach(b => b.onclick = () => {
    $('#stPartner').value = b.dataset.pstmt;
    $('#stFrom').value = ''; $('#stTo').value = today();
    $('#stPaid').value = ''; $('#stRemark').value = '';
    makeStatement();
  });

  const owe = list.reduce((s, p) => s + Math.max(0, p.owe), 0);
  const paid = list.reduce((s, p) => s + p.paid, 0);
  $('#partnerStat').innerHTML = `
    <span>单位数：<b>${list.length}</b></span>
    <span>出货总额：<b>${money(list.reduce((s, p) => s + p.sale, 0))}</b></span>
    <span>已收总额：<b style="color:#0d7a45">${money(paid)}</b></span>
    <span>未收总额：<b style="color:#c2352f">${money(owe)}</b></span>`;
  labelCells('#page-partners table.grid');

  // 收款记录
  $('#payBody').innerHTML = state.payments.length ? state.payments.slice(0, 200).map(p => `
    <tr>
      <td>${p.date}</td>
      <td><b>${esc(p.partner)}</b></td>
      <td class="num"><b>${num(p.amount).toFixed(2)}</b></td>
      <td>${esc(p.method || '-')}</td>
      <td style="color:#5c6a80;font-family:ui-monospace,Consolas,monospace">${esc(p.no || '-')}</td>
      <td style="color:#5c6a80">${esc(p.remark || '-')}</td>
      <td>
        <button class="link" data-prec="${p.id}">收据</button>
        <button class="link red" data-pdel="${p.id}">删除</button>
      </td>
    </tr>`).join('')
    : `<tr><td colspan="7" class="empty">还没有收款记录</td></tr>`;
  $$('[data-prec]').forEach(b => b.onclick = () => openReceipt(b.dataset.prec));
  $$('[data-pdel]').forEach(b => b.onclick = () => {
    const p = state.payments.find(x => x.id === b.dataset.pdel);
    if (!p) return;
    if (!confirm(`删除这笔收款（${p.partner} ${num(p.amount).toFixed(2)} 元）？欠款会相应恢复。`)) return;
    state.payments = state.payments.filter(x => x.id !== p.id);
    save(); renderPartners(); renderRecords(); renderDash();
    toast('收款记录已删除');
  });
  labelCells('#page-partners .card:last-child table.grid');
}

/* ---------- 往来单位：改名 / 合并 ----------
   单位名打错一个字就会拆成两家账，以前没法补救，只能重开单据。
   改名 = 新名字没人用；合并 = 新名字已存在，两家的单据和收款并到一家。 */
function openRename(name) {
  const all = partnerStats();          /* 只算一次，单据多时别重复全量扫 */
  $('#rnOld').value = name;
  $('#rnNew').value = name;
  $('#unitList').innerHTML = all
    .filter(p => p.name !== name)
    .map(p => `<option value="${esc(p.name)}"></option>`).join('');
  const s = all.find(p => p.name === name) || { orders: 0, owe: 0 };
  const pays = state.payments.filter(p => (p.partner || '').trim() === name).length;
  $('#rnInfo').innerHTML =
    `这个单位现有 <b>${s.orders}</b> 张单据、<b>${pays}</b> 笔收款，欠款 <b>${num(s.owe).toFixed(2)}</b> 元。<br>` +
    `改成没人用过的名字 = 单纯改名；填成一个已有单位的名字 = 两家合并成一家，欠款合并计算。<br>` +
    `<span style="color:#a35c00">历史单据的单位名会跟着变，之前打印出去的单子可能对不上。操作前已自动留快照，万一合错了可以去设置页回滚。</span>`;
  $('#renameModal').classList.add('show');
  setTimeout(() => { const el = $('#rnNew'); el.focus(); el.select(); }, 50);
}
function applyRename() {
  const oldName = $('#rnOld').value;
  const newName = $('#rnNew').value.trim();
  if (!newName) return toast('请填写新的单位名称', true);
  if (newName === oldName) return toast('名称没有变化', true);

  const orders = state.orders.filter(o => (o.partner || '').trim() === oldName);
  const pays = state.payments.filter(p => (p.partner || '').trim() === oldName);
  const merge = partnerStats().some(p => p.name === newName);
  const msg = merge
    ? `「${oldName}」的 ${orders.length} 张单据、${pays.length} 笔收款，将全部挂到「${newName}」名下。\n` +
      `两家的账会合并成一家，之后没法自动拆开。\n\n确定合并吗？`
    : `把「${oldName}」改名为「${newName}」？\n将同步修改 ${orders.length} 张单据、${pays.length} 笔收款上的单位名称。`;
  if (!confirm(msg)) return;

  snapshot();
  orders.forEach(o => o.partner = newName);
  pays.forEach(p => p.partner = newName);
  save();
  renderPartners(); renderRecords(); renderDash(); renderSelects();
  $('#renameModal').classList.remove('show');
  toast(merge ? `已合并到「${newName}」` : `已改名为「${newName}」`);
}

function gotoUnit(name) {
  $('#filterKey').value = name;
  $('#filterType').value = '';
  $('#filterSettle').value = '';
  switchPage('records');
  renderRecords();
}

function openPay(partner, no) {
  $('#pyPartner').value = partner || '';
  $('#pyNo').value = no || '';
  $('#pyAmount').value = '';
  $('#pyDate').value = today();
  $('#pyRemark').value = '';
  updatePayHint();
  $('#payModal').classList.add('show');
  setTimeout(() => $('#pyAmount').focus(), 50);
}
/* 本次最多能收多少：指定了单号就按该单尚欠，否则按该单位总欠款 */
function payCap(partner, no) {
  const o = (no || '') ? state.orders.find(x => x.no === no) : null;
  if (o) return { cap: Math.max(0, oweOfOrder(o)), label: `单 ${o.no} 尚欠` };
  const stat = partnerStats().find(p => p.name === (partner || '').trim());
  if (stat) return { cap: Math.max(0, stat.owe), label: `「${stat.name}」共欠` };
  return null;
}
function updatePayHint() {
  const name = ($('#pyPartner').value || '').trim();
  const stat = partnerStats().find(p => p.name === name);
  const no = ($('#pyNo').value || '').trim();
  let txt = '';
  if (stat) txt += `「${esc(name)}」当前欠款 <b>${stat.owe.toFixed(2)}</b> 元（出货 ${stat.sale.toFixed(2)} − 退货 ${stat.refund.toFixed(2)} − 已收 ${stat.paid.toFixed(2)}）`;
  else if (name) txt += '该单位暂无往来记录。';
  if (no) {
    const o = state.orders.find(x => x.no === no);
    if (o) txt += `　|　单 ${no} 应收 ${num(o.total).toFixed(2)}，已收 ${paidOf(no).toFixed(2)}，尚欠 <b>${oweOfOrder(o).toFixed(2)}</b>`;
    else txt += `　|　未找到单号 ${esc(no)}`;
  }
  const cap = payCap(name, no);
  const amtEl = $('#pyAmount');
  if (cap) {
    if (amtEl) { amtEl.max = cap.cap.toFixed(2); amtEl.classList.remove('invalid'); }
    txt += `<br>本次最多可收 <b style="color:#0d7a45">${cap.cap.toFixed(2)}</b> 元（${cap.label} ${cap.cap.toFixed(2)}），超出无法保存。`;
  } else if (name) {
    txt += `<br><span style="color:#c2352f">该单位目前没有欠款，不能登记收款。</span>`;
  }
  $('#payHint').innerHTML = txt;
}
function savePay() {
  const partner = $('#pyPartner').value.trim();
  const amount = num($('#pyAmount').value, NaN);
  const no = $('#pyNo').value.trim();
  if (!partner) return toast('请填写往来单位', true);
  if (!isFinite(amount) || amount <= 0) return toast('收款金额必须大于 0', true);
  /* 不能多收：最多收到处方/欠款上限，避免账上出现负数欠款 */
  const cap = payCap(partner, no);
  if (!cap) return toast(`「${partner}」目前没有欠款，不能登记收款。`, true);
  if (amount > cap.cap + 0.005) {
    const el = $('#pyAmount');
    if (el) { el.classList.add('invalid'); el.focus(); el.oninput = () => el.classList.remove('invalid'); }
    return toast(`最多只能收 ${cap.cap.toFixed(2)} 元（${cap.label} ${cap.cap.toFixed(2)}），你填了 ${amount.toFixed(2)}，多出 ${(amount - cap.cap).toFixed(2)} 元`, true);
  }
  state.payments.unshift({
    id: uid(), ts: Date.now(),
    date: $('#pyDate').value || today(),
    partner, amount: +amount.toFixed(2),
    method: $('#pyMethod').value,
    no,
    remark: $('#pyRemark').value.trim()
  });
  save();
  renderPartners(); renderRecords(); renderDash();
  $('#payModal').classList.remove('show');
  toast(`已登记收款 ${amount.toFixed(2)} 元`);
}

/* =========================================================
   库存流水
   ========================================================= */
const LOG_PAGE = 300;
let logLimit = LOG_PAGE;
function renderLogs(keepLimit) {
  if (!keepLimit) logLimit = LOG_PAGE;
  const sel = $('#logProduct'), kind = $('#logKind').value;
  const from = $('#logFrom').value, to = $('#logTo').value;
  const pid = sel.value;
  sel.innerHTML = '<option value="">全部商品</option>' +
    state.products.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  if (pid && state.products.some(p => p.id === pid)) sel.value = pid;

  const all = state.logs.filter(l => {
    if (pid && l.pid !== pid) return false;
    if (kind === 'in' && l.delta <= 0) return false;
    if (kind === 'out' && l.delta >= 0) return false;
    if (from && l.date < from) return false;
    if (to && l.date > to) return false;
    return true;
  });
  const list = all.slice(0, logLimit);

  $('#logBody').innerHTML = list.length ? list.map(l => `
    <tr>
      <td style="color:#5c6a80">${nowText(l.ts)}</td>
      <td><b>${esc(l.name)}</b></td>
      <td>${esc(l.src)}</td>
      <td style="color:#5c6a80;font-family:ui-monospace,Consolas,monospace">${esc(l.no || '-')}</td>
      <td class="num">${l.before}</td>
      <td class="num" style="color:${l.delta > 0 ? '#0d7a45' : '#c2352f'};font-weight:700">${l.delta > 0 ? '+' : ''}${l.delta}</td>
      <td class="num"><b>${l.after}</b></td>
    </tr>`).join('')
    : `<tr><td colspan="7" class="empty">${state.logs.length ? '没有符合条件的流水' : '暂无库存变动记录'}</td></tr>`;

  const inSum = all.filter(l => l.delta > 0).reduce((s, l) => s + l.delta, 0);
  const outSum = all.filter(l => l.delta < 0).reduce((s, l) => s - l.delta, 0);
  $('#logStat').innerHTML = `
    <span>显示：<b>${list.length}</b> 条</span>
    <span>累计入库：<b style="color:#0d7a45">${+inSum.toFixed(2)}</b></span>
    <span>累计出库：<b style="color:#c2352f">${+outSum.toFixed(2)}</b></span>
    <span>流水总数：<b>${state.logs.length}</b> 条（最多保留 ${LOG_MAX} 条）</span>`;
  const more = $('#logMore');
  if (more) {
    if (all.length > list.length) {
      more.style.display = 'flex';
      more.innerHTML = `<span>为流畅只渲染最新 ${list.length} 条（共 ${all.length} 条）</span>
        <button class="btn ghost sm" id="btnLogMore">再显示 ${Math.min(LOG_PAGE, all.length - list.length)} 条</button>
        <button class="btn ghost sm" id="btnLogAll">显示全部</button>`;
      $('#btnLogMore').onclick = () => { logLimit += LOG_PAGE; renderLogs(true); };
      $('#btnLogAll').onclick = () => { logLimit = all.length; renderLogs(true); };
    } else more.style.display = 'none';
  }
  labelCells('#page-logs table.grid');
}
function exportLogsCsv() {
  const rows = state.logs.map(l => [nowText(l.ts), l.name, l.src, l.no || '', l.before, l.delta, l.after]);
  exportCsv(state.logs, ['时间', '商品', '来源', '关联单号', '变动前', '变动量', '变动后'], rows, `库存流水_${today()}`);
}

/* =========================================================
   备份 / 恢复（支持合并） / 设置 / 快照
   ========================================================= */
function downloadBlob(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}
function backup() {
  downloadBlob(JSON.stringify(state, null, 2), `出单入单_备份_${today()}.json`, 'application/json');
  state.settings.lastBackup = Date.now();
  save(); renderBackupTip(); renderDash();
  toast('备份文件已下载');
}
/* 距上次备份天数；从未备份返回 null */
function backupAge() {
  const t = num(state.settings.lastBackup);
  if (!t) return null;
  return Math.floor((Date.now() - t) / 86400000);
}
function renderBackupTip() {
  const el = $('#backupTip');
  if (!el) return;
  const d = backupAge();
  if (d === null) {
    el.innerHTML = '<b style="color:#a35c00">还没备份过</b>　数据只存在这台电脑的浏览器里，清缓存或换电脑就没了，建议现在备份一次。';
  } else if (d >= 7) {
    el.innerHTML = `<b style="color:#c2352f">距上次备份已 ${d} 天</b>　${state.orders.length} 张单据、${state.products.length} 个商品存在丢失风险，建议现在备份。`;
  } else {
    el.innerHTML = `上次备份：${nowText(state.settings.lastBackup)}（${d === 0 ? '今天' : d + ' 天前'}）`;
  }
}
function mergeState(d) {
  let addP = 0, updP = 0, addO = 0, addPay = 0;
  (d.products || []).forEach(p => {
    const exist = (p.code && state.products.find(x => (x.code || '').toLowerCase() === p.code.toLowerCase()))
               || state.products.find(x => x.name === p.name);
    if (exist) { Object.assign(exist, p, { id: exist.id }); updP++; }
    else { state.products.push(p); addP++; }
  });
  const nos = new Set(state.orders.map(o => o.no));
  (d.orders || []).forEach(o => { if (!nos.has(o.no)) { state.orders.push(o); addO++; } });
  const pids = new Set(state.payments.map(p => p.id));
  (d.payments || []).forEach(p => { if (!pids.has(p.id)) { state.payments.push(p); addPay++; } });
  (d.logs || []).forEach(l => state.logs.push(l));
  state.logs.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  if (state.logs.length > LOG_MAX) state.logs.length = LOG_MAX;
  ['out', 'in', 'refund'].forEach(k => state.seq[k] = Math.max(num(state.seq[k]), num((d.seq || {})[k])));
  state.orders.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  toast(`已合并：新增商品 ${addP}、更新 ${updP}、新增单据 ${addO}、新增收款 ${addPay}`);
}
function restore(file) {
  const r = new FileReader();
  r.onload = () => {
    try {
      const d = JSON.parse(r.result);
      if (!d || !Array.isArray(d.products)) throw new Error('bad');
      const replace = confirm('点「确定」= 用备份覆盖现有数据\n点「取消」= 与现有数据合并（同货号商品更新、同单号单据跳过）');
      if (replace) {
        state = Object.assign(defaultState(), d, {
          settings: Object.assign(defaultState().settings, d.settings || {}),
          seq: Object.assign({ out: 0, in: 0, refund: 0 }, d.seq || {}),
          logs: Array.isArray(d.logs) ? d.logs : [],
          payments: Array.isArray(d.payments) ? d.payments : []
        });
      } else mergeState(d);
      save(); boot(); toast(replace ? '数据已导入' : '数据已合并');
    } catch (e) { toast('文件格式不正确，导入失败', true); }
  };
  r.readAsText(file);
}
function snapText() {
  try {
    const s = JSON.parse(localStorage.getItem(LS_SNAP) || 'null');
    $('#snapInfo').textContent = s
      ? `当前快照时间：${nowText(s.ts)}（自动快照约每 30 分钟更新一次，误删误改可回滚到此状态）`
      : '还没有创建过快照。建议现在点「立即创建快照」，后续误操作可一键回滚。';
  } catch (e) { $('#snapInfo').textContent = '快照状态读取失败。'; }
}
function makeSnapshot() {
  localStorage.setItem(LS_SNAP, JSON.stringify({ ts: Date.now(), data: JSON.stringify(state) }));
  snapText(); toast('快照已创建');
}
function rollback() {
  let s = null;
  try { s = JSON.parse(localStorage.getItem(LS_SNAP) || 'null'); } catch (e) {}
  if (!s) return toast('还没有快照可回滚', true);
  if (!confirm(`回滚到 ${nowText(s.ts)} 的快照？\n当前数据会被替换，建议先备份。`)) return;
  try {
    const d = JSON.parse(s.data);
    if (!d || !Array.isArray(d.products)) throw new Error('bad');
    state = Object.assign(defaultState(), d, {
      settings: Object.assign(defaultState().settings, d.settings || {}),
      seq: Object.assign({ out: 0, in: 0, refund: 0 }, d.seq || {}),
      logs: Array.isArray(d.logs) ? d.logs : [],
      payments: Array.isArray(d.payments) ? d.payments : []
    });
    save(); boot(); toast('已回滚到快照');
  } catch (e) { toast('快照损坏，回滚失败', true); }
}
function fillSettings() {
  const s = state.settings;
  $('#setCompany').value = s.company || '';
  $('#setContact').value = s.contact || '';
  $('#setPhone').value = s.phone || '';
  $('#setAddress').value = s.address || '';
  $('#setWarn').value = s.warn ?? 10;
  $('#setFooter').value = s.footer || '';
  $('#setDocCode').checked = !!s.docCode;
  $('#setDocCost').checked = !!s.docCost;
  $('#setDocSign').checked = s.docSign !== false;
  $('#setDocShip').checked = s.docShip !== false;
  $('#setPriceMem').checked = s.priceMemory !== false;
  snapText();
  renderBackupTip();
}

/* ---------- 复制单据：把旧单内容变成新草稿 ---------- */
function copyOrder() {
  const o = currentDoc;
  if (!o || o.type === 'refund') return;
  const t = o.type;
  if (state.drafts[t] && state.drafts[t].length &&
      !confirm(`当前${TYPE_LABEL[t].title}草稿里有 ${state.drafts[t].length} 行未提交的内容，复制会覆盖它，继续？`)) return;
  state.drafts[t] = o.items.map(it => ({
    pid: it.pid, name: it.name, spec: it.spec, unit: it.unit,
    price: it.price, cost: costOf(state.products.find(p => p.id === it.pid)), qty: it.qty
  }));
  $(`#${t}-partner`).value = o.partner || '';
  $(`#${t}-tel`).value = o.tel || '';
  $(`#${t}-account`).value = o.account || '';
  $(`#${t}-remark`).value = '';
  ['shipco', 'shipno'].forEach(k => { const el = $(`#${t}-${k}`); if (el) el.value = o[k === 'shipco' ? 'shipCo' : 'shipNo'] || ''; });
  $(`#${t}-discount`).value = o.discount || 0;
  $(`#${t}-extra`).value = o.extra || 0;
  $(`#${t}-date`).value = today();
  save(); renderItems(t); renderQuick(t); switchPage(t);
  $('#docModal').classList.remove('show');
  toast(`已复制为新的${TYPE_LABEL[t].title}草稿，核对后生成`);
}

/* ---------- 批量打印：多张单据合成一个可连续打印的文件 ---------- */
function buildBatchHtml(list) {
  const body = list.map((o, i) => {
    const full = buildDocHtml(o);
    const inner = full.slice(full.indexOf('<body>') + 6, full.lastIndexOf('</body>'));
    return `<div class="paper"${i < list.length - 1 ? ' style="page-break-after:always"' : ''}>${inner}</div>`;
  }).join('\n');
  return docShell(`批量单据_${today()}_${list.length}张`, body,
    '\n.paper{padding:0;margin-bottom:10mm}\n');
}

/* ---------- 常用商品快捷区 ---------- */
function renderQuick(type) {
  const el = $(`#${type}-quick`); if (!el) return;
  const counter = new Map();
  state.orders.filter(o => o.type === type).slice(0, 50).forEach(o =>
    o.items.forEach(it => {
      if (!state.products.some(p => p.id === it.pid)) return;
      const c = counter.get(it.pid) || { n: 0, ...it };
      c.n++; counter.set(it.pid, c);
    }));
  const list = [...counter.values()].sort((a, b) => b.n - a.n).slice(0, 8);
  el.innerHTML = list.length
    ? '<span class="tip" style="margin:0">常用：</span>' +
      list.map(c => `<button class="qk" data-qk="${c.pid}">${esc(c.name)}</button>`).join('')
    : '';
  $$('[data-qk]', el).forEach(b => b.onclick = () => {
    const p = state.products.find(x => x.id === b.dataset.qk);
    if (!p) return;
    addToDraft(type, p, 1, p.price);
    renderItems(type);
    toast(`已加入：${p.name} ×1`);
  });
}

/* ---------- 商品导出（导出 → Excel 改价 → 导入，形成闭环） ---------- */
function exportProducts() {
  if (!state.products.length) return toast('还没有商品可导出', true);
  downloadBlob('\ufeff' + ['货号,名称,规格,分类,单位,成本价,单价,库存,备注',
    ...state.products.map(p => [
      p.code || '', p.name, p.spec || '', p.cate || '', p.unit || '',
      num(p.cost).toFixed(2), p.price.toFixed(2), p.stock, p.note || ''
    ].map(c => `"${String(c).replace(/"/g, '""')}"`).join(','))].join('\r\n'),
    `商品表_${today()}.csv`, 'text/csv;charset=utf-8');
  toast('商品表已导出，可在 Excel 里改价后批量导入回来');
}

/* ---------- 库存盘点 ---------- */
let stkDraft = {};
const isoDate = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function openStocktake() {
  if (!state.products.length) return toast('还没有商品，先去添加或导入', true);
  stkDraft = {};
  $('#stkSearch').value = '';
  renderStocktake();
  $('#stockModal').classList.add('show');
}
function renderStocktake() {
  const key = ($('#stkSearch').value || '').trim().toLowerCase();
  const list = state.products.filter(p => !p.disabled &&
    (!key || ((p.code || '') + ' ' + p.name + ' ' + (p.spec || '')).toLowerCase().includes(key)));
  const diffOf = (p, v) => (v === '' || v === undefined) ? null : +(num(v) - p.stock).toFixed(4);
  $('#stkBody').innerHTML = list.length ? list.map(p => {
    const d = diffOf(p, stkDraft[p.id]);
    return `<tr>
      <td><b>${esc(p.name)}</b>${p.code ? `　<span class="tip" style="margin:0">${esc(p.code)}</span>` : ''}${p.spec ? `<br><span class="tip">${esc(p.spec)}</span>` : ''}</td>
      <td>${esc(p.unit || '-')}</td>
      <td class="num">${p.stock}</td>
      <td class="num"><input class="cell-input" data-stk="${p.id}" type="number" step="any" min="0" placeholder="未盘" value="${stkDraft[p.id] ?? ''}"></td>
      <td class="num stk-diff" style="font-weight:700;color:${d === null ? '' : (d > 0 ? '#0d7a45' : d < 0 ? '#c2352f' : '')}">${d === null ? '' : (d > 0 ? '+' : '') + d}</td>
    </tr>`;
  }).join('') : `<tr><td colspan="5" class="empty">${state.products.length ? '没有匹配的商品' : '还没有商品'}</td></tr>`;

  $$('[data-stk]', $('#stkBody')).forEach(el => el.oninput = () => {
    stkDraft[el.dataset.stk] = el.value;
    const p = state.products.find(x => x.id === el.dataset.stk);
    if (!p) return;
    const d = diffOf(p, el.value);
    const cell = $('.stk-diff', el.closest('tr'));
    cell.textContent = d === null ? '' : (d > 0 ? '+' : '') + d;
    cell.style.color = d === null ? '' : (d > 0 ? '#0d7a45' : d < 0 ? '#c2352f' : '');
    updateStkStat();
  });
  updateStkStat();
}
function updateStkStat() {
  let changed = 0, plusVal = 0, minusVal = 0;
  Object.entries(stkDraft).forEach(([pid, v]) => {
    if (v === '' || v === undefined) return;
    const p = state.products.find(x => x.id === pid);
    if (!p) return;
    const d = num(v) - p.stock;
    if (Math.abs(d) < 1e-9) return;
    changed++;
    if (d > 0) plusVal += d * num(p.price); else minusVal += -d * num(p.price);
  });
  const filled = Object.values(stkDraft).filter(v => v !== '' && v !== undefined).length;
  $('#stkCount').textContent = `已填 ${filled} / ${state.products.filter(p => !p.disabled).length} 项`;
  $('#stkStat').innerHTML = `
    <span>存在差异：<b>${changed}</b> 项</span>
    <span>盘盈金额：<b style="color:#0d7a45">${money(plusVal)}</b></span>
    <span>盘亏金额：<b style="color:#c2352f">${money(minusVal)}</b></span>
    <span>净差异：<b>${money(plusVal - minusVal)}</b></span>`;
}
function applyStocktake() {
  const changes = [];
  Object.entries(stkDraft).forEach(([pid, v]) => {
    if (v === '' || v === undefined) return;
    const p = state.products.find(x => x.id === pid);
    if (!p) return;
    const real = num(v);
    const d = +(real - p.stock).toFixed(4);
    if (Math.abs(d) < 1e-9) return;
    changes.push({ p, real, d });
  });
  if (!changes.length) return toast('填写的实际库存与账面一致，或还没有填写', true);
  const plus = changes.filter(c => c.d > 0).length, minus = changes.length - plus;
  if (!confirm(`将调整 ${changes.length} 个商品（盘盈 ${plus} / 盘亏 ${minus}），差额记入库存流水可查。\n确定按实际库存调整？`)) return;
  changes.forEach(({ p, real, d }) => {
    const before = p.stock;
    p.stock = +real.toFixed(4);
    logStock(p, before, d, '盘点调整', '');
  });
  save();
  $('#stockModal').classList.remove('show');
  renderProducts(); renderSelects(); renderDash(); renderLogs();
  toast(`已按实际库存调整 ${changes.length} 个商品`);
}
function exportStocktake() {
  const list = state.products.filter(p => !p.disabled);
  if (!list.length) return toast('还没有商品可盘点', true);
  const rows = [['货号', '名称', '规格', '单位', '账面数', '实盘数', '差异']];
  list.forEach(p => {
    const v = stkDraft[p.id] ?? '';
    rows.push([p.code || '', p.name, p.spec || '', p.unit || '', p.stock, v,
      v === '' ? '' : +(num(v) - p.stock).toFixed(4)]);
  });
  const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  downloadBlob('\ufeff' + csv, `库存盘点表_${today()}.csv`, 'text/csv;charset=utf-8');
  toast('盘点表已导出（可在纸上填好再录入）');
}

/* ---------- 月度报表导出 ---------- */
function exportReport() {
  const mon = ($('#dashReport') && $('#dashReport').dataset.mon) || today().slice(0, 7);
  const d = monthData(mon);
  exportXls('月度报表', ['项目', '数值'], [
    ['统计月份', mon],
    ['销售额', d.sale.toFixed(2)],
    ['退货额', d.refund.toFixed(2)],
    ['净销售额', d.net.toFixed(2)],
    ['销售成本', d.cost.toFixed(2)],
    ['毛利', d.profit.toFixed(2)],
    ['毛利率', d.net ? d.rate.toFixed(1) + '%' : '-'],
    ['采购入库额', d.buy.toFixed(2)],
    ['当月收款', d.paid.toFixed(2)],
    ['期末未收款', d.owe.toFixed(2)],
    ['单据数', d.orders + ' 张']
  ], `经营报表_${mon}`);
}

/* ---------- 数据体检与修复 ---------- */
function healthCheck() {
  const issues = [];
  // 1 重复单号
  const noCount = new Map();
  state.orders.forEach(o => noCount.set(o.no, (noCount.get(o.no) || 0) + 1));
  const dup = [...noCount.entries()].filter(([, n]) => n > 1);
  if (dup.length) issues.push({ key: 'dup', text: `重复单号 ${dup.length} 组：${dup.slice(0, 3).map(([no]) => no).join('、')}` });
  // 2 单据引用了已删除商品
  let orphanItems = 0;
  state.orders.forEach(o => o.items.forEach(it => { if (it.pid && !state.products.some(p => p.id === it.pid)) orphanItems++; }));
  if (orphanItems) issues.push({ key: 'orphan', text: `${orphanItems} 条明细引用了已被删除的商品（历史记录不受影响，属正常）` });
  // 3 库存与流水不一致
  const drift = [];
  state.products.forEach(p => {
    const sumDelta = state.logs.filter(l => l.pid === p.id).reduce((s, l) => s + num(l.delta), 0);
    if (Math.abs(num(sumDelta) - num(p.stock)) > 0.005) drift.push({ p, should: sumDelta });
  });
  if (drift.length) issues.push({ key: 'drift', text: `${drift.length} 个商品的库存与流水记录对不上（可能被手动改过或流水被清过）` });
  // 4 收款指向不存在的单号
  const badPay = state.payments.filter(p => p.no && !state.orders.some(o => o.no === p.no));
  if (badPay.length) issues.push({ key: 'pay', text: `${badPay.length} 笔收款关联的单号已不存在（金额仍计入欠款抵扣，单据被删时会连同清理）` });
  // 4.5 疑似同一家单位被拆成多个（名字只差标点/空格，或一个是另一个的前缀）
  const units = partnerStats().map(p => p.name).filter(n => n && n !== '（未填写单位）');
  const norm = n => n.replace(/[\s（）()·、,，.。\-_/]/g, '');
  const suspects = [];
  for (let i = 0; i < units.length; i++) {
    for (let j = i + 1; j < units.length; j++) {
      const a = norm(units[i]), b = norm(units[j]);
      if (!a || !b) continue;
      if (a === b || (a.length >= 3 && b.length >= 3 && (a.startsWith(b) || b.startsWith(a)))) {
        suspects.push(`${units[i]} ≈ ${units[j]}`);
      }
    }
  }
  if (suspects.length) issues.push({ key: 'unit', text: `有 ${suspects.length} 组单位名称看起来是同一家：${suspects.slice(0, 3).join('；')}\n   姓名/店名打错一个字就会拆成两本账、欠款各算各的。去「往来单位」页点「改名」可合并。` });
  // 5 容量
  let kb = 0;
  try { kb = Math.round(new Blob([JSON.stringify(state)]).size / 1024); } catch (e) {}
  const cap = kb > 4000 ? `\n⚠ 数据量已达 ${kb} KB，接近浏览器 5MB 上限，建议清理历史单据或流水` : `当前数据量：${kb} KB`;

  let msg = issues.length ? issues.map((x, i) => `${i + 1}. ${x.text}`).join('\n') : '未发现异常，数据健康。';
  msg += `\n\n${cap}`;
  if (drift.length && confirm(msg + '\n\n是否按库存流水重算这些商品的库存？')) {
    drift.forEach(({ p, should }) => {
      const before = p.stock;
      p.stock = +num(should).toFixed(4);
      logStock(p, before, p.stock - before, '数据修复', '');
    });
    save(); renderProducts(); renderSelects(); renderDash(); renderLogs();
    toast(`已修复 ${drift.length} 个商品的库存`);
  } else {
    alert(msg);
  }
}

/* =========================================================
   初始化
   ========================================================= */
function switchPage(page) {
  $$('.tab').forEach(x => x.classList.toggle('active', x.dataset.page === page));
  $$('.page').forEach(x => x.classList.toggle('active', x.id === `page-${page}`));
  if (window.scrollTo) window.scrollTo({ top: 0, behavior: 'smooth' });
}
function boot() {
  $('#page-out').innerHTML = billTemplate('out');
  $('#page-in').innerHTML = billTemplate('in');
  ['out', 'in'].forEach(type => {
    $(`#${type}-no`).value = nextNo(type);
    $(`#${type}-date`).value = today();
    bindBill(type);
    renderItems(type);
  });
  renderSelects();
  renderProducts();
  renderRecords();
  renderPartners();
  renderLogs();
  renderDash();
  fillSettings();
  maybeRecover();
}

/* 数据被清空（换浏览器 / 清缓存）但有快照时，提示一键恢复 */
let recoverAsked = false;
function maybeRecover() {
  if (recoverAsked) return;                                    // 每次打开只问一次，避免递归
  if (state.products.length || state.orders.length || state.payments.length) return;
  let snap = null;
  try { snap = JSON.parse(localStorage.getItem(LS_SNAP) || 'null'); } catch (e) {}
  if (!snap) return;
  try {
    const d = JSON.parse(snap.data);
    if (!d || !Array.isArray(d.products)) return;
    // 快照本身也是空的（例如刚创建的空快照）就不用问了
    if (!(d.products.length || (d.orders || []).length || (d.payments || []).length)) return;
    recoverAsked = true;
    if (confirm(`检测到本地数据为空，但存在一份 ${nowText(snap.ts)} 的快照（含 ${d.products.length} 个商品、${(d.orders || []).length} 张单据）。\n\n要用它恢复吗？（如果你是主动清空的，请点「取消」）`)) {
      state = Object.assign(defaultState(), d, {
        settings: Object.assign(defaultState().settings, d.settings || {}),
        seq: Object.assign({ out: 0, in: 0, refund: 0 }, d.seq || {}),
        logs: Array.isArray(d.logs) ? d.logs : [],
        payments: Array.isArray(d.payments) ? d.payments : []
      });
      save(); boot(); toast('已从快照恢复数据');
    }
  } catch (e) {}
}

/* ---------- 多标签页同步 ----------
    同一个浏览器开了两个标签时，A 页改了数据 B 页不会自己变（localStorage
    不跨标签同步）。这里监听 storage 事件跟着同步，欠款等统计也就跟着对了。 */
window.addEventListener('storage', e => {
  if (e.key !== LS_KEY || !e.newValue) return;
  const drafts = state.drafts || { out: [], in: [] };
  const hasDraft = (drafts.out && drafts.out.length) || (drafts.in && drafts.in.length);
  state = load();
  if (hasDraft) state.drafts = drafts;      // 别把本页还没开的单冲掉
  try {
    renderProducts(); renderSelects(); renderRecords(); renderPartners();
    renderLogs(); renderDash(); renderItems('out'); renderItems('in'); fillSettings();
  } catch (err) {}
  toast('数据已在其他页面更新，本页已同步');
});

/* ---------- 事件绑定 ---------- */
$$('.tab').forEach(t => t.onclick = () => switchPage(t.dataset.page));

$('#searchProduct').oninput = renderProducts;
$('#sortProduct').onchange = renderProducts;
$('#filterCate').onchange = renderProducts;
$('#filterStatus').onchange = renderProducts;
$('#btnAddProduct').onclick = () => openProductModal(null);
$('#btnDemo').onclick = loadDemo;
$('#btnSaveProduct').onclick = saveProduct;

$('#btnImport').onclick = () => { $('#csvText').value = ''; $('#csvPreview').textContent = ''; $('#importModal').classList.add('show'); };
$('#btnTpl').onclick = () => downloadBlob('\ufeff' +
  '货号,名称,规格,分类,单位,成本价,单价,库存,备注\nA001,示例商品,XL,默认分类,个,8.00,12.00,100,可删掉本行\n',
  '商品导入模板.csv', 'text/csv;charset=utf-8');
$('#btnPickCsv').onclick = () => $('#fileCsv').click();
$('#fileCsv').onchange = e => {
  const f = e.target.files[0];
  if (f) {
    const r = new FileReader();
    r.onload = () => { $('#csvText').value = r.result; $('#csvPreview').textContent = `已读取文件：${f.name}`; };
    r.readAsText(f, 'utf-8');
  }
  e.target.value = '';
};
$('#btnDoImport').onclick = () => importProducts($('#csvText').value);

$('#productBody').onclick = e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.edit) openProductModal(state.products.find(p => p.id === b.dataset.edit));
  if (b.dataset.toggle) {
    const p = state.products.find(x => x.id === b.dataset.toggle);
    if (!p) return;
    if (!p.disabled && p.stock > 0 &&
        !confirm(`「${p.name}」当前还有 ${p.stock}${p.unit || ''} 库存。\n停用后开单时不再出现在下拉里（历史单据不受影响），确定停用？`)) return;
    p.disabled = !p.disabled;
    save(); renderProducts(); renderSelects(); renderDash(); renderQuick('out'); renderQuick('in');
    toast(p.disabled ? `「${p.name}」已停用` : `「${p.name}」已启用`);
  }
  if (b.dataset.del) {
    const p = state.products.find(x => x.id === b.dataset.del);
    if (!p) return;
    const used = state.orders.some(o => o.items.some(i => i.pid === p.id));
    if (!confirm(`确定删除「${p.name}」？${used ? '\n（历史单据中含此商品，历史记录不受影响）' : ''}`)) return;
    snapshot();
    state.products = state.products.filter(x => x.id !== p.id);
    save(); renderProducts(); renderSelects(); renderDash(); toast('商品已删除');
  }
};

['#filterType', '#filterSettle', '#filterFrom', '#filterTo'].forEach(s => $(s).onchange = renderRecords);
/* 单据多时每敲一个字就全量过滤会卡，做个输入防抖 */
let keyTimer = null;
$('#filterKey').oninput = () => { clearTimeout(keyTimer); keyTimer = setTimeout(() => renderRecords(), 180); };
$$('[data-range]').forEach(b => b.onclick = () => {
  const t = today(), d = new Date();
  if (b.dataset.range === 'today') { $('#filterFrom').value = t; $('#filterTo').value = t; }
  else if (b.dataset.range === '7') { const s = new Date(); s.setDate(s.getDate() - 6); $('#filterFrom').value = isoDate(s); $('#filterTo').value = t; }
  else if (b.dataset.range === 'month') { $('#filterFrom').value = t.slice(0, 8) + '01'; $('#filterTo').value = t; }
  else { $('#filterFrom').value = isoDate(new Date(d.getFullYear(), d.getMonth() - 1, 1)); $('#filterTo').value = isoDate(new Date(d.getFullYear(), d.getMonth(), 0)); }
  renderRecords();
});
$('#chkAll').onchange = e => {
  const ids = filteredOrders().map(o => o.id);
  ids.forEach(i => e.target.checked ? selected.add(i) : selected.delete(i));
  renderRecords();
};
$('#btnBatchNone').onclick = () => { selected.clear(); renderRecords(); };
$('#btnBatchDel').onclick = () => {
  const list = state.orders.filter(o => selected.has(o.id));
  if (!list.length) return toast('还没有选择单据', true);
  /* 已收过钱的单据要连收款一起删，否则收款变孤儿、欠款算成负数 */
  const orphanPays = state.payments.filter(p => p.no && list.some(o => o.no === p.no));
  const orphanAmt = orphanPays.reduce((s, p) => s + num(p.amount), 0);
  let msg = `确定删除所选 ${list.length} 张单据？库存会同步还原。`;
  if (orphanAmt > 0) msg += `\n\n⚠ 其中有单据已经收过 ${orphanAmt.toFixed(2)} 元（${orphanPays.length} 笔）。\n` +
    `这些收款会一并删除，账才能平。`;
  if (!confirm(msg)) return;
  snapshot();
  list.forEach(o => {
    o.items.forEach(it => {
      const p = state.products.find(x => x.id === it.pid);
      if (!p) return;
      const before = p.stock;
      const delta = o.type === 'out' ? it.qty : -it.qty;
      p.stock = +(p.stock + delta).toFixed(4);
      logStock(p, before, delta, '单据删除', o.no);
    });
    state.orders = state.orders.filter(x => x.id !== o.id);
  });
  if (orphanPays.length) state.payments = state.payments.filter(p => !orphanPays.some(x => x.id === p.id));
  selected.clear();
  save(); renderRecords(); renderProducts(); renderSelects(); renderDash(); renderLogs(); renderPartners();
  toast(orphanAmt > 0 ? `已批量删除，库存已还原，并撤销 ${orphanPays.length} 笔收款` : '已批量删除，库存已还原');
};
$('#btnDoPaste').onclick = doPaste;
$('#pasteText').oninput = previewPaste;
$('#btnStatement').onclick = openStatement;
$('#btnDoStmt').onclick = makeStatement;
$('#btnExportXls').onclick = () => exportRecordsXls(filteredOrders());

$('#searchPartner').oninput = renderPartners;
$('#btnDoRename').onclick = applyRename;
$('#rnNew').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); applyRename(); } });
$('#partnerKind').onchange = renderPartners;
$('#btnAddPay').onclick = () => openPay('');
$('#btnSavePay').onclick = savePay;
$('#pyPartner').oninput = updatePayHint;
$('#pyNo').oninput = updatePayHint;
$('#pyAmount').oninput = () => $('#pyAmount').classList.remove('invalid');

$('#logProduct').onchange = renderLogs;
$('#logKind').onchange = renderLogs;
$('#logFrom').onchange = renderLogs;
$('#logTo').onchange = renderLogs;
$('#btnLogCsv').onclick = exportLogsCsv;

/* 设置改为即时保存：改完就生效，不再有「忘了点保存」这个坑 */
function saveHeadSettings() {
  Object.assign(state.settings, {
    company: $('#setCompany').value.trim(),
    contact: $('#setContact').value.trim(),
    phone: $('#setPhone').value.trim(),
    address: $('#setAddress').value.trim(),
    warn: Math.max(0, num($('#setWarn').value, 10)),
    footer: $('#setFooter').value.trim()
  });
  save(); renderProducts(); renderRecords(); renderDash();
}
['#setCompany', '#setContact', '#setPhone', '#setAddress', '#setFooter'].forEach(s => {
  $(s).addEventListener('input', debounce(saveHeadSettings, 300));
});
$('#setWarn').addEventListener('input', debounce(saveHeadSettings, 300));
['#setDocCode', '#setDocCost', '#setDocSign', '#setDocShip', '#setPriceMem'].forEach(s => {
  $(s).addEventListener('change', () => {
    Object.assign(state.settings, {
      docCode: $('#setDocCode').checked,
      docCost: $('#setDocCost').checked,
      docSign: $('#setDocSign').checked,
      docShip: $('#setDocShip').checked,
      priceMemory: $('#setPriceMem').checked
    });
    save();
  });
});
$('#btnSnapshot').onclick = makeSnapshot;
$('#btnRollback').onclick = rollback;
$('#btnClearAll').onclick = () => {
  if (!confirm('警告：将清空所有商品、单据、收款与设置，不可恢复！\n建议先备份。确定继续？')) return;
  if (!confirm('再次确认：真的要清空全部数据吗？')) return;
  state = defaultState(); selected.clear(); recoverAsked = true; save(); boot(); toast('数据已清空');
};
$('#btnBackup').onclick = backup;
$('#btnRestore').onclick = () => $('#fileRestore').click();
$('#fileRestore').onchange = e => { if (e.target.files[0]) restore(e.target.files[0]); e.target.value = ''; };

$$('[data-close]').forEach(b => b.onclick = () => b.closest('.modal').classList.remove('show'));
$$('.modal').forEach(m => m.onclick = e => { if (e.target === m) m.classList.remove('show'); });
$('#btnDownloadDoc').onclick = downloadDoc;
$('#btnPrintDoc').onclick = printDoc;
$('#btnRefund').onclick = () => openRefund(currentDoc);
$('#btnCopyOrder').onclick = copyOrder;
$('#btnExpProduct').onclick = exportProducts;
$('#btnRefill').onclick = openRefill;
$('#btnRfApply').onclick = applyRefill;
$('#btnRfAll').onclick = () => { $$('#rfBody input[type=checkbox]').forEach(c => c.checked = true); updateRfStat(); };
$('#btnRfNone').onclick = () => { $$('#rfBody input[type=checkbox]').forEach(c => c.checked = false); updateRfStat(); };
$('#btnPvEdit').onclick = () => {
  const p = state.products.find(x => x.id === pvId);
  $('#pviewModal').classList.remove('show');
  if (p) openProductModal(p);
};
$('#btnPvLogs').onclick = () => {
  $('#pviewModal').classList.remove('show');
  $('#logProduct').value = pvId || '';
  $('#logKind').value = ''; $('#logFrom').value = ''; $('#logTo').value = '';
  switchPage('logs'); renderLogs();
};
$('#btnStocktake').onclick = openStocktake;
$('#stkSearch').oninput = renderStocktake;
$('#btnStkApply').onclick = applyStocktake;
$('#btnStkCsv').onclick = exportStocktake;
$('#topSort').onchange = renderDash;
$('#reportMonth').onchange = renderReport;
$('#btnReportXls').onclick = exportReport;
$('#btnCheck').onclick = healthCheck;
$('#btnBatchPrint').onclick = () => {
  const list = state.orders.filter(o => selected.has(o.id));
  if (!list.length) return toast('还没有选择单据', true);
  currentDoc = null;
  currentHtml = buildBatchHtml(list);
  currentName = `批量单据_${today()}_${list.length}张`;
  toast(`已生成 ${list.length} 张单据，请在打印框里选择「另存为 PDF」或直接打印`);
  printDoc();
};
$('#btnSaveRefund').onclick = saveRefund;
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') $$('.modal').forEach(m => m.classList.remove('show'));
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    const active = $$('.page').find(p => p.classList.contains('active'));
    if (active && (active.id === 'page-out' || active.id === 'page-in')) {
      e.preventDefault();
      submitBill(active.id.replace('page-', ''));
    }
  }
});

boot();
