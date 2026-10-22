"use client"

import { useState } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { useCreateReminder } from "@/lib/api/calendar"
import { useTimezone } from "@/lib/api/profile"

export function ReminderDialog({
  trigger,
}: {
  trigger: React.ComponentProps<typeof DialogTrigger>["render"]
}) {
  const [open, setOpen] = useState(false)
  const [allDay, setAllDay] = useState(false)
  const create = useCreateReminder()
  const timezone = useTimezone()

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    const when = String(form.get("when"))
    create.mutate(
      {
        title: String(form.get("title")).trim(),
        // Wall-clock time + the zone it was typed in; the server hands both to
        // Google so the reminder lands at exactly this local time (DST-safe).
        when,
        timezone,
        notes: String(form.get("notes") ?? "").trim() || undefined,
      },
      {
        onSuccess: () => {
          toast.success("Reminder added to Google Calendar")
          setOpen(false)
        },
        onError: (err) => toast.error(err.message),
      },
    )
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !create.isPending && setOpen(next)}
    >
      <DialogTrigger render={trigger} />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create reminder</DialogTitle>
          <DialogDescription>
            Homie adds it to your Google Calendar and reminds you beforehand.
          </DialogDescription>
        </DialogHeader>
        <form id="reminder-form" onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="reminder-title">Title</Label>
            <Input
              id="reminder-title"
              name="title"
              required
              maxLength={200}
              placeholder="Renew parking pass"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="reminder-when">When</Label>
            <Input
              id="reminder-when"
              name="when"
              type={allDay ? "date" : "datetime-local"}
              required
            />
            <label className="text-muted-foreground flex min-h-11 items-center gap-3 text-sm">
              <input
                type="checkbox"
                checked={allDay}
                onChange={(e) => setAllDay(e.target.checked)}
                className="accent-primary size-4.5"
              />
              All day
            </label>
          </div>
          <div className="space-y-2">
            <Label htmlFor="reminder-notes">Notes (optional)</Label>
            <Textarea
              id="reminder-notes"
              name="notes"
              maxLength={1000}
              placeholder="Bring the vehicle registration"
            />
          </div>
        </form>
        <DialogFooter>
          <Button
            type="submit"
            form="reminder-form"
            size="lg"
            disabled={create.isPending}
          >
            {create.isPending ? "Creating…" : "Create reminder"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
