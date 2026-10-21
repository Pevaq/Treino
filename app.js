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
let user = null, plan = ls.get('plan', null), logs = ls.get('logs', {}), queue = ls.get('queue', []);

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
  const { data: pl, error } = await sb.from('plans').select('data').order('created_at', { ascending: false }).limit(1);
  if (error) throw error;
  const fresh = {};
  for (const r of rows) fresh[`${r.date}|${r.item_id}`] = r.data;
  for (const k of queue) fresh[k] = logs[k]; // lo no subido todavía gana
  logs = fresh;
  plan = pl[0]?.data ?? null;
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
  document.getElementById('sync').textContent = n ? `⟳ ${n} sin subir` : '✓';
}

addEventListener('online', flush);
setInterval(flush, 30000);

// ---------- Inputs ----------
// Cada input lleva data-p con la ruta dentro del log del card (ej. "ex.0.sets.1.kg").
// Al cambiar algo se re-arma el log entero del card leyendo sus inputs.

const num = (p, v, ph = '', cls = '') => `<input type="number" inputmode="decimal" step="any" min="0" class="${cls}" data-p="${p}" value="${v ?? ''}" placeholder="${esc(ph)}" aria-label="${esc(ph)}">`;
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
  save(key, serialize(card));
  const prog = card.querySelector('.prog');
  if (prog) prog.textContent = progText(itemByKey(key), logs[key]);
  if (e.target.matches('textarea')) grow(e.target);
}
main.addEventListener('change', onEdit);
main.addEventListener('input', e => e.target.matches('textarea, input[type=number]') && onEdit(e));

const grow = t => { t.style.height = 'auto'; t.style.height = t.scrollHeight + 'px'; };
const itemByKey = key => { const [date, id] = key.split('|'); return P.dayOf(plan, date)?.items.find(i => i.id === id); };
const progText = (item, log) => { if (!item) return ''; const [d, t] = P.itemProgress(item, log); return `${+d.toFixed(1)}/${t}`; };

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

function gymBody(item, log, date) {
  return item.exercises.map((ex, i) => {
    const l = log?.ex?.[i];
    const last = P.lastWeight(logs, ex.name, date);
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
    return `<div class="ex">
      <input type="hidden" data-p="ex.${i}.name" value="${esc(ex.name)}">
      <h4>${esc(ex.name)}</h4>
      <p class="target">${exerciseTarget(ex)}${ex.notes ? ` · <em>${esc(ex.notes)}</em>` : ''}</p>
      ${rows}
      <details ${l?.note || l?.pain != null ? 'open' : ''}><summary>Nota / dolor</summary>${pain(`ex.${i}.pain`, l?.pain)}${note(`ex.${i}.note`, l?.note)}</details>
    </div>`;
  }).join('');
}

function stepsBody(item, log) {
  const steps = item.steps.map((s, i) => {
    const l = log?.steps?.[i];
    if (!s.repeat) return `<li>${chk(`steps.${i}.done`, l?.done, stepText(s))}</li>`;
    return `<li class="repeat">
      ${chk(`steps.${i}.done`, l?.done, `<b>${s.repeat} ×</b>`)}
      <ul>${s.steps.map(x => `<li>${x.repeat ? `${x.repeat} × ` : ''}${stepText(x)}</li>`).join('')}</ul>
      <label class="inline">Completadas ${num(`steps.${i}.completed`, l?.completed, String(s.repeat), 'short')} de ${s.repeat}</label>
    </li>`;
  }).join('');
  return `<ul class="steps">${steps}</ul>
    <div class="row"><label class="inline">Tiempo total ${num('time', log?.time, 'min', 'short')} min</label>${pain('pain', log?.pain, 'Dolor durante')}</div>
    ${note('note', log?.note)}`;
}

