'use strict';

// Microphone capture at 16 kHz mono, for the overlay only. Audio stays in
// memory in this page until the user stops, then goes to the main process,
// which transcribes it locally with whisper.cpp.
(function () {
  const MAX_SECONDS = 15;

  // -> { stop(): Promise<Uint8Array>, cancel(): void }. Rejects if the mic is unavailable.
  async function startRecording({ onAutoStop } = {}) {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      video: false,
    });
    const ctx = new AudioContext({ sampleRate: 16000 });
    await ctx.audioWorklet.addModule('recorder-worklet.js');
    const source = ctx.createMediaStreamSource(stream);
    const capture = new AudioWorkletNode(ctx, 'companion-capture');
    const mute = ctx.createGain();
    mute.gain.value = 0; // the node must be connected to run; never play the mic back
    const chunks = [];
    capture.port.onmessage = (e) => chunks.push(e.data);
    source.connect(capture);
    capture.connect(mute);
    mute.connect(ctx.destination);
    await ctx.resume();

    let finished = false;
    function release() {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      capture.disconnect();
      source.disconnect();
      for (const t of stream.getTracks()) t.stop();
      ctx.close();
    }
    const timer = setTimeout(() => { if (onAutoStop) onAutoStop(); }, MAX_SECONDS * 1000);

    return {
      stop() { release(); return Promise.resolve(window.CompanionPcm.floatChunksToPcm16(chunks)); },
      cancel() { release(); chunks.length = 0; },
    };
  }

  window.CompanionRecorder = { startRecording, MAX_SECONDS };
})();
