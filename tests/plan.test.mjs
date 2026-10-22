// npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../plan.js';

const plan = {
  version: 1, name: 'Test', rules: { max_pain: 3 },
  days: [
    { date: '2026-10-22', items: [{ id: 'k1', type: 'check', title: 'Kinesio' }] },
    { date: '2026-10-23', items: [{ id: 'g1', type: 'gym', title: 'Gym', exercises: [
      { name: 'Sentadilla', sets: 3, reps: '8-10' },
      { name: 'Prensa', sets: [{ reps: 12, weight: 100 }, { reps: 10, weight: 120 }] },
    ] }] },
    { date: '2026-10-24', items: [{ id: 'r1', type: 'run', stage: 'Etapa 1', title: 'Trote', impact: true, steps: [
      { do: 'caminar', time: '5min' },
      { repeat: 8, steps: [{ do: 'trote', time: '1min' }, { do: 'caminar', time: '1min' }] },
    ] }] },
    { date: '2026-10-26', items: [{ id: 'm1', type: 'match', title: 'Amistoso', impact: true }] },
  ],
};

test('valida una rutina correcta y detecta errores', () => {
  assert.deepEqual(P.validatePlan(plan), []);
  const bad = structuredClone(plan);
  bad.days[1].items[0].id = 'k1';
  bad.days[2].date = '2026-10-01';
  bad.days[3].items[0].type = 'yoga';
  const err = P.validatePlan(bad).join('\n');
  assert.match(err, /repetido/);
  assert.match(err, /desordenadas/);
  assert.match(err, /desconocido/);
  assert.match(P.validatePlan({ version: 1, name: 'x', days: [] }).join(), /days/);
});

