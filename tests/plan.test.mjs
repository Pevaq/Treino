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
  assert.equal(P.lastWeight(logs, 'Sentadilla', '2026-10-23'), 55);
  assert.equal(P.lastWeight(logs, 'Sentadilla', '2026-10-27'), 60);
  assert.equal(P.lastWeight(logs, 'Prensa', '2026-10-27'), null);

  const pain = P.painSeries(plan, logs, '2026-10-25');
  assert.deepEqual(pain.map(r => r.date), ['2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25']);
  assert.deepEqual(pain[3], { date: '2026-10-25', impact: false, during: null, morning: 4, swelling: true });
  assert.equal(pain[1].during, 2);

  const ad = P.adherence(plan, logs, '2026-10-26');
  assert.equal(ad.week.length, 2);
  assert.equal(ad.stage[0].planned, 4);

  const ex = P.buildExport(plan, logs, '2026-10-25');
  assert.deepEqual(ex.days.map(d => d.date), ['2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25']);
  assert.equal(ex.days[3].morning.pain, 4);
  assert.equal(ex.days[0].items[0].log, null);
  assert.equal(ex.days[0].status, 'sin registrar');
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
