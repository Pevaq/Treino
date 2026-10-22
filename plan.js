// Lógica pura (sin DOM ni red): validación de rutina, progreso, análisis y export.
// Los logs son un objeto { "YYYY-MM-DD|itemId": data }. Ids reservados: _day, _morning.

export const TYPES = ['check', 'match', 'gym', 'run', 'field'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
// Quién armó la rutina. El agente nocturno solo replanifica "claude" (o sin source) y nunca toca items con "by": "manual".
export const SOURCES = ['claude', 'manual', 'ia'];

export const today = () => new Date().toLocaleDateString('sv-SE');

export function addDays(date, n) {
  const t = new Date(date + 'T00:00:00Z');
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

export const weekStart = date => addDays(date, -((new Date(date + 'T00:00:00Z').getUTCDay() + 6) % 7));

export function validatePlan(p) {
  const err = [];
  if (!p || typeof p !== 'object') return ['El archivo no es un objeto JSON'];
  if (p.version !== 1) err.push('"version" tiene que ser 1');
  if (typeof p.name !== 'string' || !p.name) err.push('Falta "name"');
  if (p.source != null && !SOURCES.includes(p.source)) err.push(`"source" tiene que ser ${SOURCES.join(', ')}`);
  if (p.replanned_through != null && (!DATE.test(p.replanned_through) || isNaN(new Date(p.replanned_through)))) err.push('"replanned_through" tiene que ser YYYY-MM-DD');
  if (p.changelog != null && (!Array.isArray(p.changelog) || p.changelog.some(c => isNaN(Date.parse(c?.at)) || typeof c?.summary !== 'string')))
    err.push('"changelog" tiene que ser una lista de { at: fecha ISO, by, summary: texto }');
  if (!Array.isArray(p.days) || !p.days.length) return [...err, 'Falta "days" (lista no vacía)'];
  const ids = new Set();
  let prev = '';
  const steps = (list, where) => {
    if (!Array.isArray(list) || !list.length) return err.push(`${where}: "steps" vacío`);
    list.forEach((s, i) => {
      if (s.repeat != null) {
        if (!Number.isInteger(s.repeat) || s.repeat < 1) err.push(`${where} paso ${i + 1}: "repeat" inválido`);
        steps(s.steps, `${where} paso ${i + 1}`);
      } else if (typeof s.do !== 'string') err.push(`${where} paso ${i + 1}: falta "do"`);
    });
  };
  for (const d of p.days) {
    if (!DATE.test(d?.date) || isNaN(new Date(d.date))) { err.push(`Fecha inválida: ${d?.date}`); continue; }
    if (d.date <= prev) err.push(`Fechas desordenadas o repetidas: ${d.date}`);
    prev = d.date;
    if (!Array.isArray(d.items)) { err.push(`${d.date}: falta "items"`); continue; }
    for (const it of d.items) {
      const where = `${d.date} ${it?.id ?? '?'}`;
      if (typeof it?.id !== 'string' || !it.id || it.id.startsWith('_') || it.id.includes('|')) err.push(`${where}: "id" inválido`);
      else if (ids.has(it.id)) err.push(`${where}: "id" repetido`);
      ids.add(it?.id);
      if (!TYPES.includes(it?.type)) err.push(`${where}: "type" desconocido (${it?.type})`);
      if (typeof it?.title !== 'string') err.push(`${where}: falta "title"`);
      if (it?.type === 'gym') {
        if (!Array.isArray(it.exercises) || !it.exercises.length) err.push(`${where}: "exercises" vacío`);
        else it.exercises.forEach((e, i) => {
          if (typeof e.name !== 'string') err.push(`${where} ejercicio ${i + 1}: falta "name"`);
          if (!(Number.isInteger(e.sets) && e.sets > 0) && !(Array.isArray(e.sets) && e.sets.length)) err.push(`${where} ${e.name}: "sets" inválido`);
        });
      }
      if (it?.type === 'run' || it?.type === 'field') steps(it.steps, where);
    }
  }
  return err.slice(0, 20);
}

export const dayOf = (plan, date) => plan.days.find(d => d.date === date);

// Etapa de cada item: la suya, o la del último item con etapa antes que él (o la primera del plan).
export function stages(plan) {
  const all = plan.days.flatMap(d => d.items);
  let last = all.find(i => i.stage)?.stage ?? 'Sin etapa';
  const m = {};
  for (const i of all) m[i.id] = last = i.stage ?? last;
  return m;
}

export const morningRequired = (plan, date) => !!dayOf(plan, addDays(date, -1))?.items.some(i => i.impact);

export const setsOf = ex => Array.isArray(ex.sets)
  ? ex.sets.map(s => ({ reps: ex.reps, time: ex.time, weight: ex.weight, ...s }))
  : Array.from({ length: ex.sets }, () => ({ reps: ex.reps, time: ex.time, weight: ex.weight }));

// [hecho, total] en unidades: series en gym, pasos en run/field (un repeat parcial cuenta su fracción).
// Un repeat cuenta sus vueltas completadas aunque no esté tildado ("me frené en la vuelta N").
const stepFrac = (s, l) => s.repeat ? Math.min(l?.completed ?? (l?.done ? s.repeat : 0), s.repeat) / s.repeat : l?.done ? 1 : 0;

export function itemProgress(item, log) {
  if (item.type === 'gym') {
    let done = 0, total = 0;
    item.exercises.forEach((ex, i) => setsOf(ex).forEach((_, j) => { total++; if (log?.ex?.[i]?.sets?.[j]?.done) done++; }));
    return [done, total];
  }
  if (item.type === 'run' || item.type === 'field') {
    const done = item.steps.reduce((a, s, i) => a + stepFrac(s, log?.steps?.[i]), 0);
    return [done, item.steps.length];
  }
  return [log?.done ? 1 : 0, 1];
}

const frac = (item, log) => { const [d, t] = itemProgress(item, log); return t ? d / t : 0; };

// Último kg registrado de un ejercicio antes de una fecha. x = { ex, name }: por id del catálogo si ambos lo tienen, si no por nombre.
export function lastWeight(logs, x, before) {
  const keys = Object.keys(logs).filter(k => k < before + '|').sort().reverse();
  for (const k of keys) {
    for (const ex of logs[k]?.ex ?? []) {
      if (x.ex && ex?.ex ? ex.ex !== x.ex : ex?.name !== x.name) continue;
      const kg = (ex.sets ?? []).map(s => s?.kg).filter(v => v != null).at(-1);
      if (kg != null) return kg;
    }
  }
  return null;
}

// Mayor dolor registrado "durante" en el día (partido, sesión o ejercicios de gym).
function painDuring(day, logs) {
  const v = day.items.flatMap(i => {
    const l = logs[`${day.date}|${i.id}`];
    return [l?.pain, ...(l?.ex ?? []).map(e => e?.pain)];
  }).filter(n => n != null);
  return v.length ? Math.max(...v) : null;
}

export function painSeries(plan, logs, until) {
  const dates = new Set(plan.days.map(d => d.date));
  plan.days.forEach(d => d.items.some(i => i.impact) && dates.add(addDays(d.date, 1)));
  return [...dates].filter(d => d <= until).sort().map(date => {
    const day = dayOf(plan, date), m = logs[`${date}|_morning`];
    return {
      date,
      impact: !!day?.items.some(i => i.impact),
      during: day ? painDuring(day, logs) : null,
      morning: m?.pain ?? null,
      swelling: m?.swelling === 'si',
    };
  });
}

export function adherence(plan, logs, until) {
  const st = stages(plan), week = {}, stage = {};
  for (const d of plan.days.filter(d => d.date <= until)) {
    for (const i of d.items) {
      const f = frac(i, logs[`${d.date}|${i.id}`]);
      for (const [m, k] of [[week, weekStart(d.date)], [stage, st[i.id]]]) {
        m[k] ??= { key: k, planned: 0, done: 0 };
        m[k].planned++;
        m[k].done += f;
      }
    }
  }
  return { week: Object.values(week), stage: Object.values(stage) };
}

// Export de lo realizado en [from, to] (inclusive). Los días planificados sin cierre llevan un estado derivado
// de los items (status_auto: true): ninguno hecho → "no hecho", todos → "hecho", si no → "parcial".
export function buildExport(plan, logs, from, to, planId = null) {
  const st = stages(plan), inPlan = new Set(), inRange = d => d >= from && d <= to;
  const dates = new Set(plan.days.map(d => d.date).filter(inRange));
  plan.days.forEach(d => d.items.some(i => i.impact) && inRange(addDays(d.date, 1)) && dates.add(addDays(d.date, 1)));
  const days = [...dates].sort().map(date => {
    const day = dayOf(plan, date), dl = logs[`${date}|_day`];
    inPlan.add(`${date}|_day`).add(`${date}|_morning`);
    const items = (day?.items ?? []).map(i => {
      const k = `${date}|${i.id}`;
      inPlan.add(k);
      const [done, total] = itemProgress(i, logs[k]);
      const exIds = i.type === 'gym' ? i.exercises.map(e => e.ex ?? null) : i.steps?.map(s => s.repeat ? s.steps.map(x => x.ex ?? null) : s.ex ?? null);
      return {
        id: i.id, type: i.type, title: i.title, stage: st[i.id], ...(exIds?.flat().some(Boolean) ? { ex: exIds } : {}), progress: `${+done.toFixed(2)}/${total}`, frac: total ? done / total : 0,
        confirmed_all: !!logs[k]?.confirmed && done === total, stopped_at: stoppedAt(i, logs[k]), log: logs[k] ?? null,
      };
    });
    const auto = !items.length ? null : items.every(i => i.frac === 1) ? 'hecho' : items.some(i => i.frac > 0) ? 'parcial' : 'no hecho';
    const prevImpact = dayOf(plan, addDays(date, -1))?.items.filter(i => i.impact).map(i => i.id) ?? [];
    return {
      date,
      status: dl?.status ?? auto,
      status_auto: !dl?.status && !!auto,
      note: dl?.note ?? null,
      morning_after: prevImpact.length ? prevImpact : null,
      morning: logs[`${date}|_morning`] ?? null,
      items: items.map(({ frac, ...i }) => i),
    };
  });
  const keys = Object.keys(logs).filter(k => inRange(k.slice(0, 10))).sort();
  const outside = keys.filter(k => !inPlan.has(k) && !k.includes('|_video:'))
    .map(k => { const [date, item_id] = k.split('|'); return { date, item_id, log: logs[k] }; });
  const video_feedback = keys.filter(k => k.includes('|_video:')).map(k => ({ date: k.slice(0, 10), ...logs[k] }));
  return { plan: plan.name, plan_id: planId, from, to, exported_at: new Date().toISOString(), rules: plan.rules ?? null, days, fuera_del_plan: outside, video_feedback };
}

// ---------- Resumen para el profesional ----------

const secs = t => { const m = /^\s*(\d+(?:\.\d+)?)\s*(min|s)\s*$/.exec(t ?? ''); return m ? m[1] * (m[2] === 'min' ? 60 : 1) : 0; };
const trotSecs = (steps, mult = 1) => steps.reduce((a, s) =>
  a + (s.repeat ? trotSecs(s.steps, mult * s.repeat) : (s.do ?? '').includes('trote') ? secs(s.time) * mult : 0), 0);
export const runMinutes = steps => Math.round(trotSecs(steps) / 6) / 10;


// Sesiones gym/run/field para el PDF: weeks = 0 → todo el plan; si no, de "from" a from + 7·weeks − 1 inclusive.
export function printSessions(plan, from, weeks) {
  const to = weeks ? addDays(from, 7 * weeks - 1) : '9999-12-31';
  return plan.days.filter(d => !weeks || (d.date >= from && d.date <= to))
    .flatMap(d => d.items.filter(i => ['gym', 'run', 'field'].includes(i.type)).map(i => ({ date: d.date, ...i })));
}

// ---------- Catálogo compartido (v2) ----------
// exercises: { <id>: { name, kind: gym|run|field, group, defaults, cue, videos } }. En la rutina, ejercicios (gym) y pasos
// (run/field) llevan "ex" opcional; sin ex (o con uno desconocido) se busca por nombre exacto, sin distinguir mayúsculas.
// Los rechazos de videos se guardan como logs "fecha|_video:<id>" para que funcionen sin señal y salgan en el export.

const norm = s => String(s ?? '').trim().toLowerCase();

export function exId(catalog, x) {
  const all = catalog?.exercises ?? {};
  if (x?.ex && all[x.ex]) return x.ex;
  const n = norm(x?.name ?? x?.do);
  return n ? Object.keys(all).find(k => norm(all[k].name) === n) ?? null : null;
}

// Copia de la rutina con "ex" completado donde falta y el nombre coincide con el catálogo.
export function fillEx(plan, catalog) {
  const p = structuredClone(plan);
  const fill = x => { if (!x.ex) { const id = exId(catalog, x); if (id) x.ex = id; } };
  const steps = list => list?.forEach(s => s.repeat ? steps(s.steps) : fill(s));
  p.days?.forEach(d => d.items?.forEach(i => { i.exercises?.forEach(fill); steps(i.steps); }));
  return p;
}

// Una línea por ejercicio para el prompt de "Generar con IA".
export const catalogLines = catalog => Object.entries(catalog?.exercises ?? {}).map(([id, e]) =>
  `- ${id} · ${e.name} (${[e.kind, ...Object.entries(e.defaults ?? {}).map(([k, v]) => v === true ? k : `${k} ${v}`)].join(', ')})`).join('\n');

// El JSON de una respuesta de IA, aunque venga envuelto en ```json o con texto alrededor.
export const extractJson = text => { const a = text.indexOf('{'), b = text.lastIndexOf('}'); return a >= 0 && b > a ? text.slice(a, b + 1) : text; };

export const rejectedVideos = logs => new Set(Object.keys(logs).filter(k => k.includes('|_video:')).map(k => k.split('|_video:')[1]));

// Primer video no rechazado; si no queda ninguno, el último con exhausted = true.
export function pickVideo(catalog, id, rejected) {
  const vids = catalog?.exercises?.[id]?.videos ?? [];
  if (!vids.length) return null;
  const v = vids.find(v => !rejected.has(v.id));
  return v ? { video: v, exhausted: false } : { video: vids.at(-1), exhausted: true };
}

// Claves a borrar en "Borrar datos de prueba": rango de fechas inclusive; registros y/o videos descartados.
export const keysToDelete = (logs, from, to, { training, videos }) => Object.keys(logs).filter(k => {
  const date = k.slice(0, 10), isVideo = k.includes('|_video:');
  return date >= from && date <= to && (isVideo ? videos : training);
});

// ---------- "Terminé la sesión" ----------
// Completa lo no tocado: en gym, los ejercicios sin series tildadas ni skip; en run/field, todo si no hay pasos tildados.
// Editar kg/reps sin tildar no cuenta como tocado. `log` es el log del card con los valores precargados.
export function confirmItem(item, log) {
  const l = structuredClone(log ?? {});
  if (item.type === 'gym') {
    item.exercises.forEach((ex, i) => {
      const e = (l.ex ??= [])[i] ??= { name: ex.name };
      e.sets ??= [];
      if (e.skip || e.sets.some(s => s?.done)) return;
      setsOf(ex).forEach((_, j) => { e.sets[j] = { ...e.sets[j], done: true }; });
    });
  } else if (!(l.steps ?? []).some(s => s?.done)) {
    l.steps = item.steps.map((s, i) => ({ ...l.steps?.[i], done: true, ...(s.repeat ? { completed: s.repeat } : {}) }));
  }
  return { ...l, confirmed: true };
}

// Dónde se frenó: gym → [{ex, set}] por ejercicio parcial (base 0); run/field → {step, round} o null.
export function stoppedAt(item, log) {
  if (item.type === 'gym') return item.exercises.flatMap((ex, i) => {
    const e = log?.ex?.[i], sets = setsOf(ex).map((_, j) => !!e?.sets?.[j]?.done);
    return !e?.skip && sets.some(Boolean) && !sets.every(Boolean) ? [{ ex: i, set: sets.indexOf(false) }] : [];
  });
  if (item.type !== 'run' && item.type !== 'field') return null;
  const fr = item.steps.map((s, i) => stepFrac(s, log?.steps?.[i]));
  if (!fr.some(f => f > 0)) return null;
  const step = fr.findIndex(f => f < 1);
  if (step < 0) return null;
  const s = item.steps[step];
  return { step, round: s.repeat ? Math.round(fr[step] * s.repeat) + 1 : null };
}

// Entradas del changelog más nuevas que la última vista (seen = ISO o null), de la más vieja a la más nueva.
export const unseenChanges = (plan, seen) => (plan.changelog ?? [])
  .filter(c => !seen || Date.parse(c.at) > Date.parse(seen))
  .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

// ---------- Crear rutina a mano ----------

// start + los días de la semana elegidos (0 = lunes) durante N semanas; sin días elegidos, solo start.
export function repeatDates(start, weekdays, weeks) {
  if (!weekdays.length) return [start];
  const n = 7 * Math.min(Math.max(weeks | 0, 1), 52);
  return Array.from({ length: n }, (_, i) => addDays(start, i)).filter(d => weekdays.includes((new Date(d + 'T00:00:00Z').getUTCDay() + 6) % 7));
}

// Saca campos vacíos ('' / null / false) para que el item quede como lo escribiría Claude.
export const cleanItem = o => Array.isArray(o) ? o.map(cleanItem) : o && typeof o === 'object'
  ? Object.fromEntries(Object.entries(o).filter(([, v]) => v !== '' && v != null && v !== false).map(([k, v]) => [k, cleanItem(v)]))
  : o;

// Nueva versión de la rutina con `item` en cada fecha. mode "replace" saca lo que había esos días, salvo los items con registros.
// Ids "<type>-<fecha>" con sufijo -2, -3… si ya existe en la rutina o en los registros (para no heredar logs viejos).
export function mergeItems(plan, dates, item, mode, logs, name = 'Mi rutina') {
  const p = plan ? structuredClone(plan) : { version: 1, name, source: 'manual', days: [] };
  const used = new Set([...p.days.flatMap(d => d.items.map(i => i.id)), ...Object.keys(logs).map(k => k.split('|')[1])]);
  for (const date of dates) {
    let day = p.days.find(d => d.date === date);
    if (!day) p.days.push(day = { date, items: [] });
    if (mode === 'replace') day.items = day.items.filter(i => logs[`${date}|${i.id}`]);
    let id = `${item.type}-${date}`;
    for (let n = 2; used.has(id); n++) id = `${item.type}-${date}-${n}`;
    used.add(id);
    day.items.push({ id, ...structuredClone(item) });
  }
  p.days.sort((a, b) => a.date.localeCompare(b.date));
  return p;
}
