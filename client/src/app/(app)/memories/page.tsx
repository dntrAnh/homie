"use client"

import { useQuery } from "@tanstack/react-query"

import { EmptyState, ErrorState, LoadingRows } from "@/components/data-states"
import { Card, CardContent } from "@/components/ui/card"
import { ApiError, useApi } from "@/lib/api"

const KIND_LABELS: Record<string, string> = {
  item_location: "Item location",
  fact: "Fact",
  preference: "Preference",
  todo: "To do",
}

export default function MemoriesPage() {
  const api = useApi()

  const { data, error, isPending, refetch } = useQuery({
    queryKey: ["memories"],
    queryFn: async () => {
      const { data, response } = await api.GET("/api/memories", {})
      if (!response.ok) {
        throw new ApiError(
          response.status,
          response.status === 401
            ? "Sign in again to see your memories."
            : "Couldn't load your memories.",
        )
      }
      return data ?? []
    },
  })

  return (
    <main className="space-y-4 p-4 md:p-8">
      <h1 className="text-lg font-semibold">Memories</h1>

      {isPending && <LoadingRows count={3} />}

      {error && <ErrorState error={error} onRetry={() => void refetch()} />}

      {data && data.length === 0 && (
        <EmptyState title="No memories yet">
          Your remembered items will appear here.
        </EmptyState>
      )}

      {data &&
        data.map((memory) => (
          <Card key={memory.id}>
            <CardContent className="space-y-2 pt-4">
              <p className="text-base font-medium">{memory.content}</p>
              <p className="text-muted-foreground text-sm">
                {KIND_LABELS[memory.kind] ?? memory.kind} ·{" "}
                {new Date(memory.created_at).toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                })}
              </p>
              {memory.tags.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {memory.tags.map((tag) => (
                    <span
                      key={tag}
                      className="rounded-full border px-2 py-0.5 text-xs"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        ))}
    </main>
  )
}
