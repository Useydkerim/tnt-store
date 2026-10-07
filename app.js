'use strict';
/* TNT — Supplement Store Manager
   All data lives on this device (IndexedDB, with localStorage as a fallback).
   Every stock change goes through move(); every money figure is derived from records by calc()/stats(). */

const VERSION = '2.0.0';

// ───────────── Utilities ─────────────
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Arabic-Indic digits (٠-٩ / ۰-۹) → 0-9, so Arabic keyboards work everywhere.
const digits = s => String(s ?? '').replace(/[٠-٩]/g, d => d.charCodeAt(0) - 0x660).replace(/[۰-۹]/g, d => d.charCodeAt(0) - 0x6F0);
// Empty → 0, garbage → NaN.
const num = s => { const t = digits(s).replace(/٫/g, '.').replace(/[\s,،٬]/g, ''); if (t === '') return 0; const n = Number(t); return Number.isFinite(n) ? n : NaN; };
const fmtN = n => Math.round(n || 0).toLocaleString('en-US');
const money = n => fmtN(n) + ' د.ع';
const pct = (a, b) => b ? Math.round(a / b * 100) + '%' : '—';
const pad = (n, l = 5) => String(n).padStart(l, '0');
// Dates are always the shop's LOCAL date, never UTC.
const ymd = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const today = () => ymd();
const addDays = (s, n) => { const d = new Date(s + 'T12:00'); d.setDate(d.getDate() + n); return ymd(d); };
const monthStart = (s = today()) => s.slice(0, 8) + '01';
const monthEnd = s => { const d = new Date(s.slice(0, 7) + '-01T12:00'); d.setMonth(d.getMonth() + 1); d.setDate(0); return ymd(d); };
const fmtDate = s => s ? s.split('-').reverse().join('/') : '';
const fmtTime = iso => iso ? new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '';
const fmtDT = iso => iso ? fmtDate(ymd(new Date(iso))) + ' ' + fmtTime(iso) : '';
const nowISO = () => new Date().toISOString();
const byName = (a, b) => a.name.localeCompare(b.name, 'ar');
const MONTHS = ['كانون الثاني', 'شباط', 'آذار', 'نيسان', 'أيار', 'حزيران', 'تموز', 'آب', 'أيلول', 'تشرين الأول', 'تشرين الثاني', 'كانون الأول'];
const normPhone = p => digits(p).replace(/[^\d+]/g, '');
const waPhone = p => { let d = digits(p).replace(/\D/g, ''); if (d.startsWith('00')) d = d.slice(2); if (d.startsWith('0')) d = '964' + d.slice(1); return d; };

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}
function csvDownload(name, rows) {
  const cell = c => { const s = String(c ?? ''); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  download(new Blob(['﻿' + rows.map(r => r.map(cell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' }), name);
}
function readImage(file, max = 480, type = 'image/jpeg') {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => {
      const im = new Image();
      im.onload = () => {
        const r = Math.min(1, max / Math.max(im.width, im.height)), c = document.createElement('canvas');
        c.width = Math.round(im.width * r); c.height = Math.round(im.height * r);
        const g = c.getContext('2d');
        if (type === 'image/jpeg') { g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); }
        g.drawImage(im, 0, 0, c.width, c.height);
        res(c.toDataURL(type, 0.82));
      };
      im.onerror = () => rej(new Error('تعذر قراءة الصورة'));
      im.src = fr.result;
    };
    fr.onerror = () => rej(fr.error);
    fr.readAsDataURL(file);
  });
}

// ───────────── Storage ─────────────
const DB_NAME = 'tnt-store', DB_STORE = 'kv', LS_KEY = 'tnt-store-state';
let S = null, ME = null, dbp = null, useLS = false, saveChain = Promise.resolve(), saveQueued = false, saveFailed = false, staleWhileModal = false;
const bc = 'BroadcastChannel' in window ? new BroadcastChannel('tnt-store') : null;

function fresh() {
  return {
    v: 2, shop: { name: 'TNT', phone: '', address: '', logo: '', footer: 'شكراً لتسوقكم معنا 💪', defMin: 5 },
    seq: { id: 1, sale: 1, order: 1, pur: 1, ret: 1 },
    users: [], products: [], sales: [], returns: [], purchases: [], supPays: [], suppliers: [], customers: [], expenses: [], moves: [],
    lastBackup: '', createdAt: nowISO(), updatedAt: '',
  };
}
function normalize(d) {
  const f = fresh();
  if (!d || typeof d !== 'object' || d.v !== 2) return f;
  for (const k in f) if (d[k] === undefined || d[k] === null) d[k] = f[k];
  d.shop = { ...f.shop, ...d.shop }; d.seq = { ...f.seq, ...d.seq };
  return d;
}
function openDB() {
  return new Promise((res, rej) => {
    if (!window.indexedDB) return rej(new Error('IndexedDB غير متوفر'));
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(DB_STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
const db = () => (dbp ||= openDB());
async function dbGet() {
  const d = await db();
  return new Promise((res, rej) => { const q = d.transaction(DB_STORE).objectStore(DB_STORE).get('state'); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
}
async function dbPut(v) {
  const d = await db();
  return new Promise((res, rej) => {
    const tx = d.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).put(v, 'state');
    tx.oncomplete = () => res();
    tx.onerror = tx.onabort = () => rej(tx.error || new Error('تعذر الحفظ'));
  });
}
async function loadState() {
  let d = null;
  try { d = await dbGet(); } catch { useLS = true; }
  if (!d) try { const raw = localStorage.getItem(LS_KEY); if (raw) d = JSON.parse(raw); } catch { }
  S = normalize(d);
}
// Saves are serialized; a failure is shown loudly instead of being swallowed.
function save() {
  S.updatedAt = nowISO();
  if (saveQueued) return saveChain;
  saveQueued = true;
  saveChain = saveChain.then(async () => {
    saveQueued = false;
    if (useLS) localStorage.setItem(LS_KEY, JSON.stringify(S)); else await dbPut(S);
    setSaveError(null);
    bc?.postMessage('saved');
  }).catch(e => { saveQueued = false; setSaveError(e); });
  return saveChain;
}
function setSaveError(e) {
  saveFailed = !!e;
  const b = $('#savebar');
  if (!e) { b.hidden = true; return; }
  b.hidden = false;
  b.innerHTML = `<span>⚠️ تعذر حفظ البيانات على هذا الجهاز (${esc(e.message || e.name || e)}). لا تغلق الصفحة — صدّر نسخة احتياطية الآن.</span><button class="btn sm" onclick="exportBackup()">تصدير</button>`;
}
window.addEventListener('beforeunload', e => { if (saveFailed) { e.preventDefault(); e.returnValue = ''; } });
// Another tab saved → pick up its data.
if (bc) bc.onmessage = async () => {
  try {
    const d = useLS ? JSON.parse(localStorage.getItem(LS_KEY)) : await dbGet();
    if (!d) return;
    S = normalize(d);
    if (ME) ME = S.users.find(u => u.id === ME.id && u.active) || null;
    if ($('#modal').classList.contains('open')) staleWhileModal = true; else render();
  } catch { }
};

// ───────────── Permissions ─────────────
const PERMS = {
  returns: 'تسجيل المرتجعات',
  stock: 'إدارة المنتجات والمخزون والمشتريات والموردين (تشمل أسعار الشراء)',
  money: 'عرض الأرباح والتقارير والمصاريف',
  del: 'الحذف وإلغاء الفواتير',
};
const isAdmin = () => ME?.role === 'admin';
const can = k => !!ME && (ME.role === 'admin' || !!ME.perms?.[k]);
const seeCost = () => can('stock') || can('money');

// ───────────── Domain ─────────────
const nid = () => S.seq.id++;
const products = () => S.products.filter(p => !p.deleted);
const P = id => S.products.find(p => p.id === +id);
const saleById = id => S.sales.find(s => s.id === +id);
const DEAD = ['ملغي', 'مرتجع'];
const ONLINE_ST = ['طلب جديد', 'قيد التجهيز', 'تم الشحن', 'تم التوصيل', 'ملغي', 'مرتجع'];
const PENDING = ['طلب جديد', 'قيد التجهيز', 'تم الشحن'];
const ST_CLS = { 'طلب جديد': 'blue', 'قيد التجهيز': 'warn', 'تم الشحن': 'purple', 'تم التوصيل': 'ok', 'ملغي': 'bad', 'مرتجع': 'bad', 'مكتمل': 'ok' };
const PAYS = ['Cash', 'Card', 'تحويل', 'أخرى'];
const EXP_TYPES = ['إيجار', 'كهرباء', 'رواتب', 'توصيل', 'إعلانات', 'تغليف', 'مصاريف أخرى'];
const CATS = ['بروتين', 'كرياتين', 'أحماض أمينية', 'Pre-Workout', 'Mass Gainer', 'فيتامينات', 'حوارق دهون', 'إكسسوارات'];
const RET_REASONS = ['رغبة العميل', 'منتج تالف', 'عيب في المنتج', 'خطأ في الطلب', 'منتهي الصلاحية', 'أخرى'];
const live = s => !DEAD.includes(s.status);
const isPending = s => s.type === 'online' && PENDING.includes(s.status);

// total = items − discount + delivery fee charged to the customer
// profit = total − cost of goods − delivery cost paid by the shop
function calc(s) {
  let sub = 0, cogs = 0;
  for (const i of s.items) { sub += i.qty * i.price; cogs += i.qty * i.cost; }
  const total = sub - s.discount + s.fee;
  return { sub, cogs, total, profit: total - cogs - s.dcost };
}
const saleReturns = s => S.returns.filter(r => r.saleId === s.id);
const returnedQty = (s, pid) => S.returns.reduce((a, r) => a + (r.saleId === s.id && r.pid === pid ? r.qty : 0), 0);
const discShare = s => { const sub = s.items.reduce((a, i) => a + i.qty * i.price, 0); return sub ? (sub - s.discount) / sub : 0; };
// Money lost on a return: what we refunded minus the value of goods that came back to stock.
const retLoss = r => r.refund - (r.restock ? r.qty * r.cost : 0);

// The ONLY place stock quantities change. Logs who, why and the new balance.
function move(p, qty, reason, ref = '') {
  p.qty += qty;
  S.moves.unshift({ id: nid(), at: nowISO(), date: today(), pid: p.id, name: p.name, qty, after: p.qty, reason, ref, user: ME?.name || '—' });
}

// Sales, profit and expenses for local dates a..b (inclusive). Returns count on their own date.
function stats(a, b, withProd = false) {
  const o = { sales: 0, store: 0, online: 0, cogs: 0, profit: 0, pStore: 0, pOnline: 0, n: 0, nStore: 0, nOnline: 0, disc: 0, refunds: 0, nRet: 0, exp: 0, net: 0, prod: {} };
  const idx = new Map(), row = (pid, name) => o.prod[pid] ||= { pid, name: P(pid)?.name || name, qty: 0, rev: 0, profit: 0 };
  for (const s of S.sales) {
    idx.set(s.id, s);
    if (!live(s) || s.date < a || s.date > b) continue;
    const c = calc(s), K = s.type === 'store' ? 'Store' : 'Online';
    o.sales += c.total; o[s.type] += c.total; o.cogs += c.cogs; o.profit += c.profit; o['p' + K] += c.profit; o.n++; o['n' + K]++; o.disc += s.discount;
    if (withProd) {
      const sh = c.sub ? (c.sub - s.discount) / c.sub : 0;
      for (const i of s.items) { const x = row(i.pid, i.name), rev = i.qty * i.price * sh; x.qty += i.qty; x.rev += rev; x.profit += rev - i.qty * i.cost; }
    }
  }
  for (const r of S.returns) {
    if (r.date < a || r.date > b) continue;
    const s = idx.get(r.saleId);
    if (!s || !live(s)) continue; // a cancelled sale is already excluded entirely
    const K = s.type === 'store' ? 'Store' : 'Online', lost = retLoss(r);
    o.sales -= r.refund; o[s.type] -= r.refund; o.cogs -= r.refund - lost; o.profit -= lost; o['p' + K] -= lost; o.refunds += r.refund; o.nRet++;
    if (withProd) { const x = row(r.pid, r.name); x.qty -= r.qty; x.rev -= r.refund; x.profit -= lost; }
  }
  for (const e of S.expenses) if (e.date >= a && e.date <= b) o.exp += e.amount;
  o.net = o.profit - o.exp;
  return o;
}
function soldMap() {
  const idx = new Map(S.sales.map(s => [s.id, s])), m = {};
  for (const s of S.sales) if (live(s)) for (const i of s.items) m[i.pid] = (m[i.pid] || 0) + i.qty;
  for (const r of S.returns) { const s = idx.get(r.saleId); if (s && live(s)) m[r.pid] = (m[r.pid] || 0) - r.qty; }
  return m;
}
function searchProducts(q) {
  const raw = digits(q).trim().toLowerCase(), toks = raw.split(/\s+/).filter(Boolean);
  return products().filter(p => { const hay = [p.name, p.brand, p.barcode, p.cat, p.flavor, p.size].join(' ').toLowerCase(); return toks.every(t => hay.includes(t)); })
    .sort((a, b) => (b.barcode === raw) - (a.barcode === raw) || (b.qty > 0) - (a.qty > 0) || byName(a, b));
}
const expState = p => {
  if (!p.exp) return '';
  const d = (new Date(p.exp + 'T12:00') - new Date(today() + 'T12:00')) / 864e5;
  return d < 0 ? 'expired' : d <= 30 ? 'soon' : '';
};

// Online order status change. Leaving an active status restocks what the customer still holds
// (sold − already returned); coming back takes it out again, if the stock is there.
function setStatus(id, st) {
  const s = saleById(id);
  if (!s || s.status === st) return;
  const was = live(s), will = !DEAD.includes(st);
  if (was && !will) {
    for (const i of s.items) { const left = i.qty - returnedQty(s, i.pid), p = P(i.pid); if (left > 0 && p) move(p, left, `${st === 'ملغي' ? 'إلغاء' : 'إرجاع'} ${s.no}`, s.no); }
  } else if (!was && will) {
    for (const i of s.items) {
      const left = i.qty - returnedQty(s, i.pid), p = P(i.pid);
      if (left > 0 && (!p || p.qty < left)) { toast(`الكمية المتوفرة غير كافية. لا يمكن إعادة تفعيل ${s.no} (${i.name})`, 'bad'); refresh(); return; }
    }
    for (const i of s.items) { const left = i.qty - returnedQty(s, i.pid); if (left > 0) move(P(i.pid), -left, `إعادة تفعيل ${s.no}`, s.no); }
  }
  s.status = st;
  (s.log ||= []).push({ st, at: nowISO(), user: ME.name });
  save(); toast(`${s.no}: ${st}`, 'ok'); refresh();
}

// ───────────── UI helpers ─────────────
function toast(msg, type = '') {
  const t = document.createElement('div');
  t.className = 'toast ' + type; t.textContent = msg; t.setAttribute('role', 'status');
  const box = $('#toasts');
  while (box.children.length >= 2) box.firstElementChild.remove(); // never stack more than two
  box.appendChild(t);
  setTimeout(() => t.classList.add('out'), 2800);
  setTimeout(() => t.remove(), 3200);
}
let MODAL_REFRESH = null;
function openModal(html, refreshFn = null) {
  $('#modal-body').innerHTML = html;
  $('#modal').classList.add('open'); document.body.classList.add('modal-open');
  MODAL_REFRESH = refreshFn; $('.sheet').scrollTop = 0;
}
function closeModal() {
  $('#modal').classList.remove('open'); document.body.classList.remove('modal-open');
  $('#modal-body').innerHTML = ''; MODAL_REFRESH = null;
  if (staleWhileModal) { staleWhileModal = false; render(); }
}
function refresh() {
  if (MODAL_REFRESH && $('#modal').classList.contains('open')) { const st = $('.sheet').scrollTop; MODAL_REFRESH(); $('.sheet').scrollTop = st; }
  render();
}
const val = id => ($('#' + id)?.value ?? '').trim();
function fld(id, label, value = '', o = {}) {
  return `<label class="fld${o.full ? ' full' : ''}"><span>${label}</span><input id="${id}" type="${o.type || 'text'}" value="${esc(value ?? '')}"${o.num ? ' inputmode="numeric" autocomplete="off"' : ''}${o.list ? ` list="${o.list}"` : ''}${o.ph ? ` placeholder="${esc(o.ph)}"` : ''}${o.attrs ? ' ' + o.attrs : ''}></label>`;
}
// Default logo is plain styled text (not SVG) so it also renders inside PDFs.
const logoHtml = sz => {
  if (S.shop.logo) return `<img class="logo" src="${esc(S.shop.logo)}" style="width:${sz}px;height:${sz}px" alt="">`;
  const t = (S.shop.name || 'TNT').trim().slice(0, 4);
  return `<span class="logo txt" style="width:${sz}px;height:${sz}px;font-size:${Math.round(sz * (t.length <= 3 ? 0.3 : 0.24))}px;border-width:${Math.max(2, Math.round(sz / 22))}px">${esc(t)}</span>`;
};
const thumb = (p, cls = '') => p.img ? `<img class="thumb ${cls}" src="${esc(p.img)}" alt="">` : `<span class="thumb ph ${cls}">💪</span>`;
const stockBadge = p => p.qty <= 0 ? '<span class="badge bad">🔴 المنتج نافد</span>' : p.qty <= p.min ? '<span class="badge warn">⚠️ المنتج قريب من النفاد</span>' : '';
const expBadge = p => { const e = expState(p); return e === 'expired' ? '<span class="badge bad">⛔ منتهي الصلاحية</span>' : e === 'soon' ? `<span class="badge warn">⏳ ينتهي ${fmtDate(p.exp)}</span>` : ''; };
const stBadge = s => `<span class="badge ${ST_CLS[s.status] || ''}">${s.status}</span>`;
const kpi = (ic, label, value, sub = '', tone = 'o', href = '', cls = '') => {
  const tag = href ? `a href="#/${href}"` : 'div';
  return `<${tag} class="kpi"><span class="ic t-${tone}">${ic}</span><span class="kl">${label}</span><b class="kv ${cls}">${value}</b>${sub ? `<small>${sub}</small>` : ''}</${href ? 'a' : 'div'}>`;
};
const empty = t => `<div class="empty">${t}</div>`;
const statusSelect = s => `<select class="st-sel" onclick="event.stopPropagation()" onchange="setStatus(${s.id},this.value)" aria-label="حالة الطلب">${ONLINE_ST.map(x => `<option ${x === s.status ? 'selected' : ''}>${x}</option>`).join('')}</select>`;

function saleCard(s, withStatus = false) {
  const c = calc(s), rf = saleReturns(s).reduce((a, r) => a + r.refund, 0);
  return `<div class="scard${live(s) ? '' : ' dead'}" onclick="showReceipt(${s.id})">
    <div class="sc-row"><b>${s.type === 'online' ? '🌐' : '🏪'} ${s.no}</b>${stBadge(s)}</div>
    ${s.cust ? `<div class="small">👤 ${esc(s.cust.name)} · <a dir="ltr" href="tel:${esc(s.cust.phone)}" onclick="event.stopPropagation()">${esc(s.cust.phone)}</a></div>` : ''}
    <div class="sc-items">${esc(s.items.map(i => i.name + ' ×' + i.qty).join('، '))}</div>
    <div class="sc-row"><span class="muted small">${fmtDT(s.at)} · ${esc(s.pay)}</span><b class="sc-tot">${money(c.total)}</b></div>
    ${rf ? `<div class="small warn">↩️ مرتجع: ${money(rf)}</div>` : ''}
    ${can('money') ? `<div class="small ${c.profit < 0 ? 'bad' : 'ok'}">الربح: ${money(c.profit)}</div>` : ''}
    ${withStatus && s.type === 'online' ? `<div class="sc-st">${statusSelect(s)}</div>` : ''}
  </div>`;
}
const moveRows = l => l.map(m => `<div class="mrow"><span class="mq ${m.qty > 0 ? 'ok' : 'bad'}" dir="ltr">${m.qty > 0 ? '+' : ''}${m.qty}</span><div><b>${esc(m.name)}</b><small>${esc(m.reason)}</small><small>👤 ${esc(m.user)} · ${fmtDT(m.at)}</small></div><span class="mafter" title="الرصيد بعد الحركة">${m.after}</span></div>`).join('');

// Bar chart: store vs online per bucket. Fixed pixel heights so it renders the same everywhere.
function buckets(a, b, mode) {
  const days = Math.round((new Date(b + 'T12:00') - new Date(a + 'T12:00')) / 864e5) + 1;
  mode ||= days <= 31 ? 'd' : days <= 120 ? 'w' : 'm';
  const out = [], lab = d => +d.slice(8) + '/' + +d.slice(5, 7);
  if (mode === 'd') for (let d = a; d <= b; d = addDays(d, 1)) out.push({ l: lab(d), a: d, b: d });
  else if (mode === 'w') for (let d = a; d <= b; d = addDays(d, 7)) { const e = addDays(d, 6); out.push({ l: lab(d), a: d, b: e < b ? e : b }); }
  else for (let d = a; d <= b;) { const e = monthEnd(d); out.push({ l: +d.slice(5, 7) + '/' + d.slice(2, 4), a: d, b: e < b ? e : b }); d = addDays(e, 1); }
  return out.map(x => ({ ...x, s: stats(x.a, x.b) }));
}
function barChart(rows) {
  const H = 150, mx = Math.max(1, ...rows.map(r => Math.max(r.s.store, r.s.online))), every = Math.ceil(rows.length / 8);
  const tot = rows.reduce((a, r) => a + r.s.sales, 0);
  return `<div class="legend"><span><i class="st"></i>المحل</span><span><i class="on"></i>الأونلاين</span><b>${money(tot)}</b></div>
  <div class="chart">${rows.map((r, k) => `<button class="col" type="button" onclick="toast('${r.l} — المحل: ${money(r.s.store)} · الأونلاين: ${money(r.s.online)}')" aria-label="${r.l}"><span class="bars"><i class="st" style="height:${(Math.max(0, r.s.store) / mx * H).toFixed(1)}px"></i><i class="on" style="height:${(Math.max(0, r.s.online) / mx * H).toFixed(1)}px"></i></span><span class="cl">${(rows.length - 1 - k) % every === 0 ? r.l : ''}</span></button>`).join('')}</div>`;
}

// ───────────── Routing ─────────────
const ROUTES = {
  dash: { t: 'لوحة التحكم', s: 'الرئيسية', i: '📊', html: pDash },
  pos: { t: 'بيع جديد', s: 'بيع', i: '🛒', html: pPos, mount: mPos },
  store: { t: 'مبيعات المحل', i: '🏪', html: pStore, mount: storeList },
  online: { t: 'المبيعات الأونلاين', s: 'الطلبات', i: '🌐', html: pOnline, mount: onlineList },
  inv: { t: 'المخزون', i: '🏬', html: pInv, mount: () => { invTable(); moveLog(); } },
  prod: { t: 'المنتجات', i: '📦', html: pProd, mount: prodList },
  pur: { t: 'المشتريات', i: '🚚', perm: 'stock', html: pPur, mount: () => { pbItems(); pbSum(); } },
  cust: { t: 'العملاء', i: '👥', html: pCust, mount: custList },
  sup: { t: 'الموردون', i: '🤝', perm: 'stock', html: pSup },
  exp: { t: 'المصاريف', i: '💸', perm: 'money', html: pExp },
  ret: { t: 'المرتجعات', i: '↩️', perm: 'returns', html: pRet, mount: () => { retOpts(); retForm(); } },
  rep: { t: 'التقارير', i: '📈', perm: 'money', html: pRep },
  users: { t: 'المستخدمون', i: '🔐', perm: 'admin', html: pUsers },
  set: { t: 'الإعدادات', i: '⚙️', perm: 'admin', html: pSet, mount: storageInfo },
  more: { t: 'المزيد', i: '☰', html: pMore },
};
const SIDE = ['dash', ['المبيعات', ['pos', 'store', 'online']], 'inv', 'prod', 'pur', 'cust', 'sup', 'exp', 'ret', 'rep', 'users', 'set'];
const BNAV = ['dash', 'pos', 'online', 'prod', 'more'];
const allowed = r => { const p = ROUTES[r]?.perm; return !p || (p === 'admin' ? isAdmin() : can(p)); };
let route = 'dash', params = new URLSearchParams(), lastRoute = '';
const UI = { chart: 'd', pq: '', pf: 'all', pc: '', ps: 'name', sr: 'today', sq: '', of: 'all', oq: '', iq: '', mp: '', mt: '', ml: 100, cq: '', em: '', ra: '', rb: '' };

function parseHash() {
  const h = decodeURIComponent(location.hash.replace(/^#\/?/, '')), [r, qs] = h.split('?');
  return { r: ROUTES[r] ? r : 'dash', q: new URLSearchParams(qs || '') };
}
function go(r) { const h = '#/' + r; if (location.hash === h) render(); else location.hash = h; }

function render() {
  if (!ME) return showLock();
  const { r, q } = parseHash();
  if (!allowed(r)) { toast('ليس لديك صلاحية للوصول إلى هذه الصفحة', 'bad'); location.replace('#/dash'); return; }
  route = r; params = q;
  blurInside($('#main'));
  $('#lock').hidden = true;
  ['#top', '#side', '#bnav', '#main'].forEach(s => $(s).hidden = false);
  renderChrome();
  const pg = ROUTES[r];
  $('#main').innerHTML = `<h1 class="ptitle">${pg.i} ${pg.t}</h1>` + pg.html();
  if ([...q.keys()].length) history.replaceState(null, '', '#/' + r);
  pg.mount?.();
  if (r !== lastRoute) { window.scrollTo(0, 0); lastRoute = r; }
}
function renderChrome() {
  const pend = S.sales.filter(isPending).length, badge = r => r === 'online' && pend ? `<em>${pend}</em>` : '';
  $('#top').innerHTML = `<a class="brand" href="#/dash">${logoHtml(36)}<span>${esc(S.shop.name)}</span></a>
    <div class="who"><span>${esc(ME.name)}<small>${isAdmin() ? 'مدير' : 'موظف'}</small></span><button class="lockbtn" onclick="lockApp()" aria-label="قفل">🔒</button></div>`;
  const link = r => `<a href="#/${r}" class="${r === route ? 'on' : ''}"><span class="i">${ROUTES[r].i}</span><span>${ROUTES[r].t}</span>${badge(r)}</a>`;
  $('#side').innerHTML = `<div class="side-brand">${logoHtml(44)}<div><b>${esc(S.shop.name)}</b><small>Supplement Store Manager</small></div></div>`
    + SIDE.map(x => Array.isArray(x) ? `<div class="grp">${x[0]}</div>` + x[1].filter(allowed).map(link).join('') : allowed(x) ? link(x) : '').join('')
    + `<div class="side-foot"><div class="small">👤 ${esc(ME.name)} · ${isAdmin() ? 'مدير' : 'موظف'}</div><button class="btn ghost block sm" onclick="lockApp()">🔒 قفل</button></div>`;
  const moreOn = !BNAV.includes(route);
  $('#bnav').innerHTML = BNAV.map(r => `<a href="#/${r}" class="${r === route || (r === 'more' && moreOn) ? 'on' : ''}"><span class="i">${ROUTES[r].i}</span><span>${ROUTES[r].s || ROUTES[r].t}</span>${badge(r)}</a>`).join('');
}

// ───────────── Lock screen & first-run setup ─────────────
const LK = { pin: '', fails: 0, until: 0 };
function showLock() {
  ['#top', '#side', '#bnav', '#main'].forEach(s => $(s).hidden = true);
  closeModal();
  const el = $('#lock'); el.hidden = false;
  if (!S.users.length) {
    el.innerHTML = `<div class="lockbox wide"><div class="center">${logoHtml(72)}</div><h1>مرحباً بك 👋</h1><p class="muted">إعداد النظام لأول مرة — أنشئ حساب المدير</p>
      ${fld('su_shop', 'اسم المحل', S.shop.name)}${fld('su_name', 'اسمك', '', { ph: 'مثال: أحمد' })}
      ${fld('su_pin', 'رمز الدخول (4 أرقام)', '', { type: 'password', attrs: 'inputmode="numeric" maxlength="4" autocomplete="new-password"' })}
      ${fld('su_pin2', 'تأكيد الرمز', '', { type: 'password', attrs: 'inputmode="numeric" maxlength="4" autocomplete="new-password"' })}
      <button class="btn block lg" onclick="doSetup()">ابدأ ←</button>
      <label class="btn ghost block">⬆️ لدي نسخة احتياطية — استعادتها<input type="file" accept=".json,application/json" hidden onchange="importBackup(this)"></label></div>`;
    return;
  }
  LK.pin = '';
  el.innerHTML = `<div class="lockbox"><div class="center">${logoHtml(78)}</div><h1>${esc(S.shop.name)}</h1><p>أدخل رمز الدخول</p><div class="dots" id="dots"></div>
    <div class="keypad">${'123456789'.split('').map(n => `<button onclick="lkKey('${n}')">${n}</button>`).join('')}<button class="k-sm" onclick="lkKey('clr')">مسح</button><button onclick="lkKey('0')">0</button><button class="k-sm" onclick="lkKey('del')" aria-label="حذف">⌫</button></div></div>`;
  lkDots();
}
function lkDots() { const d = $('#dots'); if (d) d.innerHTML = [0, 1, 2, 3].map(i => `<i class="${i < LK.pin.length ? 'on' : ''}"></i>`).join(''); }
function lkKey(k) {
  if (Date.now() < LK.until) return toast(`محاولات كثيرة — انتظر ${Math.ceil((LK.until - Date.now()) / 1000)} ثانية`, 'bad');
  if (k === 'del') LK.pin = LK.pin.slice(0, -1); else if (k === 'clr') LK.pin = ''; else if (LK.pin.length < 4) LK.pin += k;
  lkDots();
  if (LK.pin.length < 4) return;
  const u = S.users.find(x => x.active && x.pin === LK.pin);
  if (u) { LK.fails = 0; LK.pin = ''; login(u); return; }
  if (++LK.fails >= 5) { LK.fails = 0; LK.until = Date.now() + 30000; }
  $('.lockbox')?.classList.add('shake');
  toast('الرمز غير صحيح', 'bad');
  setTimeout(() => { $('.lockbox')?.classList.remove('shake'); LK.pin = ''; lkDots(); }, 450);
}
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && $('#modal').classList.contains('open')) return closeModal();
  if ($('#lock').hidden || !$('#dots')) return;
  const k = digits(e.key);
  if (/^\d$/.test(k)) lkKey(k); else if (e.key === 'Backspace') lkKey('del');
});
function login(u) {
  ME = u;
  try { sessionStorage.setItem('tnt-uid', u.id); } catch { }
  $('#lock').hidden = true; $('#lock').innerHTML = '';
  history.replaceState(null, '', '#/dash'); // a new user always starts on the dashboard
  render();
}
function lockApp() { ME = null; try { sessionStorage.removeItem('tnt-uid'); } catch { } showLock(); }
function doSetup() {
  const shop = val('su_shop') || 'TNT', name = val('su_name'), pin = digits(val('su_pin')), pin2 = digits(val('su_pin2'));
  if (!name) return toast('أدخل اسمك', 'bad');
  if (!/^\d{4}$/.test(pin)) return toast('رمز الدخول يجب أن يكون 4 أرقام', 'bad');
  if (pin !== pin2) return toast('الرمزان غير متطابقين', 'bad');
  S.shop.name = shop;
  const u = { id: nid(), name, pin, role: 'admin', perms: {}, active: true, createdAt: nowISO() };
  S.users.push(u); save(); login(u); toast('تم إعداد النظام ✅', 'ok');
}

// ───────────── Dashboard ─────────────
function backupBanner() {
  if (!isAdmin() || !S.products.length) return '';
  const days = S.lastBackup ? (Date.now() - new Date(S.lastBackup)) / 864e5 : Infinity;
  if (days < 7) return '';
  return `<div class="card banner"><span>💾 ${S.lastBackup ? `آخر نسخة احتياطية قبل ${Math.floor(days)} يوم` : 'لم تقم بعمل نسخة احتياطية بعد'} — البيانات محفوظة على هذا الجهاز فقط.</span><button class="btn sm" onclick="exportBackup()">تصدير الآن</button></div>`;
}
function pDash() {
  const t = today(), d = stats(t, t), m = stats(monthStart(t), t), ps = products(), sm = can('money');
  const low = ps.filter(p => p.qty > 0 && p.qty <= p.min), out = ps.filter(p => p.qty <= 0), expi = ps.filter(p => expState(p));
  const pend = S.sales.filter(isPending).length;
  const vc = ps.reduce((a, p) => a + Math.max(0, p.qty) * p.cost, 0), vs = ps.reduce((a, p) => a + Math.max(0, p.qty) * p.price, 0);
  const top = Object.values(stats(addDays(t, -29), t, true).prod).filter(x => x.qty > 0).sort((a, b) => b.qty - a.qty).slice(0, 5);
  const ms = ymd(new Date(new Date().getFullYear(), new Date().getMonth() - 11, 1));
  const rows = UI.chart === 'w' ? buckets(addDays(t, -55), t, 'w') : UI.chart === 'm' ? buckets(ms, t, 'm') : buckets(addDays(t, -13), t, 'd');
  const sp = Math.max(0, m.store) + Math.max(0, m.online), ps1 = sp ? Math.round(Math.max(0, m.store) / sp * 100) : 0;
  return `${backupBanner()}
  <div class="kpis">
    ${kpi('💰', 'مبيعات اليوم', money(d.sales), `${d.n} عملية`, 'g')}
    ${kpi('📅', 'مبيعات هذا الشهر', money(m.sales), `${m.n} عملية`, 'b')}
    ${kpi('🏪', 'مبيعات المحل · الشهر', money(m.store), `${m.nStore} فاتورة`, 'o', 'store')}
    ${kpi('🌐', 'مبيعات الأونلاين · الشهر', money(m.online), `${m.nOnline} طلب`, 'i', 'online')}
    ${sm ? kpi('📈', 'إجمالي الأرباح · الشهر', money(m.profit), m.sales ? `هامش ${pct(m.profit, m.sales)}` : '', 'g')
         + kpi('🧾', 'صافي الربح · بعد المصاريف', money(m.net), `المصاريف ${money(m.exp)}`, 'p', '', m.net < 0 ? 'bad' : 'ok') : ''}
    ${kpi('📦', 'عدد المنتجات', ps.length, `${ps.reduce((a, p) => a + Math.max(0, p.qty), 0)} قطعة بالمخزون`, 'y', 'prod')}
    ${kpi('⚠️', 'قريبة من النفاد', low.length, '', 'y', 'prod?f=low', low.length ? 'warn' : '')}
    ${kpi('🔴', 'نافدة', out.length, '', 'r', 'prod?f=out', out.length ? 'bad' : '')}
    ${sm ? kpi('🏷️', 'المخزون بسعر الشراء', money(vc), '', 'b') + kpi('💎', 'المخزون بسعر البيع', money(vs), `ربح متوقع ${money(vs - vc)}`, 'p') : ''}
  </div>
  ${pend ? `<a class="card alert-card" href="#/online">🛵 <b>${pend}</b> طلب أونلاين قيد المتابعة <span>عرض ←</span></a>` : ''}
  <div class="card">
    <div class="card-h"><b>📊 المبيعات</b><div class="seg mini">${[['d', 'يومي'], ['w', 'أسبوعي'], ['m', 'شهري']].map(([k, l]) => `<button class="${UI.chart === k ? 'on' : ''}" onclick="UI.chart='${k}';render()">${l}</button>`).join('')}</div></div>
    ${barChart(rows)}
  </div>
  <div class="card">
    <div class="card-h"><b>🏪 المحل مقابل 🌐 الأونلاين · هذا الشهر</b></div>
    <div class="split${sp ? '' : ' empty'}"><i class="st" style="width:${sp ? ps1 : 50}%"></i><i class="on" style="width:${sp ? 100 - ps1 : 50}%"></i></div>
    <div class="cmp">
      <div><span>🏪 المحل</span><b>${money(m.store)}</b><small>${sp ? ps1 : 0}% · ${m.nStore} فاتورة${sm ? ' · ربح ' + money(m.pStore) : ''}</small></div>
      <div><span>🌐 الأونلاين</span><b>${money(m.online)}</b><small>${sp ? 100 - ps1 : 0}% · ${m.nOnline} طلب${sm ? ' · ربح ' + money(m.pOnline) : ''}</small></div>
    </div>
  </div>
  <div class="card"><div class="card-h"><b>⚠️ Low Stock Products</b><a class="lnk" href="#/prod?f=low">عرض الكل</a></div>
    ${[...out, ...low].map(p => `<button class="lrow" onclick="productView(${p.id})">${thumb(p)}<div><b>${esc(p.name)}</b><small>${esc(p.brand || '')}</small>${stockBadge(p)}</div><div class="iq ${p.qty <= 0 ? 'bad' : 'warn'}"><b>${p.qty}</b><small>متبقي</small></div></button>`).join('') || empty('✅ كل المنتجات بمخزون جيد')}
  </div>
  ${expi.length ? `<div class="card"><div class="card-h"><b>⏳ صلاحية قريبة أو منتهية</b></div>${expi.map(p => `<button class="lrow" onclick="productView(${p.id})">${thumb(p)}<div><b>${esc(p.name)}</b>${expBadge(p)}</div><div class="iq"><b>${p.qty}</b><small>قطعة</small></div></button>`).join('')}</div>` : ''}
  <div class="card"><div class="card-h"><b>🏆 أفضل المنتجات مبيعاً · آخر 30 يوم</b></div>
    ${top.map((x, k) => `<div class="rank"><span class="rk">${k + 1}</span><b>${esc(x.name)}</b><span>${x.qty} قطعة</span>${sm ? `<small class="ok">${money(x.profit)}</small>` : ''}</div>`).join('') || empty('لا توجد مبيعات بعد')}
  </div>
  <div class="card"><div class="card-h"><b>🧾 آخر عمليات البيع</b><a class="lnk" href="#/store">الكل</a></div>${S.sales.slice(0, 6).map(s => saleCard(s)).join('') || empty('لا توجد عمليات بعد — ابدأ من «بيع»')}</div>`;
}

// ───────────── POS ─────────────
let cart = [];
try { cart = JSON.parse(sessionStorage.getItem('tnt-cart')) || []; } catch { }
const PF0 = () => ({ type: 'store', pay: 'Cash', discount: '', fee: '', dcost: '', name: '', phone: '', address: '', notes: '' });
let PF = PF0();
const saveCart = () => { try { sessionStorage.setItem('tnt-cart', JSON.stringify(cart)); } catch { } };
const segBtn = (k, v, label) => `<button type="button" data-v="${esc(v)}" class="${PF[k] === v ? 'on' : ''}" onclick="PF.${k}=this.dataset.v;posSeg()">${label}</button>`;

function pPos() {
  if (params.get('type') === 'online') PF.type = 'online';
  const on = PF.type === 'online';
  return `<div class="card">
    <input id="pq" class="big" placeholder="🔍 ابحث بالاسم أو الباركود أو البراند" autocomplete="off" oninput="posResults()" onkeydown="if(event.key==='Enter'){event.preventDefault();posEnter()}">
    <div id="pres" class="plist"></div>
  </div>
  <div class="card"><div class="card-h"><b>🧺 السلة</b><button class="btn ghost sm" onclick="cartClear()">تفريغ</button></div><div id="pcart"></div></div>
  <div class="card">
    <div class="seg" data-k="type">${segBtn('type', 'store', '🏪 بيع من المحل')}${segBtn('type', 'online', '🌐 بيع أونلاين')}</div>
    <div id="pon" ${on ? '' : 'hidden'}>
      <div class="form2">
        ${fld('o_ph', 'هاتف العميل *', PF.phone, { list: 'custdl', attrs: 'inputmode="tel" autocomplete="off" oninput="PF.phone=this.value;custFill()"' })}
        ${fld('o_nm', 'اسم العميل *', PF.name, { attrs: 'oninput="PF.name=this.value"' })}
        ${fld('o_ad', 'العنوان', PF.address, { full: true, attrs: 'oninput="PF.address=this.value"' })}
        ${fld('o_fee', 'سعر التوصيل (يدفعه العميل)', PF.fee, { num: true, attrs: 'oninput="PF.fee=this.value;posSum()"' })}
        ${fld('o_dc', 'تكلفة التوصيل (علينا)', PF.dcost, { num: true, attrs: 'oninput="PF.dcost=this.value;posSum()"' })}
      </div>
      <datalist id="custdl">${S.customers.filter(c => !c.deleted && c.phone).map(c => `<option value="${esc(c.phone)}">${esc(c.name)}</option>`).join('')}</datalist>
    </div>
    <div class="lbl">طريقة الدفع</div>
    <div class="seg" data-k="pay">${PAYS.map(x => segBtn('pay', x, x)).join('')}</div>
    <div class="form2">
      ${fld('o_disc', 'الخصم', PF.discount, { num: true, ph: '0', attrs: 'oninput="PF.discount=this.value;posSum()"' })}
      ${fld('o_nt', 'ملاحظات', PF.notes, { attrs: 'oninput="PF.notes=this.value"' })}
    </div>
    <div id="psum" class="sum"></div>
    <button class="btn block lg" id="pgo" onclick="checkout()">✅ تسجيل العملية</button>
  </div>`;
}
function mPos() { posResults(); renderCart(); posSum(); if (matchMedia('(hover:hover) and (pointer:fine)').matches) $('#pq').focus(); }
function posSeg() {
  $$('.seg[data-k] button').forEach(b => b.classList.toggle('on', PF[b.parentElement.dataset.k] === b.dataset.v));
  $('#pon').hidden = PF.type !== 'online';
  posSum();
}
function posResults() {
  const el = $('#pres'); if (!el) return;
  const q = $('#pq').value.trim();
  let list, head = '';
  if (q) list = searchProducts(q).slice(0, 12);
  else {
    const sold = soldMap();
    list = products().filter(p => p.qty > 0).sort((a, b) => (sold[b.id] || 0) - (sold[a.id] || 0) || byName(a, b)).slice(0, 6);
    head = list.length ? '<div class="hint">الأكثر مبيعاً — أو ابحث عن أي منتج</div>' : '';
  }
  el.innerHTML = head + list.map(p => {
    const inCart = cart.find(c => c.pid === p.id)?.qty || 0;
    return `<button class="pitem" onclick="addToCart(${p.id})" ${p.qty <= 0 ? 'disabled' : ''}>${thumb(p)}<span class="pi-b"><b>${esc(p.name)}</b><small>${esc([p.brand, p.size, p.flavor].filter(Boolean).join(' · '))}</small><span class="pi-m"><span class="price">${money(p.price)}</span><span class="${p.qty <= 0 ? 'bad' : p.qty <= p.min ? 'warn' : 'muted'}">${p.qty <= 0 ? 'نافد' : 'متوفر: ' + p.qty}${inCart ? ` · بالسلة ${inCart}` : ''}</span></span></span><span class="plus">＋</span></button>`;
  }).join('') + (list.length ? '' : q ? empty('لا توجد نتائج') : products().length ? '' : empty('لا توجد منتجات بعد — أضف منتجات من صفحة المنتجات'));
}
function posEnter() {
  const q = $('#pq').value.trim(); if (!q) return;
  const code = digits(q), exact = products().find(p => p.barcode && p.barcode === code);
  const r = exact ? [exact] : searchProducts(q);
  if (r.length === 1) { addToCart(r[0].id); $('#pq').value = ''; posResults(); }
}
function addToCart(pid, goPos = false) {
  const p = P(pid); if (!p || p.deleted) return;
  const line = cart.find(c => c.pid === p.id), n = (line?.qty || 0) + 1;
  if (n > p.qty) return toast('الكمية المتوفرة غير كافية.', 'bad');
  if (line) line.qty = n; else cart.push({ pid: p.id, qty: 1 });
  saveCart();
  if (goPos) { toast(`أضيف إلى السلة: ${p.name}`, 'ok'); return go('pos'); }
  renderCart(); posSum(); posResults();
}
// Blur a focused field before replacing its container, so its change event can't fire mid-replace.
function blurInside(el) { const a = document.activeElement; if (a && a !== document.body && el.contains(a)) a.blur(); }
function renderCart() {
  const el = $('#pcart'); if (!el) return;
  blurInside(el);
  cart = cart.filter(c => P(c.pid) && !P(c.pid).deleted);
  el.innerHTML = cart.map((c, i) => {
    const p = P(c.pid);
    return `<div class="cline"><span class="cl-n"><b>${esc(p.name)}</b><small>${money(p.price)} للقطعة · متوفر ${p.qty}</small></span>
      <button class="x" onclick="cartDel(${i})" aria-label="حذف">✕</button>
      <span class="stepper"><button onclick="cartStep(${i},1)" aria-label="زيادة">＋</button><input value="${c.qty}" inputmode="numeric" oninput="cartType(${i},this)" onchange="cartSet(${i},this)" aria-label="الكمية"><button onclick="cartStep(${i},-1)" aria-label="إنقاص">－</button></span>
      <b class="cl-t">${money(p.price * c.qty)}</b></div>`;
  }).join('') || empty('السلة فارغة — ابحث عن منتج واضغط عليه');
}
function cartStep(i, d) { const c = cart[i], p = P(c.pid), n = c.qty + d; if (n < 1) return; if (n > p.qty) return toast('الكمية المتوفرة غير كافية.', 'bad'); c.qty = n; saveCart(); renderCart(); posSum(); posResults(); }
// Typed quantity: valid values apply live while typing. The change event (fired on blur, i.e. while the
// user is tapping something else) must not touch the DOM when nothing is wrong — Safari drops that tap.
function cartType(i, el) {
  const c = cart[i], p = P(c.pid), n = num(el.value);
  if (!Number.isInteger(n) || n < 1 || n > p.qty || n === c.qty) return;
  c.qty = n; saveCart();
  el.closest('.cline').querySelector('.cl-t').textContent = money(p.price * n);
  posSum();
}
function cartSet(i, el) {
  const c = cart[i], p = P(c.pid), n = num(el.value);
  if (Number.isInteger(n) && n === c.qty) return;
  if (!Number.isInteger(n) || n < 1) toast('الكمية يجب أن تكون رقماً صحيحاً أكبر من صفر', 'bad');
  else if (n > p.qty) { toast('الكمية المتوفرة غير كافية.', 'bad'); c.qty = p.qty; }
  else c.qty = n;
  saveCart(); el.value = c.qty; el.closest('.cline').querySelector('.cl-t').textContent = money(p.price * c.qty);
  posSum();
}
function cartDel(i) { cart.splice(i, 1); saveCart(); renderCart(); posSum(); posResults(); }
function cartClear() { cart = []; saveCart(); renderCart(); posSum(); posResults(); }
function custFill() {
  const ph = normPhone(PF.phone), c = ph && S.customers.find(x => !x.deleted && x.phone && normPhone(x.phone) === ph);
  if (!c) return;
  if (!PF.name) { PF.name = c.name; $('#o_nm').value = c.name; }
  if (!PF.address && c.address) { PF.address = c.address; $('#o_ad').value = c.address; }
}
function posTotals() {
  let sub = 0, cogs = 0;
  for (const c of cart) { const p = P(c.pid); if (!p) continue; sub += p.price * c.qty; cogs += p.cost * c.qty; }
  const on = PF.type === 'online', r = x => Math.round(num(x));
  const disc = r(PF.discount), fee = on ? r(PF.fee) : 0, dcost = on ? r(PF.dcost) : 0, total = sub - disc + fee;
  return { sub, cogs, disc, fee, dcost, total, profit: total - cogs - dcost, on };
}
function posSum() {
  const el = $('#psum'); if (!el) return;
  const t = posTotals(), bad = !(t.disc >= 0 && t.disc <= t.sub);
  el.innerHTML = `<div><span>المجموع (${cart.reduce((a, c) => a + c.qty, 0)} قطعة)</span><b>${money(t.sub)}</b></div>
    ${t.disc || bad ? `<div><span>الخصم</span><b class="${bad ? 'bad' : ''}">${bad ? 'قيمة غير صحيحة' : '− ' + money(t.disc)}</b></div>` : ''}
    ${t.on && t.fee ? `<div><span>التوصيل</span><b>${money(t.fee)}</b></div>` : ''}
    <div class="grand"><span>الإجمالي</span><b>${money(t.total)}</b></div>
    ${can('money') && cart.length ? `<div class="small"><span>التكلفة ${money(t.cogs)}${t.dcost ? ' + توصيل ' + money(t.dcost) : ''}</span><b class="${t.profit < 0 ? 'bad' : 'ok'}">الربح ${money(t.profit)}</b></div>` : ''}`;
  $('#pgo').textContent = cart.length ? `✅ تسجيل العملية · ${money(t.total)}` : '✅ تسجيل العملية';
}
function upsertCustomer(name, phone, address) {
  const ph = normPhone(phone);
  let c = ph && S.customers.find(x => !x.deleted && normPhone(x.phone) === ph);
  if (!c) { c = { id: nid(), name, phone: ph, address, notes: '', createdAt: nowISO() }; S.customers.push(c); }
  else { c.name = name || c.name; if (address) c.address = address; }
  return c;
}
function checkout() {
  if (!cart.length) return toast('السلة فارغة', 'bad');
  for (const c of cart) {
    const p = P(c.pid);
    if (!p || p.deleted) return toast('يوجد منتج محذوف في السلة', 'bad');
    if (!Number.isInteger(c.qty) || c.qty < 1) return toast('كمية غير صحيحة في السلة', 'bad');
    if (c.qty > p.qty) return toast(`الكمية المتوفرة غير كافية. (${p.name}: المتوفر ${p.qty})`, 'bad');
  }
  const t = posTotals();
  if (![t.disc, t.fee, t.dcost].every(x => Number.isFinite(x) && x >= 0)) return toast('تأكد من الأرقام — لا يمكن أن تكون سالبة', 'bad');
  if (t.disc > t.sub) return toast('الخصم أكبر من مجموع المنتجات', 'bad');
  let cust = null;
  if (t.on) {
    if (!PF.name.trim() || !PF.phone.trim()) return toast('أدخل اسم العميل ورقم الهاتف للطلب الأونلاين', 'bad');
    cust = upsertCustomer(PF.name.trim(), PF.phone.trim(), PF.address.trim());
  }
  const no = t.on ? 'ORD-' + pad(S.seq.order++) : 'INV-' + pad(S.seq.sale++), st = t.on ? 'طلب جديد' : 'مكتمل';
  const s = {
    id: nid(), no, type: t.on ? 'online' : 'store', date: today(), at: nowISO(),
    items: cart.map(c => { const p = P(c.pid); return { pid: p.id, name: p.name, qty: c.qty, price: p.price, cost: p.cost }; }),
    discount: t.disc, fee: t.fee, dcost: t.dcost, pay: PF.pay, notes: PF.notes.trim(), status: st,
    custId: cust?.id || null, cust: cust ? { name: cust.name, phone: cust.phone, address: PF.address.trim() || cust.address || '' } : null,
    user: ME.name, uid: ME.id, log: [{ st, at: nowISO(), user: ME.name }],
  };
  for (const i of s.items) move(P(i.pid), -i.qty, (t.on ? 'طلب أونلاين ' : 'بيع ') + no, no);
  S.sales.unshift(s);
  save();
  const warn = s.items.map(i => P(i.pid)).filter(p => p.qty <= p.min);
  cart = []; saveCart(); PF = PF0();
  render(); showReceipt(s.id);
  toast(`تم تسجيل ${no} ✅`, 'ok');
  warn.forEach(p => toast(p.qty <= 0 ? `🔴 المنتج نافد: ${p.name}` : `⚠️ المنتج قريب من النفاد: ${p.name} (${p.qty})`, 'warn'));
}

// ───────────── Receipt / invoice ─────────────
function receiptHtml(s) {
  const c = calc(s), rets = saleReturns(s), refunds = rets.reduce((a, r) => a + r.refund, 0), on = s.type === 'online', sh = S.shop;
  return `<div class="receipt" id="receipt">
    <div class="r-head">${logoHtml(58)}<h2>${esc(sh.name)}</h2>${sh.phone ? `<div dir="ltr">${esc(sh.phone)}</div>` : ''}${sh.address ? `<div>${esc(sh.address)}</div>` : ''}</div>
    <div class="r-title">${on ? 'طلب أونلاين' : 'فاتورة بيع'}${live(s) ? '' : ` <span class="r-void">${s.status}</span>`}</div>
    <div class="r-meta">
      <div><span>${on ? 'رقم الطلب' : 'رقم الفاتورة'}</span><b>${s.no}</b></div>
      <div><span>التاريخ</span><b dir="ltr">${fmtDT(s.at)}</b></div>
      <div><span>طريقة الدفع</span><b>${esc(s.pay)}</b></div>
      ${on ? `<div><span>حالة الطلب</span><b>${s.status}</b></div>` : `<div><span>البائع</span><b>${esc(s.user)}</b></div>`}
    </div>
    ${s.cust ? `<div class="r-cust"><b>العميل:</b> ${esc(s.cust.name)} · <span dir="ltr">${esc(s.cust.phone)}</span>${s.cust.address ? `<br><b>العنوان:</b> ${esc(s.cust.address)}` : ''}</div>` : ''}
    <table class="r-items"><thead><tr><th>المنتج</th><th>الكمية</th><th>السعر</th><th>المجموع</th></tr></thead>
      <tbody>${s.items.map(i => `<tr><td>${esc(i.name)}</td><td>${i.qty}</td><td>${fmtN(i.price)}</td><td>${fmtN(i.qty * i.price)}</td></tr>`).join('')}</tbody></table>
    <div class="r-tot">
      <div><span>المجموع</span><b>${money(c.sub)}</b></div>
      ${s.discount ? `<div><span>الخصم</span><b>− ${money(s.discount)}</b></div>` : ''}
      ${s.fee ? `<div><span>التوصيل</span><b>${money(s.fee)}</b></div>` : ''}
      <div class="grand"><span>الإجمالي</span><b>${money(c.total)}</b></div>
      ${refunds ? `<div><span>المرتجعات (${rets.length})</span><b>− ${money(refunds)}</b></div><div class="grand"><span>الصافي بعد المرتجعات</span><b>${money(c.total - refunds)}</b></div>` : ''}
    </div>
    ${rets.length ? `<div class="r-rets">${rets.map(r => `<div>↩️ ${r.no} · ${esc(r.name)} ×${r.qty} · ${money(r.refund)} · ${fmtDate(r.date)}</div>`).join('')}</div>` : ''}
    ${s.notes ? `<div class="r-notes">📝 ${esc(s.notes)}</div>` : ''}
    <div class="r-foot">${esc(sh.footer)}</div>
  </div>`;
}
function showReceipt(id) {
  const s = saleById(id); if (!s) return;
  const c = calc(s), on = s.type === 'online', rets = saleReturns(s);
  let h = receiptHtml(s) + `<div class="actions"><button class="btn" onclick="printReceipt()">🖨️ طباعة</button><button class="btn ghost" onclick="pdfReceipt(${s.id})">📄 تحميل PDF</button><button class="btn ghost" onclick="shareReceipt(${s.id})">📤 مشاركة</button></div>`;
  if (on) h += `<div class="card soft"><label class="fld"><span>حالة الطلب</span>${statusSelect(s)}</label>${(s.log || []).map(l => `<div class="logline">• ${l.st} — ${fmtDT(l.at)} — ${esc(l.user)}</div>`).join('')}</div>`;
  if (can('money')) {
    const lost = rets.reduce((a, r) => a + retLoss(r), 0);
    h += `<div class="card soft"><div class="card-h"><b>💼 التكلفة والربح — للإدارة فقط (لا تُطبع)</b></div>
      <div class="tbl"><table><tr><th>المنتج</th><th>الكمية</th><th>سعر الشراء</th><th>سعر البيع</th><th>الربح</th></tr>${s.items.map(i => `<tr><td>${esc(i.name)}</td><td>${i.qty}</td><td>${fmtN(i.cost)}</td><td>${fmtN(i.price)}</td><td>${fmtN(i.qty * (i.price - i.cost))}</td></tr>`).join('')}</table></div>
      <div class="kv-list"><div><span>إجمالي المبيعات</span><b>${money(c.total)}</b></div><div><span>تكلفة البضاعة</span><b>${money(c.cogs)}</b></div>
      ${s.discount ? `<div><span>الخصم</span><b>${money(s.discount)}</b></div>` : ''}
      ${on ? `<div><span>رسوم التوصيل (من العميل)</span><b>${money(s.fee)}</b></div><div><span>تكلفة التوصيل (علينا)</span><b>${money(s.dcost)}</b></div>` : ''}
      <div class="grand"><span>صافي ربح العملية</span><b class="${c.profit < 0 ? 'bad' : 'ok'}">${money(c.profit)}</b></div>
      ${rets.length ? `<div><span>أثر المرتجعات</span><b class="bad">− ${money(lost)}</b></div><div class="grand"><span>الربح بعد المرتجعات</span><b>${money(c.profit - lost)}</b></div>` : ''}
      ${!live(s) ? '<div class="small muted">هذه العملية ملغاة ولا تدخل في المبيعات أو الأرباح.</div>' : ''}</div></div>`;
  }
  const b = [];
  if (live(s) && can('returns')) b.push(`<button class="btn ghost" onclick="closeModal();go('ret?sale=${s.id}')">↩️ إرجاع منتج</button>`);
  if (!on && live(s) && can('del')) b.push(`<button class="btn danger" onclick="if(confirm('إلغاء الفاتورة سيعيد الكميات إلى المخزون ويحذفها من المبيعات. متأكد؟'))setStatus(${s.id},'ملغي')">إلغاء الفاتورة</button>`);
  if (!on && !live(s) && can('del')) b.push(`<button class="btn ghost" onclick="setStatus(${s.id},'مكتمل')">استعادة الفاتورة</button>`);
  if (b.length) h += `<div class="actions">${b.join('')}</div>`;
  h += `<button class="btn ghost block" onclick="closeModal()">إغلاق</button>`;
  openModal(h, () => showReceipt(id));
  if (navigator.canShare) makePDF(s).catch(() => { }); // ready in advance so sharing stays one tap
}
function printReceipt() { $('#print-area').innerHTML = $('#receipt').outerHTML.replace('id="receipt"', ''); window.print(); }
window.addEventListener('afterprint', () => { $('#print-area').innerHTML = ''; });
const LIBS = { h2c: 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js', pdf: 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js' };
const libP = {};
const loadLib = src => libP[src] ||= new Promise((res, rej) => {
  const el = document.createElement('script'); el.src = src; el.onload = res;
  el.onerror = () => { delete libP[src]; el.remove(); rej(new Error('تعذر تحميل أداة PDF — تأكد من الاتصال بالإنترنت')); };
  document.head.appendChild(el);
});
let pdfCache = { key: '', blob: null };
async function makePDF(s) {
  const key = s.id + ':' + S.updatedAt;
  if (pdfCache.key === key && pdfCache.blob) return pdfCache.blob;
  await Promise.all([loadLib(LIBS.h2c), loadLib(LIBS.pdf)]);
  const host = document.createElement('div');
  host.className = 'pdf-host'; host.innerHTML = receiptHtml(s).replace('id="receipt"', '');
  document.body.appendChild(host);
  try {
    const canvas = await html2canvas(host.firstElementChild, { scale: 2, backgroundColor: '#ffffff', logging: false });
    const w = 100, h = w * canvas.height / canvas.width;
    const pdf = new jspdf.jsPDF({ unit: 'mm', format: [w, h], orientation: h >= w ? 'portrait' : 'landscape' });
    pdf.addImage(canvas.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, w, h);
    const blob = pdf.output('blob');
    pdfCache = { key, blob };
    return blob;
  } finally { host.remove(); }
}
async function pdfReceipt(id) {
  const s = saleById(id);
  toast('جاري إنشاء PDF…');
  try { download(await makePDF(s), s.no + '.pdf'); } catch (e) { toast(e.message, 'bad'); }
}
function receiptText(s) {
  const c = calc(s);
  return [`${S.shop.name} — ${s.type === 'online' ? 'طلب' : 'فاتورة'} ${s.no}`, fmtDT(s.at), ...s.items.map(i => `• ${i.name} ×${i.qty} = ${money(i.qty * i.price)}`),
    s.discount ? `الخصم: ${money(s.discount)}` : '', s.fee ? `التوصيل: ${money(s.fee)}` : '', `الإجمالي: ${money(c.total)}`, `الدفع: ${s.pay}`, S.shop.footer].filter(Boolean).join('\n');
}
async function shareReceipt(id) {
  const s = saleById(id), text = receiptText(s);
  if (pdfCache.key === s.id + ':' + S.updatedAt && pdfCache.blob && navigator.canShare) {
    const file = new File([pdfCache.blob], s.no + '.pdf', { type: 'application/pdf' });
    if (navigator.canShare({ files: [file] })) { try { await navigator.share({ files: [file], title: s.no, text }); return; } catch (e) { if (e.name === 'AbortError') return; } }
  }
  if (navigator.share) { try { await navigator.share({ title: s.no, text }); return; } catch (e) { if (e.name === 'AbortError') return; } }
  window.open('https://wa.me/' + (s.cust ? waPhone(s.cust.phone) : '') + '?text=' + encodeURIComponent(text), '_blank');
}

// ───────────── Store sales & online orders ─────────────
const RANGES = [['today', 'اليوم'], ['7d', 'آخر 7 أيام'], ['month', 'هذا الشهر'], ['all', 'الكل']];
function rangeOf(k) { const t = today(); return k === 'today' ? [t, t] : k === '7d' ? [addDays(t, -6), t] : k === 'month' ? [monthStart(t), t] : ['0000-00-00', '9999-12-31']; }
function pStore() {
  return `<a class="btn block" href="#/pos">＋ بيع جديد</a>
  <div class="chips">${RANGES.map(([k, l]) => `<button class="chip ${UI.sr === k ? 'on' : ''}" onclick="UI.sr='${k}';render()">${l}</button>`).join('')}</div>
  <input class="mb" placeholder="🔍 رقم الفاتورة أو اسم المنتج" value="${esc(UI.sq)}" oninput="UI.sq=this.value;storeList()">
  <div id="slist"></div>`;
}
function storeList() {
  const [a, b] = rangeOf(UI.sr), q = digits(UI.sq).trim().toLowerCase();
  const l = S.sales.filter(s => s.type === 'store' && s.date >= a && s.date <= b && (!q || (s.no + ' ' + s.items.map(i => i.name).join(' ')).toLowerCase().includes(q)));
  let tot = 0, pf = 0;
  for (const s of l) if (live(s)) { const c = calc(s), lost = saleReturns(s).reduce((x, r) => x + retLoss(r), 0); tot += c.total - saleReturns(s).reduce((x, r) => x + r.refund, 0); pf += c.profit - lost; }
  $('#slist').innerHTML = `<div class="sumbar"><span>${l.length} فاتورة</span><b>${money(tot)}</b>${can('money') ? `<span class="ok">ربح ${money(pf)}</span>` : ''}</div>`
    + (l.map(s => saleCard(s)).join('') || empty('لا توجد مبيعات في هذه الفترة'));
}
function pOnline() {
  const cnt = {}; let all = 0;
  for (const s of S.sales) if (s.type === 'online') { cnt[s.status] = (cnt[s.status] || 0) + 1; all++; }
  const chips = [['all', 'الكل', all], ['active', 'قيد المتابعة', S.sales.filter(isPending).length], ...ONLINE_ST.map(x => [x, x, cnt[x] || 0])];
  return `<a class="btn block" href="#/pos?type=online">＋ طلب أونلاين جديد</a>
  <div class="chips scroll">${chips.map(([k, l, n]) => `<button class="chip ${UI.of === k ? 'on' : ''}" onclick="UI.of='${k}';render()">${l} <em>${n}</em></button>`).join('')}</div>
  <input class="mb" placeholder="🔍 رقم الطلب أو اسم العميل أو الهاتف" value="${esc(UI.oq)}" oninput="UI.oq=this.value;onlineList()">
  <div id="olist"></div>`;
}
function onlineList() {
  const q = digits(UI.oq).trim().toLowerCase();
  const l = S.sales.filter(s => s.type === 'online' && (UI.of === 'all' || (UI.of === 'active' ? isPending(s) : s.status === UI.of)) && (!q || [s.no, s.cust?.name, s.cust?.phone].join(' ').toLowerCase().includes(q)));
  let tot = 0, pf = 0;
  for (const s of l) if (live(s)) { const c = calc(s); tot += c.total - saleReturns(s).reduce((x, r) => x + r.refund, 0); pf += c.profit - saleReturns(s).reduce((x, r) => x + retLoss(r), 0); }
  $('#olist').innerHTML = `<div class="sumbar"><span>${l.length} طلب</span><b>${money(tot)}</b>${can('money') ? `<span class="ok">ربح ${money(pf)}</span>` : ''}</div>`
    + (l.map(s => saleCard(s, true)).join('') || empty('لا توجد طلبات'));
}

// ───────────── Products ─────────────
function pProd() {
  if (params.get('f')) UI.pf = params.get('f');
  const cats = [...new Set(products().map(p => p.cat).filter(Boolean))].sort();
  const opt = (cur, v, l) => `<option value="${esc(v)}" ${cur === v ? 'selected' : ''}>${esc(l)}</option>`;
  return `<div class="toolbar">
    <input id="prq" class="big" placeholder="🔍 الاسم أو الباركود أو البراند" value="${esc(UI.pq)}" oninput="UI.pq=this.value;prodList()" autocomplete="off">
    <div class="row">
      <select onchange="UI.pf=this.value;prodList()" aria-label="فلتر">${[['all', 'كل المنتجات'], ['low', '⚠️ قريبة من النفاد'], ['out', '🔴 نافدة'], ['exp', '⏳ قريبة الانتهاء']].map(([v, l]) => opt(UI.pf, v, l)).join('')}</select>
      <select onchange="UI.pc=this.value;prodList()" aria-label="التصنيف">${opt(UI.pc, '', 'كل التصنيفات')}${cats.map(c => opt(UI.pc, c, c)).join('')}</select>
      <select onchange="UI.ps=this.value;prodList()" aria-label="الترتيب">${[['name', 'ترتيب: الاسم'], ['qty', 'ترتيب: الكمية'], ['sales', 'ترتيب: المبيعات'], ['price', 'ترتيب: السعر'], ['exp', 'ترتيب: الصلاحية']].map(([v, l]) => opt(UI.ps, v, l)).join('')}</select>
    </div>
    ${can('stock') ? `<button class="btn block" onclick="productForm()">＋ إضافة منتج</button>` : ''}
  </div><div id="plist"></div>`;
}
function prodList() {
  const q = UI.pq.trim(), sold = UI.ps === 'sales' ? soldMap() : null;
  let l = q ? searchProducts(q) : products();
  if (UI.pf === 'low') l = l.filter(p => p.qty > 0 && p.qty <= p.min); else if (UI.pf === 'out') l = l.filter(p => p.qty <= 0); else if (UI.pf === 'exp') l = l.filter(p => expState(p));
  if (UI.pc) l = l.filter(p => p.cat === UI.pc);
  const so = UI.ps;
  l = [...l].sort(so === 'qty' ? (a, b) => a.qty - b.qty : so === 'sales' ? (a, b) => (sold[b.id] || 0) - (sold[a.id] || 0) : so === 'price' ? (a, b) => b.price - a.price : so === 'exp' ? (a, b) => (a.exp || '9999').localeCompare(b.exp || '9999') : byName);
  $('#plist').innerHTML = `<div class="muted small mb">${l.length} منتج</div><div class="pgrid">${l.map(p => `<button class="pcard" onclick="productView(${p.id})">${thumb(p)}<b>${esc(p.name)}</b><small>${esc([p.brand, p.size, p.flavor].filter(Boolean).join(' · '))}</small><span class="price">${money(p.price)}</span><span class="small">الكمية: <b>${p.qty}</b>${sold ? ` · مبيع ${sold[p.id] || 0}` : ''}</span>${stockBadge(p)}${expBadge(p)}</button>`).join('')}</div>`
    + (l.length ? '' : empty(products().length ? 'لا توجد نتائج' : 'لا توجد منتجات بعد'));
}
function productView(id) {
  const p = P(id); if (!p) return;
  const sold = soldMap()[p.id] || 0, mv = S.moves.filter(m => m.pid === p.id).slice(0, 8);
  openModal(`<div class="pview">${thumb(p, 'lg')}<div><h3>${esc(p.name)}</h3><div class="muted small">${esc([p.brand, p.cat, p.size, p.flavor].filter(Boolean).join(' · '))}</div>${stockBadge(p)} ${expBadge(p)}</div></div>
  <div class="kv-list">
    <div><span>سعر البيع</span><b>${money(p.price)}</b></div>
    ${seeCost() ? `<div><span>سعر الشراء</span><b>${money(p.cost)}</b></div><div><span>الربح للقطعة</span><b>${money(p.price - p.cost)}</b></div>` : ''}
    <div><span>الكمية الحالية</span><b>${p.qty}</b></div><div><span>الحد الأدنى للمخزون</span><b>${p.min}</b></div>
    ${p.barcode ? `<div><span>الباركود</span><b dir="ltr">${esc(p.barcode)}</b></div>` : ''}
    ${p.exp ? `<div><span>انتهاء الصلاحية</span><b>${fmtDate(p.exp)}</b></div>` : ''}
    <div><span>إجمالي المُباع</span><b>${sold} قطعة</b></div>
    ${p.notes ? `<div><span>ملاحظات</span><b>${esc(p.notes)}</b></div>` : ''}
  </div>
  <div class="actions">
    ${p.qty > 0 ? `<button class="btn" onclick="closeModal();addToCart(${p.id},true)">🛒 بيع</button>` : ''}
    ${can('stock') ? `<button class="btn ghost" onclick="productForm(${p.id})">✏️ تعديل</button><button class="btn ghost" onclick="adjForm(${p.id})">📦 تعديل المخزون</button>` : ''}
    ${can('del') ? `<button class="btn danger" onclick="delProduct(${p.id})">🗑️ حذف</button>` : ''}
  </div>
  ${mv.length ? `<div class="card-h"><b>آخر حركات المخزون</b></div>${moveRows(mv)}` : ''}
  <button class="btn ghost block" onclick="closeModal()">إغلاق</button>`);
}
let FIMG = '';
const imgPrev = () => FIMG ? `<img class="thumb" src="${esc(FIMG)}" alt="">` : '<span class="thumb ph">💪</span>';
function productForm(id) {
  if (!can('stock')) return toast('ليس لديك صلاحية تعديل المنتجات', 'bad');
  const p = id ? P(id) : { min: S.shop.defMin };
  FIMG = p.img || '';
  openModal(`<h3>${id ? '✏️ تعديل منتج' : '＋ منتج جديد'}</h3>
  <div class="imgpick"><span id="fimg">${imgPrev()}</span><span class="row"><label class="btn ghost sm">📷 صورة المنتج<input type="file" accept="image/*" hidden onchange="pickImg(this)"></label><button class="btn ghost sm" onclick="FIMG='';$('#fimg').innerHTML=imgPrev()">إزالة</button></span></div>
  <div class="form2">
    ${fld('f_name', 'اسم المنتج *', p.name, { full: true })}
    ${fld('f_brand', 'الشركة / Brand', p.brand)}
    ${fld('f_cat', 'التصنيف', p.cat, { list: 'catdl' })}
    ${fld('f_size', 'الحجم / الوزن', p.size)}
    ${fld('f_flavor', 'النكهة', p.flavor)}
    ${fld('f_bc', 'الباركود', p.barcode, { attrs: 'inputmode="numeric" autocomplete="off"' })}
    ${fld('f_exp', 'تاريخ انتهاء الصلاحية', p.exp, { type: 'date' })}
    ${fld('f_cost', 'سعر الشراء / الجملة *', p.cost, { num: true })}
    ${fld('f_price', 'سعر البيع *', p.price, { num: true })}
    ${id ? `<label class="fld"><span>الكمية الحالية</span><input value="${p.qty}" disabled></label>` : fld('f_qty', 'الكمية الافتتاحية', 0, { num: true })}
    ${fld('f_min', 'الحد الأدنى للمخزون', p.min, { num: true })}
    <label class="fld full"><span>ملاحظات</span><textarea id="f_notes">${esc(p.notes || '')}</textarea></label>
  </div>
  ${id ? '<div class="hint">لتغيير الكمية استخدم «تعديل المخزون» أو «المشتريات» حتى يُسجَّل السبب ومن قام بالتغيير.</div>' : ''}
  <datalist id="catdl">${[...new Set([...CATS, ...products().map(x => x.cat).filter(Boolean)])].map(c => `<option value="${esc(c)}">`).join('')}</datalist>
  <div class="actions"><button class="btn" onclick="saveProduct(${id || 0})">💾 حفظ</button><button class="btn ghost" onclick="closeModal()">إلغاء</button></div>`);
}
async function pickImg(inp) {
  const f = inp.files[0]; if (!f) return;
  try { FIMG = await readImage(f, 480); $('#fimg').innerHTML = imgPrev(); } catch (e) { toast(e.message, 'bad'); }
}
function saveProduct(id) {
  const name = val('f_name');
  if (!name) return toast('أدخل اسم المنتج', 'bad');
  const cost = num(val('f_cost')), price = num(val('f_price')), min = num(val('f_min')), q0 = id ? 0 : num(val('f_qty'));
  if (![cost, price, min, q0].every(x => Number.isFinite(x) && x >= 0)) return toast('تأكد من الأرقام — لا يمكن أن تكون سالبة', 'bad');
  if (!Number.isInteger(min) || !Number.isInteger(q0)) return toast('الكمية والحد الأدنى يجب أن تكون أرقاماً صحيحة', 'bad');
  if (!price) return toast('أدخل سعر البيع', 'bad');
  const bcode = digits(val('f_bc'));
  if (bcode && products().some(x => x.barcode === bcode && x.id !== id)) return toast('هذا الباركود مستخدم لمنتج آخر', 'bad');
  if (price < cost && !confirm('سعر البيع أقل من سعر الشراء — هل تريد المتابعة؟')) return;
  const d = { name, brand: val('f_brand'), cat: val('f_cat'), size: val('f_size'), flavor: val('f_flavor'), barcode: bcode, cost: Math.round(cost), price: Math.round(price), min, exp: val('f_exp'), notes: val('f_notes'), img: FIMG };
  if (id) Object.assign(P(id), d);
  else { const p = { id: nid(), ...d, qty: 0, createdAt: nowISO() }; S.products.push(p); if (q0) move(p, q0, 'رصيد افتتاحي'); }
  save(); closeModal(); toast('تم حفظ المنتج', 'ok'); render();
}
function delProduct(id) {
  if (!can('del')) return;
  const p = P(id);
  if (!confirm(`حذف المنتج «${p.name}»؟`)) return;
  // Products with history are hidden, not erased, so old invoices and reports stay correct.
  const used = S.sales.some(s => s.items.some(i => i.pid === p.id)) || S.purchases.some(x => x.items.some(i => i.pid === p.id));
  if (used) p.deleted = true; else S.products = S.products.filter(x => x.id !== p.id);
  cart = cart.filter(c => c.pid !== p.id); saveCart();
  save(); closeModal(); toast('تم حذف المنتج', 'ok'); render();
}

// ───────────── Inventory ─────────────
const ADJ = { add: 'إضافة كمية', damage: 'تالف', lost: 'مفقود', expired: 'منتهي الصلاحية', count: 'جرد (تعيين الكمية الفعلية)' };
function pInv() {
  const ps = products(), sm = seeCost();
  const low = ps.filter(p => p.qty > 0 && p.qty <= p.min).length, out = ps.filter(p => p.qty <= 0).length;
  const vc = ps.reduce((a, p) => a + Math.max(0, p.qty) * p.cost, 0), vs = ps.reduce((a, p) => a + Math.max(0, p.qty) * p.price, 0);
  return `<div class="kpis">${kpi('📦', 'إجمالي القطع', ps.reduce((a, p) => a + Math.max(0, p.qty), 0), `${ps.length} منتج`, 'y')}${kpi('⚠️', 'قريبة من النفاد', low, '', 'y', 'prod?f=low', low ? 'warn' : '')}${kpi('🔴', 'نافدة', out, '', 'r', 'prod?f=out', out ? 'bad' : '')}${sm ? kpi('🏷️', 'القيمة بسعر الشراء', money(vc), '', 'b') + kpi('💎', 'القيمة بسعر البيع', money(vs), '', 'p') : ''}</div>
  ${can('stock') ? `<div class="actions"><a class="btn" href="#/pur">🚚 شراء بضاعة</a><button class="btn ghost" onclick="adjForm(0,'add')">➕ إضافة كمية</button><button class="btn ghost" onclick="adjForm(0,'damage')">🗑️ تالف / مفقود</button><button class="btn ghost" onclick="adjForm(0,'count')">📋 جرد</button></div>` : ''}
  <div class="card"><div class="card-h"><b>المخزون الحالي</b></div><input class="mb" placeholder="🔍 بحث" value="${esc(UI.iq)}" oninput="UI.iq=this.value;invTable()"><div id="itbl"></div></div>
  <div class="card"><div class="card-h"><b>🧾 سجل حركة المخزون</b></div>
    <div class="row mb"><select onchange="UI.mp=this.value;UI.ml=100;moveLog()" aria-label="المنتج"><option value="">كل المنتجات</option>${S.products.slice().sort(byName).map(p => `<option value="${p.id}" ${String(p.id) === UI.mp ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
    <select onchange="UI.mt=this.value;UI.ml=100;moveLog()" aria-label="النوع"><option value="">كل الحركات</option><option value="in" ${UI.mt === 'in' ? 'selected' : ''}>إضافات (+)</option><option value="out" ${UI.mt === 'out' ? 'selected' : ''}>خصومات (−)</option></select></div>
    <div id="mvlog"></div></div>`;
}
function invTable() {
  const q = UI.iq.trim(), sm = seeCost();
  const l = (q ? searchProducts(q) : products()).sort((a, b) => a.qty - b.qty || byName(a, b));
  $('#itbl').innerHTML = l.map(p => `<button class="lrow" onclick="productView(${p.id})">${thumb(p)}<div><b>${esc(p.name)}</b><small>الحد الأدنى ${p.min}${sm ? ` · القيمة ${money(Math.max(0, p.qty) * p.cost)}` : ''}</small></div><div class="iq ${p.qty <= 0 ? 'bad' : p.qty <= p.min ? 'warn' : ''}"><b>${p.qty}</b><small>قطعة</small></div></button>`).join('') || empty('لا توجد منتجات');
}
function moveLog() {
  const l = S.moves.filter(m => (!UI.mp || m.pid === +UI.mp) && (!UI.mt || (UI.mt === 'in' ? m.qty > 0 : m.qty < 0)));
  $('#mvlog').innerHTML = (moveRows(l.slice(0, UI.ml)) || empty('لا توجد حركات بعد')) + (l.length > UI.ml ? `<button class="btn ghost block" onclick="UI.ml+=100;moveLog()">عرض المزيد (${l.length - UI.ml})</button>` : '');
}
function adjForm(pid, type = 'add') {
  if (!can('stock')) return toast('ليس لديك صلاحية تعديل المخزون', 'bad');
  if (!products().length) return toast('أضف منتجات أولاً', 'bad');
  openModal(`<h3>📦 تعديل المخزون</h3>
  <label class="fld"><span>المنتج</span><select id="aj_p" onchange="adjHint()">${products().sort(byName).map(p => `<option value="${p.id}" ${p.id === pid ? 'selected' : ''}>${esc(p.name)} (${p.qty})</option>`).join('')}</select></label>
  <label class="fld"><span>نوع الحركة</span><select id="aj_t" onchange="adjHint()">${Object.entries(ADJ).map(([k, l]) => `<option value="${k}" ${k === type ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
  ${fld('aj_q', 'الكمية', '', { num: true })}${fld('aj_n', 'السبب / ملاحظات', '')}
  <div id="aj_h" class="hint"></div>
  <div class="actions"><button class="btn" onclick="saveAdj()">💾 حفظ</button><button class="btn ghost" onclick="closeModal()">إلغاء</button></div>`);
  adjHint();
}
function adjHint() {
  const p = P(val('aj_p')), t = val('aj_t');
  $('#aj_q').previousElementSibling.textContent = t === 'count' ? 'الكمية الفعلية الموجودة' : 'الكمية';
  $('#aj_h').textContent = p ? `الكمية الحالية بالنظام: ${p.qty}` : '';
}
function saveAdj() {
  const p = P(val('aj_p')), t = val('aj_t'), n = num(val('aj_q')), note = val('aj_n');
  if (!p) return toast('اختر المنتج', 'bad');
  if (!Number.isInteger(n) || n < 0 || (t !== 'count' && n < 1)) return toast('أدخل كمية صحيحة', 'bad');
  const d = t === 'count' ? n - p.qty : t === 'add' ? n : -n;
  if (!d) return toast('لا يوجد تغيير في الكمية', 'bad');
  if (p.qty + d < 0) return toast('الكمية المتوفرة غير كافية.', 'bad');
  move(p, d, (t === 'count' ? `جرد: ${p.qty} → ${n}` : ADJ[t]) + (note ? ' — ' + note : ''));
  save(); closeModal(); toast('تم تحديث المخزون', 'ok'); render();
}

// ───────────── Purchases & suppliers ─────────────
const PB0 = () => ({ sid: '', newName: '', newPhone: '', date: today(), inv: '', items: [], paid: '', touched: false, notes: '' });
let PB = PB0();
function pPur() {
  return `<div class="card"><div class="card-h"><b>🚚 تسجيل شراء بضاعة جديدة</b></div>
    <div class="form2">
      <label class="fld"><span>المورد</span><select id="pb_s" onchange="PB.sid=this.value;$('#pb_new').hidden=this.value!=='new'"><option value="">— بدون مورد —</option>${S.suppliers.filter(x => !x.deleted).map(x => `<option value="${x.id}" ${String(x.id) === String(PB.sid) ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}<option value="new" ${PB.sid === 'new' ? 'selected' : ''}>＋ مورد جديد…</option></select></label>
      ${fld('pb_d', 'التاريخ', PB.date, { type: 'date', attrs: 'onchange="PB.date=this.value"' })}
      <div id="pb_new" class="form2 full" ${PB.sid === 'new' ? '' : 'hidden'}>${fld('pb_nn', 'اسم المورد الجديد', PB.newName, { attrs: 'oninput="PB.newName=this.value"' })}${fld('pb_np', 'هاتف المورد', PB.newPhone, { attrs: 'inputmode="tel" oninput="PB.newPhone=this.value"' })}</div>
      ${fld('pb_i', 'رقم فاتورة المورد', PB.inv, { full: true, attrs: 'oninput="PB.inv=this.value"' })}
    </div>
    <div class="lbl">المنتجات المشتراة</div>
    <div class="pb-add">
      <select id="pb_p" onchange="pbPick()" aria-label="المنتج"><option value="">— اختر منتجاً —</option>${products().sort(byName).map(p => `<option value="${p.id}">${esc(p.name)} (${p.qty})</option>`).join('')}</select>
      <input id="pb_q" inputmode="numeric" placeholder="الكمية" aria-label="الكمية">
      <input id="pb_c" inputmode="numeric" placeholder="سعر الشراء" aria-label="سعر الشراء">
      <button class="btn ghost" onclick="pbAdd()">＋ إضافة للقائمة</button>
    </div>
    <div id="pb_items"></div>
    <div class="form2">${fld('pb_paid', 'المبلغ المدفوع للمورد', PB.paid, { num: true, attrs: 'oninput="PB.paid=this.value;PB.touched=true;pbSum()"' })}${fld('pb_n', 'ملاحظات', PB.notes, { attrs: 'oninput="PB.notes=this.value"' })}</div>
    <div id="pb_sum" class="sum"></div>
    <button class="btn block lg" onclick="savePurchase()">💾 حفظ الشراء وإضافة للمخزون</button>
  </div>
  <div class="card"><div class="card-h"><b>📜 سجل المشتريات</b></div>${S.purchases.map(x => { const sup = S.suppliers.find(y => y.id === x.supplierId); return `<div class="scard" onclick="purView(${x.id})"><div class="sc-row"><b>🚚 ${x.no}</b>${x.total - x.paid > 0 ? `<span class="badge warn">متبقي ${money(x.total - x.paid)}</span>` : '<span class="badge ok">مدفوع</span>'}</div><div class="sc-items">${esc(x.items.map(i => i.name + ' ×' + i.qty).join('، '))}</div><div class="sc-row"><span class="muted small">${fmtDate(x.date)}${sup ? ' · ' + esc(sup.name) : ''}${x.inv ? ' · فاتورة ' + esc(x.inv) : ''}</span><b>${money(x.total)}</b></div></div>`; }).join('') || empty('لا توجد مشتريات بعد')}</div>`;
}
function pbPick() { const p = P(val('pb_p')); if (p) { $('#pb_c').value = p.cost || ''; $('#pb_q').focus(); } }
function pbAdd() {
  const p = P(val('pb_p')), q = num(val('pb_q')), c = num(val('pb_c'));
  if (!p) return toast('اختر المنتج', 'bad');
  if (!Number.isInteger(q) || q < 1) return toast('أدخل كمية صحيحة', 'bad');
  if (!Number.isFinite(c) || c < 0) return toast('أدخل سعر شراء صحيح', 'bad');
  const ex = PB.items.find(i => i.pid === p.id && i.cost === Math.round(c));
  if (ex) ex.qty += q; else PB.items.push({ pid: p.id, qty: q, cost: Math.round(c) });
  $('#pb_p').value = ''; $('#pb_q').value = ''; $('#pb_c').value = '';
  pbItems(); pbSum();
}
function pbItems() {
  $('#pb_items').innerHTML = PB.items.map((i, k) => `<div class="cline"><span class="cl-n"><b>${esc(P(i.pid)?.name)}</b><small>${i.qty} × ${money(i.cost)}</small></span><button class="x" onclick="PB.items.splice(${k},1);pbItems();pbSum()" aria-label="حذف">✕</button><b class="cl-t">${money(i.qty * i.cost)}</b></div>`).join('') || empty('أضف المنتجات المشتراة');
}
function pbSum() {
  const t = PB.items.reduce((a, i) => a + i.qty * i.cost, 0);
  if (!PB.touched) { PB.paid = t ? String(t) : ''; const el = $('#pb_paid'); if (el) el.value = PB.paid; }
  const paid = num(PB.paid);
  $('#pb_sum').innerHTML = `<div><span>إجمالي الفاتورة</span><b>${money(t)}</b></div><div><span>المدفوع</span><b>${money(paid)}</b></div><div class="grand"><span>المتبقي للمورد</span><b class="${t - paid > 0 ? 'warn' : ''}">${money(t - paid)}</b></div>`;
}
function savePurchase() {
  if (val('pb_p') && val('pb_q')) { pbAdd(); if (val('pb_p')) return; }
  if (!PB.items.length) return toast('أضف منتجاً واحداً على الأقل', 'bad');
  const total = PB.items.reduce((a, i) => a + i.qty * i.cost, 0), paid = num(PB.paid);
  if (!Number.isFinite(paid) || paid < 0 || paid > total) return toast('المبلغ المدفوع يجب أن يكون بين 0 وإجمالي الفاتورة', 'bad');
  let sid = PB.sid;
  if (sid === 'new') {
    if (!PB.newName.trim()) return toast('أدخل اسم المورد الجديد', 'bad');
    const sup = { id: nid(), name: PB.newName.trim(), phone: normPhone(PB.newPhone), company: '', notes: '', createdAt: nowISO() };
    S.suppliers.push(sup); sid = sup.id;
  }
  sid = sid ? +sid : null;
  const no = 'PUR-' + pad(S.seq.pur++), sup = S.suppliers.find(x => x.id === sid);
  for (const i of PB.items) {
    const p = P(i.pid), old = Math.max(0, p.qty);
    p.cost = old + i.qty > 0 ? Math.round((old * p.cost + i.qty * i.cost) / (old + i.qty)) : i.cost; // weighted average cost
    move(p, i.qty, `شراء ${no}${sup ? ' من ' + sup.name : ''}`, no);
  }
  S.purchases.unshift({ id: nid(), no, supplierId: sid, date: PB.date || today(), inv: PB.inv.trim(), items: PB.items.map(i => ({ ...i, name: P(i.pid).name })), total, paid: Math.round(paid), notes: PB.notes.trim(), at: nowISO(), user: ME.name });
  PB = PB0(); save(); toast(`تم حفظ ${no} وإضافة الكميات للمخزون`, 'ok'); render();
}
function purView(id) {
  const x = S.purchases.find(y => y.id === id), sup = S.suppliers.find(y => y.id === x.supplierId);
  openModal(`<h3>🚚 ${x.no}</h3><div class="kv-list"><div><span>التاريخ</span><b>${fmtDate(x.date)}</b></div><div><span>المورد</span><b>${esc(sup?.name || '—')}</b></div>${x.inv ? `<div><span>رقم فاتورة المورد</span><b>${esc(x.inv)}</b></div>` : ''}<div><span>سجّلها</span><b>${esc(x.user)}</b></div></div>
  <div class="tbl"><table><tr><th>المنتج</th><th>الكمية</th><th>سعر الشراء</th><th>المجموع</th></tr>${x.items.map(i => `<tr><td>${esc(i.name)}</td><td>${i.qty}</td><td>${fmtN(i.cost)}</td><td>${fmtN(i.qty * i.cost)}</td></tr>`).join('')}</table></div>
  <div class="kv-list"><div class="grand"><span>الإجمالي</span><b>${money(x.total)}</b></div><div><span>المدفوع عند الشراء</span><b>${money(x.paid)}</b></div></div>${x.notes ? `<p class="small">📝 ${esc(x.notes)}</p>` : ''}
  <div class="actions">${can('del') ? `<button class="btn danger" onclick="delPurchase(${x.id})">🗑️ حذف الشراء</button>` : ''}<button class="btn ghost" onclick="closeModal()">إغلاق</button></div>`);
}
function delPurchase(id) {
  const x = S.purchases.find(y => y.id === id);
  for (const i of x.items) { const p = P(i.pid); if (!p || p.qty < i.qty) return toast(`لا يمكن الحذف: جزء من «${i.name}» تم بيعه أو تعديله`, 'bad'); }
  if (!confirm(`حذف ${x.no}؟ سيتم خصم كمياته من المخزون.`)) return;
  for (const i of x.items) move(P(i.pid), -i.qty, `حذف الشراء ${x.no}`, x.no);
  S.purchases = S.purchases.filter(y => y.id !== id);
  save(); closeModal(); toast('تم حذف الشراء', 'ok'); render();
}
function supStats(id) {
  const pu = S.purchases.filter(x => x.supplierId === id), pays = S.supPays.filter(x => x.supplierId === id);
  const total = pu.reduce((a, x) => a + x.total, 0), paid = pu.reduce((a, x) => a + x.paid, 0) + pays.reduce((a, x) => a + x.amount, 0);
  return { pu, pays, total, paid, due: total - paid, prods: [...new Set(pu.flatMap(x => x.items.map(i => i.name)))] };
}
function pSup() {
  const l = S.suppliers.filter(x => !x.deleted).map(x => ({ x, st: supStats(x.id) })), due = l.reduce((a, y) => a + y.st.due, 0);
  return `<button class="btn block" onclick="supForm()">＋ إضافة مورد</button>
  ${l.length ? `<div class="sumbar"><span>${l.length} مورد</span><span>المتبقي للموردين: <b class="${due > 0 ? 'warn' : ''}">${money(due)}</b></span></div>` : ''}
  ${l.map(({ x, st }) => `<div class="scard" onclick="supView(${x.id})"><div class="sc-row"><b>🤝 ${esc(x.name)}</b>${st.due > 0 ? `<span class="badge warn">متبقي ${money(st.due)}</span>` : '<span class="badge ok">مسدد</span>'}</div>
    ${x.company ? `<div class="small muted">🏢 ${esc(x.company)}</div>` : ''}${x.phone ? `<div class="small"><a dir="ltr" href="tel:${esc(x.phone)}" onclick="event.stopPropagation()">📞 ${esc(x.phone)}</a></div>` : ''}
    <div class="small muted">📦 ${esc(st.prods.join('، ') || 'لا توجد مشتريات بعد')}</div>
    <div class="sc-row small"><span>المشتريات: <b>${money(st.total)}</b></span><span>المدفوع: <b>${money(st.paid)}</b></span></div>${x.notes ? `<div class="small muted">📝 ${esc(x.notes)}</div>` : ''}</div>`).join('') || empty('لا يوجد موردون بعد')}`;
}
function supForm(id) {
  const x = id ? S.suppliers.find(y => y.id === id) : {};
  openModal(`<h3>${id ? 'تعديل مورد' : 'مورد جديد'}</h3>${fld('sp_n', 'اسم المورد *', x.name)}${fld('sp_p', 'رقم الهاتف', x.phone, { attrs: 'inputmode="tel"' })}${fld('sp_c', 'الشركة', x.company)}${fld('sp_x', 'ملاحظات', x.notes)}
  <div class="actions"><button class="btn" onclick="saveSup(${id || 0})">💾 حفظ</button><button class="btn ghost" onclick="closeModal()">إلغاء</button></div>`);
}
function saveSup(id) {
  const name = val('sp_n'); if (!name) return toast('أدخل اسم المورد', 'bad');
  const d = { name, phone: normPhone(val('sp_p')), company: val('sp_c'), notes: val('sp_x') };
  if (id) Object.assign(S.suppliers.find(y => y.id === id), d); else S.suppliers.push({ id: nid(), ...d, createdAt: nowISO() });
  save(); closeModal(); toast('تم الحفظ', 'ok'); render();
}
function supView(id) {
  const x = S.suppliers.find(y => y.id === id), st = supStats(id);
  openModal(`<h3>🤝 ${esc(x.name)}</h3><div class="kv-list">${x.company ? `<div><span>الشركة</span><b>${esc(x.company)}</b></div>` : ''}${x.phone ? `<div><span>الهاتف</span><b><a dir="ltr" href="tel:${esc(x.phone)}">${esc(x.phone)}</a></b></div>` : ''}
    <div><span>المنتجات التي يوردها</span><b>${esc(st.prods.join('، ') || '—')}</b></div><div><span>إجمالي المشتريات</span><b>${money(st.total)}</b></div><div><span>المبالغ المدفوعة</span><b>${money(st.paid)}</b></div>
    <div class="grand"><span>المبالغ المتبقية</span><b class="${st.due > 0 ? 'warn' : 'ok'}">${money(st.due)}</b></div>${x.notes ? `<div><span>ملاحظات</span><b>${esc(x.notes)}</b></div>` : ''}</div>
  <div class="actions">${st.due > 0 ? `<button class="btn" onclick="supPay(${id})">💵 تسجيل دفعة</button>` : ''}<button class="btn ghost" onclick="supForm(${id})">✏️ تعديل</button>${can('del') ? `<button class="btn danger" onclick="delSup(${id})">حذف</button>` : ''}</div>
  ${st.pays.length ? `<div class="card-h"><b>الدفعات</b></div>${st.pays.map(p => `<div class="mrow"><span class="mq ok">💵</span><div><b>${money(p.amount)}</b><small>${fmtDate(p.date)}${p.notes ? ' · ' + esc(p.notes) : ''} · ${esc(p.user || '')}</small></div></div>`).join('')}` : ''}
  <div class="card-h"><b>المشتريات</b></div>${st.pu.map(p => `<div class="mrow"><span class="mq">🚚</span><div><b>${p.no} · ${money(p.total)}</b><small>${fmtDate(p.date)} · ${esc(p.items.map(i => i.name + ' ×' + i.qty).join('، '))}</small></div></div>`).join('') || empty('لا توجد مشتريات')}
  <button class="btn ghost block" onclick="closeModal()">إغلاق</button>`);
}
function supPay(id) {
  const st = supStats(id);
  openModal(`<h3>💵 دفعة للمورد</h3><p class="muted">المتبقي: <b>${money(st.due)}</b></p>${fld('pp_a', 'المبلغ', st.due, { num: true })}${fld('pp_d', 'التاريخ', today(), { type: 'date' })}${fld('pp_n', 'ملاحظات', '')}
  <div class="actions"><button class="btn" onclick="savePay(${id})">💾 حفظ</button><button class="btn ghost" onclick="supView(${id})">رجوع</button></div>`);
}
function savePay(id) {
  const a = num(val('pp_a')), st = supStats(id);
  if (!Number.isFinite(a) || a <= 0 || a > st.due) return toast(`المبلغ يجب أن يكون بين 1 و ${fmtN(st.due)}`, 'bad');
  S.supPays.unshift({ id: nid(), supplierId: id, amount: Math.round(a), date: val('pp_d') || today(), notes: val('pp_n'), at: nowISO(), user: ME.name });
  save(); toast('تم تسجيل الدفعة', 'ok'); render(); supView(id);
}
function delSup(id) {
  const x = S.suppliers.find(y => y.id === id);
  if (!confirm(`حذف المورد «${x.name}»؟`)) return;
  if (S.purchases.some(p => p.supplierId === id)) x.deleted = true; else S.suppliers = S.suppliers.filter(y => y.id !== id);
  save(); closeModal(); toast('تم الحذف', 'ok'); render();
}

// ───────────── Customers ─────────────
function custStats(c) {
  const os = S.sales.filter(s => s.custId === c.id), lv = os.filter(live);
  let total = 0;
  for (const s of lv) total += calc(s).total - saleReturns(s).reduce((a, r) => a + r.refund, 0);
  return { os, n: lv.length, total, last: os[0]?.at };
}
function pCust() {
  return `<div class="toolbar"><input placeholder="🔍 الاسم أو الهاتف أو العنوان" value="${esc(UI.cq)}" oninput="UI.cq=this.value;custList()"><button class="btn" onclick="custForm()">＋ إضافة عميل</button></div><div id="clist"></div>`;
}
function custList() {
  const q = digits(UI.cq).trim().toLowerCase();
  const l = S.customers.filter(c => !c.deleted && (!q || [c.name, c.phone, c.address].join(' ').toLowerCase().includes(q))).map(c => ({ c, st: custStats(c) })).sort((a, b) => (b.st.last || '').localeCompare(a.st.last || ''));
  $('#clist').innerHTML = l.map(({ c, st }) => `<div class="scard" onclick="custView(${c.id})"><div class="sc-row"><b>👤 ${esc(c.name)}</b><span class="badge blue">${st.n} طلب</span></div>
    ${c.phone ? `<div class="small"><a dir="ltr" href="tel:${esc(c.phone)}" onclick="event.stopPropagation()">📞 ${esc(c.phone)}</a> · <a href="https://wa.me/${waPhone(c.phone)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">WhatsApp</a></div>` : ''}
    ${c.address ? `<div class="small muted">📍 ${esc(c.address)}</div>` : ''}
    <div class="sc-row"><span class="muted small">آخر طلب: ${st.last ? fmtDate(ymd(new Date(st.last))) : '—'}</span><b>${money(st.total)}</b></div>${c.notes ? `<div class="small muted">📝 ${esc(c.notes)}</div>` : ''}</div>`).join('')
    || empty('لا يوجد عملاء بعد — يُضاف العملاء تلقائياً مع الطلبات الأونلاين');
}
function custForm(id) {
  const c = id ? S.customers.find(x => x.id === id) : {};
  openModal(`<h3>${id ? 'تعديل عميل' : 'عميل جديد'}</h3>${fld('c_n', 'الاسم *', c.name)}${fld('c_p', 'الهاتف', c.phone, { attrs: 'inputmode="tel"' })}${fld('c_a', 'العنوان', c.address)}${fld('c_x', 'ملاحظات', c.notes)}
  <div class="actions"><button class="btn" onclick="saveCust(${id || 0})">💾 حفظ</button><button class="btn ghost" onclick="closeModal()">إلغاء</button></div>`);
}
function saveCust(id) {
  const name = val('c_n'), phone = normPhone(val('c_p'));
  if (!name) return toast('أدخل اسم العميل', 'bad');
  if (phone && S.customers.some(c => !c.deleted && c.id !== id && normPhone(c.phone) === phone)) return toast('رقم الهاتف مسجل لعميل آخر', 'bad');
  const d = { name, phone, address: val('c_a'), notes: val('c_x') };
  if (id) Object.assign(S.customers.find(c => c.id === id), d); else S.customers.push({ id: nid(), ...d, createdAt: nowISO() });
  save(); closeModal(); toast('تم الحفظ', 'ok'); render();
}
function custView(id) {
  const c = S.customers.find(x => x.id === id), st = custStats(c);
  openModal(`<h3>👤 ${esc(c.name)}</h3><div class="kv-list">${c.phone ? `<div><span>الهاتف</span><b><a dir="ltr" href="tel:${esc(c.phone)}">${esc(c.phone)}</a></b></div>` : ''}${c.address ? `<div><span>العنوان</span><b>${esc(c.address)}</b></div>` : ''}
    <div><span>عدد الطلبات</span><b>${st.n}</b></div><div><span>إجمالي المشتريات</span><b>${money(st.total)}</b></div><div><span>آخر طلب</span><b>${st.last ? fmtDT(st.last) : '—'}</b></div>${c.notes ? `<div><span>ملاحظات</span><b>${esc(c.notes)}</b></div>` : ''}</div>
  <div class="actions"><button class="btn" onclick="newOrderFor(${c.id})">🛒 طلب جديد</button><button class="btn ghost" onclick="custForm(${c.id})">✏️ تعديل</button>${can('del') ? `<button class="btn danger" onclick="delCust(${c.id})">حذف</button>` : ''}</div>
  <div class="card-h"><b>الطلبات</b></div>${st.os.map(s => saleCard(s)).join('') || empty('لا توجد طلبات')}
  <button class="btn ghost block" onclick="closeModal()">إغلاق</button>`);
}
function newOrderFor(id) {
  const c = S.customers.find(x => x.id === id);
  PF = { ...PF0(), type: 'online', name: c.name, phone: c.phone, address: c.address || '' };
  closeModal(); go('pos');
}
function delCust(id) {
  const c = S.customers.find(x => x.id === id);
  if (!confirm(`حذف العميل «${c.name}»؟`)) return;
  if (S.sales.some(s => s.custId === id)) c.deleted = true; else S.customers = S.customers.filter(x => x.id !== id);
  save(); closeModal(); toast('تم الحذف', 'ok'); render();
}

// ───────────── Expenses ─────────────
function pExp() {
  const months = [], d = new Date();
  for (let i = 0; i < 24; i++) months.push(ymd(new Date(d.getFullYear(), d.getMonth() - i, 1)).slice(0, 7));
  const m = UI.em || months[0];
  const l = S.expenses.filter(e => e.date.startsWith(m)).sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
  const by = {}; for (const e of l) by[e.type] = (by[e.type] || 0) + e.amount;
  return `<div class="card"><div class="card-h"><b>＋ تسجيل مصروف</b></div><div class="form2"><label class="fld"><span>النوع</span><select id="e_t">${EXP_TYPES.map(t => `<option>${t}</option>`).join('')}</select></label>${fld('e_a', 'المبلغ', '', { num: true })}${fld('e_d', 'التاريخ', today(), { type: 'date' })}${fld('e_n', 'ملاحظات')}</div><button class="btn block" onclick="saveExp()">💾 حفظ المصروف</button></div>
  <div class="card"><div class="card-h"><b>مصاريف الشهر</b><select class="auto" onchange="UI.em=this.value;render()" aria-label="الشهر">${months.map(x => `<option value="${x}" ${x === m ? 'selected' : ''}>${MONTHS[+x.slice(5) - 1]} ${x.slice(0, 4)}</option>`).join('')}</select></div>
    <div class="kv-list">${Object.entries(by).map(([t, a]) => `<div><span>${esc(t)}</span><b>${money(a)}</b></div>`).join('')}<div class="grand"><span>المجموع</span><b>${money(l.reduce((a, e) => a + e.amount, 0))}</b></div></div></div>
  ${l.map(e => `<div class="scard" onclick="expForm(${e.id})"><div class="sc-row"><b>💸 ${esc(e.type)}</b><b>${money(e.amount)}</b></div><div class="sc-row small muted"><span>${fmtDate(e.date)}${e.notes ? ' · ' + esc(e.notes) : ''}</span><span>${esc(e.user || '')}</span></div></div>`).join('') || empty('لا توجد مصاريف في هذا الشهر')}`;
}
function saveExp(id) {
  const pre = id ? 'x_' : 'e_', type = val(pre + 't'), amount = num(val(pre + 'a')), date = val(pre + 'd') || today(), notes = val(pre + 'n');
  if (!Number.isFinite(amount) || amount <= 0) return toast('أدخل مبلغاً صحيحاً', 'bad');
  if (id) { Object.assign(S.expenses.find(e => e.id === id), { type, amount: Math.round(amount), date, notes }); closeModal(); }
  else S.expenses.unshift({ id: nid(), type, amount: Math.round(amount), date, notes, at: nowISO(), user: ME.name });
  UI.em = date.slice(0, 7);
  save(); toast('تم حفظ المصروف', 'ok'); render();
}
function expForm(id) {
  const e = S.expenses.find(x => x.id === id);
  openModal(`<h3>تعديل مصروف</h3><label class="fld"><span>النوع</span><select id="x_t">${EXP_TYPES.map(t => `<option ${t === e.type ? 'selected' : ''}>${t}</option>`).join('')}</select></label>${fld('x_a', 'المبلغ', e.amount, { num: true })}${fld('x_d', 'التاريخ', e.date, { type: 'date' })}${fld('x_n', 'ملاحظات', e.notes)}
  <div class="actions"><button class="btn" onclick="saveExp(${id})">💾 حفظ</button>${can('del') ? `<button class="btn danger" onclick="delExp(${id})">حذف</button>` : ''}<button class="btn ghost" onclick="closeModal()">إلغاء</button></div>`);
}
function delExp(id) {
  if (!confirm('حذف المصروف؟')) return;
  S.expenses = S.expenses.filter(e => e.id !== id);
  save(); closeModal(); toast('تم الحذف', 'ok'); render();
}

// ───────────── Returns ─────────────
const RB0 = () => ({ saleId: null, pid: null, qty: '1', refund: '', touched: false, restock: true, reason: RET_REASONS[0], note: '', q: '' });
let RB = RB0();
function pRet() {
  const sid = +params.get('sale');
  if (sid) { RB = RB0(); RB.saleId = sid; }
  return `<div class="card"><div class="card-h"><b>↩️ تسجيل مرتجع</b></div>
    ${fld('r_q', 'ابحث برقم الفاتورة / الطلب أو اسم العميل', RB.q, { attrs: 'oninput="RB.q=this.value;retOpts()" autocomplete="off"' })}
    <label class="fld"><span>الفاتورة / الطلب</span><select id="r_s" onchange="RB=Object.assign(RB0(),{q:RB.q,saleId:+this.value||null});retForm()"></select></label>
    <div id="r_form"></div></div>
  <div class="card"><div class="card-h"><b>📜 سجل المرتجعات</b></div>${S.returns.map(r => `<div class="mrow"><span class="mq ok" dir="ltr">+${r.qty}</span><div><b>${r.no} · ${esc(r.name)}</b><small>${r.saleNo} · ${esc(r.reason)}${r.restock ? '' : ' · لم يُرجع للمخزون'}</small><small>👤 ${esc(r.user)} · ${fmtDT(r.at)}</small></div><b class="bad">${money(r.refund)}</b></div>`).join('') || empty('لا توجد مرتجعات')}</div>`;
}
function retOpts() {
  const q = digits(RB.q).trim().toLowerCase();
  const l = S.sales.filter(s => live(s) && (!q || [s.no, s.cust?.name, s.cust?.phone].join(' ').toLowerCase().includes(q))).slice(0, 200);
  if (RB.saleId && !l.some(s => s.id === RB.saleId)) { const s = saleById(RB.saleId); if (s && live(s)) l.unshift(s); }
  $('#r_s').innerHTML = '<option value="">— اختر الفاتورة —</option>' + l.map(s => `<option value="${s.id}" ${s.id === RB.saleId ? 'selected' : ''}>${s.no} · ${fmtDate(s.date)} · ${money(calc(s).total)}${s.cust ? ' · ' + esc(s.cust.name) : ''}</option>`).join('');
  if (q && l.length === 1 && RB.saleId !== l[0].id) { RB.saleId = l[0].id; RB.pid = null; RB.touched = false; $('#r_s').value = l[0].id; retForm(); }
}
function retForm() {
  const el = $('#r_form'), s = RB.saleId && saleById(RB.saleId);
  if (!s || !live(s)) { el.innerHTML = empty('اختر الفاتورة لعرض منتجاتها'); return; }
  const items = s.items.map(i => ({ ...i, left: i.qty - returnedQty(s, i.pid) })), avail = items.filter(i => i.left > 0);
  if (!avail.length) { el.innerHTML = empty('تم إرجاع كل منتجات هذه الفاتورة'); return; }
  if (!avail.some(i => i.pid === RB.pid)) { RB.pid = avail[0].pid; RB.touched = false; }
  const it = avail.find(i => i.pid === RB.pid), share = discShare(s);
  if (!RB.touched) RB.refund = String(Math.max(0, Math.round(Math.min(Math.round(num(RB.qty)) || 0, it.left) * it.price * share)));
  el.innerHTML = `<div class="lbl">المنتج</div>${items.map(i => `<label class="ritem ${i.left ? '' : 'off'}"><input type="radio" name="rp" ${i.pid === RB.pid ? 'checked' : ''} ${i.left ? '' : 'disabled'} onchange="RB.pid=${i.pid};RB.touched=false;retForm()"><span><b>${esc(i.name)}</b><small>مُباع ${i.qty} · مُرجَع ${i.qty - i.left} · متاح للإرجاع ${i.left} · ${money(i.price)}</small></span></label>`).join('')}
    <div class="form2">${fld('r_qty', 'الكمية المرتجعة', RB.qty, { num: true, attrs: 'oninput="RB.qty=this.value;RB.touched=false;retRefund()"' })}${fld('r_ref', 'المبلغ المُعاد للعميل', RB.refund, { num: true, attrs: 'oninput="RB.refund=this.value;RB.touched=true"' })}</div>
    ${share < 1 ? '<div class="hint">تم توزيع خصم الفاتورة على المنتجات تلقائياً عند حساب المبلغ المُعاد.</div>' : ''}
    <label class="fld"><span>سبب الإرجاع</span><select onchange="RB.reason=this.value">${RET_REASONS.map(r => `<option ${r === RB.reason ? 'selected' : ''}>${r}</option>`).join('')}</select></label>
    ${fld('r_note', 'ملاحظات', RB.note, { attrs: 'oninput="RB.note=this.value"' })}
    <label class="chk"><input type="checkbox" ${RB.restock ? 'checked' : ''} onchange="RB.restock=this.checked"> إرجاع المنتج إلى المخزون (ألغِ التحديد إذا كان تالفاً)</label>
    <button class="btn block lg" onclick="saveReturn()">↩️ تسجيل المرتجع</button>`;
}
function retRefund() {
  const s = saleById(RB.saleId), it = s?.items.find(i => i.pid === RB.pid); if (!it) return;
  RB.refund = String(Math.max(0, Math.round((Math.round(num(RB.qty)) || 0) * it.price * discShare(s))));
  $('#r_ref').value = RB.refund;
}
function saveReturn() {
  const s = saleById(RB.saleId); if (!s || !live(s)) return toast('اختر الفاتورة', 'bad');
  const it = s.items.find(i => i.pid === RB.pid); if (!it) return toast('اختر المنتج', 'bad');
  const left = it.qty - returnedQty(s, it.pid), q = num(RB.qty), refund = num(RB.refund);
  if (!Number.isInteger(q) || q < 1 || q > left) return toast(`الكمية المرتجعة غير صحيحة (المتاح للإرجاع: ${left})`, 'bad');
  if (!Number.isFinite(refund) || refund < 0 || refund > q * it.price) return toast('المبلغ المُعاد غير صحيح', 'bad');
  const r = { id: nid(), no: 'RET-' + pad(S.seq.ret++), saleId: s.id, saleNo: s.no, type: s.type, pid: it.pid, name: it.name, qty: q, price: it.price, cost: it.cost, refund: Math.round(refund), restock: RB.restock, reason: RB.reason + (RB.note.trim() ? ' — ' + RB.note.trim() : ''), date: today(), at: nowISO(), user: ME.name };
  S.returns.unshift(r);
  const p = P(it.pid);
  if (p && r.restock) move(p, q, `مرتجع ${r.no} (${s.no})`, r.no);
  save(); RB = RB0();
  toast(`تم تسجيل ${r.no} — المبلغ المُعاد ${money(r.refund)}`, 'ok'); render();
}

// ───────────── Reports ─────────────
function quickRange(k) {
  const t = today(), d = new Date();
  const m = { today: [t, t], yday: [addDays(t, -1), addDays(t, -1)], '7d': [addDays(t, -6), t], month: [monthStart(t), t], year: [t.slice(0, 4) + '-01-01', t] };
  if (k === 'lmonth') { const a = ymd(new Date(d.getFullYear(), d.getMonth() - 1, 1)); m.lmonth = [a, monthEnd(a)]; }
  [UI.ra, UI.rb] = m[k]; render();
}
function setRange() {
  let a = $('#ra').value, b = $('#rb').value;
  if (!a || !b) return;
  if (a > b) [a, b] = [b, a];
  UI.ra = a; UI.rb = b; render();
}
function pRep() {
  const a = UI.ra || monthStart(), b = UI.rb || today(), o = stats(a, b, true), ps = products();
  const rows = Object.values(o.prod);
  for (const p of ps) if (!o.prod[p.id]) rows.push({ pid: p.id, name: p.name, qty: 0, rev: 0, profit: 0 });
  rows.sort((x, y) => y.qty - x.qty || y.rev - x.rev);
  const ex = {}; for (const e of S.expenses) if (e.date >= a && e.date <= b) ex[e.type] = (ex[e.type] || 0) + e.amount;
  const rank = l => l.map((x, k) => `<div class="rank"><span class="rk">${k + 1}</span><b>${esc(x.name)}</b><span>${x.qty} قطعة</span><small class="${x.profit < 0 ? 'bad' : 'ok'}">${money(x.profit)}</small></div>`).join('') || empty('لا توجد بيانات');
  const live_ = rows.filter(x => ps.some(p => p.id === x.pid));
  const low = ps.filter(p => p.qty > 0 && p.qty <= p.min), out = ps.filter(p => p.qty <= 0);
  return `<div class="card"><div class="range">
    <label class="fld"><span>من</span><input type="date" id="ra" value="${a}" onchange="setRange()"></label>
    <label class="fld"><span>إلى</span><input type="date" id="rb" value="${b}" onchange="setRange()"></label></div>
    <div class="chips">${[['today', 'اليوم'], ['yday', 'أمس'], ['7d', 'آخر 7 أيام'], ['month', 'هذا الشهر'], ['lmonth', 'الشهر الماضي'], ['year', 'هذه السنة']].map(([k, l]) => `<button class="chip" onclick="quickRange('${k}')">${l}</button>`).join('')}</div>
    <div class="muted small">الفترة: ${fmtDate(a)} — ${fmtDate(b)}</div></div>
  <div class="kpis">
    ${kpi('💰', 'إجمالي المبيعات', money(o.sales), `${o.n} عملية`, 'g')}
    ${kpi('🏪', 'مبيعات المحل', money(o.store), `${o.nStore} فاتورة`, 'o')}
    ${kpi('🌐', 'مبيعات الأونلاين', money(o.online), `${o.nOnline} طلب`, 'i')}
    ${kpi('📦', 'تكلفة البضاعة المباعة', money(o.cogs), '', 'b')}
    ${kpi('📈', 'إجمالي الربح', money(o.profit), o.sales ? `هامش ${pct(o.profit, o.sales)}` : '', 'g')}
    ${kpi('💸', 'المصاريف', money(o.exp), '', 'r')}
    ${kpi('🧾', 'صافي الربح الحقيقي', money(o.net), 'الربح − المصاريف', 'p', '', o.net < 0 ? 'bad' : 'ok')}
    ${kpi('↩️', 'المرتجعات', money(o.refunds), `${o.nRet} عملية`, 'y')}
    ${kpi('🏷️', 'الخصومات', money(o.disc), '', 'y')}
    ${kpi('🧮', 'متوسط الفاتورة', money(o.n ? o.sales / o.n : 0), '', 'b')}
  </div>
  <div class="card"><div class="card-h"><b>📊 المبيعات خلال الفترة</b></div>${barChart(buckets(a, b))}</div>
  <div class="card"><div class="card-h"><b>💼 الأرباح حسب نوع البيع</b></div><div class="tbl"><table>
    <tr><th>النوع</th><th>العمليات</th><th>المبيعات</th><th>الربح</th><th>الهامش</th></tr>
    <tr><td>🏪 المحل</td><td>${o.nStore}</td><td>${fmtN(o.store)}</td><td>${fmtN(o.pStore)}</td><td>${pct(o.pStore, o.store)}</td></tr>
    <tr><td>🌐 الأونلاين</td><td>${o.nOnline}</td><td>${fmtN(o.online)}</td><td>${fmtN(o.pOnline)}</td><td>${pct(o.pOnline, o.online)}</td></tr>
    <tr class="tot"><td>المجموع</td><td>${o.n}</td><td>${fmtN(o.sales)}</td><td>${fmtN(o.profit)}</td><td>${pct(o.profit, o.sales)}</td></tr></table></div></div>
  <div class="card"><div class="card-h"><b>🏆 الأكثر مبيعاً</b></div>${rank(rows.filter(x => x.qty > 0).slice(0, 5))}</div>
  <div class="card"><div class="card-h"><b>🐢 الأقل مبيعاً</b></div>${rank(live_.slice(-5).reverse())}</div>
  <div class="card"><div class="card-h"><b>💰 الأرباح حسب المنتج</b></div><div class="tbl"><table><tr><th>المنتج</th><th>الكمية</th><th>المبيعات</th><th>الربح</th></tr>${rows.filter(x => x.qty || x.rev).map(x => `<tr><td>${esc(x.name)}</td><td>${x.qty}</td><td>${fmtN(x.rev)}</td><td class="${x.profit < 0 ? 'bad' : ''}">${fmtN(x.profit)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">لا توجد مبيعات في هذه الفترة</td></tr>'}</table></div></div>
  <div class="card"><div class="card-h"><b>💸 المصاريف حسب النوع</b></div><div class="kv-list">${Object.entries(ex).map(([t, v]) => `<div><span>${esc(t)}</span><b>${money(v)}</b></div>`).join('') || empty('لا توجد مصاريف')}${o.exp ? `<div class="grand"><span>المجموع</span><b>${money(o.exp)}</b></div>` : ''}</div></div>
  <div class="card"><div class="card-h"><b>🏬 المخزون الآن</b></div><div class="kv-list">
    <div><span>قيمة المخزون بسعر الشراء</span><b>${money(ps.reduce((x, p) => x + Math.max(0, p.qty) * p.cost, 0))}</b></div>
    <div><span>قيمة المخزون بسعر البيع</span><b>${money(ps.reduce((x, p) => x + Math.max(0, p.qty) * p.price, 0))}</b></div>
    <div><span>قريبة من النفاد (${low.length})</span><b>${esc(low.map(p => `${p.name} (${p.qty})`).join('، ') || '—')}</b></div>
    <div><span>نافدة (${out.length})</span><b>${esc(out.map(p => p.name).join('، ') || '—')}</b></div></div></div>
  <div class="actions"><button class="btn ghost" onclick="csvSales()">⬇️ تصدير المبيعات (Excel)</button><button class="btn ghost" onclick="csvStock()">⬇️ تصدير المخزون (Excel)</button></div>`;
}
function csvSales() {
  const a = UI.ra || monthStart(), b = UI.rb || today();
  const rows = [['الرقم', 'التاريخ', 'الوقت', 'النوع', 'الحالة', 'العميل', 'الهاتف', 'المنتجات', 'المجموع', 'الخصم', 'رسوم التوصيل', 'الإجمالي', 'تكلفة البضاعة', 'تكلفة التوصيل', 'الربح', 'المرتجعات', 'طريقة الدفع', 'البائع', 'ملاحظات']];
  for (const s of [...S.sales].reverse()) {
    if (s.date < a || s.date > b) continue;
    const c = calc(s);
    rows.push([s.no, s.date, fmtTime(s.at), s.type === 'store' ? 'محل' : 'أونلاين', s.status, s.cust?.name, s.cust?.phone, s.items.map(i => `${i.name} x${i.qty}`).join(' | '), c.sub, s.discount, s.fee, c.total, c.cogs, s.dcost, c.profit, saleReturns(s).reduce((x, r) => x + r.refund, 0), s.pay, s.user, s.notes]);
  }
  csvDownload(`TNT-sales-${a}_${b}.csv`, rows);
}
function csvStock() {
  const rows = [['المنتج', 'البراند', 'التصنيف', 'الحجم', 'النكهة', 'الباركود', 'سعر الشراء', 'سعر البيع', 'الكمية', 'الحد الأدنى', 'القيمة بسعر الشراء', 'القيمة بسعر البيع', 'الحالة', 'انتهاء الصلاحية']];
  for (const p of products().sort(byName)) rows.push([p.name, p.brand, p.cat, p.size, p.flavor, p.barcode, p.cost, p.price, p.qty, p.min, Math.max(0, p.qty) * p.cost, Math.max(0, p.qty) * p.price, p.qty <= 0 ? 'نافد' : p.qty <= p.min ? 'قريب من النفاد' : 'جيد', p.exp]);
  csvDownload(`TNT-stock-${today()}.csv`, rows);
}

// ───────────── Users ─────────────
function pUsers() {
  return `<button class="btn block" onclick="userForm()">＋ إضافة مستخدم</button>
  <div class="card">${S.users.map(u => `<button class="lrow" onclick="userForm(${u.id})"><span class="av">${u.role === 'admin' ? '👑' : '👤'}</span><div><b>${esc(u.name)}${u.id === ME.id ? ' (أنت)' : ''}</b><small>${u.role === 'admin' ? 'مدير — كل الصلاحيات' : 'موظف — البيع والطلبات' + (Object.keys(PERMS).filter(k => u.perms?.[k]).map(k => ' + ' + PERMS[k]).join('') || '')}</small></div>${u.active ? '<span class="badge ok">فعّال</span>' : '<span class="badge bad">موقوف</span>'}</button>`).join('')}</div>
  <div class="card soft small">🔐 الموظف يستطيع دائماً: تسجيل المبيعات، إدارة الطلبات الأونلاين وحالاتها، إضافة العملاء وعرض المنتجات والمخزون (بدون أسعار الشراء). أي صلاحية إضافية يحددها المدير.</div>`;
}
function userForm(id) {
  const u = id ? S.users.find(x => x.id === id) : { role: 'employee', perms: { returns: true }, active: true };
  openModal(`<h3>${id ? 'تعديل مستخدم' : 'مستخدم جديد'}</h3>
  ${fld('u_name', 'الاسم', u.name)}
  ${fld('u_pin', 'رمز الدخول (4 أرقام)', u.pin, { type: 'password', attrs: 'inputmode="numeric" maxlength="4" autocomplete="new-password"' })}
  <label class="fld"><span>الدور</span><select id="u_role" onchange="$('#u_perms').hidden=this.value==='admin'"><option value="employee" ${u.role !== 'admin' ? 'selected' : ''}>موظف (Employee)</option><option value="admin" ${u.role === 'admin' ? 'selected' : ''}>مدير (Admin)</option></select></label>
  <div id="u_perms" ${u.role === 'admin' ? 'hidden' : ''}><div class="lbl">صلاحيات إضافية للموظف</div>${Object.entries(PERMS).map(([k, l]) => `<label class="chk"><input type="checkbox" id="u_p_${k}" ${u.perms?.[k] ? 'checked' : ''}> ${l}</label>`).join('')}</div>
  <label class="chk"><input type="checkbox" id="u_act" ${u.active ? 'checked' : ''}> الحساب فعّال</label>
  <div class="actions"><button class="btn" onclick="saveUser(${id || 0})">💾 حفظ</button><button class="btn ghost" onclick="closeModal()">إلغاء</button></div>`);
}
function saveUser(id) {
  const name = val('u_name'), pin = digits(val('u_pin')), role = val('u_role'), active = $('#u_act').checked;
  if (!name) return toast('أدخل الاسم', 'bad');
  if (!/^\d{4}$/.test(pin)) return toast('رمز الدخول يجب أن يكون 4 أرقام', 'bad');
  if (S.users.some(x => x.pin === pin && x.id !== id)) return toast('هذا الرمز مستخدم لمستخدم آخر', 'bad');
  if (id === ME.id && !active) return toast('لا يمكنك إيقاف حسابك الحالي', 'bad');
  if (!(role === 'admin' && active) && !S.users.some(x => x.role === 'admin' && x.active && x.id !== id)) return toast('يجب أن يبقى مدير واحد فعّال على الأقل', 'bad');
  const perms = {}; for (const k in PERMS) perms[k] = $('#u_p_' + k).checked;
  if (id) Object.assign(S.users.find(x => x.id === id), { name, pin, role, perms, active });
  else S.users.push({ id: nid(), name, pin, role, perms, active, createdAt: nowISO() });
  save(); closeModal(); toast('تم الحفظ', 'ok'); render();
}

// ───────────── Settings, backup, theme ─────────────
const getTheme = () => { try { return localStorage.getItem('tnt-theme') || 'auto'; } catch { return 'auto'; } };
function applyTheme() { const t = getTheme(); if (t === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.dataset.theme = t; }
function setTheme(t) { try { localStorage.setItem('tnt-theme', t); } catch { } applyTheme(); render(); }
function pSet() {
  const sh = S.shop, th = getTheme();
  return `<div class="card"><div class="card-h"><b>🏪 بيانات المحل والفاتورة</b></div>
    <div class="imgpick">${logoHtml(64)}<span class="row"><label class="btn ghost sm">🖼️ رفع شعار<input type="file" accept="image/*" hidden onchange="pickLogo(this)"></label>${sh.logo ? `<button class="btn ghost sm" onclick="S.shop.logo='';save();render()">إزالة الشعار</button>` : ''}</span></div>
    <div class="form2">${fld('s_name', 'اسم المحل', sh.name)}${fld('s_phone', 'هاتف المحل', sh.phone, { attrs: 'inputmode="tel"' })}${fld('s_addr', 'العنوان', sh.address, { full: true })}${fld('s_foot', 'ملاحظة أسفل الفاتورة', sh.footer, { full: true })}${fld('s_min', 'الحد الأدنى الافتراضي للمخزون', sh.defMin, { num: true })}</div>
    <button class="btn block" onclick="saveShop()">💾 حفظ</button></div>
  <div class="card"><div class="card-h"><b>💾 النسخ الاحتياطي</b></div>
    <p class="small">كل البيانات محفوظة على هذا الجهاز وفي هذا المتصفح فقط. صدّر نسخة احتياطية بانتظام واحفظها في مكان آمن (Google Drive أو WhatsApp أو البريد) — ويمكنك استعادتها على أي جهاز.</p>
    <div class="kv-list"><div><span>آخر نسخة احتياطية</span><b>${S.lastBackup ? fmtDT(S.lastBackup) : 'لم يتم بعد'}</b></div></div>
    <div id="stinfo" class="small muted"></div>
    <div class="actions"><button class="btn" onclick="exportBackup()">⬇️ تصدير نسخة احتياطية</button><label class="btn ghost">⬆️ استعادة نسخة<input type="file" accept=".json,application/json" hidden onchange="importBackup(this)"></label></div></div>
  <div class="card"><div class="card-h"><b>🎨 المظهر</b></div><div class="seg">${[['auto', 'تلقائي'], ['light', 'فاتح'], ['dark', 'داكن']].map(([k, l]) => `<button class="${th === k ? 'on' : ''}" onclick="setTheme('${k}')">${l}</button>`).join('')}</div></div>
  <div class="card"><div class="card-h"><b>🧪 البيانات</b></div>
    <div class="actions">${products().length ? '' : '<button class="btn ghost" onclick="loadDemo()">تحميل منتجات تجريبية</button>'}<button class="btn danger" onclick="wipeData()">🗑️ مسح كل بيانات المتجر</button></div>
    <p class="small muted">الإصدار ${VERSION}</p></div>`;
}
async function storageInfo() {
  const el = $('#stinfo'); if (!el) return;
  let h = `مكان الحفظ: ${useLS ? 'localStorage' : 'IndexedDB'} على هذا الجهاز`;
  try {
    const e = await navigator.storage?.estimate?.();
    if (e) h += ` · المستخدم ${(e.usage / 1048576).toFixed(1)} MB من ${Math.round(e.quota / 1048576)} MB`;
    if (navigator.storage?.persisted) h += (await navigator.storage.persisted()) ? ' · ✅ محمي من الحذف التلقائي' : ' · ⚠️ غير محمي من الحذف التلقائي — صدّر نسخة احتياطية بانتظام';
  } catch { }
  el.textContent = h;
}
function saveShop() {
  const name = val('s_name'), min = num(val('s_min'));
  if (!name) return toast('أدخل اسم المحل', 'bad');
  if (!Number.isInteger(min) || min < 0) return toast('الحد الأدنى يجب أن يكون رقماً صحيحاً', 'bad');
  Object.assign(S.shop, { name, phone: val('s_phone'), address: val('s_addr'), footer: val('s_foot'), defMin: min });
  save(); toast('تم الحفظ', 'ok'); render();
}
async function pickLogo(inp) {
  const f = inp.files[0]; if (!f) return;
  try { S.shop.logo = await readImage(f, 256, 'image/png'); save(); render(); } catch (e) { toast(e.message, 'bad'); }
}
function exportBackup() {
  S.lastBackup = nowISO(); save();
  download(new Blob([JSON.stringify(S)], { type: 'application/json' }), `TNT-backup-${today()}.json`);
  toast('تم تصدير النسخة الاحتياطية — احفظ الملف في مكان آمن', 'ok');
  if (ME) render();
}
function importBackup(inp) {
  const f = inp.files[0]; if (!f) return;
  const fr = new FileReader();
  fr.onload = async () => {
    let d;
    try { d = JSON.parse(fr.result); if (d?.v !== 2 || !Array.isArray(d.products) || !Array.isArray(d.sales) || !Array.isArray(d.users) || !d.users.length) throw 0; }
    catch { return toast('ملف النسخة الاحتياطية غير صالح', 'bad'); }
    if (!confirm(`استعادة نسخة «${d.shop?.name || ''}» بتاريخ ${fmtDT(d.updatedAt)}؟\nسيتم استبدال كل البيانات الحالية على هذا الجهاز.`)) return;
    S = normalize(d); await save();
    if (saveFailed) return;
    toast('تمت الاستعادة ✅', 'ok');
    setTimeout(() => location.reload(), 700);
  };
  fr.readAsText(f); inp.value = '';
}
function wipeData() {
  if (prompt('سيتم مسح كل المنتجات والمبيعات والمشتريات والعملاء والمصاريف (مع الإبقاء على المستخدمين وبيانات المحل).\nللتأكيد اكتب: حذف') !== 'حذف') return;
  const keep = { shop: S.shop, users: S.users };
  S = fresh(); S.shop = keep.shop; S.users = keep.users; S.seq.id = Math.max(0, ...keep.users.map(u => u.id)) + 1;
  cart = []; saveCart(); save(); toast('تم مسح البيانات', 'ok'); go('dash');
}
function loadDemo() {
  if (products().length) return toast('البيانات التجريبية تُحمّل فقط عندما لا توجد منتجات', 'bad');
  const sup = { id: nid(), name: 'شركة الأبطال للمكملات', phone: '07701234567', company: 'الأبطال', notes: 'مورد تجريبي', createdAt: nowISO() };
  S.suppliers.push(sup);
  [
    ['Gold Standard Whey 2.27kg', 'Optimum Nutrition', 'بروتين', '5 lb', 'Double Rich Chocolate', '1000000000011', 95000, 120000, 12, 4, 420],
    ['ISO 100 Hydrolyzed 2.27kg', 'Dymatize', 'بروتين', '5 lb', 'Gourmet Vanilla', '1000000000028', 110000, 140000, 6, 3, 380],
    ['Creatine Monohydrate 300g', 'MuscleTech', 'كرياتين', '300 g', '', '1000000000035', 25000, 35000, 20, 5, 600],
    ['C4 Original Pre-Workout', 'Cellucor', 'Pre-Workout', '30 serv', 'Fruit Punch', '1000000000042', 30000, 42000, 4, 5, 240],
    ['Xtend BCAA 400g', 'Scivation', 'أحماض أمينية', '30 serv', 'Mango', '1000000000059', 28000, 38000, 0, 3, 300],
    ['Serious Mass 2.72kg', 'Optimum Nutrition', 'Mass Gainer', '6 lb', 'Chocolate', '1000000000066', 60000, 80000, 8, 3, 500],
    ['Animal Pak 44 Packs', 'Universal', 'فيتامينات', '44 packs', '', '1000000000073', 45000, 60000, 10, 3, 20],
    ['Hydroxycut Hardcore Elite', 'MuscleTech', 'حوارق دهون', '100 caps', '', '1000000000080', 30000, 40000, 7, 3, 365],
  ].forEach(([name, brand, cat, size, flavor, barcode, cost, price, qty, min, days]) => {
    const p = { id: nid(), name, brand, cat, size, flavor, barcode, cost, price, qty: 0, min, exp: addDays(today(), days), notes: '', img: '', createdAt: nowISO() };
    S.products.push(p);
    if (qty) move(p, qty, 'رصيد افتتاحي');
  });
  save(); toast('تم تحميل منتجات تجريبية', 'ok'); go('prod');
}
function pMore() {
  return `<div class="mgrid">${Object.keys(ROUTES).filter(r => !BNAV.includes(r) && allowed(r)).map(r => `<a class="mtile" href="#/${r}"><span class="ic">${ROUTES[r].i}</span><b>${ROUTES[r].t}</b></a>`).join('')}
  <button class="mtile" onclick="lockApp()"><span class="ic">🔒</span><b>قفل / تبديل المستخدم</b></button></div>`;
}

// ───────────── Boot ─────────────
async function boot() {
  applyTheme();
  try { await loadState(); } catch { S = fresh(); }
  try { const uid = +sessionStorage.getItem('tnt-uid'); ME = S.users.find(u => u.id === uid && u.active) || null; } catch { }
  $('#modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });
  window.addEventListener('hashchange', () => { if (!ME) return; if ($('#modal').classList.contains('open')) closeModal(); render(); });
  $('#boot').remove();
  render();
  navigator.storage?.persist?.().catch(() => { });
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) navigator.serviceWorker.register('sw.js').catch(() => { });
}
boot();
