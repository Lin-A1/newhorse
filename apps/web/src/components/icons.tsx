/**
 * Icon set — re-exports lucide-react (the AI-native standard) under the app's
 * stable Icon* names, pinned to consistent sizing/stroke. No emoji anywhere.
 */
import type { ComponentType } from "react"
import {
  Archive,
  ArrowLeft,
  ArrowUp,
  ArrowUpRight,
  BarChart3,
  Brain,
  Check,
  ChevronRight,
  Circle,
  Clock,
  Copy,
  Crown,
  FileText,
  Folder,
  Globe,
  LoaderCircle,
  MessageSquare,
  Monitor,
  Moon,
  Pencil,
  Paperclip,
  Pause,
  Play,
  Plus,
  Search,
  Settings,
  Shield,
  Square,
  SquareTerminal,
  StickyNote,
  Sun,
  Target,
  Trash2,
  Wrench,
  X,
} from "lucide-react"

interface IconProps {
  size?: number
  className?: string
  strokeWidth?: number
}

type LucideIcon = ComponentType<{ size?: number | string; className?: string; strokeWidth?: number | string }>

function wrap(Icon: LucideIcon) {
  return function NHIcon({ size = 15, className, strokeWidth = 1.8 }: IconProps) {
    return <Icon size={size} className={className} strokeWidth={strokeWidth} />
  }
}

export const IconChat = wrap(MessageSquare)
export const IconChart = wrap(BarChart3)
export const IconClock = wrap(Clock)
export const IconMemory = wrap(Brain)
export const IconGear = wrap(Settings)
export const IconPlus = wrap(Plus)
export const IconSend = wrap(ArrowUp)
export const IconStop = wrap(Square)
export const IconCheck = wrap(Check)
export const IconSpinner = wrap(LoaderCircle)
export const IconCircle = wrap(Circle)
export const IconTrash = wrap(Trash2)
export const IconPlay = wrap(Play)
export const IconPause = wrap(Pause)
export const IconTarget = wrap(Target)
export const IconBrain = wrap(Brain)
export const IconNote = wrap(StickyNote)
export const IconTool = wrap(Wrench)
export const IconX = wrap(X)
export const IconChevron = wrap(ChevronRight)
export const IconArrowLeft = wrap(ArrowLeft)
export const IconArrowUpRight = wrap(ArrowUpRight)
export const IconSearch = wrap(Search)
export const IconCopy = wrap(Copy)
export const IconFile = wrap(FileText)
export const IconTerminal = wrap(SquareTerminal)
export const IconPencil = wrap(Pencil)
export const IconSun = wrap(Sun)
export const IconMoon = wrap(Moon)
export const IconMonitor = wrap(Monitor)
export const IconGlobe = wrap(Globe)
export const IconFolder = wrap(Folder)
export const IconArchive = wrap(Archive)
export const IconButler = wrap(Crown)
export const IconShield = wrap(Shield)
export const IconPaperclip = wrap(Paperclip)
