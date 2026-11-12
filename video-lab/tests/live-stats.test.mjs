import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LiveMeter, coverRect, droppedBetween } from '../src/live-stats.js';

test('coverRect crops the source centre to the target aspect ratio', () => {
  assert.deepEqual(coverRect(1920, 1080, 1280, 720), { x: 0, y: 0, width: 1920, height: 1080 });
  assert.deepEqual(coverRect(640, 480, 1280, 720), { x: 0, y: 60, width: 640, height: 360 });
  assert.deepEqual(coverRect(1080, 1920, 640, 360), { x: 0, y: 656, width: 1080, height: 608 });
  assert.throws(() => coverRect(0, 1, 1, 1), RangeError);
});

test('droppedBetween ignores jitter and counts whole missing frames', () => {
  const interval = 40_000;
  assert.equal(droppedBetween(undefined, 0, interval), 0);
  assert.equal(droppedBetween(0, 40_000, interval), 0);
  assert.equal(droppedBetween(0, 55_000, interval), 0);
  assert.equal(droppedBetween(0, 80_000, interval), 1);
  assert.equal(droppedBetween(0, 200_000, interval), 4);
  assert.equal(droppedBetween(0, 80_000, Infinity), 0);
  assert.equal(droppedBetween(80_000, 40_000, interval), 0);
});

test('LiveMeter summarises segments, drops and FPS continuously across windows', () => {
  let clock = 0;
  const meter = new LiveMeter(() => clock);
  assert.equal(meter.summary(), null);
  for (let i = 0; i < 5; i++) {
    clock = i * 40;
    meter.add({ copyIn: 1, process: 2 + i, output: 1, total: 4 + i });
  }
  meter.drop(1);
  meter.drop(0);
  let summary = meter.summary();
  assert.equal(summary.frames, 5);
  assert.equal(summary.fps, 25);
  assert.equal(summary.dropped, 1);
  assert.equal(summary.dropRate, 1 / 6);
  assert.equal(summary.process.mean, 4);
  assert.equal(summary.total.p95, 8);
  meter.next();
  clock = 200;
  meter.add({ copyIn: 1, process: 1, output: 1, total: 3 });
  summary = meter.summary();
  assert.equal(summary.fps, 25, 'interval measured from the previous window’s last frame');
  assert.throws(() => meter.add({ copyIn: -1, process: 0, output: 0, total: 0 }), RangeError);
});