function itemCard(item, date) {
  const key = `${date}|${item.id}`, log = logs[key];
  const badges = [item.stage, item.impact && '⚡ impacto', item.competitive && 'competitivo'].filter(Boolean).map(b => `<span class="badge">${esc(b)}</span>`).join('');
  let body;
  if (item.type === 'check') body = chk('done', log?.done, 'Hecho');
  else if (item.type === 'match') body = `
    ${item.minutes ? `<p class="target">Minutos planificados: ${esc(item.minutes)}</p>` : ''}
    ${chk('done', log?.done, 'Jugado')}
    <div class="row"><label class="inline">Minutos jugados ${num('minutes', log?.minutes, 'min', 'short')}</label>${pain('pain', log?.pain, 'Dolor durante')}</div>
    ${note('note', log?.note)}`;
  else if (item.type === 'gym') body = gymBody(item, log, date);
  else body = stepsBody(item, log);
  return `<section class="card" data-key="${esc(key)}">
    <header><h3>${esc(item.title)}</h3><span class="prog">${progText(item, log)}</span></header>
    ${badges ? `<div>${badges}</div>` : ''}
    ${item.notes ? `<p class="target"><em>${esc(item.notes)}</em></p>` : ''}
    ${body}
  </section>`;
}

function morningCard(date) {
  const key = `${date}|_morning`, m = logs[key] ?? {};
  const done = m.skipped || (m.swelling && m.pain != null && m.trend);
  return `<section class="card morning ${done ? 'ok' : ''}" data-key="${esc(key)}">
    <header><h3>☀️ Chequeo de la mañana</h3><span class="prog">${done ? '✓' : 'pendiente'}</span></header>
    <p class="target">Después del impacto de ayer. Prueba: ${esc(plan.rules?.morning_check ?? 'bajada lenta de escalón')}</p>
    <p class="lbl">¿Hinchazón?</p>${radios(key, 'swelling', m.swelling, [['no', 'No'], ['si', 'Sí']])}
    <p class="lbl">Dolor en la prueba</p>
    <div class="pills scale">${[...Array(11).keys()].map(n => `<label class="pill"><input type="radio" name="${esc(key)}pain" data-p="pain" data-t="num" value="${n}" ${m.pain === n ? 'checked' : ''}><span>${n}</span></label>`).join('')}</div>
    <p class="lbl">Comparado con antes</p>${radios(key, 'trend', m.trend, [['mejor', 'Mejor'], ['igual', 'Igual'], ['peor', 'Peor']])}
    ${chk('skipped', m.skipped, 'Ayer no entrené (no aplica)')}
  </section>`;
}

