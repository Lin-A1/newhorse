import { For, type ComponentProps } from "solid-js"

const word = [
  ["10001", "11001", "10101", "10011", "10001"],
  ["11111", "10000", "11110", "10000", "11111"],
  ["10001", "10001", "10101", "10101", "01010"],
  ["10001", "10001", "11111", "10001", "10001"],
  ["01110", "10001", "10001", "10001", "01110"],
  ["11110", "10001", "11110", "10100", "10010"],
  ["01111", "10000", "01110", "00001", "11110"],
  ["11111", "10000", "11110", "10000", "11111"],
] as const

const mark = [
  "10001",
  "11001",
  "10101",
  "10011",
  "10001",
  "00000",
  "10001",
  "10001",
  "11111",
  "10001",
  "10001",
] as const

function blocks(pattern: readonly string[], offset = 0) {
  return pattern.flatMap((row, y) => [...row].flatMap((value, x) => (value === "1" ? [{ x: offset + x, y }] : [])))
}

const markBlocks = blocks(mark)
const wordBlocks = word.flatMap((letter, index) => blocks(letter, index * 6).map((block) => ({ ...block, index })))

const MarkBlocks = () => (
  <For each={markBlocks}>
    {(block) => (
      <rect
        x={block.x}
        y={block.y}
        width="1"
        height="1"
        fill={block.y < 5 ? "var(--icon-base)" : "var(--icon-strong-base)"}
      />
    )}
  </For>
)

export const Mark = (props: { class?: string }) => (
  <svg
    data-component="logo-mark"
    classList={{ [props.class ?? ""]: !!props.class }}
    viewBox="0 0 5 11"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    role="img"
    aria-label="Newhorse"
  >
    <MarkBlocks />
  </svg>
)

export const Splash = (props: Pick<ComponentProps<"svg">, "ref" | "class">) => (
  <svg
    ref={props.ref}
    data-component="logo-splash"
    classList={{ [props.class ?? ""]: !!props.class }}
    viewBox="0 0 5 11"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    role="img"
    aria-label="Newhorse"
  >
    <MarkBlocks />
  </svg>
)

export const Logo = (props: { class?: string }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 47 5"
    fill="none"
    classList={{ [props.class ?? ""]: !!props.class }}
    role="img"
    aria-label="Newhorse"
  >
    <For each={wordBlocks}>
      {(block) => (
        <rect
          x={block.x}
          y={block.y}
          width="1"
          height="1"
          fill={block.index < 3 ? "var(--icon-base)" : "var(--icon-strong-base)"}
        />
      )}
    </For>
  </svg>
)
