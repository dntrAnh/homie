import { ChevronRight } from "lucide-react"
import Link from "next/link"

import type { Memory } from "@/lib/api/memories"
import { formatRelative } from "@/lib/format"
import { cn } from "@/lib/utils"

import { KINDS } from "./kinds"

export function MemoryRow({ memory }: { memory: Memory }) {
  const kind = KINDS[memory.kind]
  const Icon = kind.icon
  return (
    <li>
      <Link
        href={`/memories/${encodeURIComponent(memory.id)}`}
        className="bg-card hover:border-primary/40 focus-visible:ring-ring/50 flex min-h-23 items-center gap-3.5 rounded-[10px] border px-3 py-4 outline-none focus-visible:ring-3 md:gap-4 md:px-4.5"
      >
        <span
          className={cn(
            "text-accent-dark grid size-10.5 shrink-0 place-items-center rounded-[9px]",
            kind.tint,
          )}
          aria-hidden
        >
          <Icon className="size-5" />
        </span>
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-muted-foreground text-[10px] font-bold tracking-widest uppercase">
            {kind.label}
          </p>
          <p className="line-clamp-2 text-sm font-semibold break-words md:text-[15px] md:font-medium">
            {memory.content}
          </p>
          {memory.tags.length > 0 && (
            <p className="text-muted-foreground hidden truncate text-[11px] md:block">
              {memory.tags.join(" · ")}
            </p>
          )}
        </div>
        <time
          dateTime={memory.updated_at}
          className="text-muted-foreground hidden shrink-0 text-[11px] md:block"
        >
          {formatRelative(memory.updated_at)}
        </time>
        <ChevronRight
          className="text-muted-foreground size-4.5 shrink-0"
          aria-hidden
        />
      </Link>
    </li>
  )
}
