/**
 * Capture mic audio as 16-bit PCM mono at the target sample rate
 * and stream chunks to a callback (~100ms frames).
 */
export async function startPcmCapture({
  sampleRate = 16000,
  onFrame,
  onError,
}) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  const audioContext = new AudioContext();
  const source = audioContext.createMediaStreamSource(stream);
  const processor = audioContext.createScriptProcessor(4096, 1, 1);
  const silent = audioContext.createGain();
  silent.gain.value = 0;

  const ratio = audioContext.sampleRate / sampleRate;
  let leftover = new Float32Array(0);

  processor.onaudioprocess = (event) => {
    try {
      const input = event.inputBuffer.getChannelData(0);
      const merged = new Float32Array(leftover.length + input.length);
      merged.set(leftover);
      merged.set(input, leftover.length);

      const outLength = Math.floor(merged.length / ratio);
      if (outLength < 1) {
        leftover = merged;
        return;
      }

      const pcm = new Int16Array(outLength);
      for (let i = 0; i < outLength; i += 1) {
        const idx = Math.floor(i * ratio);
        const sample = Math.max(-1, Math.min(1, merged[idx] || 0));
        pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      }

      const consumed = Math.floor(outLength * ratio);
      leftover = merged.slice(consumed);
      onFrame(pcm.buffer);
    } catch (err) {
      onError?.(err);
    }
  };

  source.connect(processor);
  processor.connect(silent);
  silent.connect(audioContext.destination);

  return {
    async stop() {
      processor.disconnect();
      source.disconnect();
      silent.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      if (audioContext.state !== "closed") await audioContext.close();
    },
    audioContext,
    source,
  };
}

export function wsUrl(path) {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.host}${path}`;
}
