import { useEffect, useRef, useState } from "react";
import { startPcmCapture, wsUrl } from "./audio.js";

const INPUT_RATE = 16000;
const OUTPUT_RATE = 24000;

export default function VoiceMock() {
  const [state, setState] = useState("idle"); // idle|connecting|live|error
  const [error, setError] = useState("");
  const [model, setModel] = useState("");
  const [turns, setTurns] = useState([]); // { role, text }
  const [partial, setPartial] = useState("");
  const [speaking, setSpeaking] = useState(false);

  const socketRef = useRef(null);
  const captureRef = useRef(null);
  const playbackRef = useRef(null);
  const turnsRef = useRef([]);
  const stoppingRef = useRef(false);
  // Echo gate: while the interviewer is speaking (plus a short tail), mic
  // frames are dropped so Grok can't hear its own voice on laptop speakers
  // and start answering its own questions.
  const echoGateRef = useRef(false);
  const echoTailRef = useRef(null);

  useEffect(() => {
    turnsRef.current = turns;
  }, [turns]);

  useEffect(() => {
    return () => {
      stoppingRef.current = true;
      teardown();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function openEchoGate() {
    echoGateRef.current = true;
    clearTimeout(echoTailRef.current);
  }

  function closeEchoGateWithTail() {
    // Keep the gate closed briefly after Grok finishes so speaker ring-off
    // and room echo don't leak in as a fake "user" utterance.
    clearTimeout(echoTailRef.current);
    echoTailRef.current = setTimeout(() => {
      echoGateRef.current = false;
    }, 800);
  }

  function addTurn(role, text) {
    setTurns((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.role === role && role === "assistant") {
        // Merge consecutive assistant deltas.
        const next = [...prev];
        next[next.length - 1] = { role, text: last.text + text };
        return next;
      }
      return [...prev, { role, text }].slice(-30);
    });
  }

  async function start() {
    setError("");
    setState("connecting");
    setTurns([]);
    stoppingRef.current = false;

    const socket = new WebSocket(wsUrl("/ws/voice"));
    socket.binaryType = "arraybuffer";
    socketRef.current = socket;

    const playback = await createPcmPlayer(OUTPUT_RATE);
    playbackRef.current = playback;

    socket.onopen = async () => {
      try {
        captureRef.current = await startPcmCapture({
          sampleRate: INPUT_RATE,
          onFrame: (buffer) => {
            if (echoGateRef.current) return; // interviewer is talking — don't echo it back
            if (socket.readyState === WebSocket.OPEN) socket.send(buffer);
          },
          onError: (err) => setError(err.message),
        });
      } catch (err) {
        setError(err.message || "Microphone access denied.");
        setState("error");
        socket.close();
      }
    };

    socket.onmessage = (event) => {
      if (typeof event.data !== "string") {
        // Binary = assistant audio PCM24k
        playback.push(new Int16Array(event.data));
        openEchoGate();
        setSpeaking(true);
        return;
      }
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }

      switch (msg.type) {
        case "voice.ready":
          setState("live");
          setModel(msg.model || "");
          // Kick off the interview (proxy turns this into user item + response.create).
          socket.send(JSON.stringify({ type: "interview_kickoff" }));
          break;
        case "response.created":
          openEchoGate();
          break;
        case "response.output_audio.delta":
          if (msg.delta) {
            playback.push(base64ToInt16(msg.delta));
            openEchoGate();
            setSpeaking(true);
          }
          break;
        case "response.output_audio_transcript.delta":
          if (msg.delta) addTurn("assistant", msg.delta);
          break;
        case "response.audio_transcript.delta":
          if (msg.delta) addTurn("assistant", msg.delta);
          break;
        case "conversation.item.input_audio_transcription.completed":
          if (msg.transcript) {
            setPartial("");
            addTurn("user", msg.transcript);
          }
          break;
        case "conversation.item.input_audio_transcription.updated":
          setPartial(msg.transcript || "");
          break;
        case "input_audio_buffer.speech_started":
          playback.clear();
          setSpeaking(false);
          break;
        case "response.done":
          setSpeaking(false);
          closeEchoGateWithTail();
          break;
        case "error":
          setError(msg.message || msg.error?.message || "Voice error");
          setState("error");
          break;
        default:
          break;
      }
    };

    socket.onerror = () => {
      setError("Voice connection error — is the server running?");
      setState("error");
    };

    socket.onclose = () => {
      clearTimeout(echoTailRef.current);
      echoGateRef.current = false;
      if (!stoppingRef.current && state !== "error") {
        setError("Voice session ended unexpectedly.");
      }
      setState("idle");
      setSpeaking(false);
    };
  }

  async function stop() {
    stoppingRef.current = true;
    await teardown();
    setState("idle");
  }

  async function teardown() {
    try {
      socketRef.current?.close();
    } catch {
      /* ignore */
    }
    socketRef.current = null;
    if (captureRef.current) {
      await captureRef.current.stop();
      captureRef.current = null;
    }
    if (playbackRef.current) {
      playbackRef.current.close();
      playbackRef.current = null;
    }
    setPartial("");
    setSpeaking(false);
  }

  return (
    <div className="control-bar voice-bar">
      <div>
        <p className="label">Two-way voice mock (Think Fast 2.0)</p>
        <p className="hint">
          Real conversation: Grok interviews you by voice, hears your answers,
          and follows up. <strong>Use headphones</strong> — on speakers the mic
          can hear Grok and it may talk to itself (echo gate helps, headphones
          are better). Wait for Grok to finish before answering.
        </p>
        {model ? <p className="voice-model">model: {model}</p> : null}
      </div>
      <div className="actions">
        {state !== "live" ? (
          <button
            className="primary"
            disabled={state === "connecting"}
            onClick={start}
          >
            {state === "connecting" ? "Connecting…" : "Start voice mock"}
          </button>
        ) : (
          <button className="danger" onClick={stop}>
            End interview
          </button>
        )}
      </div>

      {state === "live" ? (
        <div className="voice-live">
          <p className={`status ${speaking ? "status-listening" : ""}`}>
            {speaking
              ? "Interviewer speaking… (mic muted until they finish)"
              : "Your turn — answer out loud"}
          </p>
          <div className="voice-transcript">
            {turns.length === 0 && !partial ? (
              <p className="empty">Say hello to start…</p>
            ) : null}
            {turns.map((t, i) => (
              <p key={i} className={`speaker-${t.role === "user" ? "you" : "interviewer"}`}>
                <span className={`who who-${t.role === "user" ? "you" : "interviewer"}`}>
                  {t.role === "user" ? "You" : "Interviewer"}
                </span>
                {t.text}
              </p>
            ))}
            {partial ? <p className="partial">{partial}</p> : null}
          </div>
        </div>
      ) : null}
      {error ? <p className="error">{error}</p> : null}
    </div>
  );
}

function base64ToInt16(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new Int16Array(bytes.buffer);
}

async function createPcmPlayer(sampleRate) {
  const ctx = new AudioContext({ sampleRate });
  let playhead = ctx.currentTime + 0.05;
  let alive = true;

  function push(pcm) {
    if (!alive || !pcm?.length) return;
    const buffer = ctx.createBuffer(1, pcm.length, sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i += 1) {
      data[i] = pcm[i] / 32768;
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    const startAt = Math.max(playhead, ctx.currentTime + 0.02);
    source.start(startAt);
    playhead = startAt + buffer.duration;
  }

  return {
    push,
    clear() {
      playhead = ctx.currentTime + 0.05;
    },
    close() {
      alive = false;
      if (ctx.state !== "closed") ctx.close();
    },
  };
}
