"use client"

import { useParams } from "next/navigation"

import { ErrorState, LoadingRows } from "@/components/data-states"
import { MemoryEditor } from "@/components/memories/memory-editor"
import { useMemory } from "@/lib/api/memories"

export default function MemoryPage() {
  const { id } = useParams<{ id: string }>()
  const isNew = id === "new"
  const memory = useMemory(isNew ? undefined : id)

  if (isNew) return <MemoryEditor />
  if (memory.isPending) {
    return (
      <div className="p-4 md:px-11 md:py-9">
        <LoadingRows count={2} className="h-40" />
      </div>
    )
  }
  if (memory.isError) {
    return (
      <div className="p-4 md:px-11 md:py-9">
        <ErrorState error={memory.error} onRetry={() => memory.refetch()} />
      </div>
    )
  }
  return <MemoryEditor key={memory.data.id} memory={memory.data} />
}
