"use client"

import { ChevronDown, Pencil, Trash2 } from "lucide-react"
import Link from "next/link"
import { toast } from "sonner"

import { ConfirmDialog } from "@/components/confirm-dialog"
import { KINDS } from "@/components/memories/kinds"
import { Skeleton } from "@/components/ui/skeleton"
import { useDeleteMemory, useMemories } from "@/lib/api/memories"
import { formatRelative } from "@/lib/format"
import { cn } from "@/lib/utils"

function Detail({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-sidebar-primary text-[9px] font-bold tracking-wide uppercase">
        {label}
      </dt>
      <dd className="mt-0.5 text-[11px] break-words">{value}</dd>
    </div>
  )
}

const date = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" })

/** Live view of what the simulator's tools read and write. */
export function StoredMemories() {
  const memories = useMemories()
  const remove = useDeleteMemory()

  return (
    <section
      aria-labelledby="stored-memories"
      className="bg-sidebar flex min-h-0 w-full flex-col rounded-xl p-4.5 text-white"
    >
      <h2 id="stored-memories" className="font-heading text-[22px] font-medium">
        Stored memories
      </h2>
      <p className="mt-1.5 text-[11px] text-[#bfd0c6]">
        Current memory state. Expand any memory to inspect or make changes.
      </p>
      <div className="mt-3 min-h-0 flex-1 space-y-2.5 overflow-y-auto">
        {memories.isPending ? (
          [0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-20 rounded-lg bg-white/10" />
          ))
        ) : memories.isError ? (
          <p role="alert" className="text-xs text-[#f1b8b2]">
            {memories.error.message}
          </p>
        ) : memories.data.length === 0 ? (
          <p className="text-xs text-[#bfd0c6]">
            Nothing stored yet. Ask Alexa to remember something.
          </p>
        ) : (
          memories.data.map((m) => {
            const kind = KINDS[m.kind]
            const Icon = kind.icon
            return (
              <details
                key={m.id}
                className="group rounded-lg border border-white/10 bg-white/[0.06] open:bg-white/10"
              >
                <summary className="flex min-h-11 cursor-pointer list-none flex-col gap-2 p-2.5 [&::-webkit-details-marker]:hidden">
                  <span className="flex items-center gap-2">
                    <span
                      className={cn(
                        "text-accent-dark grid size-6 place-items-center rounded-md",
                        kind.tint,
                      )}
                      aria-hidden
                    >
                      <Icon className="size-3.5" />
                    </span>
                    <span className="text-[11px] font-semibold">
                      {kind.label}
                    </span>
                    {m.tags[0] && (
                      <span className="rounded-full bg-white/10 px-2 py-0.5 text-[9px] text-[#d6e2db]">
                        {m.tags[0]}
                      </span>
                    )}
                    <span className="ml-auto text-[9px] text-[#bfd0c6]">
                      {formatRelative(m.updated_at)}
                    </span>
                    <ChevronDown
                      className="size-3.5 text-[#bfd0c6] transition-transform group-open:rotate-180"
                      aria-hidden
                    />
                  </span>
                  <span className="line-clamp-2 text-[11px] text-[#d6e2db] group-open:line-clamp-none group-open:text-[13px] group-open:text-white">
                    {m.content}
                  </span>
                </summary>
                <div className="border-t border-white/10 px-2.5 pt-3 pb-2.5">
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5">
                    <Detail label="Kind" value={m.kind} />
                    <Detail label="Tags" value={m.tags.join(", ") || "—"} />
                    {m.event_id && (
                      <Detail label="Event_id" value={m.event_id} />
                    )}
                    <Detail label="Created" value={date(m.created_at)} />
                    <Detail label="Updated" value={date(m.updated_at)} />
                  </dl>
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <Link
                      href={`/memories/${encodeURIComponent(m.id)}`}
                      className="flex h-11 items-center justify-center gap-2 rounded-lg border border-white/15 bg-white/10 text-xs font-medium hover:bg-white/15"
                    >
                      <Pencil className="size-3.5" aria-hidden /> Edit
                    </Link>
                    <ConfirmDialog
                      title="Delete this memory?"
                      description={`Alexa will no longer remember: “${m.content}”`}
                      onConfirm={async () => {
                        await remove.mutateAsync(m.id)
                        toast.success("Memory deleted")
                      }}
                      trigger={
                        <button
                          type="button"
                          className="flex h-11 items-center justify-center gap-2 rounded-lg border border-[#c9776f]/60 text-xs font-medium text-[#f1b8b2] hover:bg-white/5"
                        >
                          <Trash2 className="size-3.5" aria-hidden /> Delete
                        </button>
                      }
                    />
                  </div>
                </div>
              </details>
            )
          })
        )}
      </div>
    </section>
  )
}
