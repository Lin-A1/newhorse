import { useEffect, useRef } from "react"
import { createEmotionBall } from "../lib/emotion-ball/engine"
import { mount as mountParticles } from "../lib/emotion-ball/particles"

/**
 * React wrapper over the vendored Emotion Ball engine
 * (github.com/sam70361/aora-bot, community-licensed). A `mood` maps onto the
 * engine's emotion-id vocabulary (emotions.ts: 00-09 lifecycle, 30-49 agent
 * states). The engine owns blinking / glancing / idle antics / ribbons /
 * confetti; this component only forwards mood changes and pointer gaze.
 */

export type BallMood =
  | "boot" // 加载苏醒
  | "idle" // 待机放空
  | "listening" // 等待输入
  | "thinking" // 思考中(常驻环带)
  | "working" // 处理中忙碌
  | "searching" // 检索资料
  | "replying" // 输出回复
  | "done" // 任务完成(彩带 + 撒花)
  | "error" // 出错
  | "sleep" // 睡眠(zzz)

const MOOD_ID: Record<BallMood, string> = {
  boot: "05",
  idle: "02",
  listening: "35",
  thinking: "30",
  working: "32",
  searching: "40",
  replying: "39",
  done: "33",
  error: "34",
  sleep: "00",
}

interface Props {
  mood: BallMood
  size?: number
  /** Static single render (avatars): no rAF, no idle machine. */
  lite?: boolean
  /** Pointer gaze + click-to-spin (cover hero only). */
  interactive?: boolean
  className?: string
}

export function EmotionBall({ mood, size = 96, lite = false, interactive = false, className }: Props): React.ReactElement {
  const hostRef = useRef<HTMLDivElement>(null)
  // engine is vendored untyped code; keep the handle loose
  const engineRef = useRef<{ setEmotion: (id: string) => boolean; setGaze: (x: number, y: number) => unknown; spin: (t?: number) => unknown; destroy: () => void } | null>(null)
  const moodRef = useRef(mood)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const engine = createEmotionBall(host, {
      emotion: MOOD_ID[moodRef.current],
      lite,
      ...(lite ? {} : { idle: { standbyAfter: 60_000, sleepAfter: 180_000, standbyId: "02", sleepId: "00" } }),
      eyeScale: size < 56 ? 1.3 : 1,
    })
    engineRef.current = engine
    return () => {
      engine.destroy()
      engineRef.current = null
    }
    // size only matters at construction; mood changes flow through setEmotion
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lite])

  useEffect(() => {
    moodRef.current = mood
    engineRef.current?.setEmotion(MOOD_ID[mood])
  }, [mood])

  useEffect(() => {
    if (!interactive) return
    const onMove = (e: PointerEvent): void => {
      const engine = engineRef.current
      const host = hostRef.current
      if (!engine || !host) return
      const r = host.getBoundingClientRect()
      const nx = (e.clientX - (r.left + r.width / 2)) / (window.innerWidth / 2)
      const ny = (e.clientY - (r.top + r.height / 2)) / (window.innerHeight / 2)
      engine.setGaze(Math.max(-1, Math.min(1, nx)), Math.max(-1, Math.min(1, ny)))
    }
    window.addEventListener("pointermove", onMove)
    return () => window.removeEventListener("pointermove", onMove)
  }, [interactive])

  return (
    <div
      ref={hostRef}
      className={className}
      style={{ width: size, height: size, cursor: interactive ? "pointer" : undefined, flex: "none" }}
      onClick={interactive ? () => engineRef.current?.spin(1) : undefined}
      role={interactive ? "img" : undefined}
      aria-label={interactive ? "newhorse" : undefined}
      aria-hidden={interactive ? undefined : true}
    />
  )
}

/** Breathing starfield/halftone backdrop for the cover (same vendored source). */
export function HeroParticles({ className }: { className?: string }): React.ReactElement {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    return mountParticles(canvas) ?? undefined
  }, [])
  return <canvas ref={ref} className={className} aria-hidden />
}
