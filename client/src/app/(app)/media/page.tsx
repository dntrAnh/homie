"use client"

import {
  ChevronRight,
  CloudUpload,
  ImageUp,
  Images,
  RotateCcw,
  Upload,
  X,
} from "lucide-react"
import { useRef, useState } from "react"
import { toast } from "sonner"

import { EmptyState, ErrorState, LoadingRows } from "@/components/data-states"
import { MediaCard } from "@/components/media/media-card"
import { MediaDialog } from "@/components/media/media-dialog"
import { mobileActionClass, PageHeader } from "@/components/page-header"
import { Button } from "@/components/ui/button"
import {
  ACCEPT,
  type MediaItem,
  rejectReason,
  useMedia,
  useUploads,
} from "@/lib/api/media"
import { useMemories } from "@/lib/api/memories"
import { cn } from "@/lib/utils"

const FILTERS = [
  { value: "all", label: "All", test: () => true },
  {
    value: "photos",
    label: "Photos",
    test: (m: MediaItem) => m.content_type.startsWith("image/"),
  },
  {
    value: "videos",
    label: "Videos",
    test: (m: MediaItem) => m.content_type.startsWith("video/"),
  },
  {
    value: "unattached",
    label: "Unattached",
    test: (m: MediaItem) => !m.memory_id,
  },
] as const

export default function MediaPage() {
  const media = useMedia()
  const memories = useMemories()
  const { uploads, add, retry, dismiss } = useUploads()
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["value"]>("all")
  const [open, setOpen] = useState<MediaItem | null>(null)
  const [dragging, setDragging] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  const all = media.data ?? []
  const test = FILTERS.find((f) => f.value === filter)!.test
  const shown = all.filter(test)
  const memoryText = new Map(
    (memories.data ?? []).map((m) => [m.id, m.content]),
  )

  function addFiles(list: FileList | null) {
    const files = [...(list ?? [])]
    const ok = files.filter((file) => {
      const reason = rejectReason(file)
      if (reason) toast.error(`${file.name}: ${reason}`)
      return !reason
    })
    add(ok)
  }

  const pick = () => input.current?.click()

  return (
    <div
      className="relative flex flex-1 flex-col"
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node))
          setDragging(false)
      }}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        addFiles(e.dataTransfer.files)
      }}
    >
      <input
        ref={input}
        type="file"
        multiple
        accept={Object.keys(ACCEPT).join(",")}
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(e) => {
          addFiles(e.target.files)
          e.target.value = ""
        }}
      />

      <PageHeader
        title="Photos & videos"
        subtitle="Visual reminders attached to the things Homie remembers."
        mobileSubtitle="Media attached to your memories"
        action={
          <Button size="lg" onClick={pick}>
            <Upload aria-hidden /> Upload media
          </Button>
        }
        mobileAction={
          <button
            type="button"
            aria-label="Upload media"
            onClick={pick}
            className={mobileActionClass}
          >
            <Upload aria-hidden />
          </button>
        }
      />

      <div className="flex flex-col gap-4 p-4 md:gap-5 md:px-11 md:pt-6 md:pb-9">
        <div
          role="tablist"
          aria-label="Media type"
          className="-mx-4 flex [scrollbar-width:none] gap-2 overflow-x-auto px-4 md:mx-0 md:px-0"
        >
          {FILTERS.map((f) => {
            const active = filter === f.value
            return (
              <button
                key={f.value}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setFilter(f.value)}
                className={cn(
                  "focus-visible:ring-ring/50 flex h-11 shrink-0 items-center gap-1.5 rounded-full border px-4 text-[13px] font-semibold outline-none focus-visible:ring-3 md:h-9 md:px-3.5",
                  active
                    ? "bg-sidebar border-sidebar text-white"
                    : "text-muted-foreground bg-card",
                )}
              >
                {f.label}
                {media.data && (
                  <span
                    className={cn(
                      "hidden text-[11px] font-bold md:inline",
                      active && "text-[#bfd3c6]",
                    )}
                  >
                    {all.filter(f.test).length}
                  </span>
                )}
              </button>
            )
          })}
        </div>

        <button
          type="button"
          onClick={pick}
          className="bg-secondary text-accent-dark border-primary/25 focus-visible:ring-ring/50 flex min-h-13 items-center gap-3 rounded-[10px] border px-4 text-left outline-none focus-visible:ring-3 md:hidden"
        >
          <ImageUp className="size-5" aria-hidden />
          <span className="flex-1 text-[13px] font-semibold">
            Add photos or videos
          </span>
          <ChevronRight className="size-4.5" aria-hidden />
        </button>
        <div
          className={cn(
            "bg-secondary border-primary/25 hidden items-center gap-4 rounded-[10px] border px-5 py-4 md:flex",
            dragging && "border-primary ring-primary/30 ring-3",
          )}
        >
          <span className="bg-card text-accent-dark grid size-10 place-items-center rounded-lg">
            <CloudUpload className="size-5" aria-hidden />
          </span>
          <div>
            <p className="text-[13px] font-semibold">
              Drop photos or videos anywhere here
            </p>
            <p className="text-muted-foreground text-[11px]">
              JPG, PNG, WEBP, HEIC, MP4 or MOV
            </p>
          </div>
        </div>

        {uploads.length > 0 && (
          <ul className="space-y-2" aria-label="Uploads" aria-live="polite">
            {uploads.map((u) => (
              <li
                key={u.key}
                className="bg-card flex items-center gap-3 rounded-[10px] border px-4 py-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium">
                    {u.file.name}
                  </p>
                  {u.status === "failed" ? (
                    <p className="text-destructive text-xs">{u.error}</p>
                  ) : (
                    <div
                      role="progressbar"
                      aria-label={`Uploading ${u.file.name}`}
                      aria-valuenow={Math.round(u.progress * 100)}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      className="bg-muted mt-2 h-1.5 overflow-hidden rounded-full"
                    >
                      <div
                        className="bg-primary h-full transition-[width]"
                        style={{ width: `${u.progress * 100}%` }}
                      />
                    </div>
                  )}
                </div>
                {u.status === "failed" && (
                  <>
                    <Button
                      variant="outline"
                      size="lg"
                      onClick={() => retry(u)}
                    >
                      <RotateCcw aria-hidden /> Retry
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-lg"
                      aria-label={`Dismiss ${u.file.name}`}
                      onClick={() => dismiss(u.key)}
                    >
                      <X aria-hidden />
                    </Button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}

        {media.isPending ? (
          <LoadingRows count={2} className="h-60" />
        ) : media.isError ? (
          <ErrorState error={media.error} onRetry={() => media.refetch()} />
        ) : shown.length === 0 ? (
          <EmptyState
            icon={Images}
            title={
              filter === "all" ? "No photos or videos yet" : "Nothing here"
            }
          >
            A photo of where you keep something makes it easier to recognize
            later.
          </EmptyState>
        ) : (
          <ul className="grid grid-cols-2 gap-3 md:gap-4 lg:grid-cols-3">
            {shown.map((item) => (
              <MediaCard
                key={item.id}
                item={item}
                memoryText={
                  item.memory_id ? memoryText.get(item.memory_id) : undefined
                }
                onOpen={() => setOpen(item)}
              />
            ))}
          </ul>
        )}
      </div>

      <MediaDialog
        item={open}
        memories={memories.data ?? []}
        onClose={() => setOpen(null)}
      />
    </div>
  )
}
