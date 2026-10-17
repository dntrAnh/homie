"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import { useApi } from "@/lib/api"

// dev-note: assumes GET /api/google returns connection status; the spec
// (§7) only lists connect/callback/disconnect so far.
export type GoogleStatus = { connected: boolean; email?: string | null }

export function useGoogleStatus() {
  const { request, sub, enabled } = useApi()
  return useQuery({
    queryKey: [sub, "google"],
    enabled,
    queryFn: ({ signal }) => request<GoogleStatus>("/api/google", { signal }),
  })
}

/**
 * Authenticated call so the server can bind OAuth `state` to this user, then
 * a full-page redirect to Google's consent screen.
 * dev-note: assumes GET /api/google/connect returns `{ url }` instead of a 302.
 */
export function useConnectGoogle() {
  const { request } = useApi()
  return useMutation({
    mutationFn: () => request<{ url: string }>("/api/google/connect"),
    onSuccess: ({ url }) => window.location.assign(url),
  })
}

export function useDisconnectGoogle() {
  const { request, sub } = useApi()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => request<void>("/api/google", { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: [sub] }),
  })
}
