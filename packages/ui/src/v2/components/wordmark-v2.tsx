import type { ComponentProps } from "solid-js"
import { Logo } from "../../components/logo"

export function WordmarkV2(props: Pick<ComponentProps<"svg">, "class">) {
  return <Logo class={props.class} />
}
