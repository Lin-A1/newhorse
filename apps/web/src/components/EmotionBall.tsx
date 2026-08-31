import { useEffect, useId, useRef, useState } from "react"

/**
 * EmotionBall v4 — the emotion-ball design language, fully:
 * cream sphere, ALL expression in black filled capsule eyes (morphing,
 * asymmetric), per-emotion body tint only at peaks, state keyframes
 * (receive-nod, error flash), confetti on completion, orbit ring while
 * thinking, eased blink, NO mouth. One rAF loop.
 */
export type Mood =
  | "idle"
  | "receiving"
  | "thinking"
  | "busy"
  | "searching"
  | "speaking"
  | "done"
  | "error"
  | "waiting"
  | "interrupted"

interface EyeSpec {
  shape: "capsule" | "line" | "dot"
  rot: number
  w: number
  h: number
  dy?: number
  gap?: number
}

interface BallStyle {
  body: string
  shade: string
  eyes: EyeSpec
  eye2?: EyeSpec
  /** flip body between body/shade tones at these ms marks (error flash) */
  flash?: number[]
}

const STYLES: Record<Mood, BallStyle> = {
  idle: { body: "#f4f1e8", shade: "#d8d4c6", eyes: { shape: "capsule", rot: 8, w: 4.6, h: 1.9, gap: 6.4 } },
  receiving: { body: "#f4f1e8", shade: "#d8d4c6", eyes: { shape: "capsule", rot: 8, w: 4.6, h: 1.9, gap: 6.4 } },
  thinking: { body: "#f4f1e8", shade: "#d8d4c6", eyes: { shape: "capsule", rot: -14, w: 4.2, h: 1.9, dy: -0.6, gap: 5.6 } },
  busy: { body: "#f4f1e8", shade: "#d8d4c6", eyes: { shape: "capsule", rot: -6, w: 4.4, h: 1.6, gap: 6.0 } },
  searching: { body: "#f4f1e8", shade: "#d8d4c6", eyes: { shape: "capsule", rot: -20, w: 4.0, h: 1.8, gap: 5.8 } },
  speaking: { body: "#f4f1e8", shade: "#d8d4c6", eyes: { shape: "capsule", rot: 5, w: 4.6, h: 2.1, gap: 6.4 } },
  done: { body: "#f6efe4", shade: "#e5dcc9", eyes: { shape: "capsule", rot: -25, w: 5.0, h: 2.2, dy: -1.2, gap: 6.6 }, eye2: { shape: "capsule", rot: 25, w: 5.0, h: 2.2, dy: -1.2, gap: 6.6 } },
  error: { body: "#e25b5b", shade: "#de5555", flash: [0, 170, 340, 510, 700], eyes: { shape: "capsule", rot: -6, w: 5.2, h: 2.6, gap: 6.4 }, eye2: { shape: "capsule", rot: 6, w: 5.2, h: 2.6, gap: 6.4 } },
  waiting: { body: "#f4f1e8", shade: "#d8d4c6", eyes: { shape: "capsule", rot: 12, w: 4.6, h: 1.9, gap: 6.4 } },
  interrupted: { body: "#ebe8e2", shade: "#cfcbc1", eyes: { shape: "capsule", rot: 8, w: 4.6, h: 0.95, gap: 6.4 } },
}

const N = 24
const TAU = Math.PI * 2

function capsuleD(x: number, y: number, w: number, h: number): string {
  const hh = Math.max(h, 0.4)
  const r = hh
  return `M ${x - w / 2 + r} ${y - hh / 2} L ${x + w / 2 - r} ${y - hh / 2} A ${r} ${r} 0 0 1 ${x + w / 2} ${y - hh / 2 + r} L ${x + w / 2} ${y + hh / 2 - r} A ${r} ${r} 0 0 1 ${x + w / 2 - r} ${y + hh / 2} L ${x - w / 2 + r} ${y + hh / 2} A ${r} ${r} 0 0 1 ${x - w / 2} ${y + hh / 2 - r} L ${x - w / 2} ${y - hh / 2 + r} A ${r} ${r} 0 0 1 ${x - w / 2 + r} ${y - hh / 2} Z`
}