test('fechas', () => {
  assert.equal(P.addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(P.weekStart('2026-10-25'), '2026-10-19'); // domingo → lunes anterior
  assert.equal(P.weekStart('2026-10-19'), '2026-10-19');
});

test('etapas heredadas y chequeo de la mañana', () => {
  assert.deepEqual(P.stages(plan), { k1: 'Etapa 1', g1: 'Etapa 1', r1: 'Etapa 1', m1: 'Etapa 1' });
  assert.equal(P.morningRequired(plan, '2026-10-25'), true);
  assert.equal(P.morningRequired(plan, '2026-10-24'), false);
});

test('progreso por item', () => {
  const [, gym, run] = plan.days.map(d => d.items[0]);
  assert.deepEqual(P.itemProgress(gym, { ex: [{ sets: [{ done: true }, { done: false }] }, { sets: [{ done: true }] }] }), [2, 5]);
  assert.deepEqual(P.itemProgress(run, { steps: [{ done: true }, { done: true, completed: 4 }] }), [1.5, 2]);
  assert.deepEqual(P.itemProgress(plan.days[0].items[0], undefined), [0, 1]);
});

test('último peso, series de dolor, adherencia y export', () => {
  const logs = {
    '2026-10-20|old': { ex: [{ name: 'Sentadilla', sets: [{ kg: 50 }, { kg: 55 }] }] },
    '2026-10-23|g1': { ex: [{ name: 'Sentadilla', sets: [{ done: true, kg: 60, reps: 8 }], pain: 2 }] },
    '2026-10-24|r1': { steps: [{ done: true }, { done: true }], pain: 3 },
    '2026-10-25|_morning': { swelling: 'si', pain: 4, trend: 'peor' },
  };
  assert.equal(P.lastWeight(logs, { name: 'Sentadilla' }, '2026-10-23'), 55);
  assert.equal(P.lastWeight(logs, { name: 'Sentadilla' }, '2026-10-27'), 60);
  assert.equal(P.lastWeight(logs, { name: 'Prensa' }, '2026-10-27'), null);
  // Con id del catálogo: sobrevive a un cambio de nombre; los logs viejos sin ex se buscan por nombre.
  const byId = { '2026-10-21|g': { ex: [{ name: 'Sentadilla libre', ex: 'sentadilla', sets: [{ kg: 70 }] }] }, ...logs };
  assert.equal(P.lastWeight(byId, { ex: 'sentadilla', name: 'Sentadilla' }, '2026-10-22'), 70);
  assert.equal(P.lastWeight(byId, { ex: 'sentadilla', name: 'Sentadilla' }, '2026-10-27'), 60);

  const pain = P.painSeries(plan, logs, '2026-10-25');
  assert.deepEqual(pain.map(r => r.date), ['2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25']);
  assert.deepEqual(pain[3], { date: '2026-10-25', impact: false, during: null, morning: 4, swelling: true });
  assert.equal(pain[1].during, 2);

  const ad = P.adherence(plan, logs, '2026-10-26');
  assert.equal(ad.week.length, 2);
  assert.equal(ad.stage[0].planned, 4);

  const ex = P.buildExport(plan, logs, '2026-10-01', '2026-10-25', 7);
  assert.equal(ex.plan_id, 7);
  assert.deepEqual(ex.days.map(d => d.date), ['2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25']);
  assert.equal(ex.days[3].morning.pain, 4);
  assert.deepEqual(ex.days[3].morning_after, ['r1']);
  assert.equal(ex.days[3].status, null); // día sin items planificados, solo chequeo
  assert.equal(ex.days[0].items[0].log, null);
  assert.deepEqual([ex.days[0].status, ex.days[0].status_auto], ['no hecho', true]);
  assert.equal(ex.days[1].status, 'parcial');
  assert.equal(ex.days[2].status, 'hecho');
  assert.deepEqual(P.buildExport(plan, logs, '2026-10-23', '2026-10-23').days.map(d => d.date), ['2026-10-23']);
  assert.deepEqual(ex.fuera_del_plan.map(r => r.item_id), ['old']);
});

test('minutos de trote', () => {
  assert.equal(P.runMinutes(plan.days[2].items[0].steps), 8);
  assert.equal(P.runMinutes([{ repeat: 2, steps: [{ repeat: 3, steps: [{ do: 'trote suave', time: '30s' }] }] }]), 3);
});

test('sesiones del PDF por rango', () => {
  assert.deepEqual(P.printSessions(plan, '2026-10-01', 0).map(i => i.id), ['g1', 'r1']);
  assert.deepEqual(P.printSessions(plan, '2026-10-17', 1).map(i => i.id), ['g1']); // 17 → 23 inclusive
  assert.deepEqual(P.printSessions(plan, '2026-10-25', 1), []);
});

test('catálogo compartido y videos', () => {
  const cat = { version: 2, exercises: {
    sentadilla: { name: 'Sentadilla', kind: 'gym', defaults: { sets: 3, reps: '8-10' }, videos: [{ id: 'aaaaaaaaaaa' }, { id: 'bbbbbbbbbb-' }] },
    trote: { name: 'Trote', kind: 'run', defaults: { time: '10min' }, videos: [] },
    pogos: { name: 'Pogos', kind: 'field', defaults: { sets: 2, per_side: true }, videos: [] },
  } };
  assert.equal(P.exId(cat, { ex: 'sentadilla', name: 'Otra cosa' }), 'sentadilla');
  assert.equal(P.exId(cat, { name: 'sentadilla ' }), 'sentadilla');
  assert.equal(P.exId(cat, { do: 'trote' }), 'trote');
  assert.equal(P.exId(cat, { ex: 'no-existe', name: 'Prensa' }), null);

  const filled = P.fillEx(plan, cat);
  assert.equal(filled.days[1].items[0].exercises[0].ex, 'sentadilla');
  assert.equal(filled.days[1].items[0].exercises[1].ex, undefined);
  assert.equal(filled.days[2].items[0].steps[1].steps[0].ex, 'trote');
  assert.equal(plan.days[1].items[0].exercises[0].ex, undefined); // no muta el original
  assert.match(P.buildExport(filled, {}, '2026-10-23', '2026-10-24').days[1].items[0].ex.flat().join(), /trote/);

  assert.equal(P.catalogLines(cat).split('\n')[2], '- pogos · Pogos (field, sets 2, per_side)');
  assert.equal(P.extractJson('Acá va:\n```json\n{"a":{"b":1}}\n```\nListo'), '{"a":{"b":1}}');

  const logs = { '2026-10-23|_video:aaaaaaaaaaa': { exercise: 'Sentadilla', video_id: 'aaaaaaaaaaa', reason: 'no me sirve' } };
  const rej = P.rejectedVideos(logs);
  assert.deepEqual(P.pickVideo(cat, 'sentadilla', new Set()).video.id, 'aaaaaaaaaaa');
  assert.deepEqual(P.pickVideo(cat, 'sentadilla', rej), { video: { id: 'bbbbbbbbbb-' }, exhausted: false });
  assert.equal(P.pickVideo(cat, 'sentadilla', new Set(['aaaaaaaaaaa', 'bbbbbbbbbb-'])).exhausted, true);
  assert.equal(P.pickVideo(cat, 'trote', rej), null);

  const ex = P.buildExport(plan, logs, '2026-10-01', '2026-10-25');
  assert.deepEqual([ex.video_feedback[0].reason, ex.video_feedback[0].date], ['no me sirve', '2026-10-23']);
  assert.deepEqual(ex.fuera_del_plan, []);
});

test('borrado de datos de prueba', () => {
  const logs = {
    '2026-10-20|r1': { steps: [] },
    '2026-10-21|_day': { status: 'hecho' },
    '2026-10-21|_video:aaaaaaaaaaa': { exercise: 'X', video_id: 'aaaaaaaaaaa' },
    '2026-10-21|_video:bbbbbbbbbbb': { exercise: 'X', video_id: 'bbbbbbbbbbb' },
    '2026-10-22|g1': { ex: [] },
  };
  const all = { training: true, videos: true };
  assert.deepEqual(P.keysToDelete(logs, '0000-01-01', '2026-10-21', all), Object.keys(logs).slice(0, 4));
  assert.deepEqual(P.keysToDelete(logs, '2026-10-21', '2026-10-22', { training: true, videos: false }), ['2026-10-21|_day', '2026-10-22|g1']);
  assert.deepEqual(P.keysToDelete(logs, '0000-01-01', '9999-12-31', { training: false, videos: true }).length, 2);
});

test('Terminé la sesión y dónde se frenó', () => {
  const gym = plan.days[1].items[0], run = plan.days[2].items[0];
  // Sentadilla: cambió kg sin tildar (no cuenta como tocado). Prensa: se frenó en la serie 2.
  const log = { ex: [{ name: 'Sentadilla', sets: [{ done: false, reps: 8, kg: 50 }, { done: false, reps: 8, kg: 50 }, { done: false, reps: 8, kg: 50 }] },
    { name: 'Prensa', sets: [{ done: true, reps: 12, kg: 100 }, { done: false, reps: 6, kg: 120 }] }] };
  const c = P.confirmItem(gym, log);
  assert.equal(c.confirmed, true);
  assert.deepEqual(c.ex[0].sets.map(s => [s.done, s.kg]), [[true, 50], [true, 50], [true, 50]]);
  assert.deepEqual(c.ex[1].sets.map(s => s.done), [true, false]);
  assert.deepEqual(P.stoppedAt(gym, c), [{ ex: 1, set: 1 }]);
  // "No lo hice" bloquea el autocompletado.
  const skip = P.confirmItem(gym, { ex: [{ name: 'Sentadilla', skip: true, sets: [] }] });
  assert.deepEqual([skip.ex[0].sets.length, skip.ex[1].sets.every(s => s.done)], [0, true]);
  assert.deepEqual(P.stoppedAt(gym, skip), []);
  // Sin tocar nada: no hay frenado ni se asume nada.
  assert.deepEqual(P.stoppedAt(gym, undefined), []);

  const r = P.confirmItem(run, undefined);
  assert.deepEqual(r.steps, [{ done: true }, { done: true, completed: 8 }]);
  assert.equal(P.stoppedAt(run, r), null);
  const frenado = { steps: [{ done: true }, { done: false, completed: 3 }] };
  assert.deepEqual(P.confirmItem(run, frenado).steps, frenado.steps); // ya tocado: no se completa
  assert.deepEqual(P.stoppedAt(run, frenado), { step: 1, round: 4 });
  assert.deepEqual(P.itemProgress(run, frenado), [1 + 3 / 8, 2]);

  const ex = P.buildExport({ ...plan, days: [plan.days[2]] }, { '2026-10-24|r1': r }, '2026-10-01', '2026-10-31');
  assert.deepEqual([ex.days[0].items[0].confirmed_all, ex.days[0].items[0].stopped_at], [true, null]);
});

test('changelog y replanned_through', () => {
  const p = { ...plan, replanned_through: '2026-10-23', changelog: [
    { at: '2026-10-24T03:00:00Z', by: 'claude', summary: 'Moví el trote del 24 al 25' },
    { at: '2026-10-22T03:00:00Z', by: 'claude', summary: 'Ajuste inicial' }] };
  assert.deepEqual(P.validatePlan(p), []);
  assert.match(P.validatePlan({ ...plan, replanned_through: '23/10' }).join(), /replanned_through/);
  assert.match(P.validatePlan({ ...plan, changelog: [{ at: 'ayer', summary: 'x' }] }).join(), /changelog/);
  assert.deepEqual(P.unseenChanges(p, null).map(c => c.summary), ['Ajuste inicial', 'Moví el trote del 24 al 25']);
  assert.deepEqual(P.unseenChanges(p, '2026-10-22T03:00:00Z').map(c => c.summary), ['Moví el trote del 24 al 25']);
  assert.deepEqual(P.unseenChanges(plan, null), []);
});

test('crear rutina a mano: fechas, limpieza y combinación', () => {
  assert.deepEqual(P.repeatDates('2026-10-27', [], 4), ['2026-10-27']);
  // martes y viernes (1, 4) durante 2 semanas desde el martes 27/10
  assert.deepEqual(P.repeatDates('2026-10-27', [1, 4], 2), ['2026-10-27', '2026-10-30', '2026-11-03', '2026-11-06']);
  assert.deepEqual(P.cleanItem({ a: '', b: null, c: false, d: 0, e: [{ x: '', y: 'z' }] }), { d: 0, e: [{ y: 'z' }] });

  const item = { type: 'gym', title: 'Gym', by: 'manual', exercises: [{ name: 'Sentadilla', sets: 3, reps: 10 }] };
  const logs = { '2026-10-23|g1': { ex: [] }, '2026-10-30|gym-2026-10-30': { ex: [] } };
  const add = P.mergeItems(plan, ['2026-10-23', '2026-10-30'], item, 'add', logs);
  assert.deepEqual(P.validatePlan(add), []);
  assert.deepEqual(add.days.find(d => d.date === '2026-10-23').items.map(i => i.id), ['g1', 'gym-2026-10-23']);
  // el 30/10 no tenía nada en la rutina, pero hay un log viejo con ese id: lleva sufijo
  assert.deepEqual(add.days.find(d => d.date === '2026-10-30').items.map(i => i.id), ['gym-2026-10-30-2']);
  assert.deepEqual(add.days.map(d => d.date), [...add.days.map(d => d.date)].sort());
  assert.equal(plan.days.length, 4); // no muta el original

  const rep = P.mergeItems(plan, ['2026-10-22', '2026-10-23'], item, 'replace', logs);
  assert.deepEqual(rep.days[0].items.map(i => i.id), ['gym-2026-10-22']); // k1 no tenía registros
  assert.deepEqual(rep.days[1].items.map(i => i.id), ['g1', 'gym-2026-10-23']); // g1 tiene registros: se queda

  const fresh = P.mergeItems(null, ['2026-11-02'], { type: 'check', title: 'Yoga', by: 'manual' }, 'add', {});
  assert.deepEqual([fresh.source, fresh.name, fresh.days[0].items[0].id], ['manual', 'Mi rutina', 'check-2026-11-02']);
  assert.deepEqual(P.validatePlan(fresh), []);
  assert.match(P.validatePlan({ ...fresh, source: 'otro' }).join(), /source/);
});
