import { Check, Heart, Lightbulb, MapPin } from "lucide-react"

import type { MemoryKind } from "@/lib/api/memories"

export const KINDS: Record<
  MemoryKind,
  {
    label: string
    plural: string
    short: string
    icon: typeof MapPin
    tint: string
  }
> = {
  item_location: {
    label: "Item location",
    plural: "Item locations",
    short: "Items",
    icon: MapPin,
    tint: "bg-secondary",
  },
  preference: {
    label: "Preference",
    plural: "Preferences",
    short: "Prefs",
    icon: Heart,
    tint: "bg-purple-soft",
  },
  fact: {
    label: "Fact",
    plural: "Facts",
    short: "Facts",
    icon: Lightbulb,
    tint: "bg-orange-soft",
  },
  todo: {
    label: "To-do",
    plural: "To-dos",
    short: "To-dos",
    icon: Check,
    tint: "bg-blue-soft",
  },
}

export const KIND_ORDER = Object.keys(KINDS) as MemoryKind[]
