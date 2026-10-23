import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';
import * as P from './plan.js';

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
const main = document.getElementById('main');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const ls = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sin espacio: queda solo en memoria hasta sincronizar */ } },
};

// Copia local de todo (para usar sin señal) + cola de claves pendientes de subir.
let user = null, plan = ls.get('plan', null), logs = ls.get('logs', {}), queue = ls.get('queue', []), catalog = ls.get('catalog', null), planId = ls.get('planId', null);

const fmtDate = (d, opts = { weekday: 'long', day: 'numeric', month: 'long' }) => new Date(d + 'T12:00').toLocaleDateString('es-AR', opts);

// ---------- Sincronización ----------

async function pull() {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from('logs').select('date,item_id,data').range(from, from + 999);
    if (error) throw error;
    rows.push(...data);
    if (data.length < 1000) break;
  }
  const { data: pl, error } = await sb.from('plans').select('id,data').order('created_at', { ascending: false }).limit(1);
  if (error) throw error;
  const { data: cat, error: e2 } = await sb.from('exercise_catalog').select('data').limit(1);
  if (e2) throw e2;
  catalog = cat[0]?.data ?? null;
  ls.set('catalog', catalog);
  const fresh = {};
  for (const r of rows) fresh[`${r.date}|${r.item_id}`] = r.data;
  for (const k of queue) fresh[k] = logs[k]; // lo no subido todavía gana
  logs = fresh;
  plan = pl[0]?.data ?? null;
  planId = pl[0]?.id ?? null;
  ls.set('planId', planId);
  ls.set('logs', logs);
  ls.set('plan', plan);
}

let flushing = false, flushTimer;
async function flush() {
  if (flushing || !queue.length || !user) return syncBadge();
  flushing = true;
  const keys = [...new Set(queue)];
  const sent = Object.fromEntries(keys.map(k => [k, JSON.stringify(logs[k])]));
  try {
    const rows = keys.map(k => {
      const [date, item_id] = k.split('|');
      return { user_id: user.id, date, item_id, data: logs[k], updated_at: new Date().toISOString() };
    });
    const { error } = await sb.from('logs').upsert(rows);
    // Solo saco de la cola lo que no cambió mientras subía.
    if (!error) queue = queue.filter(k => sent[k] !== JSON.stringify(logs[k]));
    ls.set('queue', queue);
  } catch { /* sin red: se reintenta */ }
  flushing = false;
  syncBadge();
}

function save(key, data) {
  logs[key] = data;
  queue.push(key);
  ls.set('logs', logs);
  ls.set('queue', queue);
  syncBadge();
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, 800);
}

function syncBadge() {
  const n = new Set(queue).size;
  const el = document.getElementById('sync');
  el.textContent = n ? `${n} sin subir` : 'Al día';
  el.dataset.s = n ? 'pend' : 'ok';
}

addEventListener('online', flush);
setInterval(flush, 30000);

// ---------- Inputs ----------
// Cada input lleva data-p con la ruta dentro del log del card (ej. "ex.0.sets.1.kg").
// Al cambiar algo se re-arma el log entero del card leyendo sus inputs.

