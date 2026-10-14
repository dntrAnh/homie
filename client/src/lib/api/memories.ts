"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import { useApi } from "@/lib/api"

// dev-note: hand-written to match the P0 spec (§5, §7). Swap for types
// generated from the server's /openapi.json once /api/memories ships.
export type MemoryKind = "item_location" | "fact" | "preference" | "todo"

export type Memory = {
  id: string
  kind: MemoryKind
  content: string
  tags: string[]
  event_id?: string | null
  media_ids: string[]
  created_at: string
  updated_at: string
}

export type MemoryInput = Pick<Memory, "kind" | "content" | "tags">

export function useMemories(q = "") {
  const { request, sub, enabled } = useApi()
  return useQuery({
    queryKey: [sub, "memories", q],
    enabled,
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({ limit: "200" })
      if (q) params.set("q", q)
      return request<Memory[]>(`/api/memories?${params}`, { signal })
    },
  })
}

export function useMemory(id: string | undefined) {
  const { request, sub, enabled } = useApi()
  return useQuery({
    queryKey: [sub, "memories", "detail", id],
    enabled: enabled && Boolean(id),
    queryFn: ({ signal }) =>
      request<Memory>(`/api/memories/${encodeURIComponent(id!)}`, { signal }),
  })
}

export function useSaveMemory() {
  const { request, sub } = useApi()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({
      id,
      body,
      requestId,
    }: {
      id?: string
      body: MemoryInput
      /** Reused on retries so the server can dedupe an uncertain create. */
      requestId: string
    }) =>
      id
        ? request<Memory>(`/api/memories/${encodeURIComponent(id)}`, {
            method: "PATCH",
            json: body,
          })
        : request<Memory>("/api/memories", {
            method: "POST",
            json: body,
            headers: { "Idempotency-Key": requestId },
          }),
    onSuccess: () => qc.invalidateQueries({ queryKey: [sub, "memories"] }),
  })
}

export function useDeleteMemory() {
  const { request, sub } = useApi()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      request<void>(`/api/memories/${encodeURIComponent(id)}`, {
        method: "DELETE",
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: [sub, "memories"] }),
  })
}
