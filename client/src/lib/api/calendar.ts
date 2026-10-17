"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import { useApi } from "@/lib/api"
import type { Memory } from "@/lib/api/memories"

export type CalendarEvent = {
  id: string
  title: string
  start: string
  end: string
  all_day: boolean
  location?: string | null
  html_link: string
  created_by_homie: boolean
  todos: Memory[]
}

export type ReminderInput = {
  title: string
  /** ISO datetime, or YYYY-MM-DD for an all-day reminder. */
  when: string
  notes?: string
}

export function useEvents(days = 14) {
  const { request, sub, enabled } = useApi()
  return useQuery({
    queryKey: [sub, "calendar", days],
    enabled,
    queryFn: ({ signal }) =>
      request<CalendarEvent[]>(`/api/calendar/events?days=${days}`, {
        signal,
      }),
  })
}

// dev-note: assumes POST /api/calendar/reminders mirroring the
// `create_reminder` MCP tool; the REST surface doesn't define it yet.
export function useCreateReminder() {
  const { request, sub } = useApi()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: ReminderInput) =>
      request<CalendarEvent>("/api/calendar/reminders", {
        method: "POST",
        json: body,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: [sub, "calendar"] }),
  })
}
