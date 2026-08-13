import type { JSX } from "solid-js"
import { NEW_SESSION_CONTENT_WIDTH } from "@/pages/session/new-session-layout"

export function NewSessionDesignView(props: { children: JSX.Element }) {
  return (
    <div data-component="session-new-design" class="relative flex size-full flex-col overflow-hidden bg-v2-background-bg-deep">
      <div class="flex flex-1 flex-col items-center justify-center px-6 py-12">
        <div class={`${NEW_SESSION_CONTENT_WIDTH} flex flex-col items-center gap-8`}>
          {props.children}
        </div>
      </div>
    </div>
  )
}
