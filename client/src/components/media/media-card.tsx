import { Ellipsis, Play } from "lucide-react"

import type { MediaItem } from "@/lib/api/media"

export function MediaCard({
  item,
  memoryText,
  onOpen,
}: {
  item: MediaItem
  /** Content of the linked memory, when there is one. */
  memoryText?: string
  onOpen: () => void
}) {
  const video = item.content_type.startsWith("video/")
  return (
    <li className="bg-card overflow-hidden rounded-xl border">
      <button
        type="button"
        onClick={onOpen}
        className="focus-visible:ring-ring/50 relative block aspect-[3/4] w-full outline-none focus-visible:ring-3 focus-visible:ring-inset md:aspect-[360/228]"
        aria-label={`View ${item.caption || "media"}`}
      >
        {video ? (
          <video
            src={item.url}
            muted
            playsInline
            preload="metadata"
            className="bg-muted size-full object-cover"
          />
        ) : (
          // Plain <img>: presigned S3 URLs expire, so they must not go through
          // the Next image optimizer's cache.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={item.url}
            alt={item.caption}
            loading="lazy"
            className="bg-muted size-full object-cover"
          />
        )}
        {video && (
          <span className="absolute top-3 left-3 grid size-8 place-items-center rounded-full bg-black/55 text-white">
            <Play className="size-4" aria-hidden />
          </span>
        )}
      </button>
      <div className="flex items-center gap-2 py-2.5 pr-2 pl-3.5">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-semibold">
            {item.caption || "Untitled"}
          </p>
          {item.memory_id ? (
            <p className="text-muted-foreground truncate text-[10px]">
              Attached to {memoryText ? `“${memoryText}”` : "a memory"}
            </p>
          ) : (
            <p className="text-destructive text-[10px]">Unattached</p>
          )}
        </div>
        <button
          type="button"
          onClick={onOpen}
          aria-label={`Options for ${item.caption || "media"}`}
          className="text-muted-foreground hover:text-foreground grid size-11 shrink-0 place-items-center rounded-lg"
        >
          <Ellipsis className="size-4.5" aria-hidden />
        </button>
      </div>
    </li>
  )
}