const num = (p, v, ph = '', cls = '') => `<input type="number" inputmode="decimal" step="any" min="0" class="${cls}" ${p ? `data-p="${p}"` : ''} value="${v ?? ''}" placeholder="${esc(ph)}" aria-label="${esc(ph)}">`;
const chk = (p, v, label) => `<label class="chk"><input type="checkbox" data-p="${p}" ${v ? 'checked' : ''}><span>${label}</span></label>`;
const note = (p, v, ph = 'Nota') => `<textarea data-p="${p}" rows="1" placeholder="${ph}" aria-label="${ph}">${esc(v)}</textarea>`;
const pain = (p, v, label = 'Dolor 0-10') => `<label class="pain">${label} <select data-p="${p}" data-t="num"><option value="">—</option>${[...Array(11).keys()].map(n => `<option ${v === n ? 'selected' : ''}>${n}</option>`).join('')}</select></label>`;
const radios = (key, p, v, opts) => `<div class="pills">${opts.map(([val, l]) => `<label class="pill"><input type="radio" name="${esc(key + p)}" data-p="${p}" value="${val}" ${v === val ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div>`;

function serialize(card) {
  const o = {};
  for (const el of card.querySelectorAll('[data-p]')) {
    if (el.type === 'radio' && !el.checked) continue;
    let v = el.type === 'checkbox' ? el.checked : el.value;
    if (v === '') continue;
    if (el.type === 'number' || el.dataset.t === 'num') v = Number(v);
    if (el.dataset.t === 'bool') v = v === 'true';
    const ks = el.dataset.p.split('.');
    let t = o;
    ks.slice(0, -1).forEach((k, i) => { t = t[k] ??= /^\d+$/.test(ks[i + 1]) ? [] : {}; });
    t[ks.at(-1)] = v;
  }
  return o;
}

function onEdit(e) {
  const card = e.target.closest('[data-key]');
  if (!card) return;
  const key = card.dataset.key;
  // "kg para todas" copia el valor a cada serie del ejercicio (no tilda nada).
  if (e.target.matches('.kgall')) e.target.closest('.ex').querySelectorAll('input[data-p$=".kg"]').forEach(i => { i.value = e.target.value; });
  save(key, serialize(card));
  const item = itemByKey(key), prog = card.querySelector('.prog');
  if (prog) prog.textContent = progText(item, logs[key]);
  card.querySelector('.segs')?.replaceWith(...tpl(segs(item, logs[key])));
  if (item?.type === 'gym') card.querySelectorAll('.exstat').forEach((el, i) => { el.textContent = exStatus(item.exercises[i], logs[key]?.ex?.[i]); el.dataset.s = statKind(el.textContent); });
  if (e.target.matches('textarea')) grow(e.target);
}
main.addEventListener('change', onEdit);
main.addEventListener('input', e => e.target.matches('textarea, input[type=number]') && onEdit(e));

const grow = t => { t.style.height = 'auto'; t.style.height = t.scrollHeight + 'px'; };
const itemByKey = key => { const [date, id] = key.split('|'); return P.dayOf(plan, date)?.items.find(i => i.id === id); };
const progText = (item, log) => { if (!item) return ''; const [d, t] = P.itemProgress(item, log); return `${+d.toFixed(1)}/${t}`; };
const tpl = html => { const t = document.createElement('template'); t.innerHTML = html; return t.content.childNodes; };

// Íconos de trazo fino (estilo Lucide).
const svg = d => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
const IC = {
  play: svg('<path d="M7 4.5v15l12-7.5z"/>'),
  sun: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
  zap: svg('<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>'),
  prev: svg('<path d="m15 18-6-6 6-6"/>'),
  next: svg('<path d="m9 18 6-6-6-6"/>'),
};

// Barra segmentada del gimnasio: un segmento por serie.
let popKey = null;
function segs(item, log) {
  if (item?.type !== 'gym') return '';
  const [d, t] = P.itemProgress(item, log);
  return `<div class="segs" aria-hidden="true">${Array.from({ length: t }, (_, i) => `<i style="--f:${Math.min(Math.max(d - i, 0), 1)};--k:${i}"></i>`).join('')}</div>`;
}

// ---------- Vistas ----------

function stepText(s) {
  return [
    s.do, s.time, s.distance,
    s.reps != null && `${s.sets ? s.sets + ' × ' : ''}${s.reps} reps`,
    s.intensity, s.pace && `${s.pace}/km`, s.per_side && 'por lado', s.notes,
  ].filter(Boolean).map(esc).join(' · ');
}

function exerciseTarget(ex) {
  const sets = P.setsOf(ex);
  const same = !Array.isArray(ex.sets);
  const one = s => [s.reps != null && `${s.reps}`, s.time, s.weight != null && `${s.weight} kg`].filter(Boolean).join(' · ');
  return [same ? `${sets.length} × ${one(sets[0])}` : sets.map(one).join(' / '), ex.per_side && 'por lado', ex.rest && `desc. ${ex.rest}`]
    .filter(Boolean).map(esc).join(' · ');
}

const statKind = s => s === '✓' ? 'done' : s === '—' ? 'none' : s === 'no lo hice' ? 'skip' : 'part';

// Estado corto de un ejercicio para la línea compacta.
function exStatus(ex, l) {
  if (l?.skip) return 'no lo hice';
  const sets = P.setsOf(ex), d = sets.filter((_, j) => l?.sets?.[j]?.done).length;
  return d === sets.length ? '✓' : d ? `${d} de ${sets.length}` : '—';
}

function gymBody(item, log, date) {
  return item.exercises.map((ex, i) => {
    const l = log?.ex?.[i];
    const id = P.exId(catalog, ex);
    const last = P.lastWeight(logs, { ex: id, name: ex.name }, date);
    const kgShown = l?.sets?.find(s => s?.kg != null)?.kg ?? ex.weight ?? last;
    const rows = P.setsOf(ex).map((s, j) => {
      const sl = l?.sets?.[j];
      const reps = sl?.reps ?? (s.reps != null ? parseInt(s.reps) || null : null);
      const timed = s.reps == null && s.time;
      return `<div class="set">
        ${chk(`ex.${i}.sets.${j}.done`, sl?.done, `Serie ${j + 1}`)}
        ${timed ? `<span class="muted">${esc(s.time)}</span>` : `${num(`ex.${i}.sets.${j}.reps`, reps, 'reps')}<span class="u">reps</span>
        ${num(`ex.${i}.sets.${j}.kg`, sl?.kg ?? s.weight ?? last, 'kg')}<span class="u">kg</span>`}
      </div>`;
    }).join('');
    const timedOnly = P.setsOf(ex).every(s => s.reps == null && s.time);
    return `<details class="ex">
      <summary>
        <span class="exname">${esc(ex.name)}</span>
        <span class="target">${exerciseTarget(ex)}${!Array.isArray(ex.sets) && ex.weight == null && kgShown != null && !timedOnly ? ` · ${esc(kgShown)} kg` : ''}</span>
        <span class="exstat" data-s="${statKind(exStatus(ex, l))}">${exStatus(ex, l)}</span>
        ${catalog?.exercises?.[id]?.videos?.length ? `<button type="button" class="play" data-video="${esc(id)}" aria-label="Ver video de ${esc(ex.name)}">${IC.play}</button>` : ''}
      </summary>
      <input type="hidden" data-p="ex.${i}.name" value="${esc(ex.name)}">${id ? `<input type="hidden" data-p="ex.${i}.ex" value="${esc(id)}">` : ''}
      ${ex.notes ? `<p class="target"><em>${esc(ex.notes)}</em></p>` : ''}
      ${timedOnly ? '' : `<label class="inline">kg para todas ${num('', null, String(kgShown ?? 'kg'), 'short kgall')}</label>`}
      ${rows}
      ${chk(`ex.${i}.skip`, l?.skip, 'No lo hice')}
      <details ${l?.note || l?.pain != null ? 'open' : ''}><summary>Nota / dolor</summary>${pain(`ex.${i}.pain`, l?.pain)}${note(`ex.${i}.note`, l?.note)}</details>
    </details>`;
  }).join('');
}

// Trote/campo: lista de lectura; tildar pasos queda escondido para cuando no se terminó.
function stepsBody(item, log) {
  const read = item.steps.map(s => `<li>${s.repeat
    ? `<b>${s.repeat} ×</b> ${s.steps.map(x => `${x.repeat ? `${x.repeat} × ` : ''}${stepText(x)}`).join(' + ')}`
    : stepText(s)}</li>`).join('');
  const steps = item.steps.map((s, i) => {
    const l = log?.steps?.[i];
    if (!s.repeat) return `<li>${chk(`steps.${i}.done`, l?.done, stepText(s))}</li>`;
    return `<li class="repeat">
      ${chk(`steps.${i}.done`, l?.done, `<b>${s.repeat} ×</b>`)}
      <ul>${s.steps.map(x => `<li>${x.repeat ? `${x.repeat} × ` : ''}${stepText(x)}</li>`).join('')}</ul>
      <label class="inline">Completadas ${num(`steps.${i}.completed`, l?.completed, String(s.repeat), 'short')} de ${s.repeat}</label>
    </li>`;
  }).join('');
  const stopped = !log?.confirmed && log?.steps?.some(l => l?.done || l?.completed != null);
  return `<ol class="read">${read}</ol>
    <details class="stop" ${stopped ? 'open' : ''}><summary>No la terminé / me frené</summary>
      <p class="target">Tildá lo que hiciste.</p><ul class="steps">${steps}</ul>
    </details>
    <div class="row compact"><label class="inline">Tiempo total ${num('time', log?.time, '', 'short')} min</label>${pain('pain', log?.pain, 'Dolor')}</div>
    ${note('note', log?.note)}`;
}

function itemCard(item, date, dayStage) {
  const key = `${date}|${item.id}`, log = logs[key];
  const badges = [item.stage !== dayStage && esc(item.stage), item.impact && `${IC.zap}impacto`, item.competitive && 'competitivo'].filter(Boolean).map(b => `<span class="badge">${b}</span>`).join('');
  let body;
  if (item.type === 'check') body = chk('done', log?.done, 'Hecho');
  else if (item.type === 'match') body = `
    ${item.minutes ? `<p class="target">Minutos planificados: ${esc(item.minutes)}</p>` : ''}
    ${chk('done', log?.done, 'Jugado')}
    <div class="row"><label class="inline">Minutos jugados ${num('minutes', log?.minutes, 'min', 'short')}</label>${pain('pain', log?.pain, 'Dolor durante')}</div>
    ${note('note', log?.note)}`;
  else if (item.type === 'gym') body = gymBody(item, log, date);
  else body = stepsBody(item, log);
  return `<section class="card t-${esc(item.type)}" data-key="${esc(key)}">
    <header><h3>${esc(item.title)}</h3>${['run', 'field'].includes(item.type) ? '' : `<span class="prog">${progText(item, log)}</span>`}</header>
    ${segs(item, log).replace('class="segs"', `class="segs${popKey === key ? ' pop' : ''}"`)}
    ${badges ? `<div>${badges}</div>` : ''}
    ${item.notes ? `<p class="target"><em>${esc(item.notes)}</em></p>` : ''}
    ${body}
    ${['gym', 'run', 'field'].includes(item.type) ? `<button type="button" class="done-all${log?.confirmed ? ' on' : ''}">${log?.confirmed ? 'Confirmada ✓ (volver a aplicar)' : '✓ Terminé la sesión'}</button>
      ${log?.confirmed ? '<input type="hidden" data-p="confirmed" data-t="bool" value="true">' : ''}` : ''}
  </section>`;
}

function morningCard(date) {
  const key = `${date}|_morning`, m = logs[key] ?? {};
  const done = m.skipped || (m.swelling && m.pain != null && m.trend);
  return `<section class="card t-morning morning ${done ? 'ok' : ''}" data-key="${esc(key)}">
    <header><h3>${IC.sun}Chequeo de la mañana</h3><span class="prog">${done ? '✓' : 'pendiente'}</span></header>
    <p class="target">Después del impacto de ayer. Prueba: ${esc(plan.rules?.morning_check ?? 'bajada lenta de escalón')}</p>
    <p class="lbl">¿Hinchazón?</p>${radios(key, 'swelling', m.swelling, [['no', 'No'], ['si', 'Sí']])}
    <p class="lbl">Dolor en la prueba</p>
    <div class="pills scale">${[...Array(11).keys()].map(n => `<label class="pill"><input type="radio" name="${esc(key)}pain" data-p="pain" data-t="num" value="${n}" ${m.pain === n ? 'checked' : ''}><span>${n}</span></label>`).join('')}</div>
    <p class="lbl">Comparado con antes</p>${radios(key, 'trend', m.trend, [['mejor', 'Mejor'], ['igual', 'Igual'], ['peor', 'Peor']])}
    ${chk('skipped', m.skipped, 'Ayer no entrené (no aplica)')}
  </section>`;
}

// Aviso de rutina ajustada por Claude (changelog del plan). Lo visto se guarda solo en este dispositivo.
function changesCard() {
  const unseen = P.unseenChanges(plan, ls.get('seenChange', null));
  if (!unseen.length) return '';
  return `<section class="card changes"><header><h3>Rutina ajustada por Claude</h3></header>
    <ul>${unseen.map(c => `<li>${esc(c.summary)} <small class="muted">${esc(new Date(c.at).toLocaleDateString('es-AR'))}</small></li>`).join('')}</ul>
    <button type="button" id="seen" data-at="${esc(unseen.at(-1).at)}">Entendido</button>
  </section>`;
}

// Selector Hoy | Semana; la última elección se recuerda en este dispositivo.
const viewSeg = (v, date) => `<nav class="seg" aria-label="Vista">
  <a href="#/d/${date}" data-view="hoy" ${v === 'hoy' ? 'aria-current="page"' : ''}>Hoy</a>
  <a href="#/s/${date}" data-view="semana" ${v === 'semana' ? 'aria-current="page"' : ''}>Semana</a></nav>`;

// Estado del día: el cierre si lo hay; si no, derivado de los items (como el export). Futuro u hoy sin avances: sin estado.
function dayStatus(day, t) {
  const st = logs[`${day.date}|_day`]?.status;
  if (st || day.date > t) return st ?? null;
  const f = day.items.map(i => { const [a, b] = P.itemProgress(i, logs[`${day.date}|${i.id}`]); return b ? a / b : 0; });
  return f.every(x => x === 1) ? 'hecho' : f.some(x => x > 0) ? 'parcial' : day.date === t ? null : 'no hecho';
}

function renderWeek(date) {
  const t = P.today(), mon = P.weekStart(date), sun = P.addDays(mon, 6);
  const dates = [...Array(7).keys()].map(n => P.addDays(mon, n));
  const days = dates.map(d => P.dayOf(plan, d)).filter(Boolean);
  const done = days.filter(d => dayStatus(d, t) === 'hecho').length;
  const max = plan.rules?.max_pain ?? 3;
  const alarm = P.painSeries(plan, logs, sun).some(r => r.date >= mon && (r.swelling || r.during > max || r.morning > max));
  const dm = d => fmtDate(d, { day: '2-digit', month: '2-digit' });
  const range = mon.slice(5, 7) === sun.slice(5, 7) ? `${mon.slice(8)}–${dm(sun)}` : `${dm(mon)}–${dm(sun)}`;
  const label = { hecho: '✓ hecho', parcial: 'parcial', 'no hecho': 'no hecho' };
  main.innerHTML = `
    ${viewSeg('semana', t >= mon && t <= sun ? t : mon)}
    <nav class="daynav">
      <a href="#/s/${P.addDays(mon, -7)}" aria-label="Semana anterior">${IC.prev}</a>
      <div class="score"><small>Semana</small><b>${esc(range)}</b></div>
      <a href="#/s/${P.addDays(mon, 7)}" aria-label="Semana siguiente">${IC.next}</a>
    </nav>
    <p class="weeksum">${days.length ? `<b>${done} de ${days.length}</b> sesiones hechas` : 'Semana sin sesiones'}
      ${alarm ? `<span class="badge alarm">dolor &gt; ${max} o hinchazón</span>` : ''}</p>
    <section class="card list">${dates.map(d => {
      const day = P.dayOf(plan, d), st = day && dayStatus(day, t);
      return `<a class="dayrow week ${d === t ? 'today' : ''} ${day ? '' : 'rest'}" href="#/d/${d}">
        <span class="date">${esc(fmtDate(d, { weekday: 'short' }).replace('.', ''))} ${d.slice(8)}</span>
        <span class="titles">${day ? day.items.map(i => `<span class="ichip t-${esc(i.type)}">${esc(i.title)}</span>`).join('') : 'Descanso'}</span>
        <span class="pct${st === 'hecho' ? ' full' : st === 'parcial' ? ' part' : ''}">${st ? label[st] : ''}</span>
      </a>`;
    }).join('')}</section>`;
}

function renderDay(date) {
  const isToday = date === P.today();
  const day = P.dayOf(plan, date);
  const next = plan.days.find(d => d.date > date);
  const dl = logs[`${date}|_day`] ?? {};
  const stage = day?.items.find(i => i.stage)?.stage;
  main.innerHTML = `
    ${viewSeg('hoy', date)}
    <nav class="daynav">
      <a href="#/d/${P.addDays(date, -1)}" aria-label="Día anterior">${IC.prev}</a>
      <div class="score">
        <small>${isToday ? 'Hoy' : esc(fmtDate(date, { month: 'long', year: 'numeric' }))}</small>
        <b>${esc(fmtDate(date, { weekday: 'short' }).replace('.', ''))} ${esc(fmtDate(date, { day: '2-digit', month: '2-digit' }))}</b>
        ${stage ? `<span class="chip">${esc(stage)}</span>` : ''}
      </div>
      <a href="#/d/${P.addDays(date, 1)}" aria-label="Día siguiente">${IC.next}</a>
    </nav>
    ${!isToday ? `<p class="center"><a href="#/d/${P.today()}">Volver a hoy</a></p>` : changesCard()}
    ${P.morningRequired(plan, date) ? morningCard(date) : ''}
    ${day ? day.items.map(i => itemCard(i, date, stage)).join('') : `<section class="card center"><h3>Descanso</h3>
      ${next ? `<p>Próximo: <a href="#/d/${next.date}">${esc(fmtDate(next.date))}</a> · ${next.items.map(i => esc(i.title)).join(', ')}</p>` : '<p>No hay más días en la rutina.</p>'}</section>`}
    ${day ? `<section class="card t-day" data-key="${esc(date)}|_day">
      <header><h3>Cierre del día</h3></header>
      ${radios(date, 'status', dl.status, [['hecho', 'Hecho'], ['parcial', 'Parcial'], ['no hecho', 'No hecho']])}
      ${note('note', dl.note, 'Cómo me sentí, qué cambié…')}
    </section>` : ''}`;
  main.querySelectorAll('textarea').forEach(grow);
  popKey = null;
}

function renderPlan(msg = '') {
  const t = P.today();
  const rows = plan ? plan.days.map(d => {
    const items = d.items.map(i => { const [a, b] = P.itemProgress(i, logs[`${d.date}|${i.id}`]); return { i, f: b ? a / b : 0 }; });
    const pct = Math.round(100 * items.reduce((s, x) => s + x.f, 0) / items.length);
    const status = logs[`${d.date}|_day`]?.status;
    const mMissing = d.items.some(i => i.impact) && P.addDays(d.date, 1) <= t && !logs[`${P.addDays(d.date, 1)}|_morning`];
    return `<a class="dayrow ${d.date === t ? 'today' : ''} ${d.date < t ? 'past' : ''}" href="#/d/${d.date}" ${d.date === t ? 'id="today"' : ''}>
      <span class="date">${esc(fmtDate(d.date, { weekday: 'short', day: 'numeric', month: 'short' }))}</span>
      <span class="titles">${d.items.map(i => esc(i.title)).join(' · ')}${mMissing ? ' <span class="badge pend">chequeo pendiente</span>' : ''}</span>
      <span class="pct${status === 'hecho' || (!status && pct === 100) ? ' full' : status === 'parcial' ? ' part' : ''}">${status ? esc(status) : d.date <= t ? pct + '%' : ''}</span>
    </a>`;
  }).join('') : '';
  main.innerHTML = `
    ${msg}
    <section class="card">
      <header><h3>${plan ? esc(plan.name) : 'Sin rutina cargada'}</h3></header>
      ${plan ? `<p class="target">${esc(fmtDate(plan.days[0].date))} → ${esc(fmtDate(plan.days.at(-1).date))}</p>
        <div class="row">
          <label class="inline">Desde <input type="date" id="exfrom" value="${plan.days[0].date}"></label>
          <label class="inline">Hasta <input type="date" id="exto" value="${P.today()}"></label>
        </div>
        <button id="export">Exportar lo hecho (copiar + descargar)</button>
        <a class="button" href="#/imprimir">PDF para el profesional</a>` : ''}
      <div class="actions"><a class="button" href="#/crear">Crear rutina</a></div>
      <details><summary>Generar con IA</summary>
        <p class="target">Copiá el prompt, completá tus datos y pegalo en ChatGPT, Gemini o Claude. Lo que te devuelva pegalo en <b>Cargar rutina nueva</b>.</p>
        <button type="button" id="prompt">Copiar prompt</button>
        <textarea id="ptext" rows="6" hidden readonly aria-label="Prompt"></textarea>
      </details>
      <details ${plan ? '' : 'open'}><summary>Cargar rutina nueva</summary>
        <p class="target">Elegí el archivo .json o pegá su contenido (sirve la respuesta entera de la IA). Reemplaza la rutina vigente; lo ya registrado se conserva.</p>
        <input type="file" id="file" accept=".json,application/json">
        <textarea id="paste" rows="4" placeholder='{"version":1, ...}'></textarea>
        <button id="load">Cargar</button>
      </details>
    </section>
    ${rows ? `<section class="card list">${rows}</section>` : ''}
    <section class="card"><details><summary>Borrar datos de prueba</summary>
      <p class="target">Borra registros del rango elegido, en este dispositivo y en la base. No toca la rutina ni el catálogo. <b>No se puede deshacer.</b></p>
      <div class="row">
        <label class="inline">Desde <input type="date" id="dfrom"></label>
        <label class="inline">Hasta <input type="date" id="dto" value="${P.today()}"></label>
      </div>
      <label class="chk"><input type="checkbox" id="dtraining" checked><span>Registros de entrenamiento (incluye chequeos y cierres)</span></label>
      <label class="chk"><input type="checkbox" id="dvideos" checked><span>Videos descartados</span></label>
      <label>Escribí BORRAR para confirmar <input id="dconfirm" autocomplete="off" autocapitalize="characters"></label>
      <button id="ddel" class="danger">Borrar</button>
    </details></section>
    <p class="center"><button class="link" id="logout">Cerrar sesión</button></p>`;
  main.querySelector('#today')?.scrollIntoView({ block: 'center' });
  main.querySelector('#file').onchange = async e => { main.querySelector('#paste').value = await e.target.files[0]?.text() ?? ''; };
  main.querySelector('#load').onclick = loadPlan;
  main.querySelector('#prompt').onclick = copyPrompt;
  main.querySelector('#ddel').onclick = deleteData;
  main.querySelector('#logout').onclick = async () => {
    const n = new Set(queue).size;
    if (n && !confirm(`Hay ${n} registros sin subir y se van a perder. ¿Salir igual?`)) return;
    await sb.auth.signOut();
    logs = {}; queue = []; plan = null; catalog = null; planId = null;
    ['logs', 'queue', 'plan', 'catalog', 'planId'].forEach(k => localStorage.removeItem(k));
    route();
  };
  const ex = main.querySelector('#export');
  if (ex) ex.onclick = exportLogs;
}

async function loadPlan() {
  let p;
  try { p = JSON.parse(P.extractJson(main.querySelector('#paste').value)); } catch (e) { return renderPlan(`<p class="error">JSON inválido: ${esc(e.message)}</p>`); }
  const err = P.validatePlan(p);
  if (err.length) return renderPlan(`<p class="error">La rutina tiene errores:<br>${err.map(esc).join('<br>')}</p>`);
  if (plan && !confirm(`¿Reemplazar "${plan.name}" por "${p.name}"?`)) return;
  p = { source: 'ia', ...P.fillEx(p, catalog) };
  const error = await savePlan(p);
  if (error) return renderPlan(`<p class="error">No se pudo guardar (¿sin conexión?): ${esc(error.message)}</p>`);
  const orphan = P.buildExport(plan, logs, '0000-01-01', '9999-12-31').fuera_del_plan.length;
  renderPlan(`<p class="ok">Rutina "${esc(p.name)}" cargada.${orphan ? ` Hay ${orphan} registros de items que no están en esta rutina: se conservan y salen en el export como "fuera_del_plan".` : ''}</p>`);
}

// Cada cambio de rutina es una versión nueva en plans; la vigente es la última.
async function savePlan(p) {
  const { data: row, error } = await sb.from('plans').insert({ user_id: user.id, name: p.name, data: p }).select('id').single();
  if (error) return error;
  plan = p;
  planId = row.id;
  ls.set('plan', plan);
  ls.set('planId', planId);
}

// Textos que se editan aparte (los cachea el service worker).
const texts = {};
const text = async f => texts[f] ??= await (await fetch(f)).text();

async function copyPrompt() {
  const t = main.querySelector('#ptext');
  try { t.value = (await text('prompt-rutina.md')).replace('{{CATALOGO}}', P.catalogLines(catalog)); } catch { t.value = 'No se pudo cargar el prompt (¿sin conexión?).'; }
  t.hidden = false;
  grow(t);
  try { await navigator.clipboard.writeText(t.value); main.querySelector('#prompt').textContent = 'Copiado ✓'; }
  catch { t.select(); main.querySelector('#prompt').textContent = 'Copialo del cuadro'; }
}

async function deleteData() {
  const v = id => main.querySelector(id);
  const from = v('#dfrom').value || '0000-01-01', to = v('#dto').value || P.today();
  const what = { training: v('#dtraining').checked, videos: v('#dvideos').checked };
  if (v('#dconfirm').value.trim().toUpperCase() !== 'BORRAR') return renderPlan('<p class="error">Para borrar, escribí BORRAR en el campo de confirmación.</p>');
  if (!what.training && !what.videos) return renderPlan('<p class="error">Elegí qué borrar.</p>');
  if (from > to) return renderPlan('<p class="error">"Desde" es posterior a "Hasta".</p>');
  let q = sb.from('logs').delete({ count: 'exact' }).gte('date', from).lte('date', to);
  if (!what.training) q = q.like('item_id', '\\_video:%');
  if (!what.videos) q = q.not('item_id', 'like', '\\_video:%');
  const { error, count } = await q;
  if (error) return renderPlan(`<p class="error">No se pudo borrar (¿sin conexión?): ${esc(error.message)}</p>`);
  const gone = new Set(P.keysToDelete(logs, from, to, what));
  gone.forEach(k => delete logs[k]);
  queue = queue.filter(k => !gone.has(k));
  ls.set('logs', logs);
  ls.set('queue', queue);
  syncBadge();
  renderPlan(`<p class="ok">Borrados ${Math.max(count ?? 0, gone.size)} registros.</p>`);
}


// ---------- Video de demostración ----------

const REASONS = ['no se ve bien', 'otro ejercicio', 'prefiero en español', 'no me sirve'];
const dialog = document.getElementById('video');

function showVideo(id, msg = '') {
  const pick = P.pickVideo(catalog, id, P.rejectedVideos(logs));
  if (!pick) return;
  const { video: v, exhausted } = pick, e = catalog.exercises[id], name = e.name;
  dialog.innerHTML = `<form method="dialog" class="vhead"><h3>${esc(name)}</h3><button aria-label="Cerrar">✕</button></form>
    ${e.cue ? `<p>${esc(e.cue)}</p>` : ''}
    ${msg}
    <div class="vframe"><iframe src="https://www.youtube-nocookie.com/embed/${v.id}" title="${esc(v.title ?? name)}" allow="encrypted-media; picture-in-picture" allowfullscreen></iframe></div>
    <p class="target">${esc([v.title, v.channel].filter(Boolean).join(' · '))} · <a href="https://www.youtube.com/shorts/${v.id}" target="_blank" rel="noopener">Abrir en YouTube</a></p>
    ${exhausted ? '<p class="warn">No hay más opciones. Exportá y pedile a Claude videos nuevos.</p>' : `
    <details><summary>Otro video</summary>
      <p class="lbl">¿Por qué? (opcional)</p>
      <div class="pills">${REASONS.map(r => `<label class="pill"><input type="radio" name="reason" value="${r}"><span>${r}</span></label>`).join('')}</div>
      <textarea id="vnote" rows="1" placeholder="Nota" aria-label="Nota"></textarea>
      <button type="button" id="vnext">Mostrar otro</button>
    </details>`}`;
  dialog.querySelector('#vnext')?.addEventListener('click', () => {
    save(`${P.today()}|_video:${v.id}`, {
      exercise: name, ex: id, video_id: v.id,
      reason: dialog.querySelector('input[name=reason]:checked')?.value ?? null,
      note: dialog.querySelector('#vnote').value || null,
      created_at: new Date().toISOString(),
    });
    showVideo(id);
  });
  if (!dialog.open) dialog.showModal();
}
main.addEventListener('click', e => {
  const b = e.target.closest('.play');
  if (b) { e.preventDefault(); showVideo(b.dataset.video); } // preventDefault: que no abra/cierre el ejercicio
  if (e.target.id === 'seen') { ls.set('seenChange', e.target.dataset.at); e.target.closest('.changes').remove(); }
  if (e.target.matches('.done-all')) {
    const card = e.target.closest('[data-key]'), key = card.dataset.key;
    save(key, P.confirmItem(itemByKey(key), serialize(card)));
    popKey = key;
    renderDay(key.slice(0, 10));
  }
});
// Cerrar corta la reproducción.
dialog.addEventListener('close', () => { dialog.innerHTML = ''; });

async function exportLogs() {
  const from = main.querySelector('#exfrom').value || plan.days[0].date, to = main.querySelector('#exto').value || P.today();
  if (from > to) return renderPlan('<p class="error">"Desde" es posterior a "Hasta".</p>');
  const data = JSON.stringify(P.buildExport(plan, logs, from, to, planId), null, 1);
  let copied = false;
  try { await navigator.clipboard.writeText(data); copied = true; } catch { /* sin permiso de portapapeles: queda la descarga */ }
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([data], { type: 'application/json' })), download: `treino-export-${from}_${to}.json` });
  a.click();
  URL.revokeObjectURL(a.href);
  renderPlan(`<p class="ok">${copied ? 'Copiado al portapapeles y descargado.' : 'Descargado.'} Pegáselo a Claude con tu comentario.</p>`);
}

async function renderAnalysis() {
  const t = P.today();
  const pain = P.painSeries(plan, logs, t);
  const ad = P.adherence(plan, logs, t);
  const pct = r => Math.round(100 * r.done / r.planned);
  main.innerHTML = `
    <section class="card"><header><h3>Dolor</h3></header>
      <p class="target">▲ = día con impacto · punto rojo = hinchazón a la mañana · línea punteada = máximo permitido (${plan.rules?.max_pain ?? 3})</p>
      ${pain.length ? '<div class="chart"><canvas id="c-pain"></canvas></div>' : '<p>Todavía no hay datos.</p>'}
    </section>
    <section class="card"><header><h3>Cumplimiento por semana</h3></header>
      ${ad.week.length ? '<div class="chart"><canvas id="c-week"></canvas></div>' : '<p>Todavía no hay datos.</p>'}
    </section>
    <section class="card"><header><h3>Cumplimiento por etapa</h3></header>
      <table>${ad.stage.map(r => `<tr><td>${esc(r.key)}</td><td>${+r.done.toFixed(1)} / ${r.planned}</td><td><b>${pct(r)}%</b></td></tr>`).join('')}</table>
    </section>`;
  if (!pain.length && !ad.week.length) return;
  let Chart;
  try { ({ default: Chart } = await import('https://cdn.jsdelivr.net/npm/chart.js@4.4.4/auto/+esm')); }
  catch { return main.insertAdjacentHTML('afterbegin', '<p class="error">No se pudieron cargar los gráficos (sin conexión).</p>'); }
  const css = getComputedStyle(document.documentElement);
  const fg = css.getPropertyValue('--muted').trim(), tok = n => css.getPropertyValue(n).trim();
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
  Chart.defaults.color = fg;
  Chart.defaults.borderColor = css.getPropertyValue('--line').trim();
  const max = plan.rules?.max_pain ?? 3;
  if (pain.length) new Chart(main.querySelector('#c-pain'), {
    type: 'line',
    data: {
      labels: pain.map(r => (r.impact ? '▲' : '') + fmtDate(r.date, { day: 'numeric', month: 'numeric' })),
      datasets: [
        { label: 'Durante', data: pain.map(r => r.during), borderColor: tok('--info'), backgroundColor: tok('--info'), spanGaps: true },
        { label: 'Mañana siguiente', data: pain.map(r => r.morning), borderColor: tok('--warn'), spanGaps: true,
          pointBackgroundColor: pain.map(r => r.swelling ? tok('--danger') : tok('--warn')), pointRadius: pain.map(r => r.swelling ? 6 : 3) },
        { label: 'Máximo', data: pain.map(() => max), borderColor: fg, borderDash: [4, 4], pointRadius: 0 },
      ],
    },
    options: { maintainAspectRatio: false, scales: { y: { min: 0, max: 10, ticks: { stepSize: 1 } } } },
  });
  if (ad.week.length) new Chart(main.querySelector('#c-week'), {
    type: 'bar',
    data: { labels: ad.week.map(r => fmtDate(r.key, { day: 'numeric', month: 'short' })), datasets: [{ label: '% hecho', data: ad.week.map(pct), backgroundColor: tok('--accent'), borderRadius: 4 }] },
    options: { maintainAspectRatio: false, scales: { y: { min: 0, max: 100 } }, plugins: { legend: { display: false } } },
  });
}

// Detalle imprimible de las sesiones gym/run/field; en Android Chrome window.print() permite "Guardar como PDF".
let printWeeks = 1, printFrom = null;
function renderPrint() {
  printFrom ??= P.today() < plan.days[0].date ? plan.days[0].date : P.today();
  const fd = d => `${fmtDate(d, { weekday: 'short' }).replace('.', '')} ${fmtDate(d, { day: '2-digit', month: '2-digit', year: 'numeric' })}`;
  const LABEL = { gym: 'Gimnasio', run: 'Trote', field: 'Campo' };
  const sessions = P.printSessions(plan, printFrom, printWeeks);
  const td = (...cells) => cells.map(c => `<td>${c ?? ''}</td>`).join('') + '<td></td>';
  const small = t => t ? `<br><small>${esc(t)}</small>` : '';
  const side = x => x.per_side ? ' por lado' : '';
  const gymRows = ex => ex.flatMap(x => Array.isArray(x.sets)
    ? x.sets.map((s, j) => `<tr>${td(j ? '' : esc(x.name) + small(x.notes), j + 1, esc((s.reps ?? s.time ?? x.reps ?? x.time ?? '') + side(x)), esc(s.weight ?? x.weight ?? '–'), esc(x.rest))}</tr>`)
    : [`<tr>${td(esc(x.name) + small(x.notes), x.sets, esc((x.reps ?? x.time ?? '') + side(x)), esc(x.weight ?? '–'), esc(x.rest))}</tr>`]);
  const stepRows = (steps, depth = 0) => steps.flatMap(s => s.repeat
    ? [`<tr><td colspan="5" style="padding-left:${6 + depth * 18}px"><b>${s.repeat} veces:</b></td></tr>`, ...stepRows(s.steps, depth + 1)]
    : [`<tr><td style="padding-left:${6 + depth * 18}px">${esc(s.do)}${small(s.notes)}</td>${td(
      esc([s.sets && `${s.sets} ×`, s.reps].filter(Boolean).join(' ') + side(s)),
      esc([s.time, s.distance].filter(Boolean).join(' · ')),
      esc([s.intensity, s.pace && `${s.pace}/km`].filter(Boolean).join(' · ')))}</tr>`]);
  main.innerHTML = `<article class="print">
    <div class="noprint card">
      <div class="row">
        <label class="inline">Rango <select id="pweeks">${[[1, '1 semana'], [2, '2 semanas'], [3, '3 semanas'], [0, 'Todo el plan']].map(([v, l]) => `<option value="${v}" ${v === printWeeks ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label class="inline">Desde <input type="date" id="pfrom" value="${printFrom}" ${printWeeks ? '' : 'disabled'}></label>
      </div>
      <div class="actions"><button onclick="print()" ${sessions.length ? '' : 'disabled'}>Imprimir / Guardar PDF</button><a class="button ghost" href="#/plan">Volver</a></div>
    </div>
    <div class="sheet">
    ${sessions.length ? `<h1>Calendario del ${esc(fd(sessions[0].date))} al ${esc(fd(sessions.at(-1).date))}</h1>
    <p class="target">Gimnasio, trote y campo · ${sessions.length} sesiones</p>` : '<p class="error">No hay sesiones de gimnasio, trote o campo en ese rango.</p>'}
    ${sessions.map(i => {
      const meta = [i.stage, i.notes, i.type === 'run' && `${P.runMinutes(i.steps)}' de trote`].filter(Boolean).map(esc).join(' · ');
      return `<section class="session">
        <h2>${LABEL[i.type]} · ${esc(fd(i.date))}${i.title.toLowerCase() !== LABEL[i.type].toLowerCase() ? ` — ${esc(i.title)}` : ''}</h2>
        ${meta ? `<small>${meta}</small>` : ''}
        <div class="tablewrap"><table>${i.type === 'gym'
          ? `<tr><th>Ejercicio</th><th>Series</th><th>Reps/tiempo</th><th>Peso (kg)</th><th>Pausa</th><th class="obs">Observaciones</th></tr>${gymRows(i.exercises).join('')}`
          : `<tr><th>Trabajo</th><th>Series × reps</th><th>Tiempo/distancia</th><th>Intensidad</th><th class="obs">Observaciones</th></tr>${stepRows(i.steps).join('')}`}
        </table></div></section>`;
    }).join('')}
    </div>
  </article>`;
  main.querySelector('#pweeks').onchange = e => { printWeeks = +e.target.value; renderPrint(); };
  main.querySelector('#pfrom').onchange = e => { if (e.target.value) printFrom = e.target.value; renderPrint(); };
}

// ---------- Ayuda ----------
// Markdown mínimo de ayuda.md: cada "## " es una sección desplegable; listas (con un nivel de sangría), **negrita** y *cursiva*.

function md(src) {
  const inline = s => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\*(.+?)\*/g, '<em>$1</em>');
  let html = '', depth = 0;
  const closeLists = (to = 0) => { while (depth > to) { html += '</li></ul>'; depth--; } };
  for (const line of src.split(/\r?\n/)) {
    const li = /^(\s*)- (.*)$/.exec(line);
    if (li) {
      const d = li[1].length >= 2 ? 2 : 1;
      if (d > depth) html += '<ul><li>'; else { closeLists(d); html += '</li><li>'; }
      depth = d;
      html += inline(li[2]);
      continue;
    }
    closeLists();
    if (line.startsWith('# ')) html += `<h2 class="helptitle">${inline(line.slice(2))}</h2>`;
    else if (line.startsWith('## ')) html += `${html.includes('<details') ? '</details>' : ''}<details class="card help"><summary><h3>${inline(line.slice(3))}</h3></summary>`;
    else if (line.trim()) html += `<p>${inline(line)}</p>`;
  }
  closeLists();
  return html + (html.includes('<details') ? '</details>' : '');
}

async function renderHelp() {
  main.innerHTML = '<p class="center muted">Cargando…</p>';
  try { main.innerHTML = md(await text('ayuda.md')); main.querySelector('details')?.setAttribute('open', ''); }
  catch { main.innerHTML = '<p class="error">No se pudo cargar la ayuda (¿sin conexión?).</p>'; }
}

// ---------- Crear rutina a mano ----------
// Borrador en memoria con la misma forma que un item; solo ejercicios del catálogo. Guardar crea una versión nueva de la rutina.

const TLABEL = { gym: 'Gimnasio', run: 'Trote', field: 'Campo', check: 'Check' };
const FL = { time: 'Tiempo', distance: 'Distancia', reps: 'Reps', sets: 'Series', intensity: 'Intensidad' };
const WD = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];
let draft = null;
const newDraft = (type, keep = {}) => ({ date: P.today(), days: [], weeks: 4, mode: 'add', name: '', ...keep, type, title: TLABEL[type], exercises: [], steps: [], target: -1, q: '', group: '' });
const at = path => path.split('.').reduce((o, k) => o[k], draft);

const ctl = (path, v, { t = '', ph = '', type = 'text' } = {}) =>
  `<input type="${type}" data-f="${path}" ${t ? `data-t="${t}"` : ''} value="${esc(v ?? '')}" placeholder="${ph}" class="short" ${type === 'number' ? 'inputmode="numeric" min="1"' : ''}>`;
const moveBtns = (list, i) => `<span class="mv">
  <button type="button" class="icon" data-act="up" data-l="${list}" data-i="${i}" aria-label="Subir">↑</button>
  <button type="button" class="icon" data-act="down" data-l="${list}" data-i="${i}" aria-label="Bajar">↓</button>
  <button type="button" class="icon" data-act="del" data-l="${list}" data-i="${i}" aria-label="Quitar">✕</button></span>`;

const gymDraft = d => d.exercises.length ? `<ol class="drafted">${d.exercises.map((e, i) => `<li>
  <div class="drow"><b>${esc(e.name)}</b>${moveBtns('exercises', i)}</div>
  <div class="row">
    <label class="inline">Series ${ctl(`exercises.${i}.sets`, e.sets, { t: 'int', type: 'number' })}</label>
    <label class="inline">Reps ${ctl(`exercises.${i}.reps`, e.reps, { t: 'reps', ph: '8-10' })}</label>
    <label class="inline">Tiempo ${ctl(`exercises.${i}.time`, e.time, { ph: '30s' })}</label>
    <label class="inline">Kg ${ctl(`exercises.${i}.weight`, e.weight, { t: 'num', ph: '–' })}</label>
    <label class="chk"><input type="checkbox" data-f="exercises.${i}.per_side" ${e.per_side ? 'checked' : ''}><span>Por lado</span></label>
  </div>
  <input data-f="exercises.${i}.notes" value="${esc(e.notes ?? '')}" placeholder="Notas" class="wide" aria-label="Notas">
</li>`).join('')}</ol>` : '<p class="muted">Agregá ejercicios del catálogo.</p>';

const stepRow = (s, list, i) => `<li><div class="drow"><b>${esc(s.do)}</b>${moveBtns(list, i)}</div>
  <div class="row">${Object.entries(FL).map(([f, l]) => `<label class="inline">${l} ${ctl(`${list}.${i}.${f}`, s[f], f === 'sets' ? { t: 'int', type: 'number' } : f === 'reps' ? { t: 'reps' } : {})}</label>`).join('')}</div></li>`;

const stepsDraft = d => `${d.steps.length ? `<ol class="drafted">${d.steps.map((s, i) => s.repeat ? `<li class="block${d.target === i ? ' on' : ''}">
    <div class="drow"><label class="inline">Repetir ${ctl(`steps.${i}.repeat`, s.repeat, { t: 'int', type: 'number' })} veces</label>${moveBtns('steps', i)}</div>
    ${s.steps.length ? `<ol>${s.steps.map((x, j) => stepRow(x, `steps.${i}.steps`, j)).join('')}</ol>` : '<p class="muted">Bloque vacío.</p>'}
    <button type="button" class="link" data-act="target" data-i="${d.target === i ? -1 : i}">${d.target === i ? 'Listo con este bloque' : 'Agregar pasos a este bloque'}</button>
  </li>` : stepRow(s, 'steps', i)).join('')}</ol>` : '<p class="muted">Agregá pasos del catálogo.</p>'}
  <button type="button" class="ghostbtn" data-act="block">+ Bloque "Repetir N veces"</button>`;

function pickList() {
  const d = draft, kinds = d.type === 'gym' ? ['gym'] : ['run', 'field'], q = d.q.trim().toLowerCase();
  const list = Object.entries(catalog?.exercises ?? {}).filter(([, e]) => kinds.includes(e.kind) && (!d.group || e.group === d.group) && (!q || e.name.toLowerCase().includes(q)));
  return list.length ? list.map(([id, e]) => `<button type="button" class="pick" data-act="add" data-id="${esc(id)}">+ ${esc(e.name)}<small>${esc(e.group ?? '')}</small></button>`).join('')
    : `<p class="muted">${catalog ? 'Nada coincide con la búsqueda.' : 'El catálogo no está cargado: abrí la app con señal.'}</p>`;
}

function picker(d) {
  const kinds = d.type === 'gym' ? ['gym'] : ['run', 'field'];
  const groups = [...new Set(Object.values(catalog?.exercises ?? {}).filter(e => kinds.includes(e.kind)).map(e => e.group).filter(Boolean))].sort();
  return `<div class="picker">
    <p class="lbl">Agregar ${d.type === 'gym' ? 'ejercicio' : d.target >= 0 ? `paso al bloque ${d.target + 1}` : 'paso'}</p>
    <div class="row"><input type="search" id="cq" placeholder="Buscar" value="${esc(d.q)}" aria-label="Buscar en el catálogo">
      <select id="cg" aria-label="Grupo"><option value="">Todos</option>${groups.map(g => `<option ${g === d.group ? 'selected' : ''}>${esc(g)}</option>`).join('')}</select></div>
    <div id="cres">${pickList()}</div></div>`;
}

function renderCreator(msg = '') {
  const d = draft ??= newDraft('gym');
  main.innerHTML = `<div id="creator">${msg}
    <section class="card"><header><h3>Crear rutina</h3></header>
      <div class="pills">${Object.entries(TLABEL).map(([t, l]) => `<label class="pill"><input type="radio" name="ctype" value="${t}" data-act="type" ${d.type === t ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div>
      <div class="row">
        <label class="inline">Fecha <input type="date" data-f="date" value="${d.date}"></label>
        <label class="inline">Título <input data-f="title" value="${esc(d.title)}" class="wide"></label>
      </div>
      ${plan ? '' : `<label class="inline">Nombre de la rutina <input data-f="name" value="${esc(d.name)}" placeholder="Mi rutina" class="wide"></label>`}
      ${d.type === 'gym' ? gymDraft(d) : d.type === 'check' ? '' : stepsDraft(d)}
      ${d.type === 'check' ? '' : picker(d)}
    </section>
    <section class="card"><header><h3>Repetir</h3></header>
      <p class="target">Elegí días de la semana para repetirla desde la fecha. Sin días, se crea solo esa fecha.</p>
      <div class="pills">${WD.map((w, i) => `<label class="pill"><input type="checkbox" data-wd="${i}" ${d.days.includes(i) ? 'checked' : ''}><span>${w}</span></label>`).join('')}</div>
      <label class="inline">Durante ${ctl('weeks', d.weeks, { t: 'int', type: 'number' })} semanas</label>
      <div id="csum"></div>
      <div class="actions"><button type="button" data-act="save">Guardar en la rutina</button><a class="button ghost" href="#/plan">Cancelar</a></div>
    </section></div>`;
  creatorSummary();
}

function creatorSummary() {
  const d = draft, dates = P.repeatDates(d.date, d.days, d.weeks);
  const busy = dates.filter(x => P.dayOf(plan ?? { days: [] }, x)?.items.length);
  const fd = x => fmtDate(x, { weekday: 'short', day: 'numeric', month: 'numeric' });
  main.querySelector('#csum').innerHTML = `<p>Se crea en ${dates.length === 1 ? '1 día' : `${dates.length} días`}: ${dates.slice(0, 8).map(x => esc(fd(x))).join(', ')}${dates.length > 8 ? ` y ${dates.length - 8} más` : ''}.</p>
    ${busy.length ? `<p class="warn">${busy.length === 1 ? '1 de esos días ya tiene' : `${busy.length} de esos días ya tienen`} algo en la rutina:</p>
      ${radios('c', 'mode', d.mode, [['add', 'Agregar'], ['replace', 'Reemplazar']]).replace(/data-p=/g, 'data-f=')}
      <p class="target">Lo que ya tiene registros no se reemplaza nunca.</p>` : ''}`;
}

function setDraft(el) {
  const ks = el.dataset.f.split('.'), o = ks.slice(0, -1).reduce((o, k) => o[k], draft);
  let v = el.type === 'checkbox' ? el.checked : el.value.trim();
  if (el.dataset.t === 'int') v = v === '' ? null : parseInt(v) || null;
  else if (el.dataset.t === 'num') v = v === '' || isNaN(v.replace(',', '.')) ? null : Number(v.replace(',', '.'));
  else if (el.dataset.t === 'reps' && /^\d+$/.test(v)) v = Number(v);
  o[ks.at(-1)] = v;
  if (['date', 'weeks'].includes(el.dataset.f)) creatorSummary();
}

function creatorAct(el) {
  const d = draft, act = el.dataset.act;
  if (act === 'type') draft = newDraft(el.value, { date: d.date, days: d.days, weeks: d.weeks, mode: d.mode, name: d.name });
  if (act === 'add') {
    const e = catalog.exercises[el.dataset.id], { weight, ...rest } = e.defaults ?? {};
    if (d.type === 'gym') d.exercises.push({ ex: el.dataset.id, name: e.name, sets: 3, ...e.defaults });
    else (d.target >= 0 ? d.steps[d.target].steps : d.steps).push({ ex: el.dataset.id, do: e.name, ...rest });
  }
  if (['up', 'down', 'del'].includes(act)) {
    const list = at(el.dataset.l), i = +el.dataset.i, j = act === 'up' ? i - 1 : i + 1;
    if (act === 'del') list.splice(i, 1);
    else if (j >= 0 && j < list.length) [list[i], list[j]] = [list[j], list[i]];
    if (el.dataset.l === 'steps') d.target = -1; // los índices de bloque cambiaron
  }
  if (act === 'block') { d.steps.push({ repeat: 4, steps: [] }); d.target = d.steps.length - 1; }
  if (act === 'target') d.target = +el.dataset.i;
  if (act === 'save') return saveCreator();
  const y = scrollY;
  renderCreator();
  scrollTo(0, y);
}

async function saveCreator() {
  const d = draft;
  if (d.type === 'gym' && !d.exercises.length) return renderCreator('<p class="error">Agregá al menos un ejercicio.</p>');
  if (['run', 'field'].includes(d.type) && !d.steps.length) return renderCreator('<p class="error">Agregá al menos un paso.</p>');
  const item = P.cleanItem({ type: d.type, title: d.title || TLABEL[d.type], by: 'manual', ...(d.type === 'gym' ? { exercises: d.exercises } : d.type === 'check' ? {} : { steps: d.steps }) });
  const dates = P.repeatDates(d.date, d.days, d.weeks);
  const p = P.mergeItems(plan, dates, item, d.mode, logs, d.name || 'Mi rutina');
  const err = P.validatePlan(p);
  if (err.length) return renderCreator(`<p class="error">Revisá la sesión:<br>${err.map(esc).join('<br>')}</p>`);
  const error = await savePlan(p);
  if (error) return renderCreator(`<p class="error">No se pudo guardar (¿sin conexión?): ${esc(error.message)}</p>`);
  draft = null;
  location.hash = `#/d/${dates[0]}`;
}

main.addEventListener('input', e => {
  if (!e.target.closest('#creator')) return;
  if (e.target.id === 'cq') { draft.q = e.target.value; main.querySelector('#cres').innerHTML = pickList(); }
  else if (e.target.dataset.f && e.target.type !== 'radio' && e.target.type !== 'checkbox') setDraft(e.target);
});
main.addEventListener('change', e => {
  if (!e.target.closest('#creator')) return;
  const el = e.target;
  if (el.id === 'cg') { draft.group = el.value; main.querySelector('#cres').innerHTML = pickList(); }
  else if (el.dataset.act === 'type') creatorAct(el);
  else if (el.dataset.wd) { const i = +el.dataset.wd; draft.days = el.checked ? [...draft.days, i].sort() : draft.days.filter(x => x !== i); creatorSummary(); }
  else if (el.type === 'radio' && el.dataset.f === 'mode') draft.mode = el.value;
  else if (el.dataset.f) setDraft(el);
});
main.addEventListener('click', e => {
  const el = e.target.closest('#creator button[data-act]');
  if (el) creatorAct(el);
});

function renderLogin(msg = '') {
  main.innerHTML = `<form class="card" id="login">
    <header><h3>Entrar</h3></header>
    ${msg}
    <label>Email <input type="email" name="email" autocomplete="username" required></label>
    <label>Contraseña <input type="password" name="password" autocomplete="current-password" required></label>
    <button>Entrar</button>
  </form>`;
  main.querySelector('#login').onsubmit = async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    const { error } = await sb.auth.signInWithPassword({ email: f.get('email'), password: f.get('password') });
    if (error) renderLogin(`<p class="error">${esc(error.message)}</p>`);
  };
}

