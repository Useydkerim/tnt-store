'use strict';
/* TNT — Supplement Store Manager · cloud edition
   Data lives in Cloud Firestore and is shared live by every device; sign-in is Firebase Auth.
   Every stock change runs inside a Firestore transaction that also writes a stock-movement record
   and updates the daily totals (days/{YYYY-MM-DD}) that the dashboard and reports read. */

const VERSION = '3.0.0';
const FB_VER = '12.19.0';
const FB_CONFIG = {
  apiKey: 'AIzaSyDrmgs9KhrDKaXrxzyQ-mHAI9a40XcmMKM',
  authDomain: 'tnt-store-iq.firebaseapp.com',
  projectId: 'tnt-store-iq',
  storageBucket: 'tnt-store-iq.firebasestorage.app',
  messagingSenderId: '133366066759',
  appId: '1:133366066759:web:5a880d0af5dcbe673e0b62',
};
// Local testing against the Firebase emulators: http://localhost:<port>/?emu
const EMU = location.hostname === 'localhost' && new URLSearchParams(location.search).has('emu');
const USER_DOMAIN = 'users.tnt-store.app';

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
const byAtDesc = (a, b) => (b.at || '').localeCompare(a.at || '');
const MONTHS = ['كانون الثاني', 'شباط', 'آذار', 'نيسان', 'أيار', 'حزيران', 'تموز', 'آب', 'أيلول', 'تشرين الأول', 'تشرين الثاني', 'كانون الأول'];
const normPhone = p => digits(p).replace(/[^\d+]/g, '');
const waPhone = p => { let d = digits(p).replace(/\D/g, ''); if (d.startsWith('00')) d = d.slice(2); if (d.startsWith('0')) d = '964' + d.slice(1); return d; };
const toEmail = u => { u = digits(u).trim().toLowerCase(); return u.includes('@') ? u : `${u}@${USER_DOMAIN}`; };
const userLabel = u => (u.email || '').endsWith('@' + USER_DOMAIN) ? u.email.split('@')[0] : u.email;

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
function readImage(file, max = 200, type = 'image/jpeg') {
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
        res(c.toDataURL(type, 0.75));
      };
      im.onerror = () => rej(new Error('تعذر قراءة الصورة'));
      im.src = fr.result;
    };
    fr.onerror = () => rej(fr.error);
    fr.readAsDataURL(file);
  });
}

// ───────────── Firebase ─────────────
let A, FS, AU, db, auth;
const col = n => FS.collection(db, n);
const dref = (n, id) => FS.doc(db, n, String(id));
const newRef = n => FS.doc(col(n));
const docsOf = snap => snap.docs.map(d => ({ id: d.id, ...d.data() }));
async function initFirebase() {
  const base = `https://www.gstatic.com/firebasejs/${FB_VER}/`;
  [A, FS, AU] = await Promise.all([import(base + 'firebase-app.js'), import(base + 'firebase-firestore.js'), import(base + 'firebase-auth.js')]);
  const cfg = EMU ? { ...FB_CONFIG, projectId: 'demo-tnt', apiKey: 'demo-key' } : FB_CONFIG;
  const app = A.initializeApp(cfg);
  try { db = FS.initializeFirestore(app, { localCache: FS.persistentLocalCache({ tabManager: FS.persistentMultipleTabManager() }) }); }
  catch { db = FS.getFirestore(app); }
  auth = AU.getAuth(app);
  if (EMU) { FS.connectFirestoreEmulator(db, 'localhost', 8080); AU.connectAuthEmulator(auth, 'http://localhost:9099', { disableWarnings: true }); }
  initFirebase.cfg = cfg;
}

class UErr extends Error { }
const AUTH_ERR = {
  'auth/invalid-credential': 'اسم المستخدم أو كلمة المرور غير صحيحة', 'auth/wrong-password': 'اسم المستخدم أو كلمة المرور غير صحيحة',
  'auth/user-not-found': 'اسم المستخدم أو كلمة المرور غير صحيحة', 'auth/invalid-email': 'اسم المستخدم أو البريد غير صالح',
  'auth/too-many-requests': 'محاولات كثيرة — انتظر قليلاً ثم حاول مجدداً', 'auth/network-request-failed': 'لا يوجد اتصال بالإنترنت',
  'auth/email-already-in-use': 'اسم المستخدم أو البريد مستخدم بالفعل', 'auth/weak-password': 'كلمة المرور ضعيفة — 6 أحرف على الأقل',
  'auth/operation-not-allowed': 'تسجيل الدخول بالبريد وكلمة المرور غير مفعّل في Firebase', 'auth/configuration-not-found': 'تسجيل الدخول غير مفعّل في Firebase بعد',
  'auth/requires-recent-login': 'سجّل الخروج ثم الدخول مجدداً ثم أعد المحاولة', 'auth/missing-password': 'أدخل كلمة المرور',
};
function errMsg(e) {
  if (e instanceof UErr) return e.message;
  const c = e?.code || '';
  if (AUTH_ERR[c]) return AUTH_ERR[c];
  if (c === 'permission-denied') return 'ليس لديك صلاحية لهذه العملية';
  if (c === 'unavailable' || /offline/i.test(e?.message || '')) return 'لا يوجد اتصال بالإنترنت — لم يتم الحفظ';
  if (c === 'failed-precondition' && /index/i.test(e?.message || '')) return 'قاعدة البيانات تجهّز الفهارس — حاول بعد دقيقة';
  return 'حدث خطأ: ' + (e?.message || c || e);
}
let busy = false;
// Runs a write: blocks double taps, needs the internet, turns any failure into a clear message.
async function act(fn, ok) {
  if (busy) return false;
  busy = true; document.body.classList.add('busy');
  try {
    if (navigator.onLine === false) throw new UErr('لا يوجد اتصال بالإنترنت — لم يتم الحفظ');
    const r = await fn();
    if (ok) toast(typeof ok === 'function' ? ok(r) : ok, 'ok');
    return r ?? true;
  } catch (e) { if (!(e instanceof UErr)) console.error(e); toast(errMsg(e), 'bad'); return false; }
  finally { busy = false; document.body.classList.remove('busy'); }
}

// ───────────── Live data cache ─────────────
const SHOP0 = { name: 'TNT', phone: '', address: '', logo: '', footer: 'شكراً لتسوقكم معنا 💪', defMin: 5 };
const freshCache = () => ({ shop: { ...SHOP0 }, users: [], products: [], suppliers: [], custRecent: [], recent: [], pending: [], days: {}, daysFrom: '', yearFrom: '', sales: new Map(), ready: {} });
let C = freshCache(), Q = {};
const LS = {}, PL = {}, ML = {}; // listeners: global, current page, open modal
// A listener that dies (network blip, permissions not yet visible on the server) retries by itself.
function listen(store, key, ref, fn, tries = 0) {
  store[key]?.();
  store[key] = FS.onSnapshot(ref, snap => { tries = 0; fn(snap); C.ready[key] = true; changed(); }, err => {
    console.warn(key, err.code);
    const gen = SESSION;
    if (tries >= 5) { if (ME) toast(errMsg(err), 'bad'); return; }
    setTimeout(() => { if (ME && SESSION === gen && store[key]) listen(store, key, ref, fn, tries + 1); }, 800 * (tries + 1));
  });
}
function stopAll(store) { for (const k of Object.keys(store)) { try { store[k](); } catch { } delete store[k]; } }
const remember = list => { for (const s of list) C.sales.set(s.id, s); };
function startData() {
  listen(LS, 'shop', dref('settings', 'shop'), d => { C.shop = { ...SHOP0, ...(d.data() || {}) }; });
  listen(LS, 'users', col('users'), s => { C.users = docsOf(s); });
  listen(LS, 'products', col('products'), s => { C.products = docsOf(s); });
  listen(LS, 'suppliers', col('suppliers'), s => { C.suppliers = docsOf(s); });
  listen(LS, 'recent', FS.query(col('sales'), FS.orderBy('at', 'desc'), FS.limit(60)), s => { C.recent = docsOf(s); remember(C.recent); });
  listen(LS, 'pending', FS.query(col('sales'), FS.where('status', 'in', PENDING)), s => { C.pending = docsOf(s).sort(byAtDesc); remember(C.pending); });
  C.daysFrom = addDays(today(), -62);
  listen(LS, 'days', FS.query(col('days'), FS.where('date', '>=', C.daysFrom)), s => { for (const d of s.docs) C.days[d.id] = d.data(); });
  listen(LS, 'custs', FS.query(col('customers'), FS.orderBy('lastAt', 'desc'), FS.limit(80)), s => { C.custRecent = docsOf(s).filter(c => !c.deleted); });
}
const NEEDED = ['shop', 'users', 'products', 'days', 'recent', 'pending'];
let chT = 0, stale = false;
function changed() { clearTimeout(chT); chT = setTimeout(applyChange, 30); }
const focusedIn = el => { const a = document.activeElement; return !!a && a !== document.body && el.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName); };
// New data arrived: re-render, but never yank a field out from under someone typing.
function applyChange() {
  if (!ME || !NEEDED.every(k => C.ready[k])) return;
  if (!booted) { booted = true; render(); return; }
  if (focusedIn($('#main'))) { stale = true; renderChrome(); ROUTES[route].live?.(); return; }
  render();
}
document.addEventListener('focusout', () => setTimeout(() => { if (stale && ME && booted && !focusedIn($('#main'))) render(); }, 0));
window.addEventListener('online', () => ME && booted && renderChrome());
window.addEventListener('offline', () => ME && booted && renderChrome());

// ───────────── Permissions ─────────────
const PERMS = {
  returns: 'تسجيل المرتجعات',
  stock: 'إدارة المنتجات والمخزون والمشتريات والموردين (تشمل أسعار الشراء)',
  money: 'عرض الأرباح والتقارير والمصاريف',
  del: 'الحذف وإلغاء الفواتير',
};
let ME = null, booted = false;
const isAdmin = () => ME?.role === 'admin';
const can = k => !!ME && (ME.role === 'admin' || !!ME.perms?.[k]);
const seeCost = () => can('stock') || can('money');

// ───────────── Domain ─────────────
const products = () => C.products.filter(p => !p.deleted);
const P = id => C.products.find(p => p.id === id);
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
const discShare = s => { const sub = s.items.reduce((a, i) => a + i.qty * i.price, 0); return sub ? (sub - s.discount) / sub : 0; };
// Money lost on a return: what we refunded minus the value of goods that came back to stock.
const retLoss = r => r.refund - (r.restock ? r.qty * r.cost : 0);
const saleLoss = s => (s.rets || []).reduce((a, r) => a + retLoss(r), 0);
const expState = p => {
  if (!p.exp) return '';
  const d = (new Date(p.exp + 'T12:00') - new Date(today() + 'T12:00')) / 864e5;
  return d < 0 ? 'expired' : d <= 30 ? 'soon' : '';
};
function searchProducts(q) {
  const raw = digits(q).trim().toLowerCase(), toks = raw.split(/\s+/).filter(Boolean);
  return products().filter(p => { const hay = [p.name, p.brand, p.barcode, p.cat, p.flavor, p.size].join(' ').toLowerCase(); return toks.every(t => hay.includes(t)); })
    .sort((a, b) => (b.barcode === raw) - (a.barcode === raw) || (b.qty > 0) - (a.qty > 0) || byName(a, b));
}

// Daily totals. Each sale/return/expense adds its share to days/{date}; reports just sum those docs.
const NUM_KEYS = ['sales', 'store', 'online', 'cogs', 'profit', 'pStore', 'pOnline', 'n', 'nStore', 'nOnline', 'disc', 'refunds', 'nRet', 'exp'];
function scale(o, k) { const out = {}; for (const [key, v] of Object.entries(o)) out[key] = typeof v === 'number' ? v * k : v && typeof v === 'object' ? scale(v, k) : v; return out; }
function saleContrib(s, sign) {
  const c = calc(s), K = s.type === 'store' ? 'Store' : 'Online', sh = c.sub ? (c.sub - s.discount) / c.sub : 0;
  const o = { sales: c.total, [s.type]: c.total, cogs: c.cogs, profit: c.profit, ['p' + K]: c.profit, n: 1, ['n' + K]: 1, disc: s.discount, prod: {} };
  for (const i of s.items) { const rev = i.qty * i.price * sh, x = o.prod[i.pid] ||= { name: i.name, qty: 0, rev: 0, profit: 0 }; x.qty += i.qty; x.rev += rev; x.profit += rev - i.qty * i.cost; }
  return scale(o, sign);
}
function retContrib(r, type, sign) {
  const K = type === 'store' ? 'Store' : 'Online', lost = retLoss(r);
  return scale({ sales: -r.refund, [type]: -r.refund, cogs: -(r.refund - lost), profit: -lost, ['p' + K]: -lost, refunds: r.refund, nRet: 1, prod: { [r.pid]: { name: r.name, qty: -r.qty, rev: -r.refund, profit: -lost } } }, sign);
}
function addInto(acc, c) { for (const [k, v] of Object.entries(c)) { if (typeof v === 'number') acc[k] = (acc[k] || 0) + v; else if (v && typeof v === 'object') addInto(acc[k] ||= {}, v); else acc[k] = v; } return acc; }
function incObj(o) { const out = {}; for (const [k, v] of Object.entries(o)) out[k] = typeof v === 'number' ? FS.increment(v) : v && typeof v === 'object' ? incObj(v) : v; return out; }
// Collects day changes so each day doc is written once per transaction.
function dayAcc() {
  const m = {};
  return { add(date, c) { addInto(m[date] ||= {}, c); }, flush(tx) { for (const [date, c] of Object.entries(m)) tx.set(dref('days', date), { date, ...incObj(c) }, { merge: true }); } };
}
function statsOf(src, a, b, withProd = false) {
  const o = Object.fromEntries(NUM_KEYS.map(k => [k, 0])); o.prod = {};
  for (const [date, d] of Object.entries(src)) {
    if (date < a || date > b) continue;
    for (const k of NUM_KEYS) o[k] += d[k] || 0;
    if (withProd && d.prod) for (const [pid, x] of Object.entries(d.prod)) {
      const y = o.prod[pid] ||= { pid, name: P(pid)?.name || x.name || '—', qty: 0, rev: 0, profit: 0 };
      y.qty += x.qty || 0; y.rev += x.rev || 0; y.profit += x.profit || 0;
    }
  }
  o.net = o.profit - o.exp;
  return o;
}
const stats = (a, b, wp) => statsOf(C.days, a, b, wp);
function moveDoc(tx, pid, name, qty, after, reason, ref = '') {
  tx.set(newRef('moves'), { at: nowISO(), date: today(), pid, name, qty, after, reason, ref, user: ME.name, uid: ME.id });
}

