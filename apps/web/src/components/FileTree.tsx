import { useEffect, useState } from "react"
import { api } from "../api"
import { IconChevron, IconFile, IconFolder, IconX } from "./icons"

interface Entry {
  name: string
  dir: boolean
}

interface Node {
  name: string
  dir: boolean
  /** relative path from the workspace root */
  path: string
  /** one-level lazy children, loaded on expand */
  loaded: boolean
  open: boolean
  children: Node[]
}

const toNode = (e: Entry, parentPath: string): Node => ({
  name: e.name,
  dir: e.dir,
  path: parentPath === "." ? e.name : `${parentPath}/${e.name}`,
  loaded: !e.dir,
  open: false,
  children: [],
})

/** Workspace file tree (codex-style side panel): lazy one-level listing via
 *  GET /v1/fs, dot/node_modules filtered server-side. Clicking a file inserts
 *  its workspace-relative path into the composer so the model can address it. */
export function FileTree({ workspace, onPick, onClose }: { workspace?: string; onPick: (path: string) => void; onClose: () => void }) {
  const [root, setRoot] = useState<Node[]>([])
  const [rootPath, setRootPath] = useState(".")
  const [err, setErr] = useState("")

  useEffect(() => {
    void api
      .fs(workspace)
      .then((r) => {
        setRootPath(r.path)
        setRoot(r.entries.map((e) => toNode(e, r.path)))
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
  }, [workspace])

  const toggle = async (node: Node): Promise<void> => {
    if (!node.dir) {
      onPick(rootPath === "." ? node.path : `${rootPath}/${node.path}`.replace(/^\.\//, ""))
      return
    }
    if (!node.loaded) {
      try {
        const r = await api.fs(workspace, node.path)
        node.children = r.entries.map((e) => toNode(e, node.path))
        node.loaded = true
      } catch {
        node.loaded = true
      }
    }
    node.open = !node.open
    setRoot([...root])
  }

  const renderNode = (n: Node, depth: number): React.ReactNode => (
    <div key={n.path}>
      <button
        className="flex h-7 w-full items-center gap-1.5 rounded-md px-1.5 text-left text-[12px] text-dim transition-colors hover:bg-surface2 hover:text-fg"
        style={{ paddingLeft: 6 + depth * 14 }}
        onClick={() => void toggle(n)}
        title={n.dir ? n.path : `插入路径 ${n.path}`}
      >
        {n.dir ? (
          <>
            <IconChevron size={10} className={`shrink-0 text-faint transition-transform ${n.open ? "rotate-90" : ""}`} />
            <IconFolder size={12} className="shrink-0 text-faint" />
          </>
        ) : (
          <>
            <span className="w-[10px] shrink-0" />
            <IconFile size={12} className="shrink-0 text-faint" />
          </>
        )}
        <span className="min-w-0 truncate">{n.name}</span>
      </button>
      {n.dir && n.open && n.children.map((c) => renderNode(c, depth + 1))}
      {n.dir && n.open && n.loaded && n.children.length === 0 && <div className="py-0.5 text-[11px] text-faint" style={{ paddingLeft: 20 + depth * 14 }}>（空）</div>}
    </div>
  )

  return (
    <div className="flex h-full w-64 shrink-0 flex-col border-l border-line bg-chrome/60" data-nh-popover>
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3">
        <IconFolder size={13} className="text-faint" />
        <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium text-dim">{workspace ? workspace.split(/[\\/]/).slice(-1)[0] : "工作区"}</span>
        <button className="nh-icon-btn" onClick={onClose} aria-label="关闭文件树">
          <IconX size={12} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {err && <div className="px-2 py-2 text-[11.5px] leading-relaxed text-bad">{err}</div>}
        {!err && root.length === 0 && <div className="px-2 py-2 text-[11.5px] text-faint">加载工作区…</div>}
        {root.map((n) => renderNode(n, 0))}
      </div>
      <div className="border-t border-line px-3 py-2 text-[10px] leading-relaxed text-faint">点击文件把路径插入输入框</div>
    </div>
  )
}
