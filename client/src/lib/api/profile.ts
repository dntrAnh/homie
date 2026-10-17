"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import { useApi } from "@/lib/api"

export type TravelMode = "DRIVE" | "WALK" | "TRANSIT" | "BICYCLE"

export type Profile = {
  timezone: string
  home?: { address: string; lat: number; lng: number } | null
  travel_mode: TravelMode
}

export type ProfileUpdate = {
  timezone: string
  travel_mode: TravelMode
  /** Server geocodes it; empty string clears home. */
  home_address: string
}

export function useProfile() {
  const { request, sub, enabled } = useApi()
  return useQuery({
    queryKey: [sub, "profile"],
    enabled,
    queryFn: ({ signal }) => request<Profile>("/api/me/profile", { signal }),
  })
}

export function useUpdateProfile() {
  const { request, sub } = useApi()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: ProfileUpdate) =>
      request<Profile>("/api/me/profile", { method: "PUT", json: body }),
    onSuccess: (profile) => qc.setQueryData([sub, "profile"], profile),
  })
}

export function useDeleteAccount() {
  const { request } = useApi()
  return useMutation({
    mutationFn: () => request<void>("/api/me", { method: "DELETE" }),
  })
}

// dev-note: assumes GET /api/me/export (not in the spec yet) returning JSON.
export function useExportData() {
  const { request } = useApi()
  return useMutation({
    mutationFn: async () => {
      const data = await request<unknown>("/api/me/export")
      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: "application/json",
      })
      const url = URL.createObjectURL(blob)
      const a = Object.assign(document.createElement("a"), {
        href: url,
        download: "homie-data.json",
      })
      a.click()
      URL.revokeObjectURL(url)
    },
  })
}