function route() {
  const h = location.hash.slice(1) || '/';
  document.querySelectorAll('#tabs a').forEach(a => a.classList.toggle('on', a.getAttribute('href') === '#' + (/^\/[ds]\//.test(h) ? '/' : h)));
  document.getElementById('tabs').hidden = !user;
  if (!user) return renderLogin();
  if (h === '/ayuda') return renderHelp();
  if (h === '/crear') return renderCreator();
  if (!plan || h === '/plan') return renderPlan();
  if (h === '/analisis') return renderAnalysis();
  if (h === '/imprimir') return renderPrint();
  const m = /^\/([ds])\/(\d{4}-\d{2}-\d{2})$/.exec(h);
  if (m ? m[1] === 's' : ls.get('view', 'hoy') === 'semana') return renderWeek(m ? m[2] : P.today());
  renderDay(m ? m[2] : P.today());
}
addEventListener('hashchange', route);
main.addEventListener('click', e => { const v = e.target.closest('[data-view]'); if (v) ls.set('view', v.dataset.view); });

sb.auth.onAuthStateChange((event, session) => {
  const was = user?.id;
  user = session?.user ?? null;
  if (user?.id === was) return;
  route();
  // setTimeout: llamar a Supabase dentro de este callback puede trabarse (supabase-js).
  if (user) setTimeout(() => pull().then(() => { if (!main.contains(document.activeElement)) route(); flush(); }).catch(syncBadge));
});

if ('serviceWorker' in navigator) {
  // Si había una versión vieja controlando la página, recargar apenas toma el control la nueva.
  const had = navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => had && location.reload());
  navigator.serviceWorker.register('sw.js');
}
syncBadge();
