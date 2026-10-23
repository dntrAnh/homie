"use client"

import { useMutation } from "@tanstack/react-query"

import { ApiError, useApi } from "@/lib/api"
import type { components } from "@/lib/api/schema"

export type ChatMessage = components["schemas"]["ChatMessage"]
export type ChatReply = components["schemas"]["ChatReply"]
export type ToolCall = ChatReply["tool_calls"][number]
export type RecalledMemory = components["schemas"]["RecalledMemory"]

export function toolError(call: ToolCall) {
  return "error" in call.result ? call.result.error : null
}

function retryAfterMessage(seconds: number | undefined) {
  if (!seconds) return "Try again shortly."
  if (seconds >= 3600) {
    return `Try again in about ${Math.ceil(seconds / 3600)} hours.`
  }
  if (seconds >= 60)
    return `Try again in about ${Math.ceil(seconds / 60)} minutes.`
  return `Try again in ${seconds} seconds.`
}

function simulatorError(error: unknown) {
  if (!(error instanceof ApiError)) return error
  if (error.status === 429) {
    return new ApiError(
      error.status,
      `Alexa is rate limited. ${retryAfterMessage(error.retryAfter)}`,
      error.retryAfter,
    )
  }
  if (error.status === 502) {
    return new ApiError(
      error.status,
      "Alexa returned an invalid response. Please try again.",
    )
  }
  if (error.status === 503) {
    return new ApiError(
      error.status,
      "Alexa is temporarily unavailable. Please try again.",
    )
  }
  if (error.status === 504) {
    return new ApiError(
      error.status,
      "Alexa took too long to respond. Please try again.",
    )
  }
  return error
}

export function useSimulatorChat() {
  const { request } = useApi()
  return useMutation({
    mutationFn: async (messages: ChatMessage[]) => {
      try {
        return await request<ChatReply>("/api/simulator/chat", {
          method: "POST",
          json: { messages },
        })
      } catch (error) {
        throw simulatorError(error)
      }
    },
  })
}

/** Memories a `recall` tool call returned, for inline cards. */
export function recalled(calls: ToolCall[]): RecalledMemory[] {
  return calls.flatMap((call) =>
    call.name === "recall" && Array.isArray(call.result) ? call.result : [],
  )
}

/** A successful mutation means the dashboard's memory queries are now stale. */
export function mutatedMemories(calls: ToolCall[]) {
  return calls.some(
    (call) =>
      (call.name === "remember" || call.name === "forget") &&
      toolError(call) === null,
  )
}