function renderDay(date) {
  const isToday = date === P.today();
  const day = P.dayOf(plan, date);
  const next = plan.days.find(d => d.date > date);
  const dl = logs[`${date}|_day`] ?? {};
  main.innerHTML = `
    <nav class="daynav">
      <a href="#/d/${P.addDays(date, -1)}" aria-label="Día anterior">‹</a>
      <div><b>${isToday ? 'Hoy' : esc(fmtDate(date, { weekday: 'long' }))}</b><small>${esc(fmtDate(date, { day: 'numeric', month: 'long', year: 'numeric' }))}</small></div>
      <a href="#/d/${P.addDays(date, 1)}" aria-label="Día siguiente">›</a>
    </nav>
    ${!isToday ? `<p class="center"><a href="#/">Volver a hoy</a></p>` : ''}
    ${P.morningRequired(plan, date) ? morningCard(date) : ''}
    ${day ? day.items.map(i => itemCard(i, date)).join('') : `<section class="card center"><h3>Descanso</h3>
      ${next ? `<p>Próximo: <a href="#/d/${next.date}">${esc(fmtDate(next.date))}</a> · ${next.items.map(i => esc(i.title)).join(', ')}</p>` : '<p>No hay más días en la rutina.</p>'}</section>`}
    ${day ? `<section class="card" data-key="${esc(date)}|_day">
      <header><h3>Cierre del día</h3></header>
      ${radios(date, 'status', dl.status, [['hecho', 'Hecho'], ['parcial', 'Parcial'], ['no hecho', 'No hecho']])}
      ${note('note', dl.note, 'Cómo me sentí, qué cambié…')}
    </section>` : ''}`;
  main.querySelectorAll('textarea').forEach(grow);
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
      <span class="titles">${d.items.map(i => esc(i.title)).join(' · ')}${mMissing ? ' <span class="warn" title="Falta el chequeo de la mañana siguiente">☀️?</span>' : ''}</span>
      <span class="pct">${status ? esc(status) : d.date <= t ? pct + '%' : ''}</span>
    </a>`;
  }).join('') : '';
  main.innerHTML = `
    ${msg}
    <section class="card">
      <header><h3>${plan ? esc(plan.name) : 'Sin rutina cargada'}</h3></header>
      ${plan ? `<p class="target">${esc(fmtDate(plan.days[0].date))} → ${esc(fmtDate(plan.days.at(-1).date))}</p>
        <button id="export">Exportar lo hecho (copiar + descargar)</button>
        <a class="button" href="#/imprimir">PDF para el profesional</a>` : ''}
      <details ${plan ? '' : 'open'}><summary>Cargar rutina nueva</summary>
        <p class="target">Elegí el archivo .json o pegá su contenido. Reemplaza la rutina vigente; lo ya registrado se conserva.</p>
        <input type="file" id="file" accept=".json,application/json">
        <textarea id="paste" rows="4" placeholder='{"version":1, ...}'></textarea>
        <button id="load">Cargar</button>
      </details>
    </section>
    ${rows ? `<section class="card list">${rows}</section>` : ''}
    <p class="center"><button class="link" id="logout">Cerrar sesión</button></p>`;
  main.querySelector('#today')?.scrollIntoView({ block: 'center' });
  main.querySelector('#file').onchange = async e => { main.querySelector('#paste').value = await e.target.files[0]?.text() ?? ''; };
  main.querySelector('#load').onclick = loadPlan;
  main.querySelector('#logout').onclick = async () => {
    const n = new Set(queue).size;
    if (n && !confirm(`Hay ${n} registros sin subir y se van a perder. ¿Salir igual?`)) return;
    await sb.auth.signOut();
    logs = {}; queue = []; plan = null;
    ['logs', 'queue', 'plan'].forEach(k => localStorage.removeItem(k));
    route();
  };
  const ex = main.querySelector('#export');
  if (ex) ex.onclick = exportLogs;
}

async function loadPlan() {
  let p;
  try { p = JSON.parse(main.querySelector('#paste').value); } catch (e) { return renderPlan(`<p class="error">JSON inválido: ${esc(e.message)}</p>`); }
  const err = P.validatePlan(p);
  if (err.length) return renderPlan(`<p class="error">La rutina tiene errores:<br>${err.map(esc).join('<br>')}</p>`);
  if (plan && !confirm(`¿Reemplazar "${plan.name}" por "${p.name}"?`)) return;
  const { error } = await sb.from('plans').insert({ user_id: user.id, name: p.name, data: p });
  if (error) return renderPlan(`<p class="error">No se pudo guardar (¿sin conexión?): ${esc(error.message)}</p>`);
  plan = p;
  ls.set('plan', plan);
  const orphan = P.buildExport(plan, logs, '9999-12-31').fuera_del_plan.length;
  renderPlan(`<p class="ok">Rutina "${esc(p.name)}" cargada.${orphan ? ` Hay ${orphan} registros de items que no están en esta rutina: se conservan y salen en el export como "fuera_del_plan".` : ''}</p>`);
}

async function exportLogs() {
  const data = JSON.stringify(P.buildExport(plan, logs, P.today()), null, 1);
  let copied = false;
  try { await navigator.clipboard.writeText(data); copied = true; } catch { /* sin permiso de portapapeles: queda la descarga */ }
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([data], { type: 'application/json' })), download: `treino-export-${P.today()}.json` });
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
      <p class="target">⚡ = día con impacto · punto rojo = hinchazón a la mañana · línea punteada = máximo permitido (${plan.rules?.max_pain ?? 3})</p>
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
  const fg = css.getPropertyValue('--muted').trim();
  Chart.defaults.color = fg;
  Chart.defaults.borderColor = css.getPropertyValue('--line').trim();
  const max = plan.rules?.max_pain ?? 3;
  if (pain.length) new Chart(main.querySelector('#c-pain'), {
    type: 'line',
    data: {
      labels: pain.map(r => (r.impact ? '⚡' : '') + fmtDate(r.date, { day: 'numeric', month: 'numeric' })),
      datasets: [
        { label: 'Durante', data: pain.map(r => r.during), borderColor: '#2a7de1', backgroundColor: '#2a7de1', spanGaps: true },
        { label: 'Mañana siguiente', data: pain.map(r => r.morning), borderColor: '#e0a100', spanGaps: true,
          pointBackgroundColor: pain.map(r => r.swelling ? '#d93025' : '#e0a100'), pointRadius: pain.map(r => r.swelling ? 6 : 3) },
        { label: 'Máximo', data: pain.map(() => max), borderColor: fg, borderDash: [4, 4], pointRadius: 0 },
      ],
    },
    options: { maintainAspectRatio: false, scales: { y: { min: 0, max: 10, ticks: { stepSize: 1 } } } },
  });
  if (ad.week.length) new Chart(main.querySelector('#c-week'), {
    type: 'bar',
    data: { labels: ad.week.map(r => fmtDate(r.key, { day: 'numeric', month: 'short' })), datasets: [{ label: '% hecho', data: ad.week.map(pct), backgroundColor: '#2a9d5c' }] },
    options: { maintainAspectRatio: false, scales: { y: { min: 0, max: 100 } }, plugins: { legend: { display: false } } },
  });
}

// Detalle imprimible de las sesiones gym/run/field; en Android Chrome window.print() permite "Guardar como PDF".
function renderPrint() {
  const fd = d => `${fmtDate(d, { weekday: 'short' }).replace('.', '')} ${fmtDate(d, { day: '2-digit', month: '2-digit', year: 'numeric' })}`;
  const LABEL = { gym: 'Gimnasio', run: 'Trote', field: 'Campo' };
  const sessions = plan.days.flatMap(d => d.items.filter(i => LABEL[i.type]).map(i => ({ date: d.date, ...i })));
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
    <p class="noprint"><button onclick="print()">Imprimir / Guardar PDF</button> <a href="#/plan">Volver</a></p>
    <h1>${esc(plan.name)}</h1>
    <p class="target">${esc(fd(plan.days[0].date))} al ${esc(fd(plan.days.at(-1).date))} · ${sessions.length} sesiones</p>
    ${sessions.map(i => {
      const meta = [i.stage, i.notes, i.type === 'run' && `${P.runMinutes(i.steps)}' de trote`].filter(Boolean).map(esc).join(' · ');
      return `<section class="session">
        <h2>${LABEL[i.type]} · ${esc(fd(i.date))}${i.title.toLowerCase() !== LABEL[i.type].toLowerCase() ? ` — ${esc(i.title)}` : ''}</h2>
        ${meta ? `<small>${meta}</small>` : ''}
        <table>${i.type === 'gym'
          ? `<tr><th>Ejercicio</th><th>Series</th><th>Reps/tiempo</th><th>Peso (kg)</th><th>Pausa</th><th class="obs">Observaciones</th></tr>${gymRows(i.exercises).join('')}`
          : `<tr><th>Trabajo</th><th>Series × reps</th><th>Tiempo/distancia</th><th>Intensidad</th><th class="obs">Observaciones</th></tr>${stepRows(i.steps).join('')}`}
        </table></section>`;
    }).join('')}
  </article>`;
}

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
  document.querySelectorAll('#tabs a').forEach(a => a.classList.toggle('on', a.getAttribute('href') === '#' + (h.startsWith('/d/') ? '/' : h)));
  document.getElementById('tabs').hidden = !user;
  if (!user) return renderLogin();
  if (!plan || h === '/plan') return renderPlan();
  if (h === '/analisis') return renderAnalysis();
  if (h === '/imprimir') return renderPrint();
  renderDay(/^\/d\/\d{4}-\d{2}-\d{2}$/.test(h) ? h.slice(3) : P.today());
}
addEventListener('hashchange', route);

sb.auth.onAuthStateChange((event, session) => {
  const was = user?.id;
  user = session?.user ?? null;
  if (user?.id === was) return;
  route();
  // setTimeout: llamar a Supabase dentro de este callback puede trabarse (supabase-js).
  if (user) setTimeout(() => pull().then(() => { if (!main.contains(document.activeElement)) route(); flush(); }).catch(syncBadge));
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
syncBadge();
