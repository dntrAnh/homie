"use client"

import { useCallback } from "react"

import { useAuth } from "@/lib/auth"
import { env } from "@/lib/env"

export type * from "./api/schema"

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
    this.name = "ApiError"
  }
}

function messageFor(status: number) {
  if (status === 401) return "Your session expired. Sign in again."
  if (status === 404) return "That item no longer exists."
  if (status === 429) return "You're going a bit fast. Try again in a minute."
  if (status >= 500) return "Homie is having trouble right now. Try again."
  return "Something went wrong. Check your input and try again."
}

/**
 * Authenticated JSON fetch scoped to the signed-in user. Query keys should
 * start with `sub` so cached data never leaks across accounts.
 */
export function useApi() {
  const auth = useAuth()
  const token = auth.session?.accessToken
  const sub = auth.session?.user.sub

  const request = useCallback(
    async <T>(path: string, init: RequestInit & { json?: unknown } = {}) => {
      if (!token || !auth.isSessionTokenActive(token)) {
        window.dispatchEvent(new Event("homie:session-expired"))
        throw new ApiError(401, messageFor(401))
      }
      const { json, headers, ...rest } = init
      let res: Response
      try {
        res = await fetch(`${env.apiUrl}${path}`, {
          ...rest,
          headers: {
            ...(json !== undefined && { "Content-Type": "application/json" }),
            Authorization: `Bearer ${token}`,
            ...headers,
          },
          body: json !== undefined ? JSON.stringify(json) : rest.body,
        })
      } catch {
        throw new ApiError(
          0,
          navigator.onLine
            ? "Couldn't reach Homie. Try again."
            : "You're offline. Reconnect and try again.",
        )
      }
      if (res.status === 401) {
        auth.invalidateSession(token)
        window.dispatchEvent(new Event("homie:session-expired"))
      }
      if (!res.ok) throw new ApiError(res.status, messageFor(res.status))
      return (res.status === 204 ? undefined : await res.json()) as T
    },
    [auth, token],
  )

  return { request, sub, enabled: Boolean(sub) }
}
