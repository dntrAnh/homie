"use client"

import {
  CalendarCheck,
  CalendarDays,
  CalendarPlus,
  ChevronRight,
  Plus,
} from "lucide-react"
import Link from "next/link"
import { useState } from "react"
import { toast } from "sonner"

import { EventRow } from "@/components/calendar/event-row"
import { ReminderDialog } from "@/components/calendar/reminder-dialog"
import { EmptyState, ErrorState, LoadingRows } from "@/components/data-states"
import { mobileActionClass, PageHeader } from "@/components/page-header"
import { Button } from "@/components/ui/button"
import { type CalendarEvent, useEvents } from "@/lib/api/calendar"
import { useConnectGoogle, useGoogleStatus } from "@/lib/api/google"
import { cn } from "@/lib/utils"

const DAYS = 14

// dev-note: dates use the browser's zone; switch to PROFILE.timezone once
// /api/me/profile is wired so Alexa and the dashboard always agree.
function dayKey(date: Date) {
  return date.toLocaleDateString("en-CA") // YYYY-MM-DD
}

function startOfToday() {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d
}

function dayLabel(date: Date, index: number) {
  const md = date.toLocaleDateString(undefined, {
    month: "long",
    day: "numeric",
  })
  const name =
    index === 0
      ? "Today"
      : index === 1
        ? "Tomorrow"
        : date.toLocaleDateString(undefined, { weekday: "long" })
  return `${name} · ${md}`
}

