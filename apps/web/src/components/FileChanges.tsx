import { useState } from "react"
import type { FileChange } from "../api"
import { IconPencil, IconX } from "./icons"

/** Files-changed panel (codex review-changes / opencode file-changes): every
 *  file the session's write/edit tools touched, with a synthesized line diff
 *  of the last change. Click a file to expand its diff. */
export function FileChanges({ changes, onClose }: { changes: FileChange[]; onClose: () => void }) {
  const [openPath, setOpenPath] = useState<string | null>(null)
  const totalAdded = changes.reduce((n, c) => n + c.added, 0)
  const totalRemoved = changes.reduce((n, c) => n + c.removed, 0)

  return (
    <div className="flex h-full w-80 shrink-0 flex-col border-l border-line bg-chrome/60" data-nh-popover>
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3">
        <IconPencil size={13} className="text-faint" />
        <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium text-dim">
          文件变更 · {changes.length} 个
          <span className="tnum ml-1.5 text-ok">+{totalAdded}</span>
          <span className="tnum ml-1 text-bad">-{totalRemoved}</span>
        </span>
        <button className="nh-icon-btn" onClick={onClose} aria-label="关闭变更面板">
          <IconX size={12} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {changes.length === 0 && <div className="px-2 py-6 text-center text-[11.5px] text-faint">这个会话还没有写入或编辑过文件</div>}
        {changes.map((c) => {
          const open = openPath === c.path
          return (
            <div key={c.path} className="mb-0.5">
              <button
                className="flex h-8 w-full items-center gap-1.5 rounded-md px-1.5 text-left text-[12px] text-dim transition-colors hover:bg-surface2 hover:text-fg"
                onClick={() => setOpenPath(open ? null : c.path)}
                title={c.path}
              >
                <IconPencil size={11} className={`shrink-0 ${c.tool === "write" ? "text-accent" : "text-warn"}`} />
                <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]">{c.path}</span>
                <span className="tnum shrink-0 text-[10.5px] text-ok">+{c.added}</span>
                <span className="tnum shrink-0 text-[10.5px] text-bad">-{c.removed}</span>
                {c.touches > 1 && <span className="tnum shrink-0 rounded border border-line bg-surface2 px-1 text-[9.5px] text-faint">×{c.touches}</span>}
              </button>
              {open && (
                <div className="mx-1.5 mb-1.5 overflow-x-auto rounded-lg border border-line bg-[var(--code-bg)] py-1 font-mono text-[11px] leading-[1.55]">
                  {c.diff.length === 0 && <div className="px-2.5 py-1 text-faint">（无文本差异）</div>}
                  {c.diff.map((d, i) => (
                    <div key={i} className={d.kind === "add" ? "cline add" : d.kind === "del" ? "cline del" : "cline"}>
                      <span className="ln">{i + 1}</span>
                      <span className="whitespace-pre-wrap break-all">{(d.kind === "add" ? "+ " : d.kind === "del" ? "- " : "  ") + d.text}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
      <div className="border-t border-line px-3 py-2 text-[10px] leading-relaxed text-faint">差异由写入/编辑工具的输入合成（最近一次变更）</div>
    </div>
  )
}
