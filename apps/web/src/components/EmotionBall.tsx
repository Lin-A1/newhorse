import { useEffect, useRef, useState } from "react"

/**
 * EmotionBall v2 — procedural expression engine (architecture inspired by the
 * emotion-ball project: parametric eye-ring outlines morphed on one rAF loop
 * over a glossy sphere). All geometry is generated, no traced data.
 *
 * Eye shapes are sampled as closed N-point loops so any expression can morph
 * into any other smoothly. Body carries breathing + squash. States:
 * idle / thinking / speaking / happy / sad / error / listening.
 */

export type Mood = "idle" | "thinking" | "speaking" | "happy" | "sad" | "error"

const MOOD_COLOR: Record<Mood, { base: string; glow: string }> = {
  idle: { base: "#5b7cfa", glow: "#8ea5ff" },
  thinking: { base: "#9b6dfa", glow: "#c0a1ff" },
  speaking: { base: "#2fbf8f", glow: "#6fe0bd" },
  happy: { base: "#f0a53c", glow: "#ffd07a" },
  sad: { base: "#64789f", glow: "#93a6c9" },
  error: { base: "#e5506a", glow: "#ff8f9f" },
}

const N = 24 // points per eye loop
const TAU = Math.PI * 2

type EyeShape = "round" | "blink" | "happy" | "half" | "wide" | "cross"

/** One closed eye loop, centered at (0,0), nominal radius ~1. */
function eyeLoop(shape: EyeShape, t: number): Array<[number, number]> {
  const pts: Array<[number, number]> = []
  for (let i = 0; i < N; i++) {
    const a = (i / N) * TAU - Math.PI / 2 // start at top
    let x = Math.cos(a) * 4.4
    let y = Math.sin(a) * 5.2
    switch (shape) {
      case "round":
        break
      case "wide":
        x = Math.cos(a) * 5
        y = Math.sin(a) * 6
        break
      case "blink": {
        const squash = Math.max(0.08, Math.abs(Math.cos(a)) * 0.16)
        y = Math.sin(a) * squash * 5.2
        break
      }
      case "happy": {
        // ^-arc: the bottom rises to meet the top -> thin crescent open downward
        const k = (Math.sin(a) + 1) / 2 // 0 top, 1 bottom
        const lift = k * k * 7.4
        y = Math.sin(a) * 5.2 - lift * 0.9 + 2.4
        x = Math.cos(a) * 4.6
        break
      }
      case "half": {
        // sleepy D: flat top, round bottom
        if (Math.sin(a) < 0) y = Math.sin(a) * 1.1
        break
      }
      case "cross": {
        // thin diamond (X is drawn as strokes on top)
        const d = Math.abs(Math.cos(a)) + Math.abs(Math.sin(a))
        x = (Math.cos(a) / d) * 5
        y = (Math.sin(a) / d) * 5
        break
      }
    }
    // subtle life: micro-jitter during thinking
    if (t > 0) {
      x += Math.sin(t * 13 + i * 1.7) * 0.06
      y += Math.cos(t * 11 + i * 2.1) * 0.06
    }
    pts.push([x, y])
  }
  return pts
}

const SHAPE_OF: Record<Mood, EyeShape> = { idle: "round", thinking: "half", speaking: "round", happy: "happy", sad: "half", error: "cross" }
const EYE2_SHAPE: Record<Mood, EyeShape> = { idle: "round", thinking: "half", speaking: "round", happy: "happy", sad: "blink", error: "cross" }

function lerpLoops(a: Array<[number, number]>, b: Array<[number, number]>, k: number): string {
  let d = ""
  for (let i = 0; i < N; i++) {
    const x = a[i]![0] + (b[i]![0] - a[i]![0]) * k
    const y = a[i]![1] + (b[i]![1] - a[i]![1]) * k
    d += `${i === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)} `
  }
  return d + "Z"
}

