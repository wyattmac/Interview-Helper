import { useCallback, useEffect, useRef, useState } from "react";
import { startPcmCapture, wsUrl } from "./audio.js";

export const STATUS_LABELS = {
  idle: "Ready",
  connecting: "Connecting…",
  "waiting-for-stt": "Getting transcription ready…",
  listening: "Listening — keep the phone on speaker",
  error: "Problem — see message",
};

export function useLiveCoach({ sampleRate = 16000 } = {}) {
  const [listening, setListening] = useState(false);
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState("");
  const [partial, setPartial] = useState("");
  const [utterances, setUtterances] = useState([]);
  const [briefs, setBriefs] = useState([]);
  const [briefLoading, setBriefLoading] = useState(false);
  const [micTest, setMicTest] = useState(null); // { phase, transcript, quality }

  const captureRef = useRef(null);
  const socketRef = useRef(null);
  const utterancesRef = useRef([]);
  const briefTimerRef = useRef(null);
  const briefAbortRef = useRef(null);
  const lastBriefKeyRef = useRef("");
  const wakeLockRef = useRef(null);
  const retryCountRef = useRef(0);
  const retryTimerRef = useRef(null);
  const stoppingRef = useRef(false);

  useEffect(() => {
    utterancesRef.current = utterances;
  }, [utterances]);

  const requestBrief = useCallback(async (forceText) => {
    const windowText =
      forceText ||
      utterancesRef.current
        .slice(-6)
        .map((u) => u.text)
        .join("\n");

    const key = windowText.trim().slice(-280);
    if (key.length < 24 || key === lastBriefKeyRef.current) return;

    // Cancel any in-flight brief so we never show a stale coach card.
    briefAbortRef.current?.abort();
    const controller = new AbortController();
    briefAbortRef.current = controller;
    setBriefLoading(true);

    try {
      const res = await fetch("/api/brief", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transcript: windowText }),
        signal: controller.signal,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Brief failed");

      // Mark success only after we have a usable brief, so failures retry.
      lastBriefKeyRef.current = key;
      setBriefs((prev) => [data, ...prev].slice(0, 12));
      return data;
    } catch (err) {
      if (err?.name !== "AbortError") {
        setError(err.message || "Brief request failed");
      }
      return null;
    } finally {
      if (briefAbortRef.current === controller) {
        setBriefLoading(false);
      }
    }
  }, []);

  const queueBrief = useCallback(() => {
    clearTimeout(briefTimerRef.current);
    briefTimerRef.current = setTimeout(() => {
      requestBrief();
    }, 650);
  }, [requestBrief]);

  const stopListening = useCallback(async () => {
    stoppingRef.current = true;
    clearTimeout(briefTimerRef.current);
    clearTimeout(retryTimerRef.current);
    briefAbortRef.current?.abort();
    try {
      if (socketRef.current?.readyState === WebSocket.OPEN) {
        socketRef.current.send(JSON.stringify({ type: "audio.done" }));
        socketRef.current.close();
      }
    } catch {
      /* ignore */
    }
    socketRef.current = null;
    if (captureRef.current) {
      await captureRef.current.stop();
      captureRef.current = null;
    }
    if (wakeLockRef.current) {
      try {
        await wakeLockRef.current.release();
      } catch {
        /* ignore */
      }
      wakeLockRef.current = null;
    }
    setListening(false);
    setPartial("");
    setStatus("idle");
  }, []);

  const startListening = useCallback(async () => {
    setError("");
    setStatus("connecting");
    setPartial("");
    stoppingRef.current = false;

    const socket = new WebSocket(wsUrl("/ws/stt"));
    socket.binaryType = "arraybuffer";
    socketRef.current = socket;

    socket.onopen = async () => {
      setStatus("waiting-for-stt");
      try {
        captureRef.current = await startPcmCapture({
          sampleRate,
          onFrame: (buffer) => {
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(buffer);
            }
          },
          onError: (err) => setError(err.message),
        });
        setListening(true);
      } catch (err) {
        setError(
          err.message ||
            "Microphone access denied. Allow mic access, put the phone on speaker, and try again.",
        );
        setStatus("idle");
        socket.close();
      }
    };

    socket.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }

      if (msg.type === "session.ready") {
        retryCountRef.current = 0;
        setStatus("listening");
        if ("wakeLock" in navigator) {
          navigator.wakeLock
            .request("screen")
            .then((lock) => {
              wakeLockRef.current = lock;
            })
            .catch(() => {});
        }
        if (msg.droppedAudioMs > 500) {
          setError(
            "Transcription was slow to start — the first second or two may be missing.",
          );
        }
      }
      if (msg.type === "error") {
        setError(msg.message);
        setStatus("error");
      }
      if (msg.type === "transcript") {
        if (!msg.isFinal) {
          setPartial(msg.text || "");
          return;
        }
        setPartial("");
        if (msg.text?.trim()) {
          const item = {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            text: msg.text.trim(),
            speechFinal: Boolean(msg.speechFinal),
            at: new Date().toLocaleTimeString(),
          };
          setUtterances((prev) => [...prev, item].slice(-40));
          queueBrief();
        }
      }
    };

    socket.onerror = () => {
      setError("Connection error — trying to reconnect…");
      setStatus("error");
    };

    socket.onclose = () => {
      setListening(false);
      if (stoppingRef.current) {
        setStatus("idle");
        return;
      }
      // Auto-reconnect with backoff if the socket dies mid-interview.
      if (captureRef.current && retryCountRef.current < 3) {
        retryCountRef.current += 1;
        setStatus("connecting");
        setError(`Connection dropped — reconnecting (attempt ${retryCountRef.current}/3)…`);
        retryTimerRef.current = setTimeout(() => {
          if (!stoppingRef.current) startListening();
        }, 800 * retryCountRef.current);
        return;
      }
      if (retryCountRef.current >= 3) {
        setError("Connection dropped 3 times — tap Start listening again.");
      }
      setStatus((prev) => (prev === "error" ? prev : "idle"));
    };
  }, [queueBrief, sampleRate]);

  const clearTranscript = useCallback(() => {
    setUtterances([]);
    setPartial("");
    lastBriefKeyRef.current = "";
  }, []);

  const clearBriefs = useCallback(() => {
    setBriefs([]);
    lastBriefKeyRef.current = "";
  }, []);

  const runMicTest = useCallback(async () => {
    if (listening) {
      setError("Stop listening before running the mic test.");
      return;
    }
    setError("");
    setMicTest({ phase: "recording", transcript: "", quality: "" });

    let capture;
    const frames = [];
    const DURATION_MS = 6000;
    try {
      capture = await startPcmCapture({
        sampleRate,
        onFrame: (buffer) => frames.push(new Int16Array(buffer)),
        onError: (err) => setError(err.message),
      });

      // Feed the mic back through the speakers at low volume so the user can
      // hear whether phone audio is reaching the laptop (and hear echo test).
      const monitor = capture.audioContext.createGain();
      monitor.gain.value = 0.25;
      capture.source.connect(monitor);
      monitor.connect(capture.audioContext.destination);
      capture.monitor = monitor;
    } catch (err) {
      setMicTest(null);
      setError(
        err.message || "Microphone access denied. Allow mic access and retry.",
      );
      return;
    }

    await new Promise((r) => setTimeout(r, DURATION_MS));
    try {
      capture.monitor?.disconnect();
    } catch {
      /* ignore */
    }
    await capture.stop();

    const total = frames.reduce((n, f) => n + f.length, 0);
    const pcm = new Int16Array(total);
    let offset = 0;
    for (const frame of frames) {
      pcm.set(frame, offset);
      offset += frame.length;
    }

    // Measure RMS to give a loudness hint.
    let sum = 0;
    let peak = 0;
    for (let i = 0; i < pcm.length; i += 1) {
      const v = Math.abs(pcm[i]);
      sum += pcm[i] * pcm[i];
      if (v > peak) peak = v;
    }
    const rms = Math.sqrt(sum / Math.max(1, pcm.length)) / 32768;

    // WAV container for the REST STT endpoint.
    const wav = encodeWav(pcm, sampleRate);
    setMicTest({ phase: "transcribing", transcript: "", quality: "" });

    try {
      const form = new FormData();
      form.append("format", "true");
      form.append("language", "en");
      form.append("file", new Blob([wav], { type: "audio/wav" }), "mic-test.wav");
      const res = await fetch("/api/stt-file", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Transcription failed");

      const text = (data.text || "").trim();
      let quality;
      if (!text) {
        quality =
          "Nothing heard — bring the phone speaker closer to the laptop mic and raise call volume.";
      } else if (rms < 0.01) {
        quality = `Very quiet (level ${(rms * 100).toFixed(1)}%) — move the phone closer or louder.`;
      } else if (text.split(/\s+/).length < 4) {
        quality = "Heard a little — okay, but closer/louder phone audio will be more accurate.";
      } else {
        quality = `Audio looks good (level ${(rms * 100).toFixed(1)}%). You're ready.`;
      }
      setMicTest({
        phase: "done",
        transcript: text || "(no speech detected)",
        quality,
      });
    } catch (err) {
      setMicTest(null);
      setError(err.message || "Mic test transcription failed");
    }
  }, [listening, sampleRate, setError]);

  useEffect(() => {
    return () => {
      stoppingRef.current = true;
      clearTimeout(retryTimerRef.current);
      stopListening();
    };
  }, [stopListening]);

  return {
    listening,
    status,
    error,
    partial,
    utterances,
    briefs,
    briefLoading,
    micTest,
    startListening,
    stopListening,
    requestBrief,
    queueBrief,
    clearTranscript,
    clearBriefs,
    runMicTest,
    setError,
  };
}

function encodeWav(pcm, sampleRate) {
  const buffer = new ArrayBuffer(44 + pcm.length * 2);
  const view = new DataView(buffer);
  const writeString = (offset, s) => {
    for (let i = 0; i < s.length; i += 1) view.setUint8(offset + i, s.charCodeAt(i));
  };
  writeString(0, "RIFF");
  view.setUint32(4, 36 + pcm.length * 2, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, pcm.length * 2, true);
  const bytes = new Uint8Array(buffer, 44);
  bytes.set(new Uint8Array(pcm.buffer));
  return buffer;
}
