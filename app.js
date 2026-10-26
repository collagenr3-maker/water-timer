'use strict';
(() => {
  const K_ROUTES = 'waterTimer.routes.v1', K_TIMER = 'waterTimer.timer.v1', K_INPUT = 'waterTimer.input.v1';
  const DEFAULT_ROUTES = [
    { id: 'a', name: '経路A', flow: 25 },
    { id: 'b', name: '経路B', flow: 40 },
    { id: 'c', name: '経路C', flow: 15 }
  ];
  const MAX_FLOW = 100000, MAX_LITERS = 1000000, MAX_SEC = 86400, MAX_ROUTES = 20, MAX_NAME = 20;
  const $ = (id) => document.getElementById(id);

  // ---------- 保存/読込（壊れたデータにも耐える） ----------
  const load = (k, fb) => { try { const v = localStorage.getItem(k); return v === null ? fb : JSON.parse(v); } catch { return fb; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 容量不足・プライベートモード等は無視 */ } };
  const validFlow = (n) => Number.isFinite(n) && n > 0 && n <= MAX_FLOW;
  const uid = () => 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const num = (s) => {
    const t = String(s).normalize('NFKC').replace(/,/g, '').trim();
    return /^\d+(\.\d+)?$/.test(t) ? parseFloat(t) : NaN;
  };

  function sanitizeRoutes(arr) {
    if (!Array.isArray(arr)) return DEFAULT_ROUTES.map((r) => ({ ...r }));
    const out = [], seen = new Set();
    for (const r of arr) {
      if (!r || typeof r.name !== 'string' || !validFlow(Number(r.flow))) continue;
      let id = typeof r.id === 'string' && r.id ? r.id : uid();
      if (seen.has(id)) id = uid();
      seen.add(id);
      out.push({ id, name: r.name.trim().slice(0, MAX_NAME) || '経路', flow: Number(r.flow) });
      if (out.length >= MAX_ROUTES) break;
    }
    return out.length ? out : DEFAULT_ROUTES.map((r) => ({ ...r }));
  }

  let routes = sanitizeRoutes(load(K_ROUTES, null));
  const inp = load(K_INPUT, {});
  let input = { routeId: String(inp.routeId || ''), liters: String(inp.liters || '') };
  // timer: {status:'idle'|'running'|'paused'|'done', routeId, liters, flow, totalSec, endAt, remainingMs, acked}
  let timer = restoreTimer(load(K_TIMER, null));
  let ticker = null, wakeLock = null;

  function restoreTimer(t) {
    const idle = { status: 'idle' };
    if (!t || !['running', 'paused', 'done'].includes(t.status)) return idle;
    const ok = validFlow(Number(t.flow)) && Number.isFinite(t.totalSec) && t.totalSec > 0 && t.totalSec <= MAX_SEC;
    if (!ok) return idle;
    if (t.status === 'running' && !(Number.isFinite(t.endAt))) return idle;
    if (t.status === 'paused' && !(Number.isFinite(t.remainingMs) && t.remainingMs > 0)) return idle;
    return t;
  }
  const saveTimer = () => save(K_TIMER, timer);
  const saveInput = () => save(K_INPUT, input);

  // ---------- 計算 ----------
  function fmtDuration(sec) { return `${Math.floor(sec / 60)}分${String(sec % 60).padStart(2, '0')}秒`; }
  function fmtClock(sec) { return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`; }
  function fmtTime(ms) { return new Date(ms).toLocaleTimeString('ja-JP', { hour12: false }); }
  function currentRoute() { return routes.find((r) => r.id === input.routeId) || routes[0]; }

  function calc() {
    const r = currentRoute();
    if (!r || !validFlow(r.flow)) return { ok: false, msg: '流量が不正です。設定を確認してください。' };
    if (input.liters.trim() === '') return { ok: false, msg: '' };
    const l = num(input.liters);
    if (!Number.isFinite(l) || l <= 0) return { ok: false, msg: '貯水量は0より大きい数値で入力してください。' };
    if (l > MAX_LITERS) return { ok: false, msg: `貯水量は${MAX_LITERS}L以下にしてください。` };
    const sec = Math.ceil((l / r.flow) * 60);
    if (!Number.isFinite(sec) || sec < 1) return { ok: false, msg: '所要時間を計算できません。' };
    if (sec > MAX_SEC) return { ok: false, msg: '所要時間が24時間を超えます。貯水量を減らしてください。' };
    return { ok: true, sec, liters: l, route: r };
  }

  // ---------- 音（Web Audio API） ----------
  let ctx = null, alarmTimer = null;
  function initAudio() { // スタートボタン操作内で呼ぶ
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!ctx) ctx = new AC();
      if (ctx.resume) ctx.resume();
      const s = ctx.createBufferSource();
      s.buffer = ctx.createBuffer(1, 1, 22050);
      s.connect(ctx.destination);
      s.start(0);
    } catch { /* 音が使えなくても動作継続 */ }
  }
  function beep(t, freq, dur) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'square'; o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.35, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(ctx.destination);
    o.start(t); o.stop(t + dur + 0.05);
  }
  function pattern() {
    if (!ctx) return;
    try {
      if (ctx.state !== 'running' && ctx.resume) ctx.resume();
      const t = ctx.currentTime;
      beep(t, 988, 0.18); beep(t + 0.28, 988, 0.18); beep(t + 0.56, 1319, 0.3);
    } catch { /* 無視 */ }
  }
  function startAlarm() { if (alarmTimer) return; pattern(); alarmTimer = setInterval(pattern, 1600); }
  function stopAlarm() { clearInterval(alarmTimer); alarmTimer = null; }

  // ---------- 画面スリープ抑止 ----------
  async function lockScreen() {
    try {
      if ('wakeLock' in navigator && !wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      }
    } catch { wakeLock = null; }
  }
  function unlockScreen() { try { if (wakeLock) wakeLock.release(); } catch { /* 無視 */ } wakeLock = null; }

  // ---------- タイマー操作 ----------
  function start() {
    const c = calc();
    if (!c.ok) { $('error').textContent = c.msg || '貯水量を入力してください。'; return; }
    initAudio();
    const now = Date.now();
    timer = { status: 'running', routeId: c.route.id, liters: c.liters, flow: c.route.flow, totalSec: c.sec, endAt: now + c.sec * 1000, acked: false };
    saveTimer(); lockScreen(); runTicker(); render();
  }
  function pause() {
    if (timer.status !== 'running') return;
    timer.remainingMs = Math.max(1, timer.endAt - Date.now());
    timer.status = 'paused'; delete timer.endAt;
    saveTimer(); stopTicker(); unlockScreen(); render();
  }
  function resume() {
    if (timer.status !== 'paused') return;
    initAudio();
    timer.endAt = Date.now() + timer.remainingMs;
    timer.status = 'running'; delete timer.remainingMs;
    saveTimer(); lockScreen(); runTicker(); render();
  }
  function reset() {
    stopAlarm(); stopTicker(); unlockScreen();
    timer = { status: 'idle' }; saveTimer(); render();
  }
  function finish() {
    stopTicker(); unlockScreen();
    timer.status = 'done'; timer.acked = false; delete timer.endAt;
    saveTimer(); startAlarm(); render();
  }
  function ackAlarm() { stopAlarm(); timer.acked = true; saveTimer(); render(); }

  function remainingSec() {
    if (timer.status === 'running') return Math.max(0, Math.ceil((timer.endAt - Date.now()) / 1000));
    if (timer.status === 'paused') return Math.ceil(timer.remainingMs / 1000);
    return 0;
  }
  function tick() {
    if (timer.status !== 'running') return;
    if (timer.endAt - Date.now() <= 0) finish(); else renderDisplay();
  }
  function runTicker() { stopTicker(); ticker = setInterval(tick, 250); }
  function stopTicker() { clearInterval(ticker); ticker = null; }

  // ---------- 描画 ----------
  const LABELS = { idle: '待機中', running: '貯水中', paused: '一時停止中', done: '貯水完了！' };
  function renderDisplay() {
    const s = timer.status;
    $('display').textContent = s === 'idle' ? '--:--' : s === 'done' ? '00:00' : fmtClock(remainingSec());
  }
  function render() {
    const s = timer.status, active = s !== 'idle';
    document.body.className = 'state-' + s + (s === 'done' && timer.acked ? ' acked' : '');
    $('stateLabel').textContent = LABELS[s];
    $('route').disabled = active; $('liters').disabled = active; $('openSettings').disabled = active;

    const r = active ? { flow: timer.flow } : currentRoute();
    $('flow').textContent = r ? String(r.flow) : '--';
    if (active) {
      $('route').value = timer.routeId; $('liters').value = String(timer.liters);
      $('estimate').textContent = fmtDuration(timer.totalSec);
      $('error').textContent = '';
    } else {
      const c = calc();
      $('estimate').textContent = c.ok ? fmtDuration(c.sec) : '--';
      $('error').textContent = c.ok ? '' : c.msg;
    }
    const endMs = s === 'running' ? timer.endAt : s === 'paused' ? Date.now() + timer.remainingMs : null;
    $('endRow').hidden = !(s === 'running');
    if (endMs && s === 'running') $('endTime').textContent = fmtTime(endMs);

    $('btnStart').hidden = s !== 'idle';
    $('btnPause').hidden = s !== 'running';
    $('btnResume').hidden = s !== 'paused';
    $('btnStopAlarm').hidden = !(s === 'done' && !timer.acked);
    $('btnReset').hidden = s === 'idle';
    $('btnStart').disabled = s === 'idle' && !calc().ok;
    renderDisplay();
  }

  function renderRouteSelect() {
    const sel = $('route'); sel.textContent = '';
    for (const r of routes) {
      const o = document.createElement('option');
      o.value = r.id; o.textContent = `${r.name}（${r.flow} L/分）`;
      sel.appendChild(o);
    }
    if (!routes.some((r) => r.id === input.routeId)) input.routeId = routes[0].id;
    sel.value = input.routeId;
  }

  // ---------- 確認ダイアログ ----------
  let onOk = null;
  function confirmDialog(msg, label, cb) {
    $('modalMsg').textContent = msg; $('modalOk').textContent = label; onOk = cb; $('modal').hidden = false;
  }
  function closeModal() { $('modal').hidden = true; onOk = null; }

  // ---------- 設定画面 ----------
  function saveRoutes() { save(K_ROUTES, routes); }
  function renderSettings() {
    const box = $('routeList'); box.textContent = '';
    routes.forEach((r) => {
      const row = document.createElement('div'); row.className = 'route-row';
      const name = document.createElement('input');
      name.type = 'text'; name.maxLength = MAX_NAME; name.value = r.name; name.setAttribute('aria-label', '経路名称');
      name.addEventListener('change', () => {
        const v = name.value.trim();
        if (!v) { name.value = r.name; return setErr('経路名称を空にはできません。'); }
        r.name = v.slice(0, MAX_NAME); setErr(''); saveRoutes();
      });
      const line = document.createElement('div'); line.className = 'line';
      const flow = document.createElement('input');
      flow.type = 'text'; flow.inputMode = 'decimal'; flow.value = String(r.flow); flow.setAttribute('aria-label', '流量');
      flow.addEventListener('change', () => {
        const v = num(flow.value);
        if (!validFlow(v)) { flow.value = String(r.flow); return setErr(`流量は0より大きく${MAX_FLOW}以下の数値で入力してください。`); }
        r.flow = v; flow.value = String(v); setErr(''); saveRoutes();
      });
      const unit = document.createElement('span'); unit.className = 'unit'; unit.textContent = 'L/分';
      line.append(flow, unit);
      const del = document.createElement('button'); del.className = 'btn danger'; del.textContent = '削除';
      del.addEventListener('click', () => {
        if (routes.length <= 1) return setErr('経路を0件にはできません。');
        confirmDialog(`「${r.name}」を削除しますか？`, '削除する', () => {
          routes = routes.filter((x) => x.id !== r.id); saveRoutes(); setErr(''); renderSettings();
        });
      });
      row.append(name, line, del); box.appendChild(row);
    });
  }
  function setErr(m) { $('settingsError').textContent = m; }
  function openSettings() { if (timer.status !== 'idle') return; setErr(''); renderSettings(); $('main').hidden = true; $('settings').hidden = false; window.scrollTo(0, 0); }
  function closeSettings() { renderRouteSelect(); saveInput(); $('settings').hidden = true; $('main').hidden = false; render(); }

  // ---------- イベント ----------
  $('route').addEventListener('change', () => { input.routeId = $('route').value; saveInput(); render(); });
  $('liters').addEventListener('input', () => { input.liters = $('liters').value; saveInput(); render(); });
  $('btnStart').addEventListener('click', start);
  $('btnPause').addEventListener('click', pause);
  $('btnResume').addEventListener('click', resume);
  $('btnStopAlarm').addEventListener('click', ackAlarm);
  $('btnReset').addEventListener('click', () => confirmDialog('タイマーをリセットしますか？\n（残り時間は失われます）', 'リセットする', reset));
  $('openSettings').addEventListener('click', openSettings);
  $('closeSettings').addEventListener('click', closeSettings);
  $('addRoute').addEventListener('click', () => {
    if (routes.length >= MAX_ROUTES) return setErr(`経路は${MAX_ROUTES}件までです。`);
    routes.push({ id: uid(), name: `経路${routes.length + 1}`, flow: 10 }); saveRoutes(); setErr(''); renderSettings();
  });
  $('modalCancel').addEventListener('click', closeModal);
  $('modalOk').addEventListener('click', () => { const f = onOk; closeModal(); if (f) f(); });
  $('modalMsg').style.whiteSpace = 'pre-line';

  // 復帰時に残り時間を再計算し、Wake Lockを再取得
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (timer.status === 'running') { lockScreen(); tick(); render(); }
    if (timer.status === 'done' && !timer.acked) startAlarm();
  });
  window.addEventListener('pageshow', () => { if (timer.status === 'running') { tick(); render(); } });

  // ---------- 起動 ----------
  renderRouteSelect();
  $('liters').value = input.liters;
  if (timer.status === 'running') {
    if (timer.endAt - Date.now() <= 0) { timer.status = 'done'; timer.acked = false; delete timer.endAt; saveTimer(); startAlarm(); }
    else { lockScreen(); runTicker(); }
  } else if (timer.status === 'done' && !timer.acked) startAlarm();
  render();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
  }
})();
