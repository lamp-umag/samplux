import test from 'node:test';
import assert from 'node:assert/strict';
import { nextPaint, eventRtMs } from '../js/tasks/helpers.js';
import {
  isNativeApp,
  hasNativeTasks,
  runNativeTaskIfAvailable,
  notifyRespondentHandoff,
  getNativeInterviewerTelemetry,
  getNativeEnvironmentSnapshot,
  mirrorOutboxEnqueue
} from '../js/nativeBridge.js';

test('nextPaint and eventRtMs compute monotonic kernel-timestamp reaction times', async () => {
  const t0 = await nextPaint();
  assert.equal(typeof t0, 'number');
  assert.ok(t0 >= 0);

  // Kernel input event timestamp on the same monotonic timebase:
  const rtHw = eventRtMs({ timeStamp: t0 + 243.6 }, t0);
  assert.equal(rtHw, 244);

  // Fallback when event has no timeStamp or incompatible epoch timeStamp:
  const rtFallback = eventRtMs({}, t0);
  assert.ok(rtFallback >= 1);
  const rtIncompatibleEpoch = eventRtMs({ timeStamp: 1700000000000 }, t0);
  assert.ok(rtIncompatibleEpoch >= 1 && rtIncompatibleEpoch < 10000);
});

test('nativeBridge is a safe no-op in regular browsers when window.SampluxNative is absent', async () => {
  delete globalThis.window;
  assert.equal(isNativeApp(), false);
  assert.equal(hasNativeTasks(), false);
  assert.equal(await runNativeTaskIfAvailable('task_rt', { nTest: 5 }), null);
  assert.equal(getNativeInterviewerTelemetry(), null);
  assert.equal(getNativeEnvironmentSnapshot(), null);
  assert.equal(await mirrorOutboxEnqueue({ surveyId: 'demo', responseId: 'r1', entry: {} }), false);
  notifyRespondentHandoff(true, 'q_priv'); // must not throw
});

test('nativeBridge delegates tasks, telemetry, env snapshot, and outbox mirror when window.SampluxNative is injected', async () => {
  let handoffLog = null;
  let mirroredPayload = null;

  globalThis.window = {
    SampluxNative: {
      startNativeTask(reqId, taskType, configJson) {
        const cfg = JSON.parse(configJson);
        const cb = globalThis.window.__sampluxTaskCallbacks[reqId];
        delete globalThis.window.__sampluxTaskCallbacks[reqId];
        cb.resolve(JSON.stringify({
          engine: 'cpp17_ndk',
          taskType,
          trials: [{ trial_index: 0, rt_ms: 218, rt_hw_us: 218140, tap_impulse_g: 0.42 }],
          summary: { n_trials: cfg.nTest || 20, mean_rt_ms: 218 }
        }));
      },
      setRespondentHandoff(active, itemId) {
        handoffLog = { active, itemId };
      },
      getInterviewerTelemetryJson() {
        return JSON.stringify({ handoffCount: 1, handoffVerifiedCount: 1, lastHandoffMotionScore: 0.91 });
      },
      getEnvironmentSnapshotJson() {
        return JSON.stringify({ ambientDbMean: 44.2, ambientLuxMean: 310, displayRefreshHz: 120 });
      },
      mirrorOutboxEnqueueJson(json) {
        mirroredPayload = JSON.parse(json);
      }
    }
  };

  try {
    assert.equal(isNativeApp(), true);
    assert.equal(hasNativeTasks(), true);

    const res = await runNativeTaskIfAvailable('task_rt', { nTest: 10 });
    assert.equal(res.engine, 'cpp17_ndk');
    assert.equal(res.summary.mean_rt_ms, 218);
    assert.equal(res.trials[0].rt_hw_us, 218140);

    notifyRespondentHandoff(true, 'q_secret');
    assert.deepEqual(handoffLog, { active: true, itemId: 'q_secret' });

    assert.equal(getNativeInterviewerTelemetry().lastHandoffMotionScore, 0.91);
    assert.equal(getNativeEnvironmentSnapshot().displayRefreshHz, 120);

    const ok = await mirrorOutboxEnqueue({
      surveyId: 'piloto',
      responseId: 'resp_01',
      entry: { answers: { q1: 5 } },
      paradata: { totalTime: 12000 },
      clips: [{ itemId: 'q_voice', docId: 'resp_01__q_voice', mime: 'audio/webm', durationMs: 2400, blob: new Blob(['abc']) }]
    });
    assert.equal(ok, true);
    assert.equal(mirroredPayload.surveyId, 'piloto');
    assert.equal(mirroredPayload.clips[0].base64, 'YWJj');
  } finally {
    delete globalThis.window;
  }
});
