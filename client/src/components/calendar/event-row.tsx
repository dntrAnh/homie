import { Bell, CalendarDays, ChevronRight, HouseHeart } from "lucide-react"

import type { CalendarEvent } from "@/lib/api/calendar"
import { useTimezone } from "@/lib/api/profile"
import { cn } from "@/lib/utils"

function duration(event: CalendarEvent) {
  const minutes = Math.round(
    (new Date(event.end).getTime() - new Date(event.start).getTime()) / 60_000,
  )
  if (minutes <= 0) return null
  return minutes % 60 === 0 && minutes >= 60
    ? `${minutes / 60} hr`
    : `${minutes} min`
}

export function EventRow({ event }: { event: CalendarEvent }) {
  const homie = event.created_by_homie
  const Icon = homie ? Bell : CalendarDays
  const timeZone = useTimezone()
  const time = event.all_day
    ? "All day"
    : new Date(event.start).toLocaleTimeString(undefined, {
        hour: "numeric",
        minute: "2-digit",
        timeZone,
      })
  const meta = event.all_day
    ? "Reminder"
    : [event.location, duration(event)].filter(Boolean).join(" · ")

  return (
    <li>
      <a
        href={event.html_link}
        target="_blank"
        rel="noreferrer"
        className="bg-card hover:border-primary/40 focus-visible:ring-ring/50 flex min-h-23 items-center gap-3 rounded-[10px] border px-3 py-4 outline-none focus-visible:ring-3 md:gap-4 md:px-4"
      >
        <div className="w-14 shrink-0 md:w-[72px]">
          <p className="text-xs font-semibold">{time}</p>
          {meta && (
            <p className="text-muted-foreground mt-1 hidden text-[10px] md:line-clamp-2">
              {meta}
            </p>
          )}
        </div>
        <span
          aria-hidden
          className={cn(
            "hidden h-13 w-0.5 shrink-0 rounded-full md:block",
            homie ? "bg-primary" : "bg-[#7f9ae0]",
          )}
        />
        <span
          aria-hidden
          className={cn(
            "grid size-10 shrink-0 place-items-center rounded-[9px]",
            homie
              ? "bg-secondary text-accent-dark"
              : "bg-blue-soft text-[#41609a]",
          )}
        >
          <Icon className="size-4.5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold md:text-[15px]">
            {event.title}
          </p>
          {meta && (
            <p className="text-muted-foreground mt-1 truncate text-[11px] md:hidden">
              {meta}
            </p>
          )}
          {homie && (
            <span className="bg-secondary text-accent-dark mt-1.5 hidden h-6 items-center gap-1.5 rounded-full px-2 text-[10px] font-semibold md:inline-flex">
              <HouseHeart className="size-3" aria-hidden /> Created by Homie
            </span>
          )}
        </div>
        <ChevronRight
          className="text-muted-foreground size-4.5 shrink-0"
          aria-hidden
        />
        <span className="sr-only">(opens Google Calendar)</span>
      </a>
    </li>
  )
}
