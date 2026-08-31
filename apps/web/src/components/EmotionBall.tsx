import { useEffect, useId, useRef } from "react"

/**
 * EmotionBall v5 — emotion-ball design language, ZERO per-frame React renders.
 * The rAF loop writes SVG attributes directly through refs (breathing, gaze,
 * blink, orbit, confetti) so the surrounding tree stays settled — critical
 * for automation and CPU. React renders only the static skeleton per mood.
 * Gradient ids are namespaced per instance (useId) so several balls coexist.
 */
export type Mood = "idle" | "receiving" | "thinking" | "busy" | "searching" | "speaking" | "done" | "error" | "waiting" | "interrupted"

interface Style {
  body: string
  shade: string
  rot: number
  eyeW: number
  eyeH: number
  gap: number
  eyeDy: number
  rot2?: number
  flash?: boolean
}

const STYLES: Record<Mood, Style> = {
  idle: { body: "#f4f1e8", shade: "#d8d4c6", rot: 8, eyeW: 4.6, eyeH: 1.9, gap: 6.4, eyeDy: -2.4 },
  receiving: { body: "#f4f1e8", shade: "#d8d4c6", rot: 8, eyeW: 4.6, eyeH: 1.9, gap: 6.4, eyeDy: -2.4 },
  thinking: { body: "#f4f1e8", shade: "#d8d4c6", rot: -14, eyeW: 4.2, eyeH: 1.9, gap: 5.6, eyeDy: -3.0 },
  busy: { body: "#f4f1e8", shade: "#d8d4c6", rot: -6, eyeW: 4.4, eyeH: 1.6, gap: 6.0, eyeDy: -2.4 },
  searching: { body: "#f4f1e8", shade: "#d8d4c6", rot: -20, eyeW: 4.0, eyeH: 1.8, gap: 5.8, eyeDy: -2.4 },
  speaking: { body: "#f4f1e8", shade: "#d8d4c6", rot: 5, eyeW: 4.6, eyeH: 2.1, gap: 6.4, eyeDy: -2.4 },
  done: { body: "#f6efe4", shade: "#e5dcc9", rot: -25, eyeW: 5.0, eyeH: 2.2, gap: 6.6, eyeDy: -3.6, rot2: 25 },
  error: { body: "#e25b5b", shade: "#de5555", rot: -6, eyeW: 5.2, eyeH: 2.6, gap: 6.4, eyeDy: -2.4, rot2: 6, flash: true },
  waiting: { body: "#f4f1e8", shade: "#d8d4c6", rot: 12, eyeW: 4.6, eyeH: 1.9, gap: 6.4, eyeDy: -2.4 },
  interrupted: { body: "#ebe8e2", shade: "#cfcbc1", rot: 8, eyeW: 4.6, eyeH: 0.95, gap: 6.4, eyeDy: -2.4 },
}

function capsuleD(w: number, h: number): string {
  const hh = Math.max(h, 0.35)
  const r = hh
  const x = -w / 2
  const y = -hh / 2
  return `M ${x + r} ${y} L ${x + w - r} ${y} A ${r} ${r} 0 0 1 ${x + w} ${y + r} L ${x + w} ${y + hh - r} A ${r} ${r} 0 0 1 ${x + w - r} ${y + hh} L ${x + r} ${y + hh} A ${r} ${r} 0 0 1 ${x} ${y + hh - r} L ${x} ${y + r} A ${r} ${r} 0 0 1 ${x + r} ${y} Z`
}

