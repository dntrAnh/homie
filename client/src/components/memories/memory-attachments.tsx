"use client"

import {
  Image as ImageIcon,
  Paperclip,
  RefreshCw,
  TriangleAlert,
  WifiOff,
} from "lucide-react"
import Link from "next/link"

import { MediaCard } from "@/components/media/media-card"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { ApiError } from "@/lib/api"
import { useMemoryMedia } from "@/lib/api/media"

const fieldLabel =
  "text-[11px] font-bold tracking-wide uppercase text-foreground"
const gridClass = "grid grid-cols-2 gap-3 md:gap-4 xl:grid-cols-3"

export function MemoryAttachments({ memoryId }: { memoryId?: string }) {
  const media = useMemoryMedia(memoryId)
  const count = media.data?.length
  const offline = media.error instanceof ApiError && media.error.status === 0

  return (
    <div className="space-y-2.5">
      <div className="flex min-h-11 items-center justify-between gap-3">
        <span className={fieldLabel}>
          Attachments{count !== undefined && ` (${count})`}
        </span>
        {memoryId && (
          <Link
            href="/media"
            className="text-accent-dark inline-flex min-h-11 items-center gap-1.5 text-xs font-semibold hover:underline"
          >
            <Paperclip className="size-4" aria-hidden /> Add photo or video
          </Link>
        )}
      </div>

      {!memoryId ? (
        <div className="bg-muted flex items-center gap-4 rounded-lg border px-4 py-4.5">
          <ImageIcon
            className="text-muted-foreground size-5 shrink-0"
            aria-hidden
          />
          <div className="min-w-0">
            <p className="text-[13px] font-semibold">Save this memory first</p>
            <p className="text-muted-foreground text-xs">
              After saving, you can attach photos or videos from the Media page.
            </p>
          </div>
        </div>
      ) : media.isPending ? (
        <div aria-busy="true">
          <span className="sr-only">Loading attachments…</span>
          <ul className={gridClass}>
            {Array.from({ length: 2 }, (_, index) => (
              <li key={index}>
                <Skeleton className="aspect-[3/4] w-full rounded-xl md:aspect-[360/228]" />
                <Skeleton className="mt-2.5 h-4 w-2/3" />
              </li>
            ))}
          </ul>
        </div>
      ) : media.isError ? (
        <div
          role="alert"
          className="bg-muted flex flex-col items-start gap-3 rounded-lg border p-4 sm:flex-row sm:items-center"
        >
          <div className="flex min-w-0 flex-1 items-center gap-3 text-[13px] font-medium">
            {offline ? (
              <WifiOff
                className="text-destructive size-5 shrink-0"
                aria-hidden
              />
            ) : (
              <TriangleAlert
                className="text-destructive size-5 shrink-0"
                aria-hidden
              />
            )}
            <span>
              {media.error instanceof Error
                ? media.error.message
                : "Couldn't load attachments."}
            </span>
          </div>
          <Button
            variant="outline"
            size="lg"
            onClick={() => void media.refetch()}
          >
            <RefreshCw aria-hidden /> Try again
          </Button>
        </div>
      ) : media.data.length === 0 ? (
        <div className="bg-muted flex items-center gap-4 rounded-lg border px-4 py-4.5">
          <ImageIcon
            className="text-muted-foreground size-5 shrink-0"
            aria-hidden
          />
          <div className="min-w-0">
            <p className="text-[13px] font-semibold">No media attached</p>
            <p className="text-muted-foreground text-xs">
              A photo can make this memory easier to recognize.
            </p>
          </div>
        </div>
      ) : (
        <ul className={gridClass}>
          {media.data.map((item) => (
            <MediaCard key={item.id} item={item} showAttachmentStatus={false} />
          ))}
        </ul>
      )}
    </div>
  )
}
