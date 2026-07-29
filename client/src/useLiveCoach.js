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
    startListening,
    stopListening,
    requestBrief,
    queueBrief,
    clearTranscript,
    clearBriefs,
    setError,
  };
}
