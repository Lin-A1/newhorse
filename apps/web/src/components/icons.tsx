/** Minimal inline SVG icon set — no emoji anywhere in the UI. */
interface IconProps {
  size?: number
  className?: string
}

const base = (size: number): { width: number; height: number; viewBox: string; fill: "none" | undefined; stroke: string; strokeWidth: number; strokeLinecap: "round"; strokeLinejoin: "round" } => ({
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: undefined,
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round",
  strokeLinejoin: "round",
})

export const IconChat = ({ size = 18, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <path d="M21 11.5a8.4 8.4 0 0 1-8.5 8.3 8.9 8.9 0 0 1-3.8-.8L3 20l1.1-4.4a8 8 0 0 1-.6-3A8.4 8.4 0 0 1 12 4.2a8.4 8.4 0 0 1 9 7.3Z" />
  </svg>
)

export const IconChart = ({ size = 18, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <path d="M4 20V10M10 20V4M16 20v-7M21 20H3" />
  </svg>
)

export const IconClock = ({ size = 18, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3.5 2" />
  </svg>
)

export const IconMemory = ({ size = 18, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <path d="M12 4a4 4 0 0 0-4 4 4 4 0 0 0-3 6.5A4 4 0 0 0 8 20h1.5M12 4a4 4 0 0 1 4 4 4 4 0 0 1 3 6.5A4 4 0 0 1 16 20h-1.5M12 4v16" />
  </svg>
)

export const IconGear = ({ size = 18, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <circle cx="12" cy="12" r="3.2" />
    <path d="M19 12a7 7 0 0 0-.14-1.4l2-1.55-2-3.46-2.35.95a7 7 0 0 0-2.42-1.4L13.7 2.6h-3.4l-.4 2.54a7 7 0 0 0-2.4 1.4L5.14 5.6l-2 3.46 2 1.55A7 7 0 0 0 5 12c0 .48.05.94.14 1.4l-2 1.55 2 3.46 2.35-.95a7 7 0 0 0 2.42 1.4l.4 2.54h3.4l.4-2.54a7 7 0 0 0 2.4-1.4l2.36.95 2-3.46-2-1.55c.09-.46.13-.92.13-1.4Z" />
  </svg>
)

export const IconPlus = ({ size = 16, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <path d="M12 5v14M5 12h14" />
  </svg>
)

export const IconSend = ({ size = 16, className }: IconProps) => (
  <svg {...base(size)} className={className} fill="currentColor" stroke="none">
    <path d="M3.4 20.4 21 12 3.4 3.6 3.4 10l12 2-12 2Z" />
  </svg>
)

export const IconStop = ({ size = 16, className }: IconProps) => (
  <svg {...base(size)} className={className} fill="currentColor" stroke="none">
    <rect x="6" y="6" width="12" height="12" rx="2" />
  </svg>
)

export const IconCheck = ({ size = 14, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <path d="M4.5 12.5 10 18 19.5 6.5" />
  </svg>
)

export const IconSpinner = ({ size = 14, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <path d="M12 3a9 9 0 1 0 9 9" />
  </svg>
)

export const IconCircle = ({ size = 14, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <circle cx="12" cy="12" r="8.5" />
  </svg>
)

export const IconTrash = ({ size = 14, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6.5 7l1 13h9l1-13M10 11v5M14 11v5" />
  </svg>
)

export const IconPlay = ({ size = 14, className }: IconProps) => (
  <svg {...base(size)} className={className} fill="currentColor" stroke="none">
    <path d="M8 5.5v13l11-6.5Z" />
  </svg>
)

export const IconPause = ({ size = 14, className }: IconProps) => (
  <svg {...base(size)} className={className} fill="currentColor" stroke="none">
    <rect x="6.5" y="5.5" width="4" height="13" rx="1" />
    <rect x="13.5" y="5.5" width="4" height="13" rx="1" />
  </svg>
)

export const IconTarget = ({ size = 14, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <circle cx="12" cy="12" r="8.5" />
    <circle cx="12" cy="12" r="4.5" />
    <circle cx="12" cy="12" r="1" fill="currentColor" />
  </svg>
)

export const IconBrain = ({ size = 14, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <path d="M12 4a4 4 0 0 0-4 4 4 4 0 0 0-3 6.5A4 4 0 0 0 8 20h1.5M12 4a4 4 0 0 1 4 4 4 4 0 0 1 3 6.5A4 4 0 0 1 16 20h-1.5M12 4v16" />
  </svg>
)

export const IconNote = ({ size = 14, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <path d="M6 3.5h9L19 8v12.5H6zM14.5 3.5V8H19M9 12h6M9 15.5h6" />
  </svg>
)

export const IconTool = ({ size = 14, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <path d="M14.5 6.5a4 4 0 0 1 5-3.9l-2.6 2.6 2.4 2.4L21.9 5a4 4 0 0 1-5.4 4.9L8 18.4a2.1 2.1 0 1 1-3-3l8.5-8.5a4 4 0 0 1 2-0.4Z" />
  </svg>
)

export const IconX = ({ size = 14, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <path d="M6 6l12 12M18 6 6 18" />
  </svg>
)

export const IconChevron = ({ size = 14, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <path d="M9 6l6 6-6 6" />
  </svg>
)
