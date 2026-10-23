"use client"

import { useQueryClient } from "@tanstack/react-query"
import {
  ArrowUp,
  ChevronRight,
  Database,
  RotateCcw,
  Search,
  Sparkles,
} from "lucide-react"
import Link from "next/link"
import { useEffect, useRef, useState } from "react"

import { KINDS } from "@/components/memories/kinds"
import { mobileActionClass, PageHeader } from "@/components/page-header"
import { StoredMemories } from "@/components/simulator/stored-memories"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useApi } from "@/lib/api"
import { useMemories } from "@/lib/api/memories"
import {
  type ChatMessage,
  mutatedMemories,
  recalled,
  type ToolCall,
  toolError,
  useSimulatorChat,
} from "@/lib/api/simulator"
import { useAuth } from "@/lib/auth"
import { cn } from "@/lib/utils"

type Turn = ChatMessage & { tools?: ToolCall[] }

function Avatar() {
  return (
    <span
      aria-hidden
      className="bg-sidebar text-sidebar-primary grid size-8 shrink-0 place-items-center rounded-full"
    >
      <Sparkles className="size-4" />
    </span>
  )
}

function AssistantTurn({ turn }: { turn: Turn }) {
  const calls = turn.tools ?? []
  const memories = recalled(calls)
  const recallCalls = calls.filter((call) => call.name === "recall")
  const changes = calls.filter((call) => call.name !== "recall")
  return (
    <li className="flex items-start gap-3">
      <Avatar />
      <div className="bg-card max-w-[34rem] min-w-0 rounded-xl border px-3.5 py-3 text-sm md:text-[15px]">
        <p className="whitespace-pre-wrap">{turn.content}</p>
        {memories.length > 0 && (
          <>
            <ul className="mt-3 space-y-2 md:hidden">
              {memories.map((m) => {
                const kind = KINDS[m.kind]
                const Icon = kind.icon
                return (
                  <li key={m.id}>
                    <Link
                      href={`/memories/${encodeURIComponent(m.id)}`}
                      className="bg-muted flex min-h-13 items-center gap-3 rounded-lg px-3"
                    >
                      <span
                        className={cn(
                          "text-accent-dark grid size-8 shrink-0 place-items-center rounded-lg",
                          kind.tint,
                        )}
                        aria-hidden
                      >
                        <Icon className="size-4" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="text-muted-foreground block text-[10px] font-semibold">
                          {kind.label}
                        </span>
                        <span className="block truncate text-xs font-semibold">
                          {m.content}
                        </span>
                      </span>
                      <ChevronRight
                        className="text-muted-foreground size-4"
                        aria-hidden
                      />
                    </Link>
                  </li>
                )
              })}
            </ul>
            <span className="bg-secondary text-accent-dark mt-3 hidden h-7 items-center gap-1.5 rounded-full px-2.5 text-xs font-semibold md:inline-flex">
              <Search className="size-3.5" aria-hidden />
              {memories.length} {memories.length === 1 ? "memory" : "memories"}{" "}
              recalled
            </span>
          </>
        )}
        {recallCalls.map((call, i) => {
          const error = toolError(call)
          const label = error
            ? `Recall failed: ${error}`
            : Array.isArray(call.result) && call.result.length === 0
              ? "No memories found"
              : null
          return label ? (
            <span
              key={`recall-${i}`}
              className={cn(
                "mt-3 mr-2 inline-flex min-h-7 items-center rounded-full px-2.5 text-[11px]",
                error
                  ? "bg-destructive/10 text-destructive"
                  : "bg-muted text-muted-foreground",
              )}
            >
              {label}
            </span>
          ) : null
        })}
        {changes.map((call, i) => {
          const error = toolError(call)
          const label = error
            ? `${call.name === "remember" ? "Save" : "Delete"} failed: ${error}`
            : call.name === "remember"
              ? "Memory saved"
              : "Memory deleted"
          return (
            <span
              key={`${call.name}-${i}`}
              className={cn(
                "mt-3 mr-2 inline-flex min-h-7 items-center rounded-full px-2.5 text-[11px]",
                error
                  ? "bg-destructive/10 text-destructive"
                  : "bg-muted text-muted-foreground",
              )}
            >
              {label}
            </span>
          )
        })}
      </div>
    </li>
  )
}

