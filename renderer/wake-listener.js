'use strict';

// Hidden wake-word listener (M6 slice 5). Captures 16 kHz mono audio with
// the same worklet the push-to-talk recorder uses, computes streaming
// log-mel frames with wake-mel.js (the exact training DSP), runs the
// converted embedding model and the trained classifier with onnxruntime-web
// (WASM, local), and reports ONE bounded score per evaluation to the main
// process. No audio, frame or transcript ever leaves this page; scores only
// go to the main process over IPC and nowhere else. The page has no network
// route and no UI.

(function () {
  const bridge = window.wakeListener;
  if (!bridge) return;

  let running = false;
  let suspended = false; // true while a detected query runs or cooldown holds
  let stopped = true;
  let ctx = null;
  let stream = null;
  let capture = null;
  let mel = null;
  let evaluator = null;
  let sessEmb = null;
  let sessHead = null;
  let embeddingOutName = null;
  let headOutName = null;
  let evaluating = false;

  function dropMic() {
    // Close the microphone immediately and synchronously as far as the OS
    // is concerned: stop the tracks first, then tear the graph down.
    if (stream) { for (const t of stream.getTracks()) t.stop(); stream = null; }
    if (capture) { try { capture.disconnect(); } catch {} capture = null; }
    if (ctx) { try { ctx.close(); } catch {} ctx = null; }
  }

  // The OS rejection lands here as a DOMException with an unfriendly name.
  // Map the two normal cases to the stable tokens the engine records, so
  // the About card can say exactly what happened in plain words.
  function micErrorToken(err) {
    const name = err && err.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') return 'wake_mic_denied';
    if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'wake_mic_missing';
    return 'wake_listener_error';
  }

  async function openMic() {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
        video: false,
      });
    } catch (err) {
      const token = micErrorToken(err);
      const mapped = new Error(token);
      mapped.name = token;
      throw mapped;
    }
    ctx = new AudioContext({ sampleRate: 16000 });
    await ctx.audioWorklet.addModule('recorder-worklet.js');
    capture = new AudioWorkletNode(ctx, 'companion-capture');
    const mute = ctx.createGain();
    mute.gain.value = 0; // the node must be connected to run; never play the mic back
    capture.port.onmessage = (e) => onSamples(e.data);
    ctx.createMediaStreamSource(stream).connect(capture);
    capture.connect(mute);
    mute.connect(ctx.destination);
    await ctx.resume();
  }

  function onSamples(chunk) {
    if (!running || suspended || stopped) return; // mic is closed anyway on suspend; belt and braces
    const fr = mel.push(chunk);
    if (!fr.length) return;
    const r = evaluator.pushFrames(fr);
    if (r.due) evaluate(r.input);
  }

  async function evaluate(melInput) {
    if (evaluating || !running || suspended || stopped) return;
    evaluating = true;
    try {
      const emb = await sessEmb.run({ input: new window.ort.Tensor('float32', melInput, [1, melInput.length / 32, 32, 1]) });
      const embData = emb[embeddingOutName].data; // [1, 16, 1, 96] -> flat 16*96
      const head = await sessHead.run({ input: new window.ort.Tensor('float32', embData.slice(), [1, 16, embData.length / 16]) });
      const raw = head[headOutName].data[0];
      const score = Math.max(0, Math.min(1, Number(raw)));
      if (Number.isFinite(score)) bridge.sendScore(score);
    } catch (err) {
      bridge.sendError(err);
    } finally {
      evaluating = false;
    }
  }

  bridge.onStart(async (payload) => {
    try {
      if (!payload || !payload.embedding || !payload.head) throw new Error('wake_listener_missing_model');
      const ort = window.ort;
      if (!ort || !window.CompanionWakeMel) throw new Error('wake_engine_missing');
      sessEmb = await ort.InferenceSession.create(new Uint8Array(payload.embedding), { executionProviders: ['wasm'] });
      sessHead = await ort.InferenceSession.create(new Uint8Array(payload.head), { executionProviders: ['wasm'] });
      embeddingOutName = sessEmb.outputNames[0];
      headOutName = sessHead.outputNames[0];
      mel = window.CompanionWakeMel.createStreamingLogmel();
      evaluator = window.CompanionWakeEval.createWakeEvaluator();
      stopped = false; running = true; suspended = false;
      await openMic(); // the OS mic permission prompt happens HERE, on the explicit start only
      bridge.sendReady();
    } catch (err) {
      dropMic();
      running = false; stopped = true;
      bridge.sendError(err);
    }
  });

  bridge.onMic((payload) => {
    const open = !!(payload && payload.open);
    if (open) {
      if (running && suspended) {
        suspended = false;
        evaluator.reset();
        openMic().catch((err) => { bridge.sendError(err); });
      }
    } else {
      suspended = true;
      dropMic();
    }
  });

  bridge.onStop(() => {
    stopped = true; running = false; suspended = false;
    dropMic();
    sessEmb = null; sessHead = null;
    evaluator = null;
  });
})();
