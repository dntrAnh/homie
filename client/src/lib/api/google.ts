"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import { useApi } from "@/lib/api"

// Contract: spec §7 `GET /api/google`.
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
 * a full-page redirect to Google's consent screen. Returns `{ url }`, not a
 * 302: a page navigation can't carry the Bearer token (spec §7).
 */
export function useConnectGoogle() {
  const { request } = useApi()
  return useMutation({
    mutationFn: async () => {
      const { url } = await request<{ url?: unknown }>("/api/google/connect")
      // Only ever navigate to Google's consent screen.
      if (
        typeof url !== "string" ||
        !url.startsWith("https://accounts.google.com/")
      )
        throw new Error("Couldn't start Google sign-in. Try again in a moment.")
      return url
    },
    onSuccess: (url) => window.location.assign(url),
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
