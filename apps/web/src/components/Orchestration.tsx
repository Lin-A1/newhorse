import { useEffect, useRef, useState } from "react"
import { api, type DagStatus } from "../api"
import { useStore } from "../store"

function PageHeader({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="mb-5">
      <h1 className="text-[17px] font-semibold tracking-tight text-fg">{title}</h1>
      {sub && <p className="mt-0.5 text-[12.5px] text-dim">{sub}</p>}
    </div>
  )
}

const TEMPLATE = `{
  "nodes": {
    "outline": { "id": "outline", "agent": { "name": "main", "model": "stub-mini" }, "input": "列出提纲" },
    "write": { "id": "write", "agent": { "name": "main", "model": "stub-mini" }, "dependsOn": ["outline"], "input": "根据提纲写正文" }
  }
}`

const STATE_COLOR: Record<string, string> = {
  succeeded: "text-ok",
  running: "text-warn",
  failed: "text-bad",
  skipped: "text-faint",
  pending: "text-dim",
  aborted: "text-bad",
}

/** 编排页: declare a DAG spec, watch node statuses live (poll), durable list. */
export function DagPage() {
  const { showToast } = useStore()
  const [rows, setRows] = useState<DagStatus[]>([])
  const [spec, setSpec] = useState(TEMPLATE)
  const [workspace, setWorkspace] = useState("")
  const [err, setErr] = useState("")
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const refresh = (): Promise<void> =>
    api
      .dags()
      .then((r) => setRows(r.dags))
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))

  useEffect(() => {
    void refresh()
    pollRef.current = setInterval(() => void refresh(), 2000)
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [])

  const create = async (): Promise<void> => {
    setErr("")
    try {
      const parsed = JSON.parse(spec) as { nodes: Record<string, unknown> }
      const res = await api.runDag(parsed, workspace ? { workspace } : undefined)
      showToast(`DAG ${res.dagId.slice(0, 8)} 已启动`)
      await refresh()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 md:px-8">
      <PageHeader title="编排" sub="声明式 DAG：节点 = 一次子代理委派，dependsOn 声明依赖，运行时派发" />

      <div className="panel mb-5 space-y-3 p-4">
        <label className="block space-y-1 text-xs text-dim">
          工作区（可选）
          <input className="input-base" placeholder="默认工作区" value={workspace} onChange={(e) => setWorkspace(e.target.value)} />
        </label>
        <label className="block space-y-1 text-xs text-dim">
          Spec（JSON，nodes.id → agent/input/dependsOn）
          <textarea className="input-base resize-none font-mono !text-[11.5px] leading-relaxed" rows={8} value={spec} onChange={(e) => setSpec(e.target.value)} />
        </label>
        {err && <div className="text-xs text-bad">{err}</div>}
        <button className="btn-primary px-4 py-1.5 text-[13px]" onClick={create}>
          声明并运行
        </button>
      </div>

      <div className="space-y-2.5">
        {rows.length === 0 && <div className="text-[13px] text-dim">还没有 DAG 运行记录</div>}
        {rows.map((d) => (
          <div key={d.dagId} className="panel p-4">
            <div className="mb-2 flex items-center gap-2 text-[11px] text-dim">
              <span className="font-mono text-fg">{d.dagId.slice(0, 8)}</span>
              {d.startedAt && <span>{new Date(d.startedAt).toLocaleString()}</span>}
              <span className={`pill ml-auto ${d.done ? "!text-ok" : "!text-warn"}`}>{d.done ? "已完成" : "运行中"}</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {d.nodes.map((n) => (
                <span key={n.node} className={`pill !text-[11px] ${STATE_COLOR[n.state] ?? "text-dim"}`} title={`${n.node} · ${n.state}${n.model ? ` · ${n.model}` : ""}`}>
                  <span className="font-mono">{n.node}</span>
                  {n.model && <span className="opacity-60">{n.model}</span>}
                  <span className="font-semibold">{n.state}</span>
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

/** 能力页: skills (three-level disclosure) + agent roles. */
export function CapabilitiesPage() {
  const { showToast } = useStore()
  const [skills, setSkills] = useState<Array<{ name: string; description?: string }>>([])
  const [openSkill, setOpenSkill] = useState<{ name: string; body: string } | null>(null)
  const [agents, setAgents] = useState<Array<{ name: string; description?: string; model?: string; allowedTools?: string[]; role?: string }>>([])
  const [err, setErr] = useState("")

  useEffect(() => {
    api
      .skills()
      .then((r) => setSkills(r.skills))
      .catch(() => {})
    api
      .agents()
      .then((r) => setAgents(r.agents))
      .catch(() => {})
  }, [])

  const openBody = async (name: string): Promise<void> => {
    try {
      const r = await api.skillBody(name)
      setOpenSkill(r)
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 md:px-8">
      <PageHeader title="能力" sub="插件目录里的技能与代理角色（发现于 agents/ 与 skills/）" />
      {err && <div className="mb-3 text-xs text-bad">{err}</div>}

      <div className="mb-6">
        <div className="mb-2 text-[11px] uppercase tracking-wider text-faint">技能 ({skills.length})</div>
        {skills.length === 0 && <div className="text-[13px] text-dim">未发现技能（设置 pluginsDir 后自动发现）</div>}
        <div className="space-y-2">
          {skills.map((sk) => (
            <div key={sk.name} className="panel p-3.5">
              <div className="flex items-center gap-2">
                <span className="text-[13px] font-medium text-fg">{sk.name}</span>
                <button className="ml-auto btn-ghost !rounded-lg !px-2 !py-0.5 !text-[11px]" onClick={() => openBody(sk.name)}>
                  查看内容
                </button>
              </div>
              {sk.description && <div className="mt-1 text-[12px] text-dim">{sk.description}</div>}
            </div>
          ))}
        </div>
      </div>

      <div>
        <div className="mb-2 text-[11px] uppercase tracking-wider text-faint">代理角色 ({agents.length})</div>
        {agents.length === 0 && <div className="text-[13px] text-dim">未发现角色（agents/*.md 自动发现）</div>}
        <div className="space-y-2">
          {agents.map((a) => (
            <div key={a.name} className="panel p-3.5">
              <div className="flex items-center gap-2">
                <span className="text-[13px] font-medium text-fg">{a.name}</span>
                {a.model && <span className="pill !text-[10.5px]">{a.model}</span>}
                {a.role && <span className="pill !text-[10.5px]">{a.role}</span>}
              </div>
              {a.description && <div className="mt-1 text-[12px] text-dim">{a.description}</div>}
              {a.allowedTools && a.allowedTools.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {a.allowedTools.map((t) => (
                    <span key={t} className="pill !px-1.5 !py-0 !text-[10px]">
                      {t}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {openSkill && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm" onClick={() => setOpenSkill(null)}>
          <div className="nh-rise max-h-[80vh] w-full max-w-xl overflow-y-auto rounded-2xl border border-white/[0.09] bg-[#0e111a] p-5 shadow-[0_30px_80px_rgba(0,0,0,0.6)]" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-[14px] font-semibold text-fg">{openSkill.name}</h3>
              <button className="btn-ghost !p-1.5" onClick={() => setOpenSkill(null)}>
                关闭
              </button>
            </div>
            <pre className="whitespace-pre-wrap rounded-xl border border-white/[0.06] bg-black/30 p-3 text-[12.5px] leading-relaxed text-slate-300">{openSkill.body}</pre>
          </div>
        </div>
      )}
    </div>
  )
}
