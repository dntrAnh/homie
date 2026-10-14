"use client"

import { Brain, Plus, Search } from "lucide-react"
import Link from "next/link"
import { useDeferredValue, useState } from "react"

import { EmptyState, ErrorState, LoadingRows } from "@/components/data-states"
import { KIND_ORDER, KINDS } from "@/components/memories/kinds"
import { MemoryRow } from "@/components/memories/memory-row"
import { mobileActionClass, PageHeader } from "@/components/page-header"
import { buttonVariants } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { type MemoryKind, useMemories } from "@/lib/api/memories"
import { cn } from "@/lib/utils"

type Tab = MemoryKind | "all"

export default function MemoriesPage() {
  const [tab, setTab] = useState<Tab>("all")
  const [search, setSearch] = useState("")
  const q = useDeferredValue(search.trim())
  const memories = useMemories(q)
  const all = memories.data ?? []
  const shown = tab === "all" ? all : all.filter((m) => m.kind === tab)
  const count = (k: Tab) =>
    k === "all" ? all.length : all.filter((m) => m.kind === k).length

  const total = memories.data
    ? `${all.length} ${all.length === 1 ? "thing" : "things"}`
    : null

  return (
    <>
      <PageHeader
        title="Your memories"
        subtitle={total && `${total} Homie is keeping close for you.`}
        mobileSubtitle={total ? `${total} remembered` : undefined}
        action={
          <Link href="/memories/new" className={buttonVariants({ size: "lg" })}>
            <Plus aria-hidden /> Add memory
          </Link>
        }
        mobileAction={
          <Link
            href="/memories/new"
            aria-label="Add memory"
            className={mobileActionClass}
          >
            <Plus aria-hidden />
          </Link>
        }
      />

      <div className="flex flex-col gap-4 p-4 md:gap-6 md:px-11 md:pt-6 md:pb-9">
        <div className="relative">
          <Search
            className="text-muted-foreground pointer-events-none absolute top-1/2 left-4 size-4.5 -translate-y-1/2"
            aria-hidden
          />
          <Input
            type="search"
            aria-label="Search memories"
            placeholder="Search what Homie remembers…"
            className="h-11.5 pl-11"
            maxLength={200}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <div
          role="tablist"
          aria-label="Memory type"
          className="-mx-4 flex [scrollbar-width:none] gap-2 overflow-x-auto px-4 md:mx-0 md:px-0"
        >
          {(["all", ...KIND_ORDER] as Tab[]).map((k) => {
            const active = tab === k
            return (
              <button
                key={k}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setTab(k)}
                className={cn(
                  "focus-visible:ring-ring/50 flex h-11 shrink-0 items-center gap-1.5 rounded-full border px-4 text-[13px] font-semibold outline-none focus-visible:ring-3 md:h-9 md:px-3.5",
                  active
                    ? "bg-sidebar border-sidebar text-white"
                    : "text-muted-foreground bg-card md:bg-transparent",
                )}
              >
                <span className="md:hidden">
                  {k === "all" ? "All" : KINDS[k].short}
                </span>
                <span className="hidden md:inline">
                  {k === "all" ? "All" : KINDS[k].plural}
                </span>
                {memories.data && (
                  <span
                    className={cn(
                      "hidden text-[11px] font-bold md:inline",
                      active && "text-[#bfd3c6]",
                    )}
                  >
                    {count(k)}
                  </span>
                )}
              </button>
            )
          })}
        </div>

        {memories.isPending ? (
          <LoadingRows />
        ) : memories.isError ? (
          <ErrorState
            error={memories.error}
            onRetry={() => memories.refetch()}
          />
        ) : shown.length === 0 ? (
          <EmptyState
            icon={q ? Search : Brain}
            title={q ? `Nothing matches “${q}”` : "Nothing here yet"}
          >
            {q
              ? "Try a different word, or clear the search."
              : "Tell Alexa “remember my passport is in the desk drawer”, or add one yourself."}
          </EmptyState>
        ) : (
          <ul className="space-y-2.5">
            {shown.map((m) => (
              <MemoryRow key={m.id} memory={m} />
            ))}
          </ul>
        )}
      </div>
    </>
  )
}
