import { Button } from "@newhorse/ui/button"
import { Dialog } from "@newhorse/ui/dialog"
import { useDialog } from "@newhorse/ui/context/dialog"
import { useLanguage } from "@/context/language"

export type ConfirmOptions = {
  title?: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
}

/**
 * Promise-based confirmation replacing `window.confirm`. Renders an in-app
 * dialog so destructive actions get the same visuals as the rest of the UI.
 * Resolves true when confirmed, false on cancel / Escape / overlay click.
 */
export function useConfirm() {
  const dialog = useDialog()
  const language = useLanguage()
  return (options: ConfirmOptions) =>
    new Promise<boolean>((resolve) => {
      let settled = false
      const finish = (value: boolean) => {
        if (settled) return
        settled = true
        dialog.close()
        resolve(value)
      }
      dialog.push(
        () => (
          <Dialog title={options.title} description={options.message}>
            <div class="flex justify-end gap-2 pt-2">
              <Button size="small" variant="ghost" onClick={() => finish(false)}>
                {options.cancelLabel ?? language.t("common.cancel")}
              </Button>
              <Button size="small" variant="primary" onClick={() => finish(true)}>
                {options.confirmLabel ?? language.t("common.confirm")}
              </Button>
            </div>
          </Dialog>
        ),
        () => finish(false),
      )
    })
}
