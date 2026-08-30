import { useEffect, useRef, useState } from "react"

/**
 * EmotionBall — the 管家/助理's face. A self-drawn SVG ball with an
 * expression state machine (idle/thinking/speaking/happy/sad/error) driven by
 * animation primitives (blink, pulse, glance, jitter) on one rAF loop —
 * architecture borrowed from the emotion-ball engine, visuals our own.
 */
export type Mood = "idle" | "thinking" | "speaking" | "happy" | "sad" | "error"

const MOOD_COLOR: Record<Mood, string> = {
  idle: "#6d8bff",
  thinking: "#b48bff",
  speaking: "#4fd1a5",
  happy: "#ffd166",
  sad: "#7c8db0",
  error: "#ff6d7a",
}

export function EmotionBall({ mood = "idle", size = 44 }: { mood?: Mood; size?: number }) {
  const [blink, setBlink] = useState(false)
  const [t, setT] = useState(0)
  const raf = useRef(0)

  useEffect(() => {
    let start = 0
    const loop = (ts: number): void => {
      if (!start) start = ts
      setT((ts - start) / 1000)
      raf.current = requestAnimationFrame(loop)
    }
    raf.current = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf.current)
  }, [])

  useEffect(() => {
    // Blink loop: quick close every 2.6-4.2s (idle/happy only).
    if (mood === "thinking" || mood === "speaking") return
    let alive = true
    let timer: ReturnType<typeof setTimeout>
    const schedule = (): void => {
      timer = setTimeout(() => {
        if (!alive) return
        setBlink(true)
        setTimeout(() => {
          setBlink(false)
          schedule()
        }, 140)
      }, 2600 + Math.random() * 1600)
    }
    schedule()
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [mood])

  const color = MOOD_COLOR[mood]
  const wobble = mood === "thinking" ? Math.sin(t * 5) * 2 : mood === "idle" ? Math.sin(t * 1.4) * 1.2 : 0
  const scale = mood === "speaking" ? 1 + Math.abs(Math.sin(t * 7)) * 0.05 : mood === "thinking" ? 1 + Math.sin(t * 3) * 0.03 : 1
  const eyeH = blink ? 1.2 : mood === "happy" ? 5 : 8
  const mouth =
    mood === "happy"
      ? "M -8 8 Q 0 15 8 8"
      : mood === "sad"
        ? "M -8 11 Q 0 5 8 11"
        : mood === "error"
          ? "M -7 10 L 7 10"
          : mood === "speaking"
            ? `M -7 9 Q 0 ${9 + Math.abs(Math.sin(t * 9)) * 5} 7 9`
            : "M -5 9 Q 0 12 5 9"

  return (
    <svg width={size} height={size} viewBox="-24 -24 48 48" style={{ overflow: "visible" }} aria-label={`assistant ${mood}`}>
      <defs>
        <radialGradient id="ballGrad" cx="35%" cy="30%">
          <stop offset="0%" stopColor={color} stopOpacity="0.95" />
          <stop offset="100%" stopColor={color} stopOpacity="0.55" />
        </radialGradient>
      </defs>
      {mood === "thinking" && (
        <g>
          {[0, 1, 2].map((i) => {
            const a = t * 3 + (i * Math.PI * 2) / 3
            return <circle key={i} cx={Math.cos(a) * 19} cy={Math.sin(a) * 19} r={2.2} fill={color} opacity={0.7} />
          })}
        </g>
      )}
      <g transform={`translate(${wobble},0) scale(${scale})`}>
        <circle r="15" fill="url(#ballGrad)" stroke={color} strokeWidth="1" />
        <ellipse cx="-5" cy="-4" rx="2.6" ry={eyeH / 2} fill="#0b0f19" />
        <ellipse cx="5" cy="-4" rx="2.6" ry={eyeH / 2} fill="#0b0f19" />
        <path d={mouth} stroke="#0b0f19" strokeWidth="1.8" fill="none" strokeLinecap="round" />
      </g>
    </svg>
  )
}
