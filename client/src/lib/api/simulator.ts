"use client"

import { useMutation } from "@tanstack/react-query"

import { useApi } from "@/lib/api"
import type { Memory } from "@/lib/api/memories"

export type ChatMessage = { role: "user" | "assistant"; content: string }

export type ToolCall = {
  name: string
  arguments: Record<string, unknown>
  result?: unknown
}

export type ChatReply = { reply: string; tool_calls: ToolCall[] }

export function useSimulatorChat() {
  const { request } = useApi()
  return useMutation({
    mutationFn: (messages: ChatMessage[]) =>
      request<ChatReply>("/api/simulator/chat", {
        method: "POST",
        json: { messages },
      }),
  })
}

/** Memories a `recall` tool call returned, for inline cards. */
export function recalled(calls: ToolCall[]): Memory[] {
  return calls.flatMap((call) =>
    call.name === "recall" && Array.isArray(call.result)
      ? (call.result as Memory[])
      : [],
  )
}