// ───────────── Transactions (every stock change goes through one of these) ─────────────
async function txCheckout(lines, f) {
  return FS.runTransaction(db, async tx => {
    const on = f.type === 'online', cRef = dref('counters', 'main'), pRefs = lines.map(l => dref('products', l.pid));
    const custRef = on ? dref('customers', f.phone) : null;
    const [cSnap, custSnap, ...pSnaps] = await Promise.all([tx.get(cRef), custRef ? tx.get(custRef) : null, ...pRefs.map(r => tx.get(r))]);
    const items = lines.map((l, k) => {
      const s = pSnaps[k];
      if (!s.exists() || s.data().deleted) throw new UErr('منتج غير موجود: ' + l.name);
      const p = s.data();
      if (p.qty < l.qty) throw new UErr(`الكمية المتوفرة غير كافية. (${p.name}: المتوفر ${p.qty})`);
      return { pid: s.id, name: p.name, qty: l.qty, price: p.price, cost: p.cost, _p: p };
    });
    const sub = items.reduce((a, i) => a + i.qty * i.price, 0);
    if (f.discount > sub) throw new UErr('الخصم أكبر من مجموع المنتجات');
    const key = on ? 'order' : 'sale', seq = (cSnap.data()?.[key] || 0) + 1, no = (on ? 'ORD-' : 'INV-') + pad(seq), at = nowISO(), st = on ? 'طلب جديد' : 'مكتمل';
    const sRef = newRef('sales');
    const sale = {
      no, type: f.type, date: today(), at, items: items.map(({ _p, ...i }) => i), discount: f.discount, fee: f.fee, dcost: f.dcost, pay: f.pay, notes: f.notes, status: st,
      custId: custRef?.id || null, cust: on ? { name: f.name, phone: f.phone, address: f.address } : null,
      user: ME.name, uid: ME.id, log: [{ st, at, user: ME.name }], returned: {}, refunds: 0, rets: [],
    };
    tx.set(cRef, { [key]: seq }, { merge: true });
    tx.set(sRef, sale);
    items.forEach((i, k) => {
      const after = i._p.qty - i.qty;
      tx.update(pRefs[k], { qty: after, sold: (i._p.sold || 0) + i.qty, used: true, updatedAt: at });
      moveDoc(tx, i.pid, i.name, -i.qty, after, (on ? 'طلب أونلاين ' : 'بيع ') + no, no);
    });
    const days = dayAcc(); days.add(sale.date, saleContrib(sale, 1)); days.flush(tx);
    if (custRef) {
      const c = custSnap.exists() ? custSnap.data() : {};
      tx.set(custRef, { name: f.name, phone: f.phone, address: f.address || c.address || '', notes: c.notes || '', orders: (c.orders || 0) + 1, total: (c.total || 0) + calc(sale).total, lastAt: at, createdAt: c.createdAt || at, deleted: false });
    }
    return { sale: { id: sRef.id, ...sale }, low: items.filter(i => i._p.qty - i.qty <= i._p.min).map(i => ({ name: i.name, qty: i._p.qty - i.qty })) };
  });
}
// Leaving an active status restocks what the customer still holds (sold − returned);
// coming back takes it out again — only if the stock is there.
async function txStatus(id, st) {
  return FS.runTransaction(db, async tx => {
    const sRef = dref('sales', id), sSnap = await tx.get(sRef);
    if (!sSnap.exists()) throw new UErr('العملية غير موجودة');
    const s = { id, ...sSnap.data() };
    if (s.status === st) return null;
    const was = live(s), will = !DEAD.includes(st), at = nowISO();
    if (was !== will) {
      const pRefs = s.items.map(i => dref('products', i.pid)), custRef = s.custId ? dref('customers', s.custId) : null;
      const [custSnap, ...pSnaps] = await Promise.all([custRef ? tx.get(custRef) : null, ...pRefs.map(r => tx.get(r))]);
      const dir = will ? -1 : 1;
      s.items.forEach((i, k) => {
        const left = i.qty - (s.returned?.[i.pid] || 0);
        if (left <= 0) return;
        if (!pSnaps[k].exists()) { if (will) throw new UErr(`المنتج ${i.name} غير موجود`); return; }
        const p = pSnaps[k].data(), after = p.qty + dir * left;
        if (after < 0) throw new UErr(`الكمية المتوفرة غير كافية. لا يمكن إعادة تفعيل ${s.no} (${i.name})`);
        tx.update(pRefs[k], { qty: after, sold: (p.sold || 0) - dir * left, updatedAt: at });
        moveDoc(tx, i.pid, i.name, dir * left, after, `${will ? 'إعادة تفعيل' : st === 'ملغي' ? 'إلغاء' : 'إرجاع'} ${s.no}`, s.no);
      });
      const k = will ? 1 : -1, days = dayAcc();
      days.add(s.date, saleContrib(s, k));
      for (const r of s.rets || []) days.add(r.date, retContrib(r, s.type, k));
      days.flush(tx);
      if (custSnap?.exists()) { const c = custSnap.data(); tx.update(custRef, { orders: (c.orders || 0) + k, total: (c.total || 0) + k * (calc(s).total - (s.refunds || 0)) }); }
    }
    tx.update(sRef, { status: st, log: [...(s.log || []), { st, at, user: ME.name }] });
    return st;
  });
}
async function txReturn(saleId, pid, qty, refund, restock, reason) {
  return FS.runTransaction(db, async tx => {
    const sRef = dref('sales', saleId), pRef = dref('products', pid), cRef = dref('counters', 'main');
    const [sSnap, pSnap, cSnap] = await Promise.all([tx.get(sRef), tx.get(pRef), tx.get(cRef)]);
    if (!sSnap.exists()) throw new UErr('الفاتورة غير موجودة');
    const s = { id: saleId, ...sSnap.data() };
    const custRef = s.custId ? dref('customers', s.custId) : null, custSnap = custRef ? await tx.get(custRef) : null;
    if (!live(s)) throw new UErr('لا يمكن الإرجاع من عملية ملغاة');
    const it = s.items.find(i => i.pid === pid);
    if (!it) throw new UErr('المنتج غير موجود في هذه الفاتورة');
    const left = it.qty - (s.returned?.[pid] || 0);
    if (!Number.isInteger(qty) || qty < 1 || qty > left) throw new UErr(`الكمية المرتجعة غير صحيحة (المتاح للإرجاع: ${left})`);
    if (!(refund >= 0 && refund <= qty * it.price)) throw new UErr('المبلغ المُعاد غير صحيح');
    const seq = (cSnap.data()?.ret || 0) + 1, no = 'RET-' + pad(seq), at = nowISO(), date = today();
    const r = { no, saleId, saleNo: s.no, type: s.type, pid, name: it.name, qty, price: it.price, cost: it.cost, refund, restock, reason, date, at, user: ME.name, uid: ME.id };
    tx.set(cRef, { ret: seq }, { merge: true });
    tx.set(newRef('returns'), r);
    tx.update(sRef, { returned: { ...(s.returned || {}), [pid]: (s.returned?.[pid] || 0) + qty }, refunds: (s.refunds || 0) + refund, rets: [...(s.rets || []), { no, date, pid, name: it.name, qty, refund, cost: it.cost, restock }] });
    if (pSnap.exists()) {
      const p = pSnap.data(), after = p.qty + (restock ? qty : 0);
      tx.update(pRef, { qty: after, sold: (p.sold || 0) - qty, updatedAt: at });
      if (restock) moveDoc(tx, pid, it.name, qty, after, `مرتجع ${no} (${s.no})`, no);
    }
    const days = dayAcc(); days.add(date, retContrib(r, s.type, 1)); days.flush(tx);
    if (custSnap?.exists()) tx.update(custRef, { total: (custSnap.data().total || 0) - refund });
    return r;
  });
}
async function txPurchase(pb) {
  return FS.runTransaction(db, async tx => {
    const cRef = dref('counters', 'main'), pids = [...new Set(pb.items.map(i => i.pid))];
    const supRef = pb.newSup ? newRef('suppliers') : pb.sid ? dref('suppliers', pb.sid) : null;
    const [cSnap, supSnap, ...pSnaps] = await Promise.all([tx.get(cRef), supRef && !pb.newSup ? tx.get(supRef) : null, ...pids.map(id => tx.get(dref('products', id)))]);
    const seq = (cSnap.data()?.pur || 0) + 1, no = 'PUR-' + pad(seq), at = nowISO();
    const cur = {};
    pids.forEach((id, k) => { if (!pSnaps[k].exists()) throw new UErr('منتج غير موجود'); cur[id] = { ...pSnaps[k].data() }; });
    const sup = supSnap?.data() || (pb.newSup ? { name: pb.newSup.name, phone: pb.newSup.phone, company: '', notes: '', createdAt: at, total: 0, paid: 0, prods: [] } : null);
    const items = pb.items.map(i => ({ ...i, name: cur[i.pid].name }));
    for (const i of items) {
      const p = cur[i.pid], old = Math.max(0, p.qty);
      p.cost = old + i.qty > 0 ? Math.round((old * p.cost + i.qty * i.cost) / (old + i.qty)) : i.cost; // weighted average cost
      p.qty += i.qty;
      moveDoc(tx, i.pid, i.name, i.qty, p.qty, `شراء ${no}${sup ? ' من ' + sup.name : ''}`, no);
    }
    for (const id of pids) tx.update(dref('products', id), { qty: cur[id].qty, cost: cur[id].cost, used: true, updatedAt: at });
    const total = items.reduce((a, i) => a + i.qty * i.cost, 0);
    tx.set(cRef, { pur: seq }, { merge: true });
    tx.set(newRef('purchases'), { no, supplierId: supRef?.id || null, supName: sup?.name || '', date: pb.date, inv: pb.inv, items, total, paid: pb.paid, notes: pb.notes, at, user: ME.name });
    if (supRef) tx.set(supRef, { ...sup, total: (sup.total || 0) + total, paid: (sup.paid || 0) + pb.paid, prods: [...new Set([...(sup.prods || []), ...items.map(i => i.name)])], updatedAt: at });
    return no;
  });
}
async function txDelPurchase(id) {
  return FS.runTransaction(db, async tx => {
    const xRef = dref('purchases', id), xSnap = await tx.get(xRef);
    if (!xSnap.exists()) throw new UErr('الشراء غير موجود');
    const x = xSnap.data(), need = {};
    for (const i of x.items) need[i.pid] = (need[i.pid] || 0) + i.qty;
    const pids = Object.keys(need), supRef = x.supplierId ? dref('suppliers', x.supplierId) : null;
    const [supSnap, ...pSnaps] = await Promise.all([supRef ? tx.get(supRef) : null, ...pids.map(p => tx.get(dref('products', p)))]);
    const at = nowISO();
    pids.forEach((pid, k) => {
      const p = pSnaps[k].exists() ? pSnaps[k].data() : null;
      if (!p || p.qty < need[pid]) throw new UErr(`لا يمكن الحذف: جزء من «${p?.name || pid}» تم بيعه أو تعديله`);
      tx.update(dref('products', pid), { qty: p.qty - need[pid], updatedAt: at });
      moveDoc(tx, pid, p.name, -need[pid], p.qty - need[pid], `حذف الشراء ${x.no}`, x.no);
    });
    if (supSnap?.exists()) { const s = supSnap.data(); tx.update(supRef, { total: (s.total || 0) - x.total, paid: (s.paid || 0) - x.paid }); }
    tx.delete(xRef);
  });
}
async function txSupPay(sid, amount, date, notes) {
  return FS.runTransaction(db, async tx => {
    const ref = dref('suppliers', sid), snap = await tx.get(ref), s = snap.data(), due = (s.total || 0) - (s.paid || 0);
    if (!(amount > 0 && amount <= due)) throw new UErr(`المبلغ يجب أن يكون بين 1 و ${fmtN(due)}`);
    tx.set(newRef('supPays'), { supplierId: sid, amount, date, notes, at: nowISO(), user: ME.name });
    tx.update(ref, { paid: (s.paid || 0) + amount });
  });
}
const ADJ = { add: 'إضافة كمية', damage: 'تالف', lost: 'مفقود', expired: 'منتهي الصلاحية', count: 'جرد (تعيين الكمية الفعلية)' };
async function txAdjust(pid, type, n, note) {
  return FS.runTransaction(db, async tx => {
    const ref = dref('products', pid), snap = await tx.get(ref), p = snap.data();
    const d = type === 'count' ? n - p.qty : type === 'add' ? n : -n;
    if (!d) throw new UErr('لا يوجد تغيير في الكمية');
    if (p.qty + d < 0) throw new UErr('الكمية المتوفرة غير كافية.');
    tx.update(ref, { qty: p.qty + d, updatedAt: nowISO() });
    moveDoc(tx, pid, p.name, d, p.qty + d, (type === 'count' ? `جرد: ${p.qty} → ${n}` : ADJ[type]) + (note ? ' — ' + note : ''));
  });
}
async function txExpense(id, e) {
  return FS.runTransaction(db, async tx => {
    const ref = id ? dref('expenses', id) : newRef('expenses'), old = id ? (await tx.get(ref)).data() : null, days = dayAcc();
    if (old) days.add(old.date, { exp: -old.amount });
    if (e) { days.add(e.date, { exp: e.amount }); tx.set(ref, { ...e, month: e.date.slice(0, 7), ...(old ? {} : { at: nowISO(), user: ME.name }) }, { merge: true }); }
    else tx.delete(ref);
    days.flush(tx);
  });
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
let MODAL_KEY = '';
const modalOpen = () => $('#modal').classList.contains('open');
function openModal(html, key = '') {
  if (key !== MODAL_KEY) stopAll(ML);
  MODAL_KEY = key;
  $('#modal-body').innerHTML = html;
  $('#modal').classList.add('open'); document.body.classList.add('modal-open');
}
function closeModal() {
  stopAll(ML); MODAL_KEY = '';
  $('#modal').classList.remove('open'); document.body.classList.remove('modal-open');
  $('#modal-body').innerHTML = '';
}
const val = id => ($('#' + id)?.value ?? '').trim();
function fld(id, label, value = '', o = {}) {
  return `<label class="fld${o.full ? ' full' : ''}"><span>${label}</span><input id="${id}" type="${o.type || 'text'}" value="${esc(value ?? '')}"${o.num ? ' inputmode="numeric" autocomplete="off"' : ''}${o.list ? ` list="${o.list}"` : ''}${o.ph ? ` placeholder="${esc(o.ph)}"` : ''}${o.attrs ? ' ' + o.attrs : ''}></label>`;
}
// Default logo is plain styled text (not SVG) so it also renders inside PDFs.
function logoHtml(sz, shop = C.shop) {
  if (shop.logo) return `<img class="logo" src="${esc(shop.logo)}" style="width:${sz}px;height:${sz}px" alt="">`;
  const t = (shop.name || 'TNT').trim().slice(0, 4);
  return `<span class="logo txt" style="width:${sz}px;height:${sz}px;font-size:${Math.round(sz * (t.length <= 3 ? 0.3 : 0.24))}px;border-width:${Math.max(2, Math.round(sz / 22))}px">${esc(t)}</span>`;
}
const thumb = (p, cls = '') => p.img ? `<img class="thumb ${cls}" src="${esc(p.img)}" alt="">` : `<span class="thumb ph ${cls}">💪</span>`;
const stockBadge = p => p.qty <= 0 ? '<span class="badge bad">🔴 المنتج نافد</span>' : p.qty <= p.min ? '<span class="badge warn">⚠️ المنتج قريب من النفاد</span>' : '';
const expBadge = p => { const e = expState(p); return e === 'expired' ? '<span class="badge bad">⛔ منتهي الصلاحية</span>' : e === 'soon' ? `<span class="badge warn">⏳ ينتهي ${fmtDate(p.exp)}</span>` : ''; };
const stBadge = s => `<span class="badge ${ST_CLS[s.status] || ''}">${s.status}</span>`;
const kpi = (ic, label, value, sub = '', tone = 'o', href = '', cls = '') => {
  const tag = href ? `a href="#/${href}"` : 'div';
  return `<${tag} class="kpi"><span class="ic t-${tone}">${ic}</span><span class="kl">${label}</span><b class="kv ${cls}">${value}</b>${sub ? `<small>${sub}</small>` : ''}</${href ? 'a' : 'div'}>`;
};
const empty = t => `<div class="empty">${t}</div>`;
const loading = () => '<div class="empty"><span class="spin"></span> جاري التحميل…</div>';
const statusSelect = s => `<select class="st-sel" onclick="event.stopPropagation()" onchange="setStatus('${s.id}',this.value)" aria-label="حالة الطلب">${ONLINE_ST.map(x => `<option ${x === s.status ? 'selected' : ''}>${x}</option>`).join('')}</select>`;
function saleCard(s, withStatus = false) {
  const c = calc(s), rf = s.refunds || 0;
  return `<div class="scard${live(s) ? '' : ' dead'}" onclick="showReceipt('${s.id}')">
    <div class="sc-row"><b>${s.type === 'online' ? '🌐' : '🏪'} ${s.no}</b>${stBadge(s)}</div>
    ${s.cust ? `<div class="small">👤 ${esc(s.cust.name)} · <a dir="ltr" href="tel:${esc(s.cust.phone)}" onclick="event.stopPropagation()">${esc(s.cust.phone)}</a></div>` : ''}
    <div class="sc-items">${esc(s.items.map(i => i.name + ' ×' + i.qty).join('، '))}</div>
    <div class="sc-row"><span class="muted small">${fmtDT(s.at)} · ${esc(s.pay)} · ${esc(s.user)}</span><b class="sc-tot">${money(c.total)}</b></div>
    ${rf ? `<div class="small warn">↩️ مرتجع: ${money(rf)}</div>` : ''}
    ${can('money') ? `<div class="small ${c.profit < 0 ? 'bad' : 'ok'}">الربح: ${money(c.profit - saleLoss(s))}</div>` : ''}
    ${withStatus && s.type === 'online' ? `<div class="sc-st">${statusSelect(s)}</div>` : ''}
  </div>`;
}
const moveRows = l => l.map(m => `<div class="mrow"><span class="mq ${m.qty > 0 ? 'ok' : 'bad'}" dir="ltr">${m.qty > 0 ? '+' : ''}${m.qty}</span><div><b>${esc(m.name)}</b><small>${esc(m.reason)}</small><small>👤 ${esc(m.user)} · ${fmtDT(m.at)}</small></div><span class="mafter" title="الرصيد بعد الحركة">${m.after}</span></div>`).join('');
function buckets(a, b, mode, src = C.days) {
  const days = Math.round((new Date(b + 'T12:00') - new Date(a + 'T12:00')) / 864e5) + 1;
  mode ||= days <= 31 ? 'd' : days <= 120 ? 'w' : 'm';
  const out = [], lab = d => +d.slice(8) + '/' + +d.slice(5, 7);
  if (mode === 'd') for (let d = a; d <= b; d = addDays(d, 1)) out.push({ l: lab(d), a: d, b: d });
  else if (mode === 'w') for (let d = a; d <= b; d = addDays(d, 7)) { const e = addDays(d, 6); out.push({ l: lab(d), a: d, b: e < b ? e : b }); }
  else for (let d = a; d <= b;) { const e = monthEnd(d); out.push({ l: +d.slice(5, 7) + '/' + d.slice(2, 4), a: d, b: e < b ? e : b }); d = addDays(e, 1); }
  return out.map(x => ({ ...x, s: statsOf(src, x.a, x.b) }));
}
function barChart(rows) {
  const H = 150, mx = Math.max(1, ...rows.map(r => Math.max(r.s.store, r.s.online))), every = Math.ceil(rows.length / 8);
  const tot = rows.reduce((a, r) => a + r.s.sales, 0);
  return `<div class="legend"><span><i class="st"></i>المحل</span><span><i class="on"></i>الأونلاين</span><b>${money(tot)}</b></div>
  <div class="chart">${rows.map((r, k) => `<button class="col" type="button" onclick="toast('${r.l} — المحل: ${money(r.s.store)} · الأونلاين: ${money(r.s.online)}')" aria-label="${r.l}"><span class="bars"><i class="st" style="height:${(Math.max(0, r.s.store) / mx * H).toFixed(1)}px"></i><i class="on" style="height:${(Math.max(0, r.s.online) / mx * H).toFixed(1)}px"></i></span><span class="cl">${(rows.length - 1 - k) % every === 0 ? r.l : ''}</span></button>`).join('')}</div>`;
}
function blurInside(el) { const a = document.activeElement; if (a && a !== document.body && el.contains(a)) a.blur(); }

// ───────────── Routing ─────────────
const ROUTES = {
  dash: { t: 'لوحة التحكم', s: 'الرئيسية', i: '📊', html: pDash },
  pos: { t: 'بيع جديد', s: 'بيع', i: '🛒', html: pPos, mount: mPos, live: () => { posResults(); if (!focusedIn($('#pcart'))) renderCart(); posSum(); } },
  store: { t: 'مبيعات المحل', i: '🏪', html: pStore, mount: storeList, live: storeList, watch: storeWatch },
  online: { t: 'المبيعات الأونلاين', s: 'الطلبات', i: '🌐', html: pOnline, mount: onlineList, live: onlineList, watch: onlineWatch },
  inv: { t: 'المخزون', i: '🏬', html: pInv, mount: () => { invTable(); moveLog(); }, live: () => { invTable(); moveLog(); }, watch: movesWatch },
  prod: { t: 'المنتجات', i: '📦', html: pProd, mount: prodList, live: prodList },
  pur: { t: 'المشتريات', i: '🚚', perm: 'stock', html: pPur, mount: () => { pbItems(); pbSum(); purList(); }, live: purList, watch: purWatch },
  cust: { t: 'العملاء', i: '👥', html: pCust, mount: custList, live: custList, watch: custWatch },
  sup: { t: 'الموردون', i: '🤝', perm: 'stock', html: pSup },
  exp: { t: 'المصاريف', i: '💸', perm: 'money', html: pExp, watch: expWatch },
  ret: { t: 'المرتجعات', i: '↩️', perm: 'returns', html: pRet, mount: () => { retOpts(); retForm(); }, watch: retWatch },
  rep: { t: 'التقارير', i: '📈', perm: 'money', html: pRep },
  users: { t: 'المستخدمون', i: '🔐', perm: 'admin', html: pUsers },
  set: { t: 'الإعدادات', i: '⚙️', perm: 'admin', html: pSet },
  more: { t: 'المزيد', i: '☰', html: pMore },
};
const SIDE = ['dash', ['المبيعات', ['pos', 'store', 'online']], 'inv', 'prod', 'pur', 'cust', 'sup', 'exp', 'ret', 'rep', 'users', 'set'];
const BNAV = ['dash', 'pos', 'online', 'prod', 'more'];
const allowed = r => { const p = ROUTES[r]?.perm; return !p || (p === 'admin' ? isAdmin() : can(p)); };
let route = 'dash', params = new URLSearchParams(), lastRoute = '';
const UI = { chart: 'd', pq: '', pf: 'all', pc: '', ps: 'name', sr: 'today', sq: '', slim: 300, of: 'all', oq: '', olim: 200, iq: '', mp: '', mt: '', ml: 100, cq: '', em: '', ra: '', rb: '' };

function parseHash() {
  const h = decodeURIComponent(location.hash.replace(/^#\/?/, '')), [r, qs] = h.split('?');
  return { r: ROUTES[r] ? r : 'dash', q: new URLSearchParams(qs || '') };
}
function go(r) { const h = '#/' + r; if (location.hash === h) render(); else location.hash = h; }
function showChrome(on) { ['#top', '#side', '#bnav', '#main'].forEach(s => $(s).hidden = !on); $('#lock').hidden = on; }

function render() {
  if (!ME) return;
  if (!booted) return showLoading();
  const { r, q } = parseHash();
  if (!allowed(r)) { toast('ليس لديك صلاحية للوصول إلى هذه الصفحة', 'bad'); location.replace('#/dash'); return; }
  const routeChanged = r !== lastRoute;
  route = r; params = q;
  blurInside($('#main'));
  if (routeChanged) { stopAll(PL); Q = {}; }
  showChrome(true);
  renderChrome();
  const pg = ROUTES[r];
  if (routeChanged) pg.watch?.();
  $('#main').innerHTML = `<h1 class="ptitle">${pg.i} ${pg.t}</h1>` + pg.html();
  if ([...q.keys()].length) history.replaceState(null, '', '#/' + r);
  pg.mount?.();
  if (routeChanged) { window.scrollTo(0, 0); lastRoute = r; }
  stale = false;
}
function renderChrome() {
  const pend = C.pending.length, badge = r => r === 'online' && pend ? `<em>${pend}</em>` : '';
  const off = navigator.onLine === false ? '<span class="offline">📴 غير متصل</span>' : '';
  $('#top').innerHTML = `<a class="brand" href="#/dash">${logoHtml(36)}<span>${esc(C.shop.name)}</span></a>${off}
    <div class="who"><button class="whobtn" onclick="accountForm()" aria-label="حسابي">${esc(ME.name)}<small>${isAdmin() ? 'مدير' : 'موظف'} ✏️</small></button><button class="lockbtn" onclick="logout()" aria-label="تسجيل الخروج">🔒</button></div>`;
  const link = r => `<a href="#/${r}" class="${r === route ? 'on' : ''}"><span class="i">${ROUTES[r].i}</span><span>${ROUTES[r].t}</span>${badge(r)}</a>`;
  $('#side').innerHTML = `<div class="side-brand">${logoHtml(44)}<div><b>${esc(C.shop.name)}</b><small>Supplement Store Manager</small></div></div>`
    + SIDE.map(x => Array.isArray(x) ? `<div class="grp">${x[0]}</div>` + x[1].filter(allowed).map(link).join('') : allowed(x) ? link(x) : '').join('')
    + `<div class="side-foot"><button class="whobtn side" onclick="accountForm()">👤 ${esc(ME.name)} · ${isAdmin() ? 'مدير' : 'موظف'} ✏️</button><button class="btn ghost block sm" onclick="logout()">🔒 تسجيل الخروج</button></div>`;
  const moreOn = !BNAV.includes(route);
  $('#bnav').innerHTML = BNAV.map(r => `<a href="#/${r}" class="${r === route || (r === 'more' && moreOn) ? 'on' : ''}"><span class="i">${ROUTES[r].i}</span><span>${ROUTES[r].s || ROUTES[r].t}</span>${badge(r)}</a>`).join('');
}

// ───────────── Sign-in, first-run setup, account ─────────────
let meUnsub = null, SETUP = false, SESSION = 0, FRESH = false;
function onAuth(user) {
  meUnsub?.(); meUnsub = null; SESSION++;
  stopAll(LS); stopAll(PL); closeModal();
  ME = null; booted = false; C = freshCache(); Q = {}; lastRoute = '';
  if (!user) return showLogin();
  showLoading();
  meUnsub = FS.onSnapshot(dref('users', user.uid), { includeMetadataChanges: true }, d => {
    if (d.metadata.hasPendingWrites) return; // wait until the server has the profile, or reads get refused
    const u = d.exists() ? { id: d.id, ...d.data() } : null;
    if (!u || !u.active) {
      if (SETUP && !u) return; // first-run: the profile is being written right now
      ME = null; stopAll(LS); booted = false;
      return showBlocked();
    }
    const first = !ME; ME = u;
    if (first && FRESH) { FRESH = false; history.replaceState(null, '', '#/dash'); } // a new sign-in starts on the dashboard
    if (first) { startData(); findLegacyLocal(); } else changed();
  }, () => { if (!SETUP) showBlocked(); });
}
function lockShell(inner) { showChrome(false); $('#lock').innerHTML = inner; }
function showLoading() { lockShell(`<div class="lockbox"><div class="center">${logoHtml(78)}</div><h1>${esc(C.shop.name)}</h1><p><span class="spin"></span> جاري تحميل البيانات…</p></div>`); }
function showBlocked() {
  lockShell(`<div class="lockbox wide"><div class="center">${logoHtml(64)}</div><h1>الحساب غير مفعّل</h1><p>هذا الحساب موقوف أو غير موجود. اطلب من المدير تفعيله.</p><button class="btn block" onclick="logout()">تسجيل الخروج</button></div>`);
}
async function showLogin() {
  lockShell(`<div class="lockbox"><p><span class="spin"></span></p></div>`);
  let setupDone = true, shop = { ...SHOP0 };
  try {
    const [m, s] = await Promise.all([FS.getDoc(dref('meta', 'setup')), FS.getDoc(dref('settings', 'shop'))]);
    setupDone = m.exists(); shop = { ...SHOP0, ...(s.data() || {}) };
  } catch (e) { console.warn(e); }
  if (auth.currentUser) return;
  if (!setupDone) {
    lockShell(`<div class="lockbox wide"><div class="center">${logoHtml(72, shop)}</div><h1>مرحباً بك 👋</h1><p>إعداد النظام لأول مرة — أنشئ حساب المدير</p>
      ${fld('su_shop', 'اسم المحل', shop.name)}${fld('su_name', 'اسمك', '', { ph: 'مثال: أحمد' })}
      ${fld('su_email', 'بريدك الإلكتروني (لاستعادة كلمة المرور)', '', { type: 'email', attrs: 'dir="ltr" autocomplete="username" autocapitalize="none"' })}
      ${fld('su_pw', 'كلمة المرور (6 أحرف على الأقل)', '', { type: 'password', attrs: 'autocomplete="new-password"' })}
      ${fld('su_pw2', 'تأكيد كلمة المرور', '', { type: 'password', attrs: 'autocomplete="new-password" onkeydown="if(event.key===\'Enter\')doSetup()"' })}
      <button class="btn block lg" onclick="doSetup()">ابدأ ←</button></div>`);
    return;
  }
  lockShell(`<div class="lockbox wide"><div class="center">${logoHtml(72, shop)}</div><h1>${esc(shop.name)}</h1><p>تسجيل الدخول</p>
    ${fld('lg_u', 'اسم المستخدم أو البريد الإلكتروني', '', { attrs: 'dir="ltr" autocomplete="username" autocapitalize="none" spellcheck="false"' })}
    ${fld('lg_p', 'كلمة المرور', '', { type: 'password', attrs: 'autocomplete="current-password" onkeydown="if(event.key===\'Enter\')doLogin()"' })}
    <button class="btn block lg" onclick="doLogin()">دخول</button>
    <button class="linkbtn" onclick="forgotPw()">نسيت كلمة المرور؟</button></div>`);
}
async function doLogin() {
  const u = val('lg_u'), pw = $('#lg_p').value;
  if (!u || !pw) return toast('أدخل اسم المستخدم وكلمة المرور', 'bad');
  document.body.classList.add('busy');
  FRESH = true;
  try { await AU.signInWithEmailAndPassword(auth, toEmail(u), pw); }
  catch (e) { FRESH = false; toast(errMsg(e), 'bad'); }
  finally { document.body.classList.remove('busy'); }
}
async function forgotPw() {
  const u = val('lg_u');
  if (!u.includes('@')) return toast('أدخل بريدك الإلكتروني أولاً. الموظفون: اطلبوا من المدير حساباً جديداً.', 'warn');
  try { await AU.sendPasswordResetEmail(auth, toEmail(u)); toast('أرسلنا رابط تغيير كلمة المرور إلى بريدك ✉️', 'ok'); } catch (e) { toast(errMsg(e), 'bad'); }
}
async function doSetup() {
  const shop = val('su_shop') || 'TNT', name = val('su_name'), email = val('su_email').toLowerCase(), pw = $('#su_pw').value;
  if (!name) return toast('أدخل اسمك', 'bad');
  if (!/^\S+@\S+\.\S+$/.test(email)) return toast('أدخل بريداً إلكترونياً صحيحاً', 'bad');
  if (pw.length < 6) return toast('كلمة المرور 6 أحرف على الأقل', 'bad');
  if (pw !== $('#su_pw2').value) return toast('كلمتا المرور غير متطابقتين', 'bad');
  SETUP = true; FRESH = true; document.body.classList.add('busy');
  let cred = null;
  try {
    cred = await AU.createUserWithEmailAndPassword(auth, email, pw);
    const at = nowISO(), b = FS.writeBatch(db);
    b.set(dref('users', cred.user.uid), { name, email, role: 'admin', perms: {}, active: true, createdAt: at });
    b.set(dref('meta', 'setup'), { by: cred.user.uid, at });
    await b.commit();
    await FS.setDoc(dref('settings', 'shop'), { ...SHOP0, name: shop });
    toast('تم إعداد النظام ✅', 'ok');
  } catch (e) {
    toast(errMsg(e), 'bad');
    if (cred) { await cred.user.delete().catch(() => { }); }
  } finally { SETUP = false; document.body.classList.remove('busy'); }
}
async function logout() { closeModal(); await AU.signOut(auth); }
function accountForm() {
  openModal(`<h3>👤 حسابي</h3>
    <div class="kv-list"><div><span>اسم الدخول</span><b dir="ltr">${esc(userLabel(ME))}</b></div><div><span>الدور</span><b>${isAdmin() ? 'مدير (Admin)' : 'موظف'}</b></div></div>
    ${fld('ac_name', 'الاسم الظاهر', ME.name)}
    <button class="btn block" onclick="saveMyName()">💾 حفظ الاسم</button>
    <div class="lbl">تغيير كلمة المرور</div>
    ${fld('ac_cur', 'كلمة المرور الحالية', '', { type: 'password', attrs: 'autocomplete="current-password"' })}
    ${fld('ac_new', 'كلمة المرور الجديدة (6 أحرف على الأقل)', '', { type: 'password', attrs: 'autocomplete="new-password"' })}
    <button class="btn ghost block" onclick="changePw()">🔑 تغيير كلمة المرور</button>
    <button class="btn ghost block" onclick="closeModal()">إغلاق</button>`);
}
async function saveMyName() {
  const name = val('ac_name');
  if (!name) return toast('أدخل الاسم', 'bad');
  if (await act(() => FS.updateDoc(dref('users', ME.id), { name }), 'تم تغيير الاسم ✅')) closeModal();
}
async function changePw() {
  const cur = $('#ac_cur').value, nw = $('#ac_new').value;
  if (nw.length < 6) return toast('كلمة المرور الجديدة 6 أحرف على الأقل', 'bad');
  const ok = await act(async () => {
    const u = auth.currentUser;
    await AU.reauthenticateWithCredential(u, AU.EmailAuthProvider.credential(u.email, cur));
    await AU.updatePassword(u, nw);
  }, 'تم تغيير كلمة المرور ✅');
  if (ok) closeModal();
}

// ───────────── Dashboard ─────────────
let yearLoading = null;
function loadYear() {
  if (C.yearFrom || yearLoading) return;
  const ms = ymd(new Date(new Date().getFullYear(), new Date().getMonth() - 11, 1));
  yearLoading = FS.getDocs(FS.query(col('days'), FS.where('date', '>=', ms), FS.where('date', '<', C.daysFrom)))
    .then(s => { for (const d of s.docs) C.days[d.id] = d.data(); C.yearFrom = ms; changed(); })
    .catch(e => toast(errMsg(e), 'bad')).finally(() => { yearLoading = null; });
}
function pDash() {
  const t = today(), d = stats(t, t), m = stats(monthStart(t), t), ps = products(), sm = can('money');
  const low = ps.filter(p => p.qty > 0 && p.qty <= p.min), out = ps.filter(p => p.qty <= 0), expi = ps.filter(p => expState(p));
  const pend = C.pending.length;
  const vc = ps.reduce((a, p) => a + Math.max(0, p.qty) * p.cost, 0), vs = ps.reduce((a, p) => a + Math.max(0, p.qty) * p.price, 0);
  const top = Object.values(stats(addDays(t, -29), t, true).prod).filter(x => x.qty > 0).sort((a, b) => b.qty - a.qty).slice(0, 5);
  if (UI.chart === 'm') loadYear();
  const ms = ymd(new Date(new Date().getFullYear(), new Date().getMonth() - 11, 1));
  const chart = UI.chart === 'w' ? barChart(buckets(addDays(t, -55), t, 'w')) : UI.chart === 'm' ? (C.yearFrom ? barChart(buckets(ms, t, 'm')) : loading()) : barChart(buckets(addDays(t, -13), t, 'd'));
  const sp = Math.max(0, m.store) + Math.max(0, m.online), ps1 = sp ? Math.round(Math.max(0, m.store) / sp * 100) : 0;
  return `${legacyCard()}
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
    ${chart}
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
    ${[...out, ...low].map(p => `<button class="lrow" onclick="productView('${p.id}')">${thumb(p)}<div><b>${esc(p.name)}</b><small>${esc(p.brand || '')}</small>${stockBadge(p)}</div><div class="iq ${p.qty <= 0 ? 'bad' : 'warn'}"><b>${p.qty}</b><small>متبقي</small></div></button>`).join('') || empty('✅ كل المنتجات بمخزون جيد')}
  </div>
  ${expi.length ? `<div class="card"><div class="card-h"><b>⏳ صلاحية قريبة أو منتهية</b></div>${expi.map(p => `<button class="lrow" onclick="productView('${p.id}')">${thumb(p)}<div><b>${esc(p.name)}</b>${expBadge(p)}</div><div class="iq"><b>${p.qty}</b><small>قطعة</small></div></button>`).join('')}</div>` : ''}
  <div class="card"><div class="card-h"><b>🏆 أفضل المنتجات مبيعاً · آخر 30 يوم</b></div>
    ${top.map((x, k) => `<div class="rank"><span class="rk">${k + 1}</span><b>${esc(x.name)}</b><span>${x.qty} قطعة</span>${sm ? `<small class="ok">${money(x.profit)}</small>` : ''}</div>`).join('') || empty('لا توجد مبيعات بعد')}
  </div>
  <div class="card"><div class="card-h"><b>🧾 آخر عمليات البيع</b><a class="lnk" href="#/store">الكل</a></div>${C.recent.slice(0, 6).map(s => saleCard(s)).join('') || empty('لا توجد عمليات بعد — ابدأ من «بيع»')}</div>`;
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
      <datalist id="custdl">${C.custRecent.filter(c => c.phone).map(c => `<option value="${esc(c.phone)}">${esc(c.name)}</option>`).join('')}</datalist>
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
    list = products().filter(p => p.qty > 0).sort((a, b) => (b.sold || 0) - (a.sold || 0) || byName(a, b)).slice(0, 6);
    head = list.length ? '<div class="hint">الأكثر مبيعاً — أو ابحث عن أي منتج</div>' : '';
  }
  el.innerHTML = head + list.map(p => {
    const inCart = cart.find(c => c.pid === p.id)?.qty || 0;
    return `<button class="pitem" onclick="addToCart('${p.id}')" ${p.qty <= 0 ? 'disabled' : ''}>${thumb(p)}<span class="pi-b"><b>${esc(p.name)}</b><small>${esc([p.brand, p.size, p.flavor].filter(Boolean).join(' · '))}</small><span class="pi-m"><span class="price">${money(p.price)}</span><span class="${p.qty <= 0 ? 'bad' : p.qty <= p.min ? 'warn' : 'muted'}">${p.qty <= 0 ? 'نافد' : 'متوفر: ' + p.qty}${inCart ? ` · بالسلة ${inCart}` : ''}</span></span></span><span class="plus">＋</span></button>`;
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
  saveCart(); el.value = c.qty;
  el.closest('.cline').querySelector('.cl-t').textContent = money(p.price * c.qty);
  posSum();
}
function cartDel(i) { cart.splice(i, 1); saveCart(); renderCart(); posSum(); posResults(); }
function cartClear() { cart = []; saveCart(); renderCart(); posSum(); posResults(); }
let custT = 0;
function custFill() {
  clearTimeout(custT);
  const ph = normPhone(PF.phone);
  if (ph.length < 7) return;
  custT = setTimeout(async () => {
    let c = C.custRecent.find(x => x.id === ph);
    if (!c) try { const d = await FS.getDoc(dref('customers', ph)); if (d.exists() && !d.data().deleted) c = d.data(); } catch { }
    if (!c || normPhone(PF.phone) !== ph) return;
    if (!PF.name) { PF.name = c.name; if ($('#o_nm')) $('#o_nm').value = c.name; }
    if (!PF.address && c.address) { PF.address = c.address; if ($('#o_ad')) $('#o_ad').value = c.address; }
  }, 300);
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
async function checkout() {
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
  const phone = normPhone(PF.phone);
  if (t.on && (!PF.name.trim() || phone.length < 7)) return toast('أدخل اسم العميل ورقم هاتف صحيح للطلب الأونلاين', 'bad');
  const lines = cart.map(c => ({ pid: c.pid, qty: c.qty, name: P(c.pid).name }));
  const f = { type: t.on ? 'online' : 'store', pay: PF.pay, discount: t.disc, fee: t.fee, dcost: t.dcost, notes: PF.notes.trim(), name: PF.name.trim(), phone, address: PF.address.trim() };
  const r = await act(() => txCheckout(lines, f));
  if (!r) return;
  C.sales.set(r.sale.id, r.sale);
  cart = []; saveCart(); PF = PF0();
  render(); showReceipt(r.sale.id);
  toast(`تم تسجيل ${r.sale.no} ✅`, 'ok');
  r.low.forEach(x => toast(x.qty <= 0 ? `🔴 المنتج نافد: ${x.name}` : `⚠️ المنتج قريب من النفاد: ${x.name} (${x.qty})`, 'warn'));
}

// ───────────── Receipt / invoice ─────────────
function receiptHtml(s) {
  const c = calc(s), rets = s.rets || [], refunds = s.refunds || 0, on = s.type === 'online', sh = C.shop;
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
async function showReceipt(id) {
  let s = C.sales.get(id);
  if (!s) {
    try { const d = await FS.getDoc(dref('sales', id)); if (!d.exists()) return toast('العملية غير موجودة', 'bad'); s = { id, ...d.data() }; C.sales.set(id, s); }
    catch (e) { return toast(errMsg(e), 'bad'); }
  }
  renderReceipt(s);
  // keep the open receipt in sync with the database (status changes from another phone, returns…)
  ML.sale?.();
  ML.sale = FS.onSnapshot(dref('sales', id), d => {
    if (!d.exists() || MODAL_KEY !== 'sale:' + id) return;
    const ns = { id, ...d.data() }; C.sales.set(id, ns);
    const st = $('.sheet').scrollTop; renderReceipt(ns); $('.sheet').scrollTop = st;
  });
}
function renderReceipt(s) {
  const c = calc(s), on = s.type === 'online', rets = s.rets || [];
  let h = receiptHtml(s) + `<div class="actions"><button class="btn" onclick="printReceipt()">🖨️ طباعة</button><button class="btn ghost" onclick="pdfReceipt('${s.id}')">📄 تحميل PDF</button><button class="btn ghost" onclick="shareReceipt('${s.id}')">📤 مشاركة</button></div>`;
  if (on) h += `<div class="card soft"><label class="fld"><span>حالة الطلب</span>${statusSelect(s)}</label>${(s.log || []).map(l => `<div class="logline">• ${l.st} — ${fmtDT(l.at)} — ${esc(l.user)}</div>`).join('')}</div>`;
  if (can('money')) {
    const lost = saleLoss(s);
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
  if (!on && live(s) && can('del')) b.push(`<button class="btn danger" onclick="if(confirm('إلغاء الفاتورة سيعيد الكميات إلى المخزون ويحذفها من المبيعات. متأكد؟'))setStatus('${s.id}','ملغي')">إلغاء الفاتورة</button>`);
  if (!on && !live(s) && can('del')) b.push(`<button class="btn ghost" onclick="setStatus('${s.id}','مكتمل')">استعادة الفاتورة</button>`);
  if (b.length) h += `<div class="actions">${b.join('')}</div>`;
  h += `<button class="btn ghost block" onclick="closeModal()">إغلاق</button>`;
  openModal(h, 'sale:' + s.id);
  if (navigator.canShare) makePDF(s).catch(() => { }); // ready in advance so sharing stays one tap
}
async function setStatus(id, st) {
  const ok = await act(() => txStatus(id, st), `تم تحديث الحالة: ${st}`);
  if (!ok) { const s = C.sales.get(id); if (s && MODAL_KEY === 'sale:' + id) renderReceipt(s); if (!focusedIn($('#main'))) render(); }
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
const pdfKey = s => s.id + ':' + s.status + ':' + (s.refunds || 0) + ':' + C.shop.name;
async function makePDF(s) {
  const key = pdfKey(s);
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
  const s = C.sales.get(id);
  toast('جاري إنشاء PDF…');
  try { download(await makePDF(s), s.no + '.pdf'); } catch (e) { toast(e.message, 'bad'); }
}
function receiptText(s) {
  const c = calc(s);
  return [`${C.shop.name} — ${s.type === 'online' ? 'طلب' : 'فاتورة'} ${s.no}`, fmtDT(s.at), ...s.items.map(i => `• ${i.name} ×${i.qty} = ${money(i.qty * i.price)}`),
    s.discount ? `الخصم: ${money(s.discount)}` : '', s.fee ? `التوصيل: ${money(s.fee)}` : '', `الإجمالي: ${money(c.total)}`, `الدفع: ${s.pay}`, C.shop.footer].filter(Boolean).join('\n');
}
async function shareReceipt(id) {
  const s = C.sales.get(id), text = receiptText(s);
  if (pdfCache.key === pdfKey(s) && pdfCache.blob && navigator.canShare) {
    const file = new File([pdfCache.blob], s.no + '.pdf', { type: 'application/pdf' });
    if (navigator.canShare({ files: [file] })) { try { await navigator.share({ files: [file], title: s.no, text }); return; } catch (e) { if (e.name === 'AbortError') return; } }
  }
  if (navigator.share) { try { await navigator.share({ title: s.no, text }); return; } catch (e) { if (e.name === 'AbortError') return; } }
  window.open('https://wa.me/' + (s.cust ? waPhone(s.cust.phone) : '') + '?text=' + encodeURIComponent(text), '_blank');
}

// ───────────── Store sales & online orders ─────────────
const RANGES = [['today', 'اليوم'], ['7d', 'آخر 7 أيام'], ['month', 'هذا الشهر'], ['all', 'الكل']];
function rangeOf(k) { const t = today(); return k === 'today' ? [t, t] : k === '7d' ? [addDays(t, -6), t] : k === 'month' ? [monthStart(t), t] : ['', '']; }
function storeWatch() {
  Q.store = null;
  const [a, b] = rangeOf(UI.sr);
  const q = UI.sr === 'all' ? FS.query(col('sales'), FS.orderBy('at', 'desc'), FS.limit(UI.slim))
    : FS.query(col('sales'), FS.where('date', '>=', a), FS.where('date', '<=', b), FS.orderBy('date', 'desc'), FS.limit(2000));
  listen(PL, 'store', q, s => { const l = docsOf(s); remember(l); Q.store = l.filter(x => x.type === 'store').sort(byAtDesc); Q.storeFull = s.size >= (UI.sr === 'all' ? UI.slim : 2000); });
}
function pStore() {
  return `<a class="btn block" href="#/pos">＋ بيع جديد</a>
  <div class="chips">${RANGES.map(([k, l]) => `<button class="chip ${UI.sr === k ? 'on' : ''}" onclick="UI.sr='${k}';storeWatch();render()">${l}</button>`).join('')}</div>
  <input class="mb" placeholder="🔍 رقم الفاتورة أو اسم المنتج" value="${esc(UI.sq)}" oninput="UI.sq=this.value;storeList()">
  <div id="slist"></div>`;
}
function storeList() {
  const el = $('#slist'); if (!el) return;
  if (!Q.store) { el.innerHTML = loading(); return; }
  const q = digits(UI.sq).trim().toLowerCase();
  const l = Q.store.filter(s => !q || (s.no + ' ' + s.items.map(i => i.name).join(' ')).toLowerCase().includes(q));
  let tot = 0, pf = 0;
  for (const s of l) if (live(s)) { tot += calc(s).total - (s.refunds || 0); pf += calc(s).profit - saleLoss(s); }
  el.innerHTML = `<div class="sumbar"><span>${l.length} فاتورة</span><b>${money(tot)}</b>${can('money') ? `<span class="ok">ربح ${money(pf)}</span>` : ''}</div>`
    + (l.map(s => saleCard(s)).join('') || empty('لا توجد مبيعات في هذه الفترة'))
    + (UI.sr === 'all' && Q.storeFull ? `<button class="btn ghost block" onclick="UI.slim+=300;storeWatch();storeList()">عرض المزيد</button>` : '');
}
function onlineWatch() {
  Q.online = null;
  listen(PL, 'online', FS.query(col('sales'), FS.where('type', '==', 'online'), FS.orderBy('at', 'desc'), FS.limit(UI.olim)), s => { Q.online = docsOf(s); remember(Q.online); Q.onlineFull = s.size >= UI.olim; });
}
function pOnline() {
  const cnt = {}, base = Q.online || [];
  for (const s of base) cnt[s.status] = (cnt[s.status] || 0) + 1;
  const chips = [['all', 'الكل', base.length], ['active', 'قيد المتابعة', C.pending.length], ...ONLINE_ST.map(x => [x, x, cnt[x] || 0])];
  return `<a class="btn block" href="#/pos?type=online">＋ طلب أونلاين جديد</a>
  <div class="chips scroll">${chips.map(([k, l, n]) => `<button class="chip ${UI.of === k ? 'on' : ''}" onclick="UI.of='${k}';render()">${l} <em>${n}</em></button>`).join('')}</div>
  <input class="mb" placeholder="🔍 رقم الطلب أو اسم العميل أو الهاتف" value="${esc(UI.oq)}" oninput="UI.oq=this.value;onlineList()">
  <div id="olist"></div>`;
}
function onlineList() {
  const el = $('#olist'); if (!el) return;
  if (!Q.online && UI.of !== 'active') { el.innerHTML = loading(); return; }
  const q = digits(UI.oq).trim().toLowerCase();
  const src = UI.of === 'active' ? C.pending : Q.online;
  const l = src.filter(s => (UI.of === 'all' || UI.of === 'active' || s.status === UI.of) && (!q || [s.no, s.cust?.name, s.cust?.phone].join(' ').toLowerCase().includes(q)));
  let tot = 0, pf = 0;
  for (const s of l) if (live(s)) { tot += calc(s).total - (s.refunds || 0); pf += calc(s).profit - saleLoss(s); }
  el.innerHTML = `<div class="sumbar"><span>${l.length} طلب</span><b>${money(tot)}</b>${can('money') ? `<span class="ok">ربح ${money(pf)}</span>` : ''}</div>`
    + (l.map(s => saleCard(s, true)).join('') || empty('لا توجد طلبات'))
    + (UI.of !== 'active' && Q.onlineFull ? `<button class="btn ghost block" onclick="UI.olim+=200;onlineWatch();onlineList()">عرض المزيد</button>` : '');
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
  const el = $('#plist'); if (!el) return;
  const q = UI.pq.trim(), so = UI.ps;
  let l = q ? searchProducts(q) : products();
  if (UI.pf === 'low') l = l.filter(p => p.qty > 0 && p.qty <= p.min); else if (UI.pf === 'out') l = l.filter(p => p.qty <= 0); else if (UI.pf === 'exp') l = l.filter(p => expState(p));
  if (UI.pc) l = l.filter(p => p.cat === UI.pc);
  l = [...l].sort(so === 'qty' ? (a, b) => a.qty - b.qty : so === 'sales' ? (a, b) => (b.sold || 0) - (a.sold || 0) : so === 'price' ? (a, b) => b.price - a.price : so === 'exp' ? (a, b) => (a.exp || '9999').localeCompare(b.exp || '9999') : byName);
  el.innerHTML = `<div class="muted small mb">${l.length} منتج</div><div class="pgrid">${l.map(p => `<button class="pcard" onclick="productView('${p.id}')">${thumb(p)}<b>${esc(p.name)}</b><small>${esc([p.brand, p.size, p.flavor].filter(Boolean).join(' · '))}</small><span class="price">${money(p.price)}</span><span class="small">الكمية: <b>${p.qty}</b>${so === 'sales' ? ` · مبيع ${p.sold || 0}` : ''}</span>${stockBadge(p)}${expBadge(p)}</button>`).join('')}</div>`
    + (l.length ? '' : empty(products().length ? 'لا توجد نتائج' : 'لا توجد منتجات بعد'));
}
function productView(id) {
  const p = P(id); if (!p) return;
  openModal(`<div class="pview">${thumb(p, 'lg')}<div><h3>${esc(p.name)}</h3><div class="muted small">${esc([p.brand, p.cat, p.size, p.flavor].filter(Boolean).join(' · '))}</div>${stockBadge(p)} ${expBadge(p)}</div></div>
  <div class="kv-list">
    <div><span>سعر البيع</span><b>${money(p.price)}</b></div>
    ${seeCost() ? `<div><span>سعر الشراء</span><b>${money(p.cost)}</b></div><div><span>الربح للقطعة</span><b>${money(p.price - p.cost)}</b></div>` : ''}
    <div><span>الكمية الحالية</span><b>${p.qty}</b></div><div><span>الحد الأدنى للمخزون</span><b>${p.min}</b></div>
    ${p.barcode ? `<div><span>الباركود</span><b dir="ltr">${esc(p.barcode)}</b></div>` : ''}
    ${p.exp ? `<div><span>انتهاء الصلاحية</span><b>${fmtDate(p.exp)}</b></div>` : ''}
    <div><span>إجمالي المُباع</span><b>${p.sold || 0} قطعة</b></div>
    ${p.notes ? `<div><span>ملاحظات</span><b>${esc(p.notes)}</b></div>` : ''}
  </div>
  <div class="actions">
    ${p.qty > 0 ? `<button class="btn" onclick="closeModal();addToCart('${p.id}',true)">🛒 بيع</button>` : ''}
    ${can('stock') ? `<button class="btn ghost" onclick="productForm('${p.id}')">✏️ تعديل</button><button class="btn ghost" onclick="adjForm('${p.id}')">📦 تعديل المخزون</button>` : ''}
    ${can('del') ? `<button class="btn danger" onclick="delProduct('${p.id}')">🗑️ حذف</button>` : ''}
  </div>
  <div id="pv_moves"></div>
  <button class="btn ghost block" onclick="closeModal()">إغلاق</button>`, 'prod:' + id);
  FS.getDocs(FS.query(col('moves'), FS.where('pid', '==', id), FS.orderBy('at', 'desc'), FS.limit(8)))
    .then(s => { const el = $('#pv_moves'); if (el && !s.empty) el.innerHTML = `<div class="card-h"><b>آخر حركات المخزون</b></div>${moveRows(docsOf(s))}`; }).catch(() => { });
}
let FIMG = '';
const imgPrev = () => FIMG ? `<img class="thumb" src="${esc(FIMG)}" alt="">` : '<span class="thumb ph">💪</span>';
function productForm(id) {
  if (!can('stock')) return toast('ليس لديك صلاحية تعديل المنتجات', 'bad');
  const p = id ? P(id) : { min: C.shop.defMin };
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
  <div class="actions"><button class="btn" onclick="saveProduct('${id || ''}')">💾 حفظ</button><button class="btn ghost" onclick="closeModal()">إلغاء</button></div>`, 'pform');
}
async function pickImg(inp) {
  const f = inp.files[0]; if (!f) return;
  try { FIMG = await readImage(f, 200); $('#fimg').innerHTML = imgPrev(); } catch (e) { toast(e.message, 'bad'); }
}
async function saveProduct(id) {
  const name = val('f_name');
  if (!name) return toast('أدخل اسم المنتج', 'bad');
  const cost = num(val('f_cost')), price = num(val('f_price')), min = num(val('f_min')), q0 = id ? 0 : num(val('f_qty'));
  if (![cost, price, min, q0].every(x => Number.isFinite(x) && x >= 0)) return toast('تأكد من الأرقام — لا يمكن أن تكون سالبة', 'bad');
  if (!Number.isInteger(min) || !Number.isInteger(q0)) return toast('الكمية والحد الأدنى يجب أن تكون أرقاماً صحيحة', 'bad');
  if (!price) return toast('أدخل سعر البيع', 'bad');
  const bcode = digits(val('f_bc'));
  if (bcode && products().some(x => x.barcode === bcode && x.id !== id)) return toast('هذا الباركود مستخدم لمنتج آخر', 'bad');
  if (price < cost && !confirm('سعر البيع أقل من سعر الشراء — هل تريد المتابعة؟')) return;
  const at = nowISO();
  const d = { name, brand: val('f_brand'), cat: val('f_cat'), size: val('f_size'), flavor: val('f_flavor'), barcode: bcode, cost: Math.round(cost), price: Math.round(price), min, exp: val('f_exp'), notes: val('f_notes'), img: FIMG, updatedAt: at };
  const ok = await act(async () => {
    if (id) return FS.updateDoc(dref('products', id), d);
    const ref = newRef('products'), b = FS.writeBatch(db);
    b.set(ref, { ...d, qty: q0, sold: 0, used: false, deleted: false, createdAt: at });
    if (q0) b.set(newRef('moves'), { at, date: today(), pid: ref.id, name, qty: q0, after: q0, reason: 'رصيد افتتاحي', ref: '', user: ME.name, uid: ME.id });
    return b.commit();
  }, 'تم حفظ المنتج');
  if (ok) closeModal();
}
async function delProduct(id) {
  const p = P(id);
  if (!can('del') || !confirm(`حذف المنتج «${p.name}»؟`)) return;
  // Products with history are hidden, not erased, so old invoices and reports stay correct.
  const ok = await act(() => p.used ? FS.updateDoc(dref('products', id), { deleted: true, updatedAt: nowISO() }) : FS.deleteDoc(dref('products', id)), 'تم حذف المنتج');
  if (ok) { cart = cart.filter(c => c.pid !== id); saveCart(); closeModal(); }
}

// ───────────── Inventory ─────────────
function movesWatch() {
  Q.moves = null;
  const q = UI.mp ? FS.query(col('moves'), FS.where('pid', '==', UI.mp), FS.orderBy('at', 'desc'), FS.limit(UI.ml)) : FS.query(col('moves'), FS.orderBy('at', 'desc'), FS.limit(UI.ml));
  listen(PL, 'moves', q, s => { Q.moves = docsOf(s); Q.movesFull = s.size >= UI.ml; });
}
function pInv() {
  const ps = products(), sm = seeCost();
  const low = ps.filter(p => p.qty > 0 && p.qty <= p.min).length, out = ps.filter(p => p.qty <= 0).length;
  const vc = ps.reduce((a, p) => a + Math.max(0, p.qty) * p.cost, 0), vs = ps.reduce((a, p) => a + Math.max(0, p.qty) * p.price, 0);
  return `<div class="kpis">${kpi('📦', 'إجمالي القطع', ps.reduce((a, p) => a + Math.max(0, p.qty), 0), `${ps.length} منتج`, 'y')}${kpi('⚠️', 'قريبة من النفاد', low, '', 'y', 'prod?f=low', low ? 'warn' : '')}${kpi('🔴', 'نافدة', out, '', 'r', 'prod?f=out', out ? 'bad' : '')}${sm ? kpi('🏷️', 'القيمة بسعر الشراء', money(vc), '', 'b') + kpi('💎', 'القيمة بسعر البيع', money(vs), '', 'p') : ''}</div>
  ${can('stock') ? `<div class="actions"><a class="btn" href="#/pur">🚚 شراء بضاعة</a><button class="btn ghost" onclick="adjForm('','add')">➕ إضافة كمية</button><button class="btn ghost" onclick="adjForm('','damage')">🗑️ تالف / مفقود</button><button class="btn ghost" onclick="adjForm('','count')">📋 جرد</button></div>` : ''}
  <div class="card"><div class="card-h"><b>المخزون الحالي</b></div><input class="mb" placeholder="🔍 بحث" value="${esc(UI.iq)}" oninput="UI.iq=this.value;invTable()"><div id="itbl"></div></div>
  <div class="card"><div class="card-h"><b>🧾 سجل حركة المخزون</b></div>
    <div class="row mb"><select onchange="UI.mp=this.value;UI.ml=100;movesWatch();moveLog()" aria-label="المنتج"><option value="">كل المنتجات</option>${C.products.slice().sort(byName).map(p => `<option value="${p.id}" ${p.id === UI.mp ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
    <select onchange="UI.mt=this.value;moveLog()" aria-label="النوع"><option value="">كل الحركات</option><option value="in" ${UI.mt === 'in' ? 'selected' : ''}>إضافات (+)</option><option value="out" ${UI.mt === 'out' ? 'selected' : ''}>خصومات (−)</option></select></div>
    <div id="mvlog"></div></div>`;
}
function invTable() {
  const el = $('#itbl'); if (!el) return;
  const q = UI.iq.trim(), sm = seeCost();
  const l = (q ? searchProducts(q) : products()).sort((a, b) => a.qty - b.qty || byName(a, b));
  el.innerHTML = l.map(p => `<button class="lrow" onclick="productView('${p.id}')">${thumb(p)}<div><b>${esc(p.name)}</b><small>الحد الأدنى ${p.min}${sm ? ` · القيمة ${money(Math.max(0, p.qty) * p.cost)}` : ''}</small></div><div class="iq ${p.qty <= 0 ? 'bad' : p.qty <= p.min ? 'warn' : ''}"><b>${p.qty}</b><small>قطعة</small></div></button>`).join('') || empty('لا توجد منتجات');
}
function moveLog() {
  const el = $('#mvlog'); if (!el) return;
  if (!Q.moves) { el.innerHTML = loading(); return; }
  const l = Q.moves.filter(m => !UI.mt || (UI.mt === 'in' ? m.qty > 0 : m.qty < 0));
  el.innerHTML = (moveRows(l) || empty('لا توجد حركات بعد')) + (Q.movesFull ? `<button class="btn ghost block" onclick="UI.ml+=100;movesWatch();moveLog()">عرض المزيد</button>` : '');
}
function adjForm(pid, type = 'add') {
  if (!can('stock')) return toast('ليس لديك صلاحية تعديل المخزون', 'bad');
  if (!products().length) return toast('أضف منتجات أولاً', 'bad');
  openModal(`<h3>📦 تعديل المخزون</h3>
  <label class="fld"><span>المنتج</span><select id="aj_p" onchange="adjHint()">${products().sort(byName).map(p => `<option value="${p.id}" ${p.id === pid ? 'selected' : ''}>${esc(p.name)} (${p.qty})</option>`).join('')}</select></label>
  <label class="fld"><span>نوع الحركة</span><select id="aj_t" onchange="adjHint()">${Object.entries(ADJ).map(([k, l]) => `<option value="${k}" ${k === type ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
  ${fld('aj_q', 'الكمية', '', { num: true })}${fld('aj_n', 'السبب / ملاحظات', '')}
  <div id="aj_h" class="hint"></div>
  <div class="actions"><button class="btn" onclick="saveAdj()">💾 حفظ</button><button class="btn ghost" onclick="closeModal()">إلغاء</button></div>`, 'adj');
  adjHint();
}
function adjHint() {
  const p = P(val('aj_p')), t = val('aj_t');
  $('#aj_q').previousElementSibling.textContent = t === 'count' ? 'الكمية الفعلية الموجودة' : 'الكمية';
  $('#aj_h').textContent = p ? `الكمية الحالية بالنظام: ${p.qty}` : '';
}
async function saveAdj() {
  const pid = val('aj_p'), t = val('aj_t'), n = num(val('aj_q')), note = val('aj_n');
  if (!P(pid)) return toast('اختر المنتج', 'bad');
  if (!Number.isInteger(n) || n < 0 || (t !== 'count' && n < 1)) return toast('أدخل كمية صحيحة', 'bad');
  if (await act(() => txAdjust(pid, t, n, note), 'تم تحديث المخزون')) closeModal();
}

// ───────────── Purchases & suppliers ─────────────
const PB0 = () => ({ sid: '', newName: '', newPhone: '', date: today(), inv: '', items: [], paid: '', touched: false, notes: '' });
let PB = PB0();
function purWatch() { Q.pur = null; listen(PL, 'pur', FS.query(col('purchases'), FS.orderBy('at', 'desc'), FS.limit(100)), s => { Q.pur = docsOf(s); }); }
function pPur() {
  return `<div class="card"><div class="card-h"><b>🚚 تسجيل شراء بضاعة جديدة</b></div>
    <div class="form2">
      <label class="fld"><span>المورد</span><select id="pb_s" onchange="PB.sid=this.value;$('#pb_new').hidden=this.value!=='new'"><option value="">— بدون مورد —</option>${C.suppliers.filter(x => !x.deleted).sort(byName).map(x => `<option value="${x.id}" ${x.id === PB.sid ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}<option value="new" ${PB.sid === 'new' ? 'selected' : ''}>＋ مورد جديد…</option></select></label>
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
  <div class="card"><div class="card-h"><b>📜 سجل المشتريات</b></div><div id="purlist"></div></div>`;
}
function purList() {
  const el = $('#purlist'); if (!el) return;
  if (!Q.pur) { el.innerHTML = loading(); return; }
  el.innerHTML = Q.pur.map(x => `<div class="scard" onclick="purView('${x.id}')"><div class="sc-row"><b>🚚 ${x.no}</b>${x.total - x.paid > 0 ? `<span class="badge warn">غير مدفوع ${money(x.total - x.paid)}</span>` : '<span class="badge ok">مدفوع</span>'}</div><div class="sc-items">${esc(x.items.map(i => i.name + ' ×' + i.qty).join('، '))}</div><div class="sc-row"><span class="muted small">${fmtDate(x.date)}${x.supName ? ' · ' + esc(x.supName) : ''}${x.inv ? ' · فاتورة ' + esc(x.inv) : ''}</span><b>${money(x.total)}</b></div></div>`).join('') || empty('لا توجد مشتريات بعد');
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
  const el = $('#pb_items'); if (!el) return;
  el.innerHTML = PB.items.map((i, k) => `<div class="cline"><span class="cl-n"><b>${esc(P(i.pid)?.name)}</b><small>${i.qty} × ${money(i.cost)}</small></span><button class="x" onclick="PB.items.splice(${k},1);pbItems();pbSum()" aria-label="حذف">✕</button><b class="cl-t">${money(i.qty * i.cost)}</b></div>`).join('') || empty('أضف المنتجات المشتراة');
}
function pbSum() {
  const el = $('#pb_sum'); if (!el) return;
  const t = PB.items.reduce((a, i) => a + i.qty * i.cost, 0);
  if (!PB.touched) { PB.paid = t ? String(t) : ''; const f = $('#pb_paid'); if (f) f.value = PB.paid; }
  const paid = num(PB.paid);
  el.innerHTML = `<div><span>إجمالي الفاتورة</span><b>${money(t)}</b></div><div><span>المدفوع</span><b>${money(paid)}</b></div><div class="grand"><span>المتبقي للمورد</span><b class="${t - paid > 0 ? 'warn' : ''}">${money(t - paid)}</b></div>`;
}
async function savePurchase() {
  if (val('pb_p') && val('pb_q')) { pbAdd(); if (val('pb_p')) return; }
  if (!PB.items.length) return toast('أضف منتجاً واحداً على الأقل', 'bad');
  const total = PB.items.reduce((a, i) => a + i.qty * i.cost, 0), paid = num(PB.paid);
  if (!Number.isFinite(paid) || paid < 0 || paid > total) return toast('المبلغ المدفوع يجب أن يكون بين 0 وإجمالي الفاتورة', 'bad');
  if (PB.sid === 'new' && !PB.newName.trim()) return toast('أدخل اسم المورد الجديد', 'bad');
  const pb = { sid: PB.sid === 'new' ? '' : PB.sid, newSup: PB.sid === 'new' ? { name: PB.newName.trim(), phone: normPhone(PB.newPhone) } : null, date: PB.date || today(), inv: PB.inv.trim(), items: PB.items, paid: Math.round(paid), notes: PB.notes.trim() };
  const no = await act(() => txPurchase(pb), no => `تم حفظ ${no} وإضافة الكميات للمخزون`);
  if (no) { PB = PB0(); render(); }
}
function purView(id) {
  const x = Q.pur?.find(y => y.id === id) || purCache[id]; if (!x) return;
  openModal(`<h3>🚚 ${x.no}</h3><div class="kv-list"><div><span>التاريخ</span><b>${fmtDate(x.date)}</b></div><div><span>المورد</span><b>${esc(x.supName || '—')}</b></div>${x.inv ? `<div><span>رقم فاتورة المورد</span><b>${esc(x.inv)}</b></div>` : ''}<div><span>سجّلها</span><b>${esc(x.user)}</b></div></div>
  <div class="tbl"><table><tr><th>المنتج</th><th>الكمية</th><th>سعر الشراء</th><th>المجموع</th></tr>${x.items.map(i => `<tr><td>${esc(i.name)}</td><td>${i.qty}</td><td>${fmtN(i.cost)}</td><td>${fmtN(i.qty * i.cost)}</td></tr>`).join('')}</table></div>
  <div class="kv-list"><div class="grand"><span>الإجمالي</span><b>${money(x.total)}</b></div><div><span>المدفوع عند الشراء</span><b>${money(x.paid)}</b></div></div>${x.notes ? `<p class="small">📝 ${esc(x.notes)}</p>` : ''}
  <div class="actions">${can('del') ? `<button class="btn danger" onclick="delPurchase('${x.id}','${x.no}')">🗑️ حذف الشراء</button>` : ''}<button class="btn ghost" onclick="closeModal()">إغلاق</button></div>`, 'pur:' + id);
}
const purCache = {};
async function delPurchase(id, no) {
  if (!confirm(`حذف ${no}؟ سيتم خصم كمياته من المخزون.`)) return;
  if (await act(() => txDelPurchase(id), 'تم حذف الشراء')) closeModal();
}
function pSup() {
  const l = C.suppliers.filter(x => !x.deleted).sort(byName), due = l.reduce((a, x) => a + (x.total || 0) - (x.paid || 0), 0);
  return `<button class="btn block" onclick="supForm()">＋ إضافة مورد</button>
  ${l.length ? `<div class="sumbar"><span>${l.length} مورد</span><span>المتبقي للموردين: <b class="${due > 0 ? 'warn' : ''}">${money(due)}</b></span></div>` : ''}
  ${l.map(x => { const d = (x.total || 0) - (x.paid || 0); return `<div class="scard" onclick="supView('${x.id}')"><div class="sc-row"><b>🤝 ${esc(x.name)}</b>${d > 0 ? `<span class="badge warn">متبقي ${money(d)}</span>` : '<span class="badge ok">مسدد</span>'}</div>
    ${x.company ? `<div class="small muted">🏢 ${esc(x.company)}</div>` : ''}${x.phone ? `<div class="small"><a dir="ltr" href="tel:${esc(x.phone)}" onclick="event.stopPropagation()">📞 ${esc(x.phone)}</a></div>` : ''}
    <div class="small muted">📦 ${esc((x.prods || []).join('، ') || 'لا توجد مشتريات بعد')}</div>
    <div class="sc-row small"><span>المشتريات: <b>${money(x.total)}</b></span><span>المدفوع: <b>${money(x.paid)}</b></span></div>${x.notes ? `<div class="small muted">📝 ${esc(x.notes)}</div>` : ''}</div>`; }).join('') || empty('لا يوجد موردون بعد')}`;
}
function supForm(id) {
  const x = id ? C.suppliers.find(y => y.id === id) : {};
  openModal(`<h3>${id ? 'تعديل مورد' : 'مورد جديد'}</h3>${fld('sp_n', 'اسم المورد *', x.name)}${fld('sp_p', 'رقم الهاتف', x.phone, { attrs: 'inputmode="tel"' })}${fld('sp_c', 'الشركة', x.company)}${fld('sp_x', 'ملاحظات', x.notes)}
  <div class="actions"><button class="btn" onclick="saveSup('${id || ''}')">💾 حفظ</button><button class="btn ghost" onclick="closeModal()">إلغاء</button></div>`, 'supform');
}
async function saveSup(id) {
  const name = val('sp_n'); if (!name) return toast('أدخل اسم المورد', 'bad');
  const d = { name, phone: normPhone(val('sp_p')), company: val('sp_c'), notes: val('sp_x'), updatedAt: nowISO() };
  const ok = await act(() => id ? FS.updateDoc(dref('suppliers', id), d) : FS.setDoc(newRef('suppliers'), { ...d, total: 0, paid: 0, prods: [], createdAt: d.updatedAt, deleted: false }), 'تم الحفظ');
  if (ok) closeModal();
}
async function supView(id) {
  const x = C.suppliers.find(y => y.id === id); if (!x) return;
  const d = (x.total || 0) - (x.paid || 0);
  openModal(`<h3>🤝 ${esc(x.name)}</h3><div class="kv-list">${x.company ? `<div><span>الشركة</span><b>${esc(x.company)}</b></div>` : ''}${x.phone ? `<div><span>الهاتف</span><b><a dir="ltr" href="tel:${esc(x.phone)}">${esc(x.phone)}</a></b></div>` : ''}
    <div><span>المنتجات التي يوردها</span><b>${esc((x.prods || []).join('، ') || '—')}</b></div><div><span>إجمالي المشتريات</span><b>${money(x.total)}</b></div><div><span>المبالغ المدفوعة</span><b>${money(x.paid)}</b></div>
    <div class="grand"><span>المبالغ المتبقية</span><b class="${d > 0 ? 'warn' : 'ok'}">${money(d)}</b></div>${x.notes ? `<div><span>ملاحظات</span><b>${esc(x.notes)}</b></div>` : ''}</div>
  <div class="actions">${d > 0 ? `<button class="btn" onclick="supPay('${id}')">💵 تسجيل دفعة</button>` : ''}<button class="btn ghost" onclick="supForm('${id}')">✏️ تعديل</button>${can('del') ? `<button class="btn danger" onclick="delSup('${id}')">حذف</button>` : ''}</div>
  <div id="sv_hist">${loading()}</div>
  <button class="btn ghost block" onclick="closeModal()">إغلاق</button>`, 'sup:' + id);
  try {
    const [pu, pays] = await Promise.all([FS.getDocs(FS.query(col('purchases'), FS.where('supplierId', '==', id))), FS.getDocs(FS.query(col('supPays'), FS.where('supplierId', '==', id)))]);
    const el = $('#sv_hist'); if (!el || MODAL_KEY !== 'sup:' + id) return;
    const P1 = docsOf(pu).sort(byAtDesc), P2 = docsOf(pays).sort(byAtDesc);
    P1.forEach(p => purCache[p.id] = p);
    el.innerHTML = (P2.length ? `<div class="card-h"><b>الدفعات</b></div>${P2.map(p => `<div class="mrow"><span class="mq ok">💵</span><div><b>${money(p.amount)}</b><small>${fmtDate(p.date)}${p.notes ? ' · ' + esc(p.notes) : ''} · ${esc(p.user || '')}</small></div></div>`).join('')}` : '')
      + `<div class="card-h"><b>المشتريات</b></div>${P1.map(p => `<div class="mrow"><span class="mq">🚚</span><div><b>${p.no} · ${money(p.total)}</b><small>${fmtDate(p.date)} · ${esc(p.items.map(i => i.name + ' ×' + i.qty).join('، '))}</small></div></div>`).join('') || empty('لا توجد مشتريات')}`;
  } catch (e) { const el = $('#sv_hist'); if (el) el.innerHTML = ''; }
}
function supPay(id) {
  const x = C.suppliers.find(y => y.id === id), d = (x.total || 0) - (x.paid || 0);
  openModal(`<h3>💵 دفعة للمورد</h3><p class="muted">المتبقي: <b>${money(d)}</b></p>${fld('pp_a', 'المبلغ', d, { num: true })}${fld('pp_d', 'التاريخ', today(), { type: 'date' })}${fld('pp_n', 'ملاحظات', '')}
  <div class="actions"><button class="btn" onclick="savePay('${id}')">💾 حفظ</button><button class="btn ghost" onclick="supView('${id}')">رجوع</button></div>`, 'pay:' + id);
}
async function savePay(id) {
  const a = num(val('pp_a'));
  if (!Number.isFinite(a) || a <= 0) return toast('أدخل مبلغاً صحيحاً', 'bad');
  if (await act(() => txSupPay(id, Math.round(a), val('pp_d') || today(), val('pp_n')), 'تم تسجيل الدفعة')) closeModal();
}
async function delSup(id) {
  const x = C.suppliers.find(y => y.id === id);
  if (!confirm(`حذف المورد «${x.name}»؟`)) return;
  if (await act(() => (x.total || 0) > 0 ? FS.updateDoc(dref('suppliers', id), { deleted: true }) : FS.deleteDoc(dref('suppliers', id)), 'تم الحذف')) closeModal();
}

// ───────────── Customers ─────────────
function custWatch() { Q.custs = null; listen(PL, 'custs', FS.query(col('customers'), FS.orderBy('lastAt', 'desc'), FS.limit(500)), s => { Q.custs = docsOf(s).filter(c => !c.deleted); }); }
function pCust() {
  return `<div class="toolbar"><input placeholder="🔍 الاسم أو الهاتف أو العنوان" value="${esc(UI.cq)}" oninput="UI.cq=this.value;custList()"><button class="btn" onclick="custForm()">＋ إضافة عميل</button></div><div id="clist"></div>`;
}
function custList() {
  const el = $('#clist'); if (!el) return;
  if (!Q.custs) { el.innerHTML = loading(); return; }
  const q = digits(UI.cq).trim().toLowerCase();
  const l = Q.custs.filter(c => !q || [c.name, c.phone, c.address].join(' ').toLowerCase().includes(q));
  el.innerHTML = l.map(c => `<div class="scard" onclick="custView('${c.id}')"><div class="sc-row"><b>👤 ${esc(c.name)}</b><span class="badge blue">${c.orders || 0} طلب</span></div>
    ${c.phone ? `<div class="small"><a dir="ltr" href="tel:${esc(c.phone)}" onclick="event.stopPropagation()">📞 ${esc(c.phone)}</a> · <a href="https://wa.me/${waPhone(c.phone)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">WhatsApp</a></div>` : ''}
    ${c.address ? `<div class="small muted">📍 ${esc(c.address)}</div>` : ''}
    <div class="sc-row"><span class="muted small">آخر طلب: ${c.orders ? fmtDate(ymd(new Date(c.lastAt))) : '—'}</span><b>${money(c.total)}</b></div>${c.notes ? `<div class="small muted">📝 ${esc(c.notes)}</div>` : ''}</div>`).join('')
    || empty('لا يوجد عملاء بعد — يُضاف العملاء تلقائياً مع الطلبات الأونلاين');
}
function custForm(id) {
  const c = id ? (Q.custs || []).find(x => x.id === id) || C.custRecent.find(x => x.id === id) : {};
  openModal(`<h3>${id ? 'تعديل عميل' : 'عميل جديد'}</h3>${fld('c_n', 'الاسم *', c.name)}${id ? `<label class="fld"><span>الهاتف</span><input value="${esc(c.phone || '')}" disabled dir="ltr"></label>` : fld('c_p', 'الهاتف', '', { attrs: 'inputmode="tel"' })}${fld('c_a', 'العنوان', c.address)}${fld('c_x', 'ملاحظات', c.notes)}
  <div class="actions"><button class="btn" onclick="saveCust('${id || ''}')">💾 حفظ</button><button class="btn ghost" onclick="closeModal()">إلغاء</button></div>`, 'cform');
}
async function saveCust(id) {
  const name = val('c_n'); if (!name) return toast('أدخل اسم العميل', 'bad');
  const d = { name, address: val('c_a'), notes: val('c_x') };
  const ok = await act(async () => {
    if (id) return FS.updateDoc(dref('customers', id), d);
    const phone = normPhone(val('c_p')), ref = phone ? dref('customers', phone) : newRef('customers');
    if (phone) { const ex = await FS.getDoc(ref); if (ex.exists() && !ex.data().deleted) throw new UErr('رقم الهاتف مسجل لعميل آخر'); }
    const at = nowISO();
    return FS.setDoc(ref, { ...d, phone, orders: 0, total: 0, lastAt: at, createdAt: at, deleted: false });
  }, 'تم الحفظ');
  if (ok) closeModal();
}
async function custView(id) {
  const c = (Q.custs || []).find(x => x.id === id) || C.custRecent.find(x => x.id === id); if (!c) return;
  openModal(`<h3>👤 ${esc(c.name)}</h3><div class="kv-list">${c.phone ? `<div><span>الهاتف</span><b><a dir="ltr" href="tel:${esc(c.phone)}">${esc(c.phone)}</a></b></div>` : ''}${c.address ? `<div><span>العنوان</span><b>${esc(c.address)}</b></div>` : ''}
    <div><span>عدد الطلبات</span><b>${c.orders || 0}</b></div><div><span>إجمالي المشتريات</span><b>${money(c.total)}</b></div><div><span>آخر طلب</span><b>${c.orders ? fmtDT(c.lastAt) : '—'}</b></div>${c.notes ? `<div><span>ملاحظات</span><b>${esc(c.notes)}</b></div>` : ''}</div>
  <div class="actions"><button class="btn" onclick="newOrderFor('${c.id}')">🛒 طلب جديد</button><button class="btn ghost" onclick="custForm('${c.id}')">✏️ تعديل</button>${can('del') ? `<button class="btn danger" onclick="delCust('${c.id}')">حذف</button>` : ''}</div>
  <div class="card-h"><b>الطلبات</b></div><div id="cv_orders">${loading()}</div>
  <button class="btn ghost block" onclick="closeModal()">إغلاق</button>`, 'cust:' + id);
  try {
    const s = await FS.getDocs(FS.query(col('sales'), FS.where('custId', '==', id)));
    const l = docsOf(s).sort(byAtDesc); remember(l);
    const el = $('#cv_orders'); if (el && MODAL_KEY === 'cust:' + id) el.innerHTML = l.map(x => saleCard(x)).join('') || empty('لا توجد طلبات');
  } catch { }
}
function newOrderFor(id) {
  const c = (Q.custs || []).find(x => x.id === id) || C.custRecent.find(x => x.id === id);
  PF = { ...PF0(), type: 'online', name: c.name, phone: c.phone, address: c.address || '' };
  closeModal(); go('pos');
}
async function delCust(id) {
  const c = (Q.custs || []).find(x => x.id === id);
  if (!confirm(`حذف العميل «${c.name}»؟`)) return;
  if (await act(() => (c.orders || 0) > 0 || (c.total || 0) ? FS.updateDoc(dref('customers', id), { deleted: true }) : FS.deleteDoc(dref('customers', id)), 'تم الحذف')) closeModal();
}

// ───────────── Expenses ─────────────
const expMonths = () => { const d = new Date(), m = []; for (let i = 0; i < 24; i++) m.push(ymd(new Date(d.getFullYear(), d.getMonth() - i, 1)).slice(0, 7)); return m; };
function expWatch() { Q.exp = null; listen(PL, 'exp', FS.query(col('expenses'), FS.where('month', '==', UI.em || today().slice(0, 7))), s => { Q.exp = docsOf(s); }); }
function pExp() {
  const m = UI.em || today().slice(0, 7), l = (Q.exp || []).slice().sort((a, b) => b.date.localeCompare(a.date) || byAtDesc(a, b));
  const by = {}; for (const e of l) by[e.type] = (by[e.type] || 0) + e.amount;
  return `<div class="card"><div class="card-h"><b>＋ تسجيل مصروف</b></div><div class="form2"><label class="fld"><span>النوع</span><select id="e_t">${EXP_TYPES.map(t => `<option>${t}</option>`).join('')}</select></label>${fld('e_a', 'المبلغ', '', { num: true })}${fld('e_d', 'التاريخ', today(), { type: 'date' })}${fld('e_n', 'ملاحظات')}</div><button class="btn block" onclick="saveExp('')">💾 حفظ المصروف</button></div>
  <div class="card"><div class="card-h"><b>مصاريف الشهر</b><select class="auto" onchange="UI.em=this.value;expWatch();render()" aria-label="الشهر">${expMonths().map(x => `<option value="${x}" ${x === m ? 'selected' : ''}>${MONTHS[+x.slice(5) - 1]} ${x.slice(0, 4)}</option>`).join('')}</select></div>
    ${Q.exp ? `<div class="kv-list">${Object.entries(by).map(([t, a]) => `<div><span>${esc(t)}</span><b>${money(a)}</b></div>`).join('')}<div class="grand"><span>المجموع</span><b>${money(l.reduce((a, e) => a + e.amount, 0))}</b></div></div>` : loading()}</div>
  ${l.map(e => `<div class="scard" onclick="expForm('${e.id}')"><div class="sc-row"><b>💸 ${esc(e.type)}</b><b>${money(e.amount)}</b></div><div class="sc-row small muted"><span>${fmtDate(e.date)}${e.notes ? ' · ' + esc(e.notes) : ''}</span><span>${esc(e.user || '')}</span></div></div>`).join('') || (Q.exp ? empty('لا توجد مصاريف في هذا الشهر') : '')}`;
}
async function saveExp(id) {
  const pre = id ? 'x_' : 'e_', type = val(pre + 't'), amount = num(val(pre + 'a')), date = val(pre + 'd') || today(), notes = val(pre + 'n');
  if (!Number.isFinite(amount) || amount <= 0) return toast('أدخل مبلغاً صحيحاً', 'bad');
  const ok = await act(() => txExpense(id, { type, amount: Math.round(amount), date, notes }), 'تم حفظ المصروف');
  if (!ok) return;
  if (id) closeModal();
  if (date.slice(0, 7) !== (UI.em || today().slice(0, 7))) { UI.em = date.slice(0, 7); expWatch(); }
  render();
}
function expForm(id) {
  const e = (Q.exp || []).find(x => x.id === id); if (!e) return;
  openModal(`<h3>تعديل مصروف</h3><label class="fld"><span>النوع</span><select id="x_t">${EXP_TYPES.map(t => `<option ${t === e.type ? 'selected' : ''}>${t}</option>`).join('')}</select></label>${fld('x_a', 'المبلغ', e.amount, { num: true })}${fld('x_d', 'التاريخ', e.date, { type: 'date' })}${fld('x_n', 'ملاحظات', e.notes)}
  <div class="actions"><button class="btn" onclick="saveExp('${id}')">💾 حفظ</button>${can('del') ? `<button class="btn danger" onclick="delExp('${id}')">حذف</button>` : ''}<button class="btn ghost" onclick="closeModal()">إلغاء</button></div>`, 'exp:' + id);
}
async function delExp(id) {
  if (!confirm('حذف المصروف؟')) return;
  if (await act(() => txExpense(id, null), 'تم الحذف')) closeModal();
}

// ───────────── Returns ─────────────
const RB0 = () => ({ saleId: '', pid: '', qty: '1', refund: '', touched: false, restock: true, reason: RET_REASONS[0], note: '', q: '' });
let RB = RB0();
function retWatch() { Q.rets = null; listen(PL, 'rets', FS.query(col('returns'), FS.orderBy('at', 'desc'), FS.limit(100)), s => { Q.rets = docsOf(s); }); }
function pRet() {
  const sid = params.get('sale');
  if (sid) { RB = RB0(); RB.saleId = sid; }
  return `<div class="card"><div class="card-h"><b>↩️ تسجيل مرتجع</b></div>
    ${fld('r_q', 'ابحث برقم الفاتورة / الطلب (مثال: INV-00012)', RB.q, { attrs: 'dir="ltr" oninput="RB.q=this.value;retSearch()" autocomplete="off"' })}
    <label class="fld"><span>الفاتورة / الطلب</span><select id="r_s" onchange="RB=Object.assign(RB0(),{q:RB.q,saleId:this.value});retForm()"></select></label>
    <div id="r_form"></div></div>
  <div class="card"><div class="card-h"><b>📜 سجل المرتجعات</b></div>${Q.rets ? Q.rets.map(r => `<div class="mrow"><span class="mq ok" dir="ltr">+${r.qty}</span><div><b>${r.no} · ${esc(r.name)}</b><small>${r.saleNo} · ${esc(r.reason)}${r.restock ? '' : ' · لم يُرجع للمخزون'}</small><small>👤 ${esc(r.user)} · ${fmtDT(r.at)}</small></div><b class="bad">${money(r.refund)}</b></div>`).join('') || empty('لا توجد مرتجعات') : loading()}</div>`;
}
let retT = 0;
function retSearch() {
  retOpts();
  clearTimeout(retT);
  const m = digits(RB.q).trim().toUpperCase().match(/^(INV|ORD)[-\s]?(\d{1,6})$/);
  if (!m) return;
  const no = m[1] + '-' + pad(+m[2]);
  retT = setTimeout(async () => {
    try {
      const s = docsOf(await FS.getDocs(FS.query(col('sales'), FS.where('no', '==', no))));
      remember(s);
      const hit = s.find(live);
      if (hit && RB.saleId !== hit.id) { RB = Object.assign(RB0(), { q: RB.q, saleId: hit.id }); retOpts(); retForm(); }
    } catch { }
  }, 250);
}
function retOpts() {
  const el = $('#r_s'); if (!el) return;
  const q = digits(RB.q).trim().toLowerCase();
  const seen = new Map();
  for (const s of [...(RB.saleId && C.sales.get(RB.saleId) ? [C.sales.get(RB.saleId)] : []), ...C.recent, ...C.pending]) if (live(s) && !seen.has(s.id)) seen.set(s.id, s);
  const l = [...seen.values()].filter(s => s.id === RB.saleId || !q || [s.no, s.cust?.name, s.cust?.phone].join(' ').toLowerCase().includes(q));
  el.innerHTML = '<option value="">— اختر الفاتورة —</option>' + l.map(s => `<option value="${s.id}" ${s.id === RB.saleId ? 'selected' : ''}>${s.no} · ${fmtDate(s.date)} · ${money(calc(s).total)}${s.cust ? ' · ' + esc(s.cust.name) : ''}</option>`).join('');
}
async function retForm() {
  const el = $('#r_form'); if (!el) return;
  let s = RB.saleId && C.sales.get(RB.saleId);
  if (RB.saleId && !s) {
    el.innerHTML = loading();
    try { const d = await FS.getDoc(dref('sales', RB.saleId)); if (d.exists()) { s = { id: d.id, ...d.data() }; C.sales.set(s.id, s); retOpts(); } } catch { }
  }
  if (!s || !live(s)) { el.innerHTML = empty('اختر الفاتورة لعرض منتجاتها'); return; }
  const items = s.items.map(i => ({ ...i, left: i.qty - (s.returned?.[i.pid] || 0) })), avail = items.filter(i => i.left > 0);
  if (!avail.length) { el.innerHTML = empty('تم إرجاع كل منتجات هذه الفاتورة'); return; }
  if (!avail.some(i => i.pid === RB.pid)) { RB.pid = avail[0].pid; RB.touched = false; }
  const it = avail.find(i => i.pid === RB.pid), share = discShare(s);
  if (!RB.touched) RB.refund = String(Math.max(0, Math.round(Math.min(Math.round(num(RB.qty)) || 0, it.left) * it.price * share)));
  el.innerHTML = `<div class="lbl">المنتج</div>${items.map(i => `<label class="ritem ${i.left ? '' : 'off'}"><input type="radio" name="rp" ${i.pid === RB.pid ? 'checked' : ''} ${i.left ? '' : 'disabled'} onchange="RB.pid='${i.pid}';RB.touched=false;retForm()"><span><b>${esc(i.name)}</b><small>مُباع ${i.qty} · مُرجَع ${i.qty - i.left} · متاح للإرجاع ${i.left} · ${money(i.price)}</small></span></label>`).join('')}
    <div class="form2">${fld('r_qty', 'الكمية المرتجعة', RB.qty, { num: true, attrs: 'oninput="RB.qty=this.value;RB.touched=false;retRefund()"' })}${fld('r_ref', 'المبلغ المُعاد للعميل', RB.refund, { num: true, attrs: 'oninput="RB.refund=this.value;RB.touched=true"' })}</div>
    ${share < 1 ? '<div class="hint">تم توزيع خصم الفاتورة على المنتجات تلقائياً عند حساب المبلغ المُعاد.</div>' : ''}
    <label class="fld"><span>سبب الإرجاع</span><select onchange="RB.reason=this.value">${RET_REASONS.map(r => `<option ${r === RB.reason ? 'selected' : ''}>${r}</option>`).join('')}</select></label>
    ${fld('r_note', 'ملاحظات', RB.note, { attrs: 'oninput="RB.note=this.value"' })}
    <label class="chk"><input type="checkbox" ${RB.restock ? 'checked' : ''} onchange="RB.restock=this.checked"> إرجاع المنتج إلى المخزون (ألغِ التحديد إذا كان تالفاً)</label>
    <button class="btn block lg" onclick="saveReturn()">↩️ تسجيل المرتجع</button>`;
}
function retRefund() {
  const s = C.sales.get(RB.saleId), it = s?.items.find(i => i.pid === RB.pid); if (!it) return;
  RB.refund = String(Math.max(0, Math.round((Math.round(num(RB.qty)) || 0) * it.price * discShare(s))));
  $('#r_ref').value = RB.refund;
}
async function saveReturn() {
  const s = C.sales.get(RB.saleId); if (!s) return toast('اختر الفاتورة', 'bad');
  const q = num(RB.qty), refund = num(RB.refund);
  if (!Number.isInteger(q) || q < 1) return toast('أدخل كمية صحيحة', 'bad');
  if (!Number.isFinite(refund) || refund < 0) return toast('المبلغ المُعاد غير صحيح', 'bad');
  const reason = RB.reason + (RB.note.trim() ? ' — ' + RB.note.trim() : '');
  const r = await act(() => txReturn(s.id, RB.pid, q, Math.round(refund), RB.restock, reason), r => `تم تسجيل ${r.no} — المبلغ المُعاد ${money(r.refund)}`);
  if (r) { RB = RB0(); render(); }
}

// ───────────── Reports ─────────────
let REP = { key: '', days: null };
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
function loadRep(a, b, key) {
  FS.getDocs(FS.query(col('days'), FS.where('date', '>=', a), FS.where('date', '<=', b)))
    .then(s => { if (REP.key !== key) return; REP.days = Object.fromEntries(s.docs.map(d => [d.id, d.data()])); render(); })
    .catch(e => toast(errMsg(e), 'bad'));
}
function pRep() {
  const a = UI.ra || monthStart(), b = UI.rb || today(), key = a + '|' + b;
  if (REP.key !== key) { REP = { key, days: null }; loadRep(a, b, key); }
  const head = `<div class="card"><div class="range">
    <label class="fld"><span>من</span><input type="date" id="ra" value="${a}" onchange="setRange()"></label>
    <label class="fld"><span>إلى</span><input type="date" id="rb" value="${b}" onchange="setRange()"></label></div>
    <div class="chips">${[['today', 'اليوم'], ['yday', 'أمس'], ['7d', 'آخر 7 أيام'], ['month', 'هذا الشهر'], ['lmonth', 'الشهر الماضي'], ['year', 'هذه السنة']].map(([k, l]) => `<button class="chip" onclick="quickRange('${k}')">${l}</button>`).join('')}</div>
    <div class="muted small">الفترة: ${fmtDate(a)} — ${fmtDate(b)}</div></div>`;
  if (!REP.days) return head + loading();
  // recent days come from the live listener, so today's sales show up without reloading
  const src = { ...REP.days };
  for (const [dt, d] of Object.entries(C.days)) if (dt >= a && dt <= b && dt >= C.daysFrom) src[dt] = d;
  const o = statsOf(src, a, b, true), ps = products();
  const rows = Object.values(o.prod);
  for (const p of ps) if (!o.prod[p.id]) rows.push({ pid: p.id, name: p.name, qty: 0, rev: 0, profit: 0 });
  rows.sort((x, y) => y.qty - x.qty || y.rev - x.rev);
  const rank = l => l.map((x, k) => `<div class="rank"><span class="rk">${k + 1}</span><b>${esc(x.name)}</b><span>${x.qty} قطعة</span><small class="${x.profit < 0 ? 'bad' : 'ok'}">${money(x.profit)}</small></div>`).join('') || empty('لا توجد بيانات');
  const live_ = rows.filter(x => ps.some(p => p.id === x.pid));
  const low = ps.filter(p => p.qty > 0 && p.qty <= p.min), out = ps.filter(p => p.qty <= 0);
  return head + `
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
  <div class="card"><div class="card-h"><b>📊 المبيعات خلال الفترة</b></div>${barChart(buckets(a, b, '', src))}</div>
  <div class="card"><div class="card-h"><b>💼 الأرباح حسب نوع البيع</b></div><div class="tbl"><table>
    <tr><th>النوع</th><th>العمليات</th><th>المبيعات</th><th>الربح</th><th>الهامش</th></tr>
    <tr><td>🏪 المحل</td><td>${o.nStore}</td><td>${fmtN(o.store)}</td><td>${fmtN(o.pStore)}</td><td>${pct(o.pStore, o.store)}</td></tr>
    <tr><td>🌐 الأونلاين</td><td>${o.nOnline}</td><td>${fmtN(o.online)}</td><td>${fmtN(o.pOnline)}</td><td>${pct(o.pOnline, o.online)}</td></tr>
    <tr class="tot"><td>المجموع</td><td>${o.n}</td><td>${fmtN(o.sales)}</td><td>${fmtN(o.profit)}</td><td>${pct(o.profit, o.sales)}</td></tr></table></div></div>
  <div class="card"><div class="card-h"><b>🏆 الأكثر مبيعاً</b></div>${rank(rows.filter(x => x.qty > 0).slice(0, 5))}</div>
  <div class="card"><div class="card-h"><b>🐢 الأقل مبيعاً</b></div>${rank(live_.slice(-5).reverse())}</div>
  <div class="card"><div class="card-h"><b>💰 الأرباح حسب المنتج</b></div><div class="tbl"><table><tr><th>المنتج</th><th>الكمية</th><th>المبيعات</th><th>الربح</th></tr>${rows.filter(x => x.qty || x.rev).map(x => `<tr><td>${esc(x.name)}</td><td>${x.qty}</td><td>${fmtN(x.rev)}</td><td class="${x.profit < 0 ? 'bad' : ''}">${fmtN(x.profit)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">لا توجد مبيعات في هذه الفترة</td></tr>'}</table></div></div>
  <div class="card"><div class="card-h"><b>🏬 المخزون الآن</b></div><div class="kv-list">
    <div><span>قيمة المخزون بسعر الشراء</span><b>${money(ps.reduce((x, p) => x + Math.max(0, p.qty) * p.cost, 0))}</b></div>
    <div><span>قيمة المخزون بسعر البيع</span><b>${money(ps.reduce((x, p) => x + Math.max(0, p.qty) * p.price, 0))}</b></div>
    <div><span>قريبة من النفاد (${low.length})</span><b>${esc(low.map(p => `${p.name} (${p.qty})`).join('، ') || '—')}</b></div>
    <div><span>نافدة (${out.length})</span><b>${esc(out.map(p => p.name).join('، ') || '—')}</b></div></div></div>
  <div class="actions"><button class="btn ghost" onclick="csvSales()">⬇️ تصدير المبيعات (Excel)</button><button class="btn ghost" onclick="csvStock()">⬇️ تصدير المخزون (Excel)</button></div>`;
}
async function csvSales() {
  const a = UI.ra || monthStart(), b = UI.rb || today();
  try {
    const l = docsOf(await FS.getDocs(FS.query(col('sales'), FS.where('date', '>=', a), FS.where('date', '<=', b), FS.orderBy('date')))).sort((x, y) => (x.at || '').localeCompare(y.at || ''));
    const rows = [['الرقم', 'التاريخ', 'الوقت', 'النوع', 'الحالة', 'العميل', 'الهاتف', 'المنتجات', 'المجموع', 'الخصم', 'رسوم التوصيل', 'الإجمالي', 'تكلفة البضاعة', 'تكلفة التوصيل', 'الربح', 'المرتجعات', 'طريقة الدفع', 'البائع', 'ملاحظات']];
    for (const s of l) { const c = calc(s); rows.push([s.no, s.date, fmtTime(s.at), s.type === 'store' ? 'محل' : 'أونلاين', s.status, s.cust?.name, s.cust?.phone, s.items.map(i => `${i.name} x${i.qty}`).join(' | '), c.sub, s.discount, s.fee, c.total, c.cogs, s.dcost, c.profit, s.refunds || 0, s.pay, s.user, s.notes]); }
    csvDownload(`TNT-sales-${a}_${b}.csv`, rows);
  } catch (e) { toast(errMsg(e), 'bad'); }
}
function csvStock() {
  const rows = [['المنتج', 'البراند', 'التصنيف', 'الحجم', 'النكهة', 'الباركود', 'سعر الشراء', 'سعر البيع', 'الكمية', 'الحد الأدنى', 'القيمة بسعر الشراء', 'القيمة بسعر البيع', 'الحالة', 'انتهاء الصلاحية']];
  for (const p of products().sort(byName)) rows.push([p.name, p.brand, p.cat, p.size, p.flavor, p.barcode, p.cost, p.price, p.qty, p.min, Math.max(0, p.qty) * p.cost, Math.max(0, p.qty) * p.price, p.qty <= 0 ? 'نافد' : p.qty <= p.min ? 'قريب من النفاد' : 'جيد', p.exp]);
  csvDownload(`TNT-stock-${today()}.csv`, rows);
}

// ───────────── Users ─────────────
function pUsers() {
  return `<button class="btn block" onclick="userForm()">＋ إضافة مستخدم</button>
  <div class="card">${C.users.slice().sort((a, b) => (a.role !== 'admin') - (b.role !== 'admin') || byName(a, b)).map(u => `<button class="lrow" onclick="userForm('${u.id}')"><span class="av">${u.role === 'admin' ? '👑' : '👤'}</span><div><b>${esc(u.name)}${u.id === ME.id ? ' (أنت)' : ''}</b><small dir="ltr">${esc(userLabel(u))}</small><small>${u.role === 'admin' ? 'مدير — كل الصلاحيات' : 'موظف — البيع والطلبات' + (Object.keys(PERMS).filter(k => u.perms?.[k]).map(k => ' + ' + PERMS[k]).join('') || '')}</small></div>${u.active ? '<span class="badge ok">فعّال</span>' : '<span class="badge bad">موقوف</span>'}</button>`).join('')}</div>
  <div class="card soft small">🔐 الموظف يستطيع دائماً: تسجيل المبيعات، إدارة الطلبات الأونلاين وحالاتها، إضافة العملاء وعرض المنتجات والمخزون (بدون أسعار الشراء). أي صلاحية إضافية يحددها المدير.<br>🔑 كل مستخدم يغيّر اسمه وكلمة مروره من «حسابي» (اضغط على اسمك في الأعلى). إذا نسي موظف كلمة المرور: أوقف حسابه وأنشئ له حساباً جديداً.</div>`;
}
function userForm(id) {
  const u = id ? C.users.find(x => x.id === id) : { role: 'employee', perms: { returns: true }, active: true };
  openModal(`<h3>${id ? 'تعديل مستخدم' : 'مستخدم جديد'}</h3>
  ${fld('u_name', 'الاسم', u.name)}
  ${id ? `<label class="fld"><span>اسم الدخول</span><input value="${esc(userLabel(u))}" disabled dir="ltr"></label>`
    : fld('u_login', 'اسم الدخول (أحرف إنجليزية وأرقام)', '', { attrs: 'dir="ltr" autocapitalize="none" spellcheck="false" autocomplete="off" placeholder="sara"' })
      + fld('u_pw', 'كلمة المرور (6 أحرف على الأقل)', '', { type: 'password', attrs: 'autocomplete="new-password"' })}
  <label class="fld"><span>الدور</span><select id="u_role" onchange="$('#u_perms').hidden=this.value==='admin'"><option value="employee" ${u.role !== 'admin' ? 'selected' : ''}>موظف (Employee)</option><option value="admin" ${u.role === 'admin' ? 'selected' : ''}>مدير (Admin)</option></select></label>
  <div id="u_perms" ${u.role === 'admin' ? 'hidden' : ''}><div class="lbl">صلاحيات إضافية للموظف</div>${Object.entries(PERMS).map(([k, l]) => `<label class="chk"><input type="checkbox" id="u_p_${k}" ${u.perms?.[k] ? 'checked' : ''}> ${l}</label>`).join('')}</div>
  <label class="chk"><input type="checkbox" id="u_act" ${u.active ? 'checked' : ''}> الحساب فعّال</label>
  <div class="actions"><button class="btn" onclick="saveUser('${id || ''}')">💾 حفظ</button><button class="btn ghost" onclick="closeModal()">إلغاء</button></div>`, 'uform');
}
// Creating an account signs that account in, so it is done on a throwaway Firebase app instance.
async function createAccount(email, pw) {
  const app2 = A.initializeApp(initFirebase.cfg, 'creator-' + Date.now());
  const a2 = AU.initializeAuth(app2, { persistence: AU.inMemoryPersistence });
  if (EMU) AU.connectAuthEmulator(a2, 'http://localhost:9099', { disableWarnings: true });
  try { return (await AU.createUserWithEmailAndPassword(a2, email, pw)).user.uid; }
  finally { await AU.signOut(a2).catch(() => { }); await A.deleteApp(app2).catch(() => { }); }
}
async function saveUser(id) {
  const name = val('u_name'), role = val('u_role'), active = $('#u_act').checked;
  if (!name) return toast('أدخل الاسم', 'bad');
  if (id === ME.id && !active) return toast('لا يمكنك إيقاف حسابك الحالي', 'bad');
  if (!(role === 'admin' && active) && !C.users.some(x => x.role === 'admin' && x.active && x.id !== id)) return toast('يجب أن يبقى مدير واحد فعّال على الأقل', 'bad');
  const perms = {}; for (const k in PERMS) perms[k] = $('#u_p_' + k).checked;
  let login = '', pw = '';
  if (!id) {
    login = digits(val('u_login')).toLowerCase(); pw = $('#u_pw').value;
    if (!/^[a-z0-9._-]{3,30}$/.test(login) && !/^\S+@\S+\.\S+$/.test(login)) return toast('اسم الدخول: 3 أحرف إنجليزية أو أرقام على الأقل، بدون مسافات', 'bad');
    if (pw.length < 6) return toast('كلمة المرور 6 أحرف على الأقل', 'bad');
  }
  const ok = await act(async () => {
    if (id) return FS.updateDoc(dref('users', id), { name, role, perms, active });
    const email = toEmail(login), uid = await createAccount(email, pw);
    return FS.setDoc(dref('users', uid), { name, email, role, perms, active, createdAt: nowISO() });
  }, id ? 'تم الحفظ' : `تم إنشاء الحساب — اسم الدخول: ${login}`);
  if (ok) closeModal();
}

// ───────────── Settings, backup, theme ─────────────
const getTheme = () => { try { return localStorage.getItem('tnt-theme') || 'auto'; } catch { return 'auto'; } };
function applyTheme() { const t = getTheme(); if (t === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.dataset.theme = t; }
function setTheme(t) { try { localStorage.setItem('tnt-theme', t); } catch { } applyTheme(); render(); }
function pSet() {
  const sh = C.shop, th = getTheme(), emptyDb = !C.products.length && !C.recent.length;
  return `<div class="card"><div class="card-h"><b>🏪 بيانات المحل والفاتورة</b></div>
    <div class="imgpick">${logoHtml(64)}<span class="row"><label class="btn ghost sm">🖼️ رفع شعار<input type="file" accept="image/*" hidden onchange="pickLogo(this)"></label>${sh.logo ? `<button class="btn ghost sm" onclick="act(()=>FS.setDoc(dref('settings','shop'),{logo:''},{merge:true}),'تمت إزالة الشعار')">إزالة الشعار</button>` : ''}</span></div>
    <div class="form2">${fld('s_name', 'اسم المحل', sh.name)}${fld('s_phone', 'هاتف المحل', sh.phone, { attrs: 'inputmode="tel"' })}${fld('s_addr', 'العنوان', sh.address, { full: true })}${fld('s_foot', 'ملاحظة أسفل الفاتورة', sh.footer, { full: true })}${fld('s_min', 'الحد الأدنى الافتراضي للمخزون', sh.defMin, { num: true })}</div>
    <button class="btn block" onclick="saveShop()">💾 حفظ</button></div>
  <div class="card"><div class="card-h"><b>☁️ قاعدة البيانات</b></div>
    <p class="small">كل البيانات محفوظة على السحابة (Firebase) ومشتركة بين كل الأجهزة. أي عملية بيع من أي جهاز تظهر فوراً على الأجهزة الأخرى.</p>
    <div class="actions"><button class="btn ghost" onclick="exportBackup()">⬇️ تنزيل نسخة احتياطية (اختياري)</button></div>
    ${emptyDb ? `<div class="card soft small">📥 <b>نقل البيانات من النسخة القديمة:</b> إذا كان لديك ملف نسخة احتياطية (TNT-backup-….json) من النسخة السابقة التي كانت تحفظ على الهاتف، ارفعه هنا وسيتم نقل كل المنتجات والمبيعات والعملاء إلى قاعدة البيانات.<div class="actions"><label class="btn">⬆️ رفع ملف النسخة<input type="file" accept=".json,application/json" hidden onchange="importBackup(this)"></label></div></div>` : ''}</div>
  <div class="card"><div class="card-h"><b>🎨 المظهر</b></div><div class="seg">${[['auto', 'تلقائي'], ['light', 'فاتح'], ['dark', 'داكن']].map(([k, l]) => `<button class="${th === k ? 'on' : ''}" onclick="setTheme('${k}')">${l}</button>`).join('')}</div></div>
  ${products().length ? '' : `<div class="card"><div class="card-h"><b>🧪 تجربة</b></div><button class="btn ghost block" onclick="loadDemo()">تحميل منتجات تجريبية</button></div>`}
  <p class="small muted center">الإصدار ${VERSION}</p>`;
}
async function saveShop() {
  const name = val('s_name'), min = num(val('s_min'));
  if (!name) return toast('أدخل اسم المحل', 'bad');
  if (!Number.isInteger(min) || min < 0) return toast('الحد الأدنى يجب أن يكون رقماً صحيحاً', 'bad');
  await act(() => FS.setDoc(dref('settings', 'shop'), { name, phone: val('s_phone'), address: val('s_addr'), footer: val('s_foot'), defMin: min }, { merge: true }), 'تم الحفظ');
}
async function pickLogo(inp) {
  const f = inp.files[0]; if (!f) return;
  try { const logo = await readImage(f, 256, 'image/png'); await act(() => FS.setDoc(dref('settings', 'shop'), { logo }, { merge: true }), 'تم رفع الشعار'); } catch (e) { toast(e.message, 'bad'); }
}
const BACKUP_COLS = ['settings', 'counters', 'products', 'customers', 'suppliers', 'sales', 'returns', 'purchases', 'supPays', 'expenses', 'moves', 'days'];
async function exportBackup() {
  toast('جاري تجهيز النسخة…');
  try {
    const data = {};
    for (const c of BACKUP_COLS) data[c] = docsOf(await FS.getDocs(col(c)));
    download(new Blob([JSON.stringify({ v: 3, exportedAt: nowISO(), data })], { type: 'application/json' }), `TNT-cloud-backup-${today()}.json`);
    toast('تم تنزيل النسخة الاحتياطية', 'ok');
  } catch (e) { toast(errMsg(e), 'bad'); }
}
// Turns a backup from the old on-phone version (v2) into documents for the cloud database.
function fromLegacy(d) {
  const PID = id => 'p' + id, SID = id => 'x' + id, SUP = id => 's' + id;
  const custKey = c => (c.phone && normPhone(c.phone)) || 'c' + c.id;
  const custById = new Map((d.customers || []).map(c => [c.id, c]));
  const retsBy = {}; for (const r of d.returns || []) (retsBy[r.saleId] ||= []).push(r);
  const out = { settings: [{ id: 'shop', ...SHOP0, ...(d.shop || {}) }], products: [], customers: [], suppliers: [], sales: [], returns: [], purchases: [], supPays: [], expenses: [], moves: [], days: [], counters: [] };
  const sold = {}, used = new Set(), cstat = {}, days = {};
  for (const s of d.sales || []) {
    const rets = retsBy[s.id] || [], returned = {};
    for (const r of rets) returned[PID(r.pid)] = (returned[PID(r.pid)] || 0) + r.qty;
    const cust = s.custId != null ? custById.get(s.custId) : null;
    const ns = {
      id: SID(s.id), no: s.no, type: s.type, date: s.date, at: s.at, items: s.items.map(i => ({ pid: PID(i.pid), name: i.name, qty: i.qty, price: i.price, cost: i.cost })),
      discount: s.discount || 0, fee: s.fee || 0, dcost: s.dcost || 0, pay: s.pay, notes: s.notes || '', status: s.status, custId: cust ? custKey(cust) : null, cust: s.cust || null,
      user: s.user || '', uid: null, log: s.log || [], returned, refunds: rets.reduce((a, r) => a + r.refund, 0),
      rets: rets.map(r => ({ no: r.no, date: r.date, pid: PID(r.pid), name: r.name, qty: r.qty, refund: r.refund, cost: r.cost, restock: r.restock !== false })),
    };
    out.sales.push(ns);
    for (const i of ns.items) used.add(i.pid);
    if (!live(ns)) continue;
    addInto(days[ns.date] ||= {}, saleContrib(ns, 1));
    for (const r of ns.rets) addInto(days[r.date] ||= {}, retContrib(r, ns.type, 1));
    for (const i of ns.items) sold[i.pid] = (sold[i.pid] || 0) + i.qty - (returned[i.pid] || 0);
    if (ns.custId) { const x = cstat[ns.custId] ||= { orders: 0, total: 0, lastAt: '' }; x.orders++; x.total += calc(ns).total - ns.refunds; if (ns.at > x.lastAt) x.lastAt = ns.at; }
  }
  for (const r of d.returns || []) out.returns.push({ id: 'r' + r.id, no: r.no, saleId: SID(r.saleId), saleNo: r.saleNo, type: r.type, pid: PID(r.pid), name: r.name, qty: r.qty, price: r.price, cost: r.cost, refund: r.refund, restock: r.restock !== false, reason: r.reason || '', date: r.date, at: r.at, user: r.user || '' });
  const supTot = {};
  for (const x of d.purchases || []) {
    for (const i of x.items) used.add(PID(i.pid));
    if (x.supplierId != null) { const t = supTot[x.supplierId] ||= { total: 0, paid: 0, prods: new Set() }; t.total += x.total; t.paid += x.paid; x.items.forEach(i => t.prods.add(i.name)); }
    out.purchases.push({ id: 'u' + x.id, no: x.no, supplierId: x.supplierId != null ? SUP(x.supplierId) : null, supName: (d.suppliers || []).find(s => s.id === x.supplierId)?.name || '', date: x.date, inv: x.inv || '', items: x.items.map(i => ({ pid: PID(i.pid), name: i.name, qty: i.qty, cost: i.cost })), total: x.total, paid: x.paid, notes: x.notes || '', at: x.at, user: x.user || '' });
  }
  for (const y of d.supPays || []) { (supTot[y.supplierId] ||= { total: 0, paid: 0, prods: new Set() }).paid += y.amount; out.supPays.push({ id: 'y' + y.id, supplierId: SUP(y.supplierId), amount: y.amount, date: y.date, notes: y.notes || '', at: y.at, user: y.user || '' }); }
  for (const s of d.suppliers || []) { const t = supTot[s.id] || { total: 0, paid: 0, prods: new Set() }; out.suppliers.push({ id: SUP(s.id), name: s.name, phone: s.phone || '', company: s.company || '', notes: s.notes || '', total: t.total, paid: t.paid, prods: [...t.prods], deleted: !!s.deleted, createdAt: s.createdAt || nowISO() }); }
  for (const p of d.products || []) out.products.push({ id: PID(p.id), name: p.name, brand: p.brand || '', cat: p.cat || '', size: p.size || '', flavor: p.flavor || '', barcode: p.barcode || '', cost: p.cost || 0, price: p.price || 0, qty: Math.max(0, p.qty || 0), min: p.min ?? 5, exp: p.exp || '', notes: p.notes || '', img: p.img || '', sold: Math.max(0, sold[PID(p.id)] || 0), used: used.has(PID(p.id)), deleted: !!p.deleted, createdAt: p.createdAt || nowISO(), updatedAt: nowISO() });
  for (const c of d.customers || []) { const x = cstat[custKey(c)] || { orders: 0, total: 0, lastAt: '' }; out.customers.push({ id: custKey(c), name: c.name, phone: normPhone(c.phone || ''), address: c.address || '', notes: c.notes || '', orders: x.orders, total: x.total, lastAt: x.lastAt || c.createdAt || nowISO(), createdAt: c.createdAt || nowISO(), deleted: !!c.deleted }); }
  for (const e of d.expenses || []) { out.expenses.push({ id: 'e' + e.id, type: e.type, amount: e.amount, date: e.date, month: e.date.slice(0, 7), notes: e.notes || '', at: e.at || nowISO(), user: e.user || '' }); addInto(days[e.date] ||= {}, { exp: e.amount }); }
  for (const m of d.moves || []) out.moves.push({ id: 'm' + m.id, at: m.at, date: m.date, pid: PID(m.pid), name: m.name, qty: m.qty, after: m.after, reason: m.reason, ref: m.ref || '', user: m.user || '' });
  for (const [date, x] of Object.entries(days)) out.days.push({ id: date, date, ...x });
  const seq = d.seq || {};
  out.counters.push({ id: 'main', sale: (seq.sale || 1) - 1, order: (seq.order || 1) - 1, pur: (seq.pur || 1) - 1, ret: (seq.ret || 1) - 1 });
  return out;
}
async function writeAll(data) {
  const all = [];
  for (const [c, docs] of Object.entries(data)) if (BACKUP_COLS.includes(c)) for (const { id, ...rest } of docs) all.push([c, id, rest]);
  for (let i = 0; i < all.length; i += 400) {
    const b = FS.writeBatch(db);
    for (const [c, id, rest] of all.slice(i, i + 400)) b.set(dref(c, id), rest);
    await b.commit();
    toast(`جاري النقل… ${Math.min(i + 400, all.length)} / ${all.length}`);
  }
  return all.length;
}
async function importData(d) {
  let data;
  if (d?.v === 2 && Array.isArray(d.products) && Array.isArray(d.sales)) data = fromLegacy(d);
  else if (d?.v === 3 && d.data) data = d.data;
  else return toast('هذا ليس ملف نسخة احتياطية من نظام TNT', 'bad');
  if (C.products.length || C.recent.length) return toast('قاعدة البيانات تحتوي على بيانات بالفعل — النقل متاح فقط لقاعدة فارغة', 'bad');
  if (!confirm(`نقل ${data.products?.length || 0} منتج و ${data.sales?.length || 0} عملية بيع إلى قاعدة البيانات؟`)) return;
  const n = await act(() => writeAll(data));
  if (n) { LEGACY = null; toast(`تم نقل البيانات بنجاح ✅ (${n} سجل)`, 'ok'); }
}
function importBackup(inp) {
  const f = inp.files[0]; if (!f) return;
  const fr = new FileReader();
  fr.onload = () => { let d; try { d = JSON.parse(fr.result); } catch { return toast('الملف غير صالح', 'bad'); } importData(d); };
  fr.readAsText(f); inp.value = '';
}
// Data left on this phone by the old version (it kept everything in this browser).
let LEGACY = null;
async function findLegacyLocal() {
  try {
    const db0 = await new Promise((res, rej) => {
      const r = indexedDB.open('tnt-store');
      r.onupgradeneeded = () => r.transaction.abort(); // no old database here — don't create one
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    if (!db0.objectStoreNames.contains('kv')) { db0.close(); return; }
    const d = await new Promise((res, rej) => { const q = db0.transaction('kv').objectStore('kv').get('state'); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
    db0.close();
    if (d?.v === 2 && (d.products?.length || d.sales?.length)) { LEGACY = d; changed(); }
  } catch { }
}
const legacyCard = () => LEGACY && isAdmin() && !C.products.length && !C.recent.length ? `<div class="card banner"><span>📲 وجدنا بيانات من النسخة السابقة محفوظة على هذا الجهاز (${LEGACY.products.length} منتج، ${LEGACY.sales.length} عملية بيع). انقلها إلى قاعدة البيانات لتظهر على كل الأجهزة.</span><button class="btn sm" onclick="importData(LEGACY)">نقل البيانات الآن</button></div>` : '';
async function loadDemo() {
  if (products().length) return toast('المنتجات التجريبية تُحمّل فقط عندما لا توجد منتجات', 'bad');
  const at = nowISO(), b = FS.writeBatch(db);
  b.set(newRef('suppliers'), { name: 'شركة الأبطال للمكملات', phone: '07701234567', company: 'الأبطال', notes: 'مورد تجريبي', total: 0, paid: 0, prods: [], deleted: false, createdAt: at });
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
    const ref = newRef('products');
    b.set(ref, { name, brand, cat, size, flavor, barcode, cost, price, qty, min, exp: addDays(today(), days), notes: '', img: '', sold: 0, used: false, deleted: false, createdAt: at, updatedAt: at });
    if (qty) b.set(newRef('moves'), { at, date: today(), pid: ref.id, name, qty, after: qty, reason: 'رصيد افتتاحي', ref: '', user: ME.name, uid: ME.id });
  });
  if (await act(() => b.commit(), 'تم تحميل منتجات تجريبية')) go('prod');
}
function pMore() {
  return `<div class="mgrid">${Object.keys(ROUTES).filter(r => !BNAV.includes(r) && allowed(r)).map(r => `<a class="mtile" href="#/${r}"><span class="ic">${ROUTES[r].i}</span><b>${ROUTES[r].t}</b></a>`).join('')}
  <button class="mtile" onclick="accountForm()"><span class="ic">👤</span><b>حسابي — الاسم وكلمة المرور</b></button>
  <button class="mtile" onclick="logout()"><span class="ic">🔒</span><b>تسجيل الخروج / تبديل المستخدم</b></button></div>`;
}

// ───────────── Boot ─────────────
async function boot() {
  applyTheme();
  $('#modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && modalOpen()) closeModal(); });
  window.addEventListener('hashchange', () => { if (!ME || !booted) return; if (modalOpen()) closeModal(); render(); });
  try { await initFirebase(); }
  catch (e) {
    console.error(e);
    $('#boot').innerHTML = '<div style="text-align:center;font-size:17px;letter-spacing:0;line-height:1.8;padding:20px">تعذر الاتصال بالخادم 📡<br><small>تأكد من الاتصال بالإنترنت ثم</small><br><button class="btn" onclick="location.reload()">إعادة المحاولة</button></div>';
    return;
  }
  $('#boot').remove();
  AU.onAuthStateChanged(auth, onAuth);
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => { });
}
boot();
