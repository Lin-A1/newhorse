import { ButtonV2 } from "@newhorse/ui/v2/button-v2"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@newhorse/ui/v2/dialog-v2"
import { DividerV2 } from "@newhorse/ui/v2/divider-v2"
import { Switch } from "@newhorse/ui/v2/switch-v2"
import { useDialog } from "@newhorse/ui/context/dialog"
import { createEffect, createSignal } from "solid-js"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"

/** Registers the desktop main process's close-action request: when the user
 * closes a window with the close action set to "ask", show the choice dialog. */
export function CloseChoiceListener() {
  const dialog = useDialog()
  const platform = usePlatform()
  createEffect(() => {
    const dispose = platform.onCloseChoice?.(() => {
      dialog.show(() => <CloseChoiceDialog />)
    })
    return dispose
  })
  return null
}

/** Shown by the desktop main process when the user closes a window and the
 * close action is "ask": minimize to tray (keep running) or quit. Chinese,
 * matches the app theme. */
export function CloseChoiceDialog() {
  const dialog = useDialog()
  const language = useLanguage()
  const platform = usePlatform()
  const [always, setAlways] = createSignal(false)

  const choose = (action: "tray" | "quit") => {
    platform.replyCloseChoice?.({ action, always: always() })
    dialog.close()
  }

  return (
    <Dialog fit class="settings-v2-server-dialog">
      <DialogHeader hideClose={true}>
        <DialogTitle>{language.t("desktop.close.title")}</DialogTitle>
      </DialogHeader>
      <DividerV2 />
      <DialogBody class="flex w-full min-w-0 flex-col gap-4 px-5 pt-4 pb-2">
        <p class="text-13-regular text-v2-text-text-muted">{language.t("desktop.close.description")}</p>
        <div class="flex w-full items-center justify-between gap-2">
          <span class="text-13-regular text-v2-text-text-base">{language.t("desktop.close.remember")}</span>
          <Switch checked={always()} onChange={setAlways} aria-label={language.t("desktop.close.remember")} />
        </div>
      </DialogBody>
      <DialogFooter>
        <ButtonV2 variant="neutral" onClick={() => dialog.close()}>
          {language.t("common.cancel")}
        </ButtonV2>
        <ButtonV2 variant="contrast" onClick={() => choose("tray")}>
          {language.t("desktop.close.tray")}
        </ButtonV2>
        <ButtonV2 variant="danger" onClick={() => choose("quit")}>
          {language.t("desktop.close.quit")}
        </ButtonV2>
      </DialogFooter>
    </Dialog>
  )
}