export default function SimulatorPage() {
  const { session } = useAuth()
  const { sub } = useApi()
  const qc = useQueryClient()
  const chat = useSimulatorChat()
  const memories = useMemories()
  const [turns, setTurns] = useState<Turn[]>([])
  const [draft, setDraft] = useState("")
  const [limitError, setLimitError] = useState<string | null>(null)
  const end = useRef<HTMLLIElement>(null)

  const firstName = session?.user.name.split(" ")[0]
  const greeting: Turn = {
    role: "assistant",
    content: `Hi${firstName ? ` ${firstName}` : ""}! What would you like me to remember?`,
  }

  useEffect(() => {
    end.current?.scrollIntoView({ block: "end", behavior: "smooth" })
  }, [turns, chat.isPending])

  function send(e: React.FormEvent) {
    e.preventDefault()
    const text = draft.trim()
    if (!text || chat.isPending) return
    const next: Turn[] = [...turns, { role: "user", content: text }]
    const transcriptLength = next.reduce(
      (total, turn) => total + turn.content.length,
      0,
    )
    // A valid alternating transcript that starts and ends with the user has
    // at most 19 messages, even though the API's generic list cap is 20.
    if (next.length > 19 || transcriptLength > 12000) {
      setLimitError(
        "This conversation has reached its limit. Start a new conversation to continue.",
      )
      return
    }
    setLimitError(null)
    setTurns(next)
    chat.mutate(
      next.map(({ role, content }) => ({ role, content })),
      {
        onSuccess: ({ reply, tool_calls }) => {
          setDraft("")
          setTurns([
            ...next,
            { role: "assistant", content: reply, tools: tool_calls },
          ])
          if (mutatedMemories(tool_calls)) {
            void qc.invalidateQueries({ queryKey: [sub, "memories"] })
          }
        },
        // Keep the draft so the user can resend it.
        onError: () => setTurns(turns),
      },
    )
  }

  function reset() {
    chat.reset()
    setTurns([])
    setDraft("")
    setLimitError(null)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col md:h-dvh">
      <PageHeader
        title={
          <>
            <span className="md:hidden">Alexa Simulator</span>
            <span className="hidden md:inline">Try Homie with Alexa</span>
          </>
        }
        subtitle="Test the same memory tools Alexa+ will use on a real device."
        mobileSubtitle="Connected to your Homie memory"
        action={
          <Button variant="outline" size="lg" onClick={reset}>
            <RotateCcw aria-hidden /> New conversation
          </Button>
        }
        mobileAction={
          <button
            type="button"
            aria-label="New conversation"
            onClick={reset}
            className={mobileActionClass}
          >
            <RotateCcw aria-hidden />
          </button>
        }
      />

      <div className="flex min-h-0 flex-1 flex-col gap-5 p-4 md:grid md:grid-cols-[minmax(0,1fr)_340px] md:px-11 md:pt-6 md:pb-8">
        <section
          aria-label="Conversation"
          className="md:bg-card flex min-h-0 flex-1 flex-col md:overflow-hidden md:rounded-xl md:border"
        >
          <div className="hidden items-center gap-3 border-b px-4.5 py-3 md:flex">
            <span className="bg-secondary text-accent-dark grid size-9 place-items-center rounded-full">
              <Sparkles className="size-4.5" aria-hidden />
            </span>
            <div className="flex-1">
              <p className="text-[13px] font-semibold">Demo conversation</p>
              <p className="text-accent-dark text-[11px]">
                Connected to your Homie memory
              </p>
            </div>
            <span className="bg-secondary text-accent-dark rounded-full px-2.5 py-1 text-[11px] font-semibold">
              Live
            </span>
          </div>
          <span className="bg-secondary text-accent-dark inline-flex h-7 items-center gap-1.5 self-start rounded-full px-3 text-[11px] font-semibold md:hidden">
            <span className="bg-primary size-1.5 rounded-full" aria-hidden />
            Live conversation
          </span>

          <ol
            aria-live="polite"
            className="flex-1 space-y-4 overflow-y-auto py-4 md:bg-[#f7faf8] md:px-5"
          >
            {[greeting, ...turns].map((turn, i) =>
              turn.role === "user" ? (
                <li key={i} className="flex justify-end">
                  <p className="bg-sidebar max-w-[34rem] rounded-xl px-3.5 py-3 text-sm whitespace-pre-wrap text-white md:text-[15px]">
                    {turn.content}
                  </p>
                </li>
              ) : (
                <AssistantTurn key={i} turn={turn} />
              ),
            )}
            {chat.isPending && (
              <li className="flex items-center gap-3">
                <Avatar />
                <span className="text-muted-foreground text-sm">
                  Alexa is thinking…
                </span>
              </li>
            )}
            {(chat.isError || limitError) && (
              <li role="alert" className="text-destructive pl-11 text-sm">
                {limitError ?? (chat.isError ? chat.error.message : null)}
              </li>
            )}
            <li ref={end} aria-hidden />
          </ol>

          {memories.data && (
            <Link
              href="/memories"
              className="bg-muted mb-3 flex min-h-13 items-center gap-3 rounded-lg px-3.5 md:hidden"
            >
              <Database className="text-accent-dark size-5" aria-hidden />
              <span className="flex-1">
                <span className="block text-[13px] font-semibold">
                  Stored memories
                </span>
                <span className="text-muted-foreground block text-[10px]">
                  {memories.data.length}{" "}
                  {memories.data.length === 1 ? "memory" : "memories"}
                </span>
              </span>
              <ChevronRight
                className="text-muted-foreground size-4"
                aria-hidden
              />
            </Link>
          )}

          <form
            onSubmit={send}
            className="bg-background sticky bottom-[calc(4rem+env(safe-area-inset-bottom))] -mx-4 flex gap-2.5 border-t px-4 py-3 md:static md:mx-0 md:bg-transparent md:px-4"
          >
            <Input
              aria-label="Message Alexa"
              placeholder="Ask Alexa to remember or recall…"
              value={draft}
              maxLength={2000}
              onChange={(e) => {
                setDraft(e.target.value)
                setLimitError(null)
              }}
              className="bg-muted md:bg-muted"
            />
            <Button
              type="submit"
              size="icon-lg"
              aria-label="Send"
              disabled={!draft.trim() || chat.isPending}
              className="size-12"
            >
              <ArrowUp aria-hidden />
            </Button>
          </form>
        </section>

        <div className="hidden min-h-0 md:flex">
          <StoredMemories />
        </div>
      </div>
    </div>
  )
}