export function EmotionBall({ mood = "idle", size = 44 }: { mood?: Mood; size?: number }) {
  const [t, setT] = useState(0)
  const [blinkK, setBlinkK] = useState(0)
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
    // blink envelope: 0 -> 1 -> 0 every 2.8-4.4s (skipped while cross/happy)
    if (mood === "error" || mood === "happy") return
    let alive = true
    let timer: ReturnType<typeof setTimeout>
    const run = (): void => {
      const close = (): void => {
        if (!alive) return
        setBlinkK(1)
        setTimeout(() => {
          if (!alive) return
          setBlinkK(0)
          run()
        }, 130)
      }
      timer = setTimeout(close, 2800 + Math.random() * 1600)
    }
    run()
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [mood])

  const c = MOOD_COLOR[mood]
  const breathe = 1 + Math.sin(t * 1.6) * 0.018
  const squash = mood === "speaking" ? 1 + Math.abs(Math.sin(t * 8)) * 0.045 : 1
  const tilt = mood === "thinking" ? Math.sin(t * 1.2) * 4 : 0
  const sway = mood === "idle" ? Math.sin(t * 0.9) * 1.1 : 0

  const base = eyeLoop(SHAPE_OF[mood], t)
  const other = eyeLoop(EYE2_SHAPE[mood], t)
  const blinkShape = eyeLoop("blink", t)
  const left = lerpLoops(base, blinkShape, blinkK)
  const right = lerpLoops(other, blinkShape, blinkK)
  // eyes track a slow figure-eight while thinking
  const gazeX = mood === "thinking" ? Math.sin(t * 2.1) * 2.2 : Math.sin(t * 0.7) * 0.6
  const gazeY = mood === "thinking" ? Math.cos(t * 4.2) * 1.2 : Math.sin(t * 0.5) * 0.4
  const mouthOpen = mood === "speaking" ? Math.abs(Math.sin(t * 8.5)) : mood === "happy" ? 0.7 : mood === "sad" ? -0.4 : 0.12
  const mouth = `M -6.5 ${7 + mouthOpen * 1.5} Q 0 ${7 + mouthOpen * 6.5} 6.5 ${7 + mouthOpen * 1.5}`
  const mouthFlip = mood === "sad" ? `M -6.5 ${11 - mouthOpen * 4} Q 0 ${6} 6.5 ${11 - mouthOpen * 4}` : mouth

  return (
    <svg width={size} height={size} viewBox="-24 -24 48 48" style={{ overflow: "visible" }} aria-label={`assistant ${mood}`}>
      <defs>
        <radialGradient id="nhBall" cx="34%" cy="28%" r="78%">
          <stop offset="0%" stopColor={c.glow} />
          <stop offset="55%" stopColor={c.base} />
          <stop offset="100%" stopColor={c.base} stopOpacity="0.82" />
        </radialGradient>
        <radialGradient id="nhBallGloss" cx="30%" cy="22%" r="30%">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.85" />
          <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* orbit particles while thinking */}
      {mood === "thinking" &&
        [0, 1, 2].map((i) => {
          const a = t * 2.6 + (i * TAU) / 3
          return <circle key={i} cx={Math.cos(a) * 19} cy={Math.sin(a) * 19} r={1.9} fill={c.glow} opacity={0.55 + Math.sin(a * 2) * 0.25} />
        })}

      <g transform={`translate(${sway},0)`}>
        <g transform={`scale(${breathe * squash},${(2 - breathe * squash) * 1}) rotate(${tilt})`}>
          <circle r="15" fill="url(#nhBall)" />
          <circle r="15" fill="none" stroke="#ffffff" strokeOpacity="0.14" strokeWidth="0.7" />
          {/* bottom ambient shade */}
          <ellipse cx="0" cy="9.5" rx="10.5" ry="5" fill="#0b0f19" opacity="0.18" />
          {/* gloss */}
          <ellipse cx="-5.4" cy="-7.2" rx="6.4" ry="4.2" fill="url(#nhBallGloss)" transform="rotate(-18)" />
          <circle cx="6.8" cy="-9.4" r="1.5" fill="#ffffff" opacity="0.75" />
          {/* eyes (morphing loops) */}
          <g transform={`translate(${gazeX - 5.4},${gazeY - 2.5})`}>
            <path d={left} fill="#0b0f19" />
            {mood === "error" && <path d="M -4 -4 L 4 4 M 4 -4 L -4 4" stroke={c.glow} strokeWidth="1.4" strokeLinecap="round" />}
          </g>
          <g transform={`translate(${gazeX + 5.4},${gazeY - 2.5})`}>
            <path d={right} fill="#0b0f19" />
            {mood === "error" && <path d="M -4 -4 L 4 4 M 4 -4 L -4 4" stroke={c.glow} strokeWidth="1.4" strokeLinecap="round" />}
          </g>
          {/* mouth */}
          <path d={mouthFlip} stroke="#0b0f19" strokeWidth="1.6" fill="none" strokeLinecap="round" />
          {/* blush when happy */}
          {mood === "happy" && (
            <g fill="#ff9d9d" opacity="0.55">
              <ellipse cx="-9.5" cy="4.5" rx="2.6" ry="1.5" />
              <ellipse cx="9.5" cy="4.5" rx="2.6" ry="1.5" />
            </g>
          )}
        </g>
      </g>
    </svg>
  )
}
