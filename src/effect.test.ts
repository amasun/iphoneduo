import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_EFFECT_SETTINGS, effectAtAngle } from './effect.ts';

test('the calibrated face stays sharp and at the screen surface', () => {
  assert.deepEqual(effectAtAngle(0, DEFAULT_EFFECT_SETTINGS), { progress: 0, blur: 0, dim: 0 });
  assert.equal(effectAtAngle(DEFAULT_EFFECT_SETTINGS.threshold, DEFAULT_EFFECT_SETTINGS).blur, 0);
});
test('defocus increases symmetrically and remains bounded', () => {
  const settings = DEFAULT_EFFECT_SETTINGS;
  let previous = 0;
  let previousDim = 0;
  for (let angle = 0; angle < 180; angle++) {
    const effect = effectAtAngle(angle, settings);
    assert.ok(effect.progress >= previous && effect.progress <= 1);
    assert.ok(effect.blur <= settings.blur);
    assert.ok(effect.dim >= previousDim && effect.dim < 1);
    assert.deepEqual(effect, effectAtAngle(-angle, settings));
    previous = effect.progress;
    previousDim = effect.dim;
  }
});

test('darkness follows the chosen blur strength and disappears at zero blur', () => {
  const settings = DEFAULT_EFFECT_SETTINGS;
  assert.equal(effectAtAngle(52, { ...settings, blur: 0 }).dim, 0);
  const strengths = [16, 24, 48, 96, 120].map(blur => effectAtAngle(52, { ...settings, blur }));
  for (let index = 1; index < strengths.length; index++) {
    assert.ok(strengths[index].blur > strengths[index - 1].blur);
    assert.ok(strengths[index].dim > strengths[index - 1].dim);
  }
  assert.deepEqual(effectAtAngle(52, { ...settings, blur: 200 }), strengths.at(-1));
});
