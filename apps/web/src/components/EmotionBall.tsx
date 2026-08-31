import { useEffect, useRef, useState } from "react"

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

export function EmotionBall({ mood = "idle", size = 44, burstKey = 0 }: { mood?: Mood; size?: number; burstKey?: number }) {
  const [t, setT] = useState(0)
  const [blink, setBlink] = useState(1) // openness 0.05..1, eased
  const [confetti, setConfetti] = useState<Confetti[]>([])
  const raf = useRef(0)
  const started = useRef(0)

  useEffect(() => {
    let loop = (ts: number): void => {
      if (!started.current) started.current = ts
      setT((ts - started.current) / 1000)
      raf.current = requestAnimationFrame(loop)
    }
    raf.current = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf.current)
  }, [])

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

  // completion confetti (one burst per burstKey change)
  useEffect(() => {
    if (burstKey <= 0) return
    const pieces: Confetti[] = []
    for (let i = 0; i < 24; i++) {
      const a = Math.random() * TAU
      const speed = 170 + Math.random() * 190
      pieces.push({
        x: 0,
        y: 0,
        vx: Math.cos(a) * speed,
        vy: Math.sin(a) * speed - 120,
        life: 0,
        ttl: 450 + Math.random() * 400,
        color: CONFETTI_COLORS[i % CONFETTI_COLORS.length]!,
        star: Math.random() < 0.15,
        spin: Math.random() * TAU,
      })
    }
    setConfetti(pieces)
    const t0 = performance.now()
    let anim = 0
    const tick = (ts: number): void => {
      const dt = (ts - t0) / 1000
      setConfetti((prev) =>
        prev
          .map((p) => ({ ...p, x: p.x + (p.vx * dt) / 1000, y: p.y + (p.vy * dt) / 1000 + (490 * dt * dt) / 2, life: dt * 1000 }))
          .filter((p) => p.life < p.ttl),
      )
      if (dt < 0.9) anim = requestAnimationFrame(tick)
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

  return (
    <svg width={size} height={size} viewBox="-26 -26 52 52" style={{ overflow: "visible" }} aria-label={`assistant ${mood}`}>
      <defs>
        <radialGradient id="nhBody" cx="36%" cy="30%" r="80%">
          <stop offset="0%" stopColor="#ffffff" />
          <stop offset="58%" stopColor={body} />
          <stop offset="100%" stopColor={shade} />
        </radialGradient>
      </defs>

      {/* orbit ring while thinking */}
      {mood === "thinking" && (
        <ellipse cx="0" cy="0" rx="19" ry="7" fill="none" stroke="#c9c5b8" strokeWidth="0.8" opacity="0.5" transform={`rotate(${8 + Math.sin(t * 0.9) * 10}) scale(1,${1 + Math.sin(t * 1.3) * 0.15})`}>
          <circle r="1.6" fill="#8b8578" />
        </ellipse>
      )}
      {mood === "thinking" &&
        [0, 1].map((i) => {
          const a = t * (1.9 + i * 0.4) + i * Math.PI
          return <circle key={i} cx={Math.cos(a) * 19} cy={Math.sin(a) * 7} r={1.5} fill="#b3aea0" opacity={0.75} transform={`rotate(${8})`} />
        })}

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
          <circle r="15" fill="url(#nhBody)" />
          <circle r="14.6" fill="none" stroke="#0b0f19" strokeOpacity="0.07" strokeWidth="0.6" />
          {/* eyes: black filled capsules (asymmetric supported) */}
          <g transform={`translate(${gx - gap},${gy + eyeY}) rotate(${e1.rot})`}>
            <path d={capsuleD(0, 0, e1.w, e1.h)} fill="#1a1a1a" stroke="#1a1a1a" strokeWidth="1.6" strokeLinejoin="round" />
          </g>
          <g transform={`translate(${gx + gap},${gy + eyeY}) rotate(${e2.rot})`}>
            <path d={capsuleD(0, 0, e2.w, e2.h)} fill="#1a1a1a" stroke="#1a1a1a" strokeWidth="1.6" strokeLinejoin="round" />
          </g>
          {/* zzz while interrupted */}
          {mood === "interrupted" && (
            <text x="12" y="-10" fontSize="7" fill="#8b8578" fontFamily="ui-monospace, monospace" opacity={0.4 + Math.sin(t * 2) * 0.3}>
              z
            </text>
          )}
        </g>
      </g>
    </svg>
  )
}