export function EmotionBall({ mood = "idle", size = 44, burstKey = 0 }: { mood?: Mood; size?: number; burstKey?: number }) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "")
  const gradId = `nhBody${uid}`
  const gRef = useRef<SVGGElement>(null)
  const bodyRef = useRef<SVGCircleElement>(null)
  const e1Ref = useRef<SVGPathElement>(null)
  const e2Ref = useRef<SVGPathElement>(null)
  const e1gRef = useRef<SVGGElement>(null)
  const e2gRef = useRef<SVGGElement>(null)
  const ringRef = useRef<SVGEllipseElement>(null)
  const orb1Ref = useRef<SVGCircleElement>(null)
  const orb2Ref = useRef<SVGCircleElement>(null)
  const confettiRef = useRef<SVGGElement>(null)
  const raf = useRef(0)

  const styleRef = useRef(STYLES[mood])
  styleRef.current = STYLES[mood]
  const colors = ["#7d9bff", "#a78bfa", "#f4c34e", "#34d399", "#fb7185"]

  useEffect(() => {
    let start = 0
    const confetti: Array<{ x: number; y: number; vx: number; vy: number; born: number; color: string; star: boolean }> = []

    const loop = (ts: number): void => {
      if (!start) start = ts
      const t = (ts - start) / 1000
      const st = styleRef.current
      const g = gRef.current

      if (confettiRef.current && confetti.length > 0) {
        let html = ""
        let alive = 0
        for (const p of confetti) {
          const age = (ts - p.born) / 1000
          if (age < 0 || age > 0.9) continue
          alive++
          const x = p.x + p.vx * age
          const y = p.y + p.vy * age + 490 * age * age
          html += p.star
            ? `<path transform="translate(${x.toFixed(1)},${y.toFixed(1)}) rotate(${(age * 160) % 360})" d="M 0 -3 L 0.9 -0.9 3 0 0.9 0.9 0 3 -0.9 0.9 -3 0 -0.9 -0.9 Z" fill="#f4c34e"/>`
            : `<rect transform="translate(${x.toFixed(1)},${y.toFixed(1)}) rotate(${(age * 160) % 360})" x="-2.2" y="-1" width="4.4" height="2" rx="0.8" fill="${p.color}"/>`
        }
        confettiRef.current.innerHTML = html
        if (alive === 0) confetti.length = 0
      }

      if (g) {
        const breathe = 1 + Math.sin(t * 1.7) * 0.016
        const squash = mood === "speaking" ? 1 + Math.abs(Math.sin(t * 8)) * 0.04 : 1
        const settle = mood === "interrupted" ? 0.97 : 1
        const tilt = mood === "thinking" ? Math.sin(t * 1.1) * 5 : mood === "done" ? Math.sin(t * 2.2) * 3 : 0
        const sway = mood === "idle" || mood === "waiting" ? Math.sin(t * 0.85) * 1.3 : 0
        const bounce = mood === "done" && t < 1.1 ? -Math.sin((t / 1.1) * Math.PI) * 5 : 0
        const nod = mood === "receiving" && t < 0.7 ? Math.sin((t / 0.7) * Math.PI) * 1.2 : 0
        g.setAttribute("transform", `translate(${sway.toFixed(2)},${(bounce + nod).toFixed(2)}) scale(${(breathe * squash * settle).toFixed(3)},${(2 - breathe * squash * settle).toFixed(3)}) rotate(${tilt.toFixed(2)})`)
      }

      // error flash (body circle repaint)
      if (g && bodyRef.current && st.flash) {
        const hold = t > 0.7
        const phase = Math.floor((t * 1000) / 170) % 2
        bodyRef.current.setAttribute("fill", hold ? "url(#" + gradId + ")" : phase === 0 ? "#e25b5b" : "#f6f3ec")
      }

      // eyes: eased blink + gaze + speaking pulse
      const blinkCycle = (t % 3.6) < 0.13 ? Math.sin(((t % 3.6) / 0.13) * Math.PI) : 1
      const openness = mood === "interrupted" ? 0.5 : 1 - blinkCycle * 0.95
      const pulse = mood === "speaking" ? 1 + Math.sin(t * 9.2) * 0.1 : 1
      const gx = mood === "thinking" ? Math.sin(t * 2.4) * 4.5 : mood === "busy" ? Math.sin(t * 5.2) * 3 : mood === "searching" ? Math.sin(t * 9) * 5.5 : 0
      const gy = mood === "thinking" ? -3 + Math.sin(t * 3.1) * 1.2 : mood === "busy" ? Math.sin(t * 7) * 2 : mood === "waiting" ? Math.sin(t * 2.9) * 3 : 0
      const eyeY = st.eyeDy + gy
      const gap = st.gap / 2
      if (e1gRef.current) e1gRef.current.setAttribute("transform", `translate(${(gx - gap).toFixed(2)},${(eyeY + gy).toFixed(2)}) rotate(${st.rot})`)
      if (e1Ref.current) e1Ref.current.setAttribute("d", capsuleD(st.eyeW * pulse, Math.max(st.eyeH * openness * pulse, 0.35)))
      if (e2gRef.current) e2gRef.current.setAttribute("transform", `translate(${(gx + gap).toFixed(2)},${(eyeY + gy).toFixed(2)}) rotate(${(st.rot2 ?? st.rot).toFixed(2)})`)
      if (e2Ref.current) e2Ref.current.setAttribute("d", capsuleD(st.eyeW * pulse, Math.max(st.eyeH * openness * pulse, 0.35)))

      // thinking orbit ring + orbs
      if (ringRef.current) {
        ringRef.current.setAttribute("transform", `rotate(${8 + Math.sin(t * 0.9) * 10})`)
        ringRef.current.setAttribute("opacity", mood === "thinking" ? "0.5" : "0")
      }
      if (orb1Ref.current) {
        const a = t * 1.9
        orb1Ref.current.setAttribute("cx", (Math.cos(a) * 19).toFixed(1))
        orb1Ref.current.setAttribute("cy", (Math.sin(a) * 7).toFixed(1))
        orb1Ref.current.setAttribute("opacity", mood === "thinking" ? "0.75" : "0")
      }
      if (orb2Ref.current) {
        const a = t * 2.3 + Math.PI
        orb2Ref.current.setAttribute("cx", (Math.cos(a) * 19).toFixed(1))
        orb2Ref.current.setAttribute("cy", (Math.sin(a) * 7).toFixed(1))
        orb2Ref.current.setAttribute("opacity", mood === "thinking" ? "0.75" : "0")
      }

      raf.current = requestAnimationFrame(loop)
    }
    raf.current = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf.current)
    // mood is read through styleRef each frame; the loop never re-binds
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // confetti burst (once per burstKey change)
  useEffect(() => {
    if (burstKey <= 0) return
    const now = performance.now()
    const confetti: Array<{ x: number; y: number; vx: number; vy: number; born: number; color: string; star: boolean }> = []
    for (let i = 0; i < 24; i++) {
      const a = Math.random() * Math.PI * 2
      const speed = 170 + Math.random() * 190
      confetti.push({ x: 0, y: 0, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed - 120, born: now + Math.random() * 120, color: colors[i % colors.length]!, star: Math.random() < 0.15 })
    }
    const draw = (): void => {
      if (!confettiRef.current) return
      let html = ""
      let alive = 0
      for (const p of confetti) {
        const age = (performance.now() - p.born) / 1000
        if (age < 0 || age > 0.9) continue
        alive++
        const x = p.x + p.vx * age
        const y = p.y + p.vy * age + 490 * age * age
        html += p.star
          ? `<path transform="translate(${x.toFixed(1)},${y.toFixed(1)}) rotate(${(age * 160) % 360})" d="M 0 -3 L 0.9 -0.9 3 0 0.9 0.9 0 3 -0.9 0.9 -3 0 -0.9 -0.9 Z" fill="#f4c34e"/>`
          : `<rect transform="translate(${x.toFixed(1)},${y.toFixed(1)}) rotate(${(age * 160) % 360})" x="-2.2" y="-1" width="4.4" height="2" rx="0.8" fill="${p.color}"/>`
      }
      confettiRef.current.innerHTML = html
      if (alive > 0 && performance.now() - now < 1100) requestAnimationFrame(draw)
      else confettiRef.current.innerHTML = ""
    }
    requestAnimationFrame(draw)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [burstKey])

  return (
    <svg width={size} height={size} viewBox="-26 -26 52 52" style={{ overflow: "visible" }} aria-label={`assistant ${mood}`}>
      <defs>
        <radialGradient id={gradId} cx="36%" cy="30%" r="80%">
          <stop offset="0%" stopColor="#ffffff" />
          <stop offset="58%" stopColor={STYLES[mood].body} />
          <stop offset="100%" stopColor={STYLES[mood].shade} />
        </radialGradient>
      </defs>
      <ellipse ref={ringRef} cx="0" cy="0" rx="19" ry="7" fill="none" stroke="#c9c5b8" strokeWidth="0.8" opacity="0" />
      <circle ref={orb1Ref} r="1.5" fill="#b3aea0" opacity="0" />
      <circle ref={orb2Ref} r="1.5" fill="#b3aea0" opacity="0" />
      <g ref={gRef}>
        <circle ref={bodyRef} r="15" fill={`url(#${gradId})`} />
        <circle r="14.6" fill="none" stroke="#0b0f19" strokeOpacity="0.07" strokeWidth="0.6" />
        <g ref={e1gRef}>
          <path ref={e1Ref} d={capsuleD(STYLES[mood].eyeW, STYLES[mood].eyeH)} fill="#1a1a1a" stroke="#1a1a1a" strokeWidth="1.6" strokeLinejoin="round" />
        </g>
        <g ref={e2gRef}>
          <path ref={e2Ref} d={capsuleD(STYLES[mood].eyeW, STYLES[mood].eyeH)} fill="#1a1a1a" stroke="#1a1a1a" strokeWidth="1.6" strokeLinejoin="round" />
        </g>
        {mood === "interrupted" && (
          <text x="12" y="-12" fontSize="7" fill="#8b8578" fontFamily="ui-monospace, monospace" opacity="0.6">
            z
          </text>
        )}
      </g>
      <g ref={confettiRef} />
    </svg>
  )
}