export default function CalendarPage() {
  const google = useGoogleStatus()
  const events = useEvents(DAYS)
  const connect = useConnectGoogle()
  const [selected, setSelected] = useState(0)

  const today = startOfToday()
  const days = Array.from({ length: DAYS }, (_, i) => {
    const d = new Date(today)
    d.setDate(today.getDate() + i)
    return d
  })

  const byDay = new Map<string, CalendarEvent[]>()
  for (const event of events.data ?? []) {
    const key = event.all_day
      ? event.start.slice(0, 10)
      : dayKey(new Date(event.start))
    byDay.set(key, [...(byDay.get(key) ?? []), event])
  }
  const groups = days
    .map((date, i) => ({ date, i, items: byDay.get(dayKey(date)) ?? [] }))
    .filter((g) => g.i >= selected && g.items.length > 0)
  const todos = (events.data ?? []).flatMap((e) =>
    e.todos.map((todo) => ({ todo, event: e })),
  )

  const notConnected = google.data && !google.data.connected

  return (
    <>
      <PageHeader
        title="Coming up"
        subtitle="Your next 14 days, with the things Homie wants you to remember."
        mobileSubtitle="Your schedule and reminders"
        action={
          <ReminderDialog
            trigger={
              <Button size="lg" disabled={notConnected}>
                <CalendarPlus aria-hidden /> Create reminder
              </Button>
            }
          />
        }
        mobileAction={
          <ReminderDialog
            trigger={
              <button
                type="button"
                aria-label="Create reminder"
                disabled={notConnected}
                className={mobileActionClass}
              >
                <Plus aria-hidden />
              </button>
            }
          />
        }
      />

      <div className="flex flex-col gap-4 p-4 md:gap-5 md:px-11 md:pt-6 md:pb-9">
        {google.data?.connected && (
          <Link
            href="/settings"
            className="bg-blue-soft flex min-h-12 items-center gap-3 rounded-[10px] px-4 text-[13px] font-medium text-[#41609a] md:hidden"
          >
            <CalendarCheck className="size-5" aria-hidden />
            <span className="flex-1">Google Calendar connected</span>
            <ChevronRight className="size-4.5" aria-hidden />
          </Link>
        )}

        <div
          role="tablist"
          aria-label="Start day"
          className="-mx-4 flex [scrollbar-width:none] gap-2 overflow-x-auto px-4 md:mx-0 md:px-0"
        >
          {days.map((date, i) => {
            const active = selected === i
            return (
              <button
                key={i}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setSelected(i)}
                className={cn(
                  "focus-visible:ring-ring/50 flex h-16 w-12 shrink-0 flex-col items-center justify-center gap-1 rounded-[10px] border outline-none focus-visible:ring-3 md:w-auto md:min-w-[140px] md:flex-1",
                  active ? "bg-sidebar border-sidebar text-white" : "bg-card",
                )}
              >
                <span
                  className={cn(
                    "text-[10px] font-semibold md:tracking-wider md:uppercase",
                    active ? "text-[#bfd3c6]" : "text-muted-foreground",
                  )}
                >
                  {i === 0 ? (
                    <>
                      <span className="md:hidden">
                        {date.toLocaleDateString(undefined, {
                          weekday: "short",
                        })}
                      </span>
                      <span className="hidden md:inline">Today</span>
                    </>
                  ) : (
                    date.toLocaleDateString(undefined, { weekday: "short" })
                  )}
                </span>
                <span className="text-lg leading-none font-semibold md:font-normal">
                  {date.getDate()}
                </span>
              </button>
            )
          })}
        </div>

        <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_310px]">
          <div className="min-w-0 space-y-5">
            {google.isPending || events.isPending ? (
              <LoadingRows count={4} />
            ) : notConnected ? (
              <EmptyState icon={CalendarDays} title="Connect Google Calendar">
                <p>
                  Homie reads your upcoming events live and adds reminders you
                  ask Alexa for.
                </p>
                <Button
                  size="lg"
                  className="mt-4"
                  disabled={connect.isPending}
                  onClick={() =>
                    connect.mutate(undefined, {
                      onError: (err) => toast.error(err.message),
                    })
                  }
                >
                  Connect Google Calendar
                </Button>
              </EmptyState>
            ) : events.isError ? (
              <ErrorState
                error={events.error}
                onRetry={() => events.refetch()}
              />
            ) : groups.length === 0 ? (
              <EmptyState icon={CalendarDays} title="Nothing coming up">
                Ask Alexa to “remind me to renew the parking pass tomorrow”, or
                create a reminder here.
              </EmptyState>
            ) : (
              groups.map(({ date, i, items }) => (
                <section
                  key={i}
                  aria-labelledby={`day-${i}`}
                  className="space-y-2.5"
                >
                  <h2
                    id={`day-${i}`}
                    className="flex items-center justify-between text-sm font-semibold md:text-xs md:tracking-wide"
                  >
                    {dayLabel(date, i)}
                    <span className="text-muted-foreground text-[11px] font-normal md:hidden">
                      {items.length} {items.length === 1 ? "event" : "events"}
                    </span>
                  </h2>
                  <ul className="space-y-2.5">
                    {items.map((event) => (
                      <EventRow key={event.id} event={event} />
                    ))}
                  </ul>
                </section>
              ))
            )}
          </div>

          <aside className="hidden flex-col gap-4 pt-7 md:flex">
            {google.data?.connected && (
              <section className="bg-card rounded-xl border p-5">
                <div className="flex items-center gap-3">
                  <span className="bg-blue-soft grid size-10 place-items-center rounded-[9px] text-[#41609a]">
                    <CalendarCheck className="size-5" aria-hidden />
                  </span>
                  <div>
                    <h2 className="text-[13px] font-semibold">
                      Google Calendar
                    </h2>
                    <p className="text-accent-dark text-[11px]">Connected</p>
                  </div>
                </div>
                <p className="text-muted-foreground mt-3 text-xs">
                  Events update live. Homie-created reminders appear in your
                  Google Calendar too.
                </p>
              </section>
            )}
            <section className="bg-sidebar rounded-xl p-5 text-white">
              <h2 className="font-heading text-lg font-medium">
                Linked to-dos
              </h2>
              <p className="mt-2 text-xs text-[#bfd0c6]">
                Homie will mention these when you ask what&apos;s coming up.
              </p>
              {todos.length === 0 ? (
                <p className="mt-4 border-t border-white/10 pt-4 text-xs text-[#bfd0c6]">
                  No to-dos linked to upcoming events yet.
                </p>
              ) : (
                <ul className="mt-2">
                  {todos.map(({ todo, event }) => (
                    <li
                      key={`${event.id}-${todo.id}`}
                      className="border-t border-white/10 py-3"
                    >
                      <p className="text-sidebar-primary text-[11px] font-semibold">
                        {event.title}
                      </p>
                      <p className="mt-1 text-[13px]">{todo.content}</p>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </aside>
        </div>
      </div>
    </>
  )
}
