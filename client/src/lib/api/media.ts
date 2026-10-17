"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useCallback, useState } from "react"

import { useApi } from "@/lib/api"

export type MediaItem = {
  id: string
  content_type: string
  size: number
  caption: string
  tags: string[]
  memory_id?: string | null
  training_consent: boolean
  status: "pending" | "uploaded"
  /** Short-lived presigned GET. Never cache or persist it. */
  url: string
  created_at: string
}

export type MediaUpdate = Partial<
  Pick<MediaItem, "caption" | "tags" | "training_consent" | "memory_id">
>

export const ACCEPT = {
  "image/jpeg": 50,
  "image/png": 50,
  "image/webp": 50,
  "image/heic": 50,
  "video/mp4": 500,
  "video/quicktime": 500,
} as const satisfies Record<string, number> // MB caps, spec §5

export function rejectReason(file: File) {
  const capMb = ACCEPT[file.type as keyof typeof ACCEPT]
  if (!capMb) return "Use JPG, PNG, WEBP, HEIC, MP4 or MOV."
  if (file.size > capMb * 1024 * 1024) return `Keep it under ${capMb} MB.`
  return null
}

export function useMedia() {
  const { request, sub, enabled } = useApi()
  return useQuery({
    queryKey: [sub, "media"],
    enabled,
    queryFn: ({ signal }) =>
      request<MediaItem[]>("/api/media?limit=200", { signal }),
    // Presigned GETs expire after 15 min; refresh well before that.
    staleTime: 5 * 60_000,
  })
}

export function useUpdateMedia() {
  const { request, sub } = useApi()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: MediaUpdate }) =>
      request<MediaItem>(`/api/media/${encodeURIComponent(id)}`, {
        method: "PATCH",
        json: body,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: [sub, "media"] }),
  })
}

export function useDeleteMedia() {
  const { request, sub } = useApi()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      request<void>(`/api/media/${encodeURIComponent(id)}`, {
        method: "DELETE",
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: [sub, "media"] }),
  })
}

export type Upload = {
  key: string
  file: File
  progress: number
  status: "uploading" | "failed"
  error?: string
}

function putWithProgress(
  url: string,
  file: File,
  onProgress: (fraction: number) => void,
) {
  // fetch() has no upload progress yet; XHR does.
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open("PUT", url)
    xhr.setRequestHeader("Content-Type", file.type)
    xhr.upload.onprogress = (e) =>
      e.lengthComputable && onProgress(e.loaded / e.total)
    xhr.onload = () =>
      xhr.status < 300 ? resolve() : reject(new Error("Upload was rejected."))
    xhr.onerror = () => reject(new Error("Upload interrupted."))
    xhr.send(file)
  })
}

/**
 * Foreground uploads: create a pending record + presigned PUT, upload,
 * then confirm. A retry starts over with a fresh presigned URL.
 */
const patchUpload = (key: string, next: Partial<Upload>) => (list: Upload[]) =>
  list.map((u) => (u.key === key ? { ...u, ...next } : u))

export function useUploads() {
  const { request, sub } = useApi()
  const qc = useQueryClient()
  const [uploads, setUploads] = useState<Upload[]>([])

  const run = useCallback(
    async (key: string, file: File) => {
      setUploads(
        patchUpload(key, {
          status: "uploading",
          progress: 0,
          error: undefined,
        }),
      )
      try {
        const { media, upload_url } = await request<{
          media: MediaItem
          upload_url: string
        }>("/api/media", {
          method: "POST",
          json: {
            content_type: file.type,
            size: file.size,
            caption: file.name.replace(/\.[^.]+$/, ""),
          },
        })
        await putWithProgress(upload_url, file, (p) =>
          setUploads(patchUpload(key, { progress: p })),
        )
        await request(`/api/media/${encodeURIComponent(media.id)}/complete`, {
          method: "POST",
        })
        setUploads((list) => list.filter((u) => u.key !== key))
        void qc.invalidateQueries({ queryKey: [sub, "media"] })
      } catch (err) {
        setUploads(
          patchUpload(key, {
            status: "failed",
            error: err instanceof Error ? err.message : "Upload failed.",
          }),
        )
      }
    },
    [request, qc, sub],
  )

  const add = useCallback(
    (files: File[]) => {
      for (const file of files) {
        const key = crypto.randomUUID()
        setUploads((list) => [
          ...list,
          { key, file, progress: 0, status: "uploading" },
        ])
        void run(key, file)
      }
    },
    [run],
  )

  return {
    uploads,
    add,
    retry: (u: Upload) => void run(u.key, u.file),
    dismiss: (key: string) =>
      setUploads((list) => list.filter((u) => u.key !== key)),
  }
}
