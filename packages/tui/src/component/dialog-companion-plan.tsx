import { useRoute } from "../context/route"
import { useSync } from "../context/sync"
import { useDialog } from "../ui/dialog"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { useToast } from "../ui/toast"
import { DialogMemory } from "./dialog-memory"
import { DialogReminder } from "./dialog-reminder"
import { DialogContinuityGrant } from "./dialog-continuity-grant"

type PlanValue = "memory" | "reminders" | "continuity" | "close"

export function DialogCompanionPlan() {
  const dialog = useDialog()
  const route = useRoute()
  const sync = useSync()
  const toast = useToast()

  const open = (value: PlanValue) => {
    if (value === "memory") {
      dialog.replace(() => <DialogMemory />)
      return
    }
    if (value === "reminders") {
      dialog.replace(() => <DialogReminder />)
      return
    }
    if (value === "continuity") {
      const current = route.data
      if (current.type !== "session") {
        toast.show({ message: "Open a source session to review Continuity grants", variant: "warning" })
        return
      }
      const session = sync.session.get(current.sessionID)
      if (!session) {
        toast.show({ message: "Source session metadata is still loading", variant: "warning" })
        return
      }
      dialog.replace(() => (
        <DialogContinuityGrant
          source={{
            key: `session:${current.sessionID}:${session.workspaceID ?? ""}:${session.directory}`,
            sessionID: current.sessionID,
            workspaceID: session.workspaceID,
            directory: session.directory,
            query: {
              session: current.sessionID,
              directory: session.directory,
              workspace: session.workspaceID,
            },
          }}
        />
      ))
      return
    }
    dialog.clear()
  }

  const options: DialogSelectOption<PlanValue>[] = [
    {
      value: "memory",
      title: "Memory proposals",
      description: "Review and accept or reject proposed Memory",
      category: "Review",
    },
    {
      value: "reminders",
      title: "Reminders",
      description: "Manage scheduled and recurring reminders",
      category: "Review",
    },
    {
      value: "continuity",
      title: "Continuity grants",
      description: "Approve or revoke minimized handoffs (requires a source session)",
      category: "Review",
    },
    {
      value: "close",
      title: "Close",
      category: "Actions",
    },
  ]

  return (
    <DialogSelect
      title="Companion Plan Review"
      placeholder="Memory · Reminders · Continuity"
      options={options}
      onSelect={(option) => open(option.value)}
    />
  )
}