interface Confetti {
  x: number
  y: number
  vx: number
  vy: number
  life: number
  ttl: number
  color: string
  star: boolean
  spin: number
}

const CONFETTI_COLORS = ["#7d9bff", "#a78bfa", "#f4c34e", "#34d399", "#fb7185"]

/** Mood-tinted halo glow behind the ball (alpha ramps are baked in the gradient). */
const HALO: Record<Mood, string> = {
  idle: "#f4f1e8",
  receiving: "#f4f1e8",
  thinking: "#7d9bff",
  busy: "#b18cf7",
  searching: "#35c3bd",
  speaking: "#7d9bff",
  done: "#f4c34e",
  error: "#fb7185",
  waiting: "#f4f1e8",
  interrupted: "#8b93a7",
}

export function EmotionBall({ mood = "idle", size = 44 }: { mood?: Mood; size?: number }) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "")
  const [t, setT] = useState(0)
  const [blink, setBlink] = useState(1) // openness 0.05..1, eased
  const [confetti, setConfetti] = useState<Confetti[]>([])
  const [burstKey, setBurstKey] = useState(0)
  const raf = useRef(0)
  const started = useRef(0)

  // Drive the clock only while there is something to animate (a live mood).
  // An idle ball costs nothing and breathes/blinks on cheap timers instead.
  useEffect(() => {
    if (mood === "idle") return
    let loop = (ts: number): void => {
      if (!started.current) started.current = ts
      setT((ts - started.current) / 1000)
      raf.current = requestAnimationFrame(loop)
    }
    started.current = 0
    raf.current = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf.current)
  }, [mood])

  // eased blink envelope (0.05..1) at random intervals
  useEffect(() => {
    if (mood === "error") return
    let alive = true
    let timer: ReturnType<typeof setTimeout>
    let anim: ReturnType<typeof requestAnimationFrame>
    const run = (): void => {
      timer = setTimeout(() => {
        if (!alive) return
        const t0 = performance.now()
        const ease = (ts: number): void => {
          if (!alive) return
          const dt = ts - t0
          // close 90ms ease-out, hold 40ms, open 120ms ease-in
          const k = dt < 90 ? 1 - dt / 90 : dt < 130 ? 0.05 : Math.min(1, 0.05 + ((dt - 130) / 120) * 0.95)
          setBlink(Math.max(0.05, k))
          if (dt < 250) anim = requestAnimationFrame(ease)
          else {
            setBlink(1)
            run()
          }
        }
        anim = requestAnimationFrame(ease)
      }, 2800 + Math.random() * 1600)
    }
    run()
    return () => {
      alive = false
      clearTimeout(timer)
      cancelAnimationFrame(anim)
    }
  }, [mood])

  // auto-burst once each time the ball enters the done mood
  useEffect(() => {
    if (mood !== "done") return
    setBurstKey((k) => k + 1)
  }, [mood])

  // completion confetti (one burst per burstKey change)
  useEffect(() => {
    if (burstKey <= 0) return
    const pieces: Confetti[] = []
    for (let i = 0; i < 26; i++) {
      const a = Math.random() * TAU
      const speed = 26 + Math.random() * 46 // SVG units/sec (viewBox is ~60 wide)
      pieces.push({
        x: 0,
        y: 0,
        vx: Math.cos(a) * speed,
        vy: Math.sin(a) * speed - 34,
        life: 0,
        ttl: 700 + Math.random() * 500,
        color: CONFETTI_COLORS[i % CONFETTI_COLORS.length]!,
        star: Math.random() < 0.15,
        spin: Math.random() * TAU,
      })
    }
    setConfetti(pieces)
    const t0 = performance.now()
    let last = t0
    let anim = 0
    const tick = (ts: number): void => {
      const dt = Math.min((ts - last) / 1000, 0.05) // frame delta (seconds), clamped
      last = ts
      const g = 200 // gravity, SVG units/sec^2
      setConfetti((prev) =>
        prev
          .map((p) => {
            const vy = p.vy + g * dt
            return { ...p, x: p.x + p.vx * dt, y: p.y + p.vy * dt + 0.5 * g * dt * dt, vy, life: p.life + dt * 1000 }
          })
          .filter((p) => p.life < p.ttl),
      )
      if (ts - t0 < 1600) anim = requestAnimationFrame(tick)
      else setConfetti([])
    }
    anim = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(anim)
  }, [burstKey])

  const st = STYLES[mood]
  // error flash sequence
  let body = st.body
  let shade = st.shade
  if (st.flash) {
    const inFlash = st.flash.some((mark, i) => t * 1000 >= mark && (i === st.flash!.length - 1 || t * 1000 < st.flash![i + 1]!)) && Math.floor((t * 1000) / 170) % 2 === 0
    body = inFlash ? "#f6f3ec" : st.body
    shade = inFlash ? "#d8d4c6" : st.shade
    if (t * 1000 > 700) {
      body = "#de5555"
      shade = "#b8453a"
    }
  }

  const breathe = 1 + Math.sin(t * 1.7) * 0.016
  const squash = mood === "speaking" ? 1 + Math.abs(Math.sin(t * 8)) * 0.04 : 1
  const nod = mood === "receiving" ? (t < 0.7 ? Math.sin((t / 0.7) * Math.PI) * 0.08 : 0) : 0
  const settle = mood === "interrupted" ? 0.97 : 1
  const tilt = mood === "thinking" ? Math.sin(t * 1.1) * 5 : mood === "done" ? Math.sin(t * 2.2) * 3 : 0
  const sway = mood === "idle" || mood === "waiting" ? Math.sin(t * 0.85) * 1.3 : 0
  const bounce = mood === "done" ? (t < 1.1 ? -Math.sin((t / 1.1) * Math.PI) * 5 : 0) : 0

  // eye pulse while speaking (token rhythm)
  const pulse = mood === "speaking" ? 1 + Math.sin(t * 9.2) * 0.1 : 1
  // gaze
  const gx = mood === "thinking" ? Math.sin(t * 2.4) * 4.5 : mood === "busy" ? Math.sin(t * 5.2) * 3 : mood === "searching" ? Math.sin(t * 9) * 5.5 : 0
  const gy = mood === "thinking" ? -3 + Math.sin(t * 3.1) * 1.2 : mood === "busy" ? Math.sin(t * 7) * 2 : mood === "waiting" ? Math.sin(t * 2.9) * 3 : 0

  const e1 = { ...st.eyes, h: Math.max(st.eyes.h * blink * pulse, 0.35) }
  const e2spec = st.eye2 ?? st.eyes
  const e2 = { ...e2spec, h: Math.max(e2spec.h * blink * pulse, 0.35) }
  const eyeY = -2.4 + (st.eyes.dy ?? 0)
  const gap = (st.eyes.gap ?? 6.4) / 2
  // Small rendered sizes (header/sidebar) need taller eyes to stay legible;
  // width scales gently so the two capsules never merge across the gap.
  // The hero gets a slight presence boost.
  const eyeSX = size < 60 ? Math.min(1.35, 60 / size) : size >= 96 ? 1.12 : 1
  const eyeSY = size < 60 ? Math.min(2.0, 64 / size) : size >= 96 ? 1.12 : 1

  const haloColor = HALO[mood]
  const haloPulse = mood === "thinking" || mood === "busy" || mood === "speaking" || mood === "searching" ? 0.85 + Math.sin(t * 2.2) * 0.25 : mood === "done" ? 1 : 0.55

  return (
    <svg width={size} height={size} viewBox="-30 -30 60 60" style={{ overflow: "visible" }} aria-label={`assistant ${mood}`}>
      <defs>
        <radialGradient id={`${uid}body`} cx="36%" cy="30%" r="80%">
          <stop offset="0%" stopColor="#ffffff" />
          <stop offset="58%" stopColor={body} />
          <stop offset="100%" stopColor={shade} />
        </radialGradient>
        <radialGradient id={`${uid}halo`}>
          <stop offset="0%" stopColor={haloColor} stopOpacity="0.5" />
          <stop offset="55%" stopColor={haloColor} stopOpacity="0.14" />
          <stop offset="100%" stopColor={haloColor} stopOpacity="0" />
        </radialGradient>
        <filter id={`${uid}shadow`} x="-60%" y="-120%" width="220%" height="340%">
          <feGaussianBlur stdDeviation="1.4" />
        </filter>
      </defs>

      {/* mood halo */}
      <circle r="27" fill={`url(#${uid}halo)`} opacity={haloPulse} style={{ transition: "opacity .4s ease" }} />

      {/* comet orbit ring while thinking/searching */}
      {(mood === "thinking" || mood === "searching") &&
        [0, 1, 2].map((i) => {
          const speed = mood === "searching" ? 2.6 : 1.8
          const a = t * speed + (i * TAU) / 3
          const rx = 21
          const ry = 8.5
          const tilt = 10
          const x = Math.cos(a) * rx
          const y = Math.sin(a) * ry
          const rad = (tilt * Math.PI) / 180
          const X = x * Math.cos(rad) - y * Math.sin(rad)
          const Y = x * Math.sin(rad) + y * Math.cos(rad)
          const trailA = a - 0.9
          const tx = Math.cos(trailA) * rx
          const ty = Math.sin(trailA) * ry
          const TX = tx * Math.cos(rad) - ty * Math.sin(rad)
          const TY = tx * Math.sin(rad) + ty * Math.cos(rad)
          return (
            <g key={i}>
              <line x1={TX} y1={TY} x2={X} y2={Y} stroke={i === 0 ? "#9db2ff" : "#b9b4a6"} strokeWidth="1.4" strokeLinecap="round" opacity="0.55" />
              <circle cx={X} cy={Y} r={i === 0 ? 1.7 : 1.3} fill={i === 0 ? "#cdd8ff" : "#cfcabb"} />
            </g>
          )
        })}

      {/* soft contact shadow (blurred; compresses/fades with the bounce) */}
      <ellipse cx={sway} cy={20} rx={11 - bounce * 0.6} ry={3.2 - bounce * 0.06} fill="#000" opacity={mood === "done" ? 0.18 - bounce / 120 : 0.22} filter={`url(#${uid}shadow)`} />


      {/* confetti */}
      {confetti.map((p, i) => (
        <g key={i} transform={`translate(${p.x},${p.y}) rotate(${(p.spin + p.life / 60) * 57.3})`}>
          {p.star ? (
            <path d="M 0 -3 L 0.9 -0.9 3 0 0.9 0.9 0 3 -0.9 0.9 -3 0 -0.9 -0.9 Z" fill="#f4c34e" />
          ) : (
            <rect x={-2.2} y={-1} width={4.4} height={2} rx={0.8} fill={p.color} />
          )}
        </g>
      ))}

      <g transform={`translate(${sway},${bounce})`}>
        <g transform={`scale(${breathe * squash * settle},${2 - breathe * squash * settle}) rotate(${tilt}) translate(0,${nod * 15})`}>
          <circle r="15" fill={`url(#${uid}body)`} />
          <circle r="14.6" fill="none" stroke="#0b0f19" strokeOpacity="0.07" strokeWidth="0.6" />
          {/* eyes: black filled capsules (asymmetric supported); enlarged at small
              render sizes so the face stays legible in the header/sidebar */}
          <g transform={`translate(${gx - gap},${gy + eyeY}) rotate(${e1.rot}) scale(${eyeSX},${eyeSY})`}>
            <path d={capsuleD(0, 0, e1.w, e1.h)} fill="#1a1a1a" />
          </g>
          <g transform={`translate(${gx + gap},${gy + eyeY}) rotate(${e2.rot}) scale(${eyeSX},${eyeSY})`}>
            <path d={capsuleD(0, 0, e2.w, e2.h)} fill="#1a1a1a" />
          </g>
          {/* zzz while interrupted */}
          {mood === "interrupted" && (
            <text x="11" y="-9" fontSize="7" fill="#8b8578" fontFamily="ui-monospace, monospace" opacity={0.4 + Math.sin(t * 2) * 0.3}>
              z
            </text>
          )}
        </g>
      </g>
    </svg>
  )
}
