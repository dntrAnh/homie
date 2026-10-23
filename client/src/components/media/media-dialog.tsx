"use client"

import { Trash2 } from "lucide-react"
import { toast } from "sonner"

import { ConfirmDialog } from "@/components/confirm-dialog"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { type MediaItem, useDeleteMedia, useUpdateMedia } from "@/lib/api/media"
import type { Memory } from "@/lib/api/memories"

export function MediaDialog({
  item,
  memories,
  onClose,
}: {
  item: MediaItem | null
  memories: Memory[]
  onClose: () => void
}) {
  const update = useUpdateMedia()
  const remove = useDeleteMedia()

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!item) return
    const form = new FormData(e.currentTarget)
    update.mutate(
      {
        id: item.id,
        body: {
          caption: String(form.get("caption")).trim(),
          memory_id: String(form.get("memory_id")) || null,
          training_consent: form.get("training_consent") === "on",
        },
      },
      {
        onSuccess: () => {
          toast.success("Saved")
          onClose()
        },
        onError: (err) => toast.error(err.message),
      },
    )
  }

  return (
    <Dialog
      open={item !== null}
      onOpenChange={(open) => !open && !update.isPending && onClose()}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        {item && (
          <>
            <DialogHeader>
              <DialogTitle>{item.caption || "Untitled"}</DialogTitle>
            </DialogHeader>
            {item.content_type.startsWith("video/") ? (
              <video
                src={item.url}
                controls
                playsInline
                className="max-h-80 w-full rounded-lg bg-black"
              />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={item.url}
                alt={item.caption}
                className="bg-muted max-h-80 w-full rounded-lg object-contain"
              />
            )}
            <form
              id="media-form"
              key={item.id}
              onSubmit={onSubmit}
              className="space-y-4"
            >
              <div className="space-y-2">
                <Label htmlFor="media-caption">Caption</Label>
                <Input
                  id="media-caption"
                  name="caption"
                  maxLength={200}
                  defaultValue={item.caption}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="media-memory">Attached memory</Label>
                <select
                  id="media-memory"
                  name="memory_id"
                  defaultValue={item.memory_id ?? ""}
                  className="bg-card focus-visible:border-ring focus-visible:ring-ring/50 h-12 w-full rounded-lg border px-3 text-base outline-none focus-visible:ring-3"
                >
                  <option value="">Not attached</option>
                  {/* A stable option for the current link, so it survives memories loading,
                      failing, or paging it out (removing a selected option resets the select). */}
                  {item.memory_id && (
                    <option value={item.memory_id}>
                      {memories
                        .find((m) => m.id === item.memory_id)
                        ?.content.slice(0, 80) ?? "Current memory"}
                    </option>
                  )}
                  {memories
                    .filter((m) => m.id !== item.memory_id)
                    .map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.content.slice(0, 80)}
                      </option>
                    ))}
                </select>
              </div>
              <label className="flex min-h-11 items-start gap-3 text-sm">
                <input
                  type="checkbox"
                  name="training_consent"
                  defaultChecked={item.training_consent}
                  className="accent-primary mt-0.5 size-4.5 shrink-0"
                />
                <span>
                  Allow Homie to use this to improve recognition
                  <span className="text-muted-foreground block text-xs">
                    Off by default. You can change this anytime.
                  </span>
                </span>
              </label>
            </form>
            <DialogFooter className="sm:justify-between">
              <ConfirmDialog
                title="Delete this file?"
                description="It's removed from Homie and from any memory it's attached to. This can't be undone."
                onConfirm={async () => {
                  await remove.mutateAsync(item.id)
                  toast.success("Deleted")
                  onClose()
                }}
                trigger={
                  <Button variant="destructive" size="lg">
                    <Trash2 aria-hidden /> Delete
                  </Button>
                }
              />
              <Button
                type="submit"
                form="media-form"
                size="lg"
                disabled={update.isPending}
              >
                {update.isPending ? "Saving…" : "Save"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
