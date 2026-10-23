"use client"

import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  Clock3,
  CalendarPlus,
  Image as ImageIcon,
  Paperclip,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useEffect, useState } from "react"
import { toast } from "sonner"

import { ConfirmDialog } from "@/components/confirm-dialog"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import {
  type Memory,
  type MemoryKind,
  useDeleteMemory,
  useSaveMemory,
} from "@/lib/api/memories"
import { ApiError } from "@/lib/api"
import { formatStamp } from "@/lib/format"
import { cn } from "@/lib/utils"

import { KIND_ORDER, KINDS } from "./kinds"

const MAX_TAGS = 20
const fieldLabel =
  "text-[11px] font-bold tracking-wide uppercase text-foreground"

export function MemoryEditor({ memory }: { memory?: Memory }) {
  const router = useRouter()
  const save = useSaveMemory()
  const remove = useDeleteMemory()
  const [content, setContent] = useState(memory?.content ?? "")
  const [kind, setKind] = useState<MemoryKind>(memory?.kind ?? "item_location")
  const [tags, setTags] = useState<string[]>(memory?.tags ?? [])
  const [tagDraft, setTagDraft] = useState("")
  // One key per editor session: retries after a lost response reuse it.
  const [requestId] = useState(() => crypto.randomUUID())
  // A create that failed with no response or a 5xx may have been committed, so
  // the body is frozen until a retry succeeds; editing would make the reused
  // key conflict (409), and a new key could save the memory twice.
  const [uncertain, setUncertain] = useState(false)
  const locked = !memory && (save.isPending || uncertain)

  const dirty =
    content !== (memory?.content ?? "") ||
    kind !== (memory?.kind ?? "item_location") ||
    tags.join("\n") !== (memory?.tags ?? []).join("\n")

  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener("beforeunload", warn)
    return () => window.removeEventListener("beforeunload", warn)
  }, [dirty])

  function leave() {
    if (!dirty || confirm("Discard your unsaved changes?")) {
      router.push("/memories")
    }
  }

  function addTag(raw: string) {
    const tag = raw.trim().replace(/^#/, "").slice(0, 50)
    if (tag && !tags.includes(tag) && tags.length < MAX_TAGS) {
      setTags([...tags, tag])
    }
    setTagDraft("")
  }

  function onSave() {
    const text = content.trim()
    if (!text) {
      toast.error("Write something for Homie to remember.")
      return
    }
    const pendingTag = tagDraft.trim() ? [tagDraft.trim()] : []
    save.mutate(
      {
        id: memory?.id,
        requestId,
        body: { content: text, kind, tags: [...tags, ...pendingTag] },
      },
      {
        onSuccess: (saved) => {
          toast.success(memory ? "Changes saved" : "Memory saved")
          if (!memory) router.replace(`/memories/${saved.id}`)
        },
        // Input stays as typed so nothing is lost.
        onError: (err) => {
          if (
            !memory &&
            err instanceof ApiError &&
            (err.status === 0 || err.status >= 500)
          ) {
            setUncertain(true)
          }
          toast.error(err.message)
        },
      },
    )
  }

  const KindIcon = KINDS[kind].icon
  const saveLabel = save.isPending
    ? "Saving…"
    : memory
      ? "Save changes"
      : uncertain
        ? "Retry save"
        : "Save memory"

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="bg-sidebar sticky top-0 z-10 flex h-[calc(3.625rem+env(safe-area-inset-top))] items-end px-2 pb-1.5 md:hidden">
        <button
          type="button"
          onClick={leave}
          className="flex min-h-11 items-center gap-2 px-2 text-base font-semibold text-white"
        >
          <ArrowLeft className="size-5" aria-hidden /> Memory
        </button>
      </header>

      <div className="flex flex-1 flex-col gap-4 p-4 md:gap-6 md:px-11 md:py-8">
        <button
          type="button"
          onClick={leave}
          className="text-muted-foreground hover:text-foreground hidden min-h-8 items-center gap-2 self-start text-[13px] font-medium md:flex"
        >
          <ArrowLeft className="size-4" aria-hidden /> All memories
        </button>

        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="font-heading text-[26px] font-medium md:text-[34px]">
                {memory ? "Memory details" : "New memory"}
              </h1>
              <span className="bg-secondary text-accent-dark inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[11px] font-semibold">
                <KindIcon className="size-3.5" aria-hidden />
                {KINDS[kind].label}
              </span>
            </div>
            {memory && (
              <p className="text-muted-foreground mt-1 hidden text-[13px] md:block">
                Last updated {formatStamp(memory.updated_at)}
              </p>
            )}
            {uncertain && (
              <p
                role="status"
                className="text-muted-foreground mt-1 text-[13px]"
              >
                We couldn&apos;t confirm this saved. Retry to finish; editing is
                paused so it isn&apos;t saved twice.
              </p>
            )}
          </div>
          <Button
            size="lg"
            className="hidden md:inline-flex"
            disabled={save.isPending || (memory && !dirty)}
            onClick={onSave}
          >
            <Check aria-hidden /> {saveLabel}
          </Button>
        </div>

        <div className="grid flex-1 gap-5 md:grid-cols-[minmax(0,1fr)_310px]">
          <section className="bg-card flex flex-col gap-4 rounded-xl border p-4 md:gap-6 md:p-6.5">
            <div className="space-y-2.5">
              <label htmlFor="memory-content" className={fieldLabel}>
                What should Homie remember?
              </label>
              <Textarea
                id="memory-content"
                value={content}
                onChange={(e) => setContent(e.target.value)}
                disabled={locked}
                maxLength={10_000}
                required
                placeholder="My passport is in the top desk drawer"
                className="border-primary min-h-24 border-2 md:min-h-30"
              />
            </div>

            <div className="grid gap-4 md:grid-cols-[260px_minmax(0,1fr)]">
              <div className="space-y-2.5">
                <label
                  htmlFor="memory-kind"
                  className={cn(fieldLabel, "hidden md:block")}
                >
                  Type
                </label>
                <div className="relative">
                  <KindIcon
                    className="text-accent-dark pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2"
                    aria-hidden
                  />
                  <select
                    id="memory-kind"
                    aria-label="Type"
                    value={kind}
                    onChange={(e) => setKind(e.target.value as MemoryKind)}
                    disabled={locked}
                    className="bg-muted md:bg-card focus-visible:border-ring focus-visible:ring-ring/50 h-12 w-full appearance-none rounded-lg border pr-10 pl-10 text-base outline-none focus-visible:ring-3 md:text-sm"
                  >
                    {KIND_ORDER.map((k) => (
                      <option key={k} value={k}>
                        {KINDS[k].label}
                      </option>
                    ))}
                  </select>
                  <ChevronDown
                    className="text-muted-foreground pointer-events-none absolute top-1/2 right-4 size-4 -translate-y-1/2"
                    aria-hidden
                  />
                </div>
              </div>

              <div className="space-y-2.5">
                <label
                  htmlFor="memory-tag"
                  className={cn(fieldLabel, "hidden md:block")}
                >
                  Tags
                </label>
                <div className="focus-within:border-ring focus-within:ring-ring/50 flex min-h-12 flex-wrap items-center gap-2 md:rounded-lg md:border md:px-2.5 md:py-1.5 md:focus-within:ring-3">
                  {tags.map((tag) => (
                    <span
                      key={tag}
                      className="bg-secondary text-accent-dark inline-flex h-8 items-center gap-1 rounded-full pr-1 pl-3 text-xs font-semibold"
                    >
                      {tag}
                      <button
                        type="button"
                        aria-label={`Remove tag ${tag}`}
                        onClick={() => setTags(tags.filter((t) => t !== tag))}
                        disabled={locked}
                        className="grid size-7 place-items-center rounded-full hover:bg-black/5"
                      >
                        <X className="size-3" aria-hidden />
                      </button>
                    </span>
                  ))}
                  <input
                    id="memory-tag"
                    value={tagDraft}
                    onChange={(e) => setTagDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === ",") {
                        e.preventDefault()
                        addTag(tagDraft)
                      } else if (e.key === "Backspace" && !tagDraft) {
                        setTags(tags.slice(0, -1))
                      }
                    }}
                    onBlur={() => tagDraft && addTag(tagDraft)}
                    disabled={locked || tags.length >= MAX_TAGS}
                    placeholder={
                      tags.length >= MAX_TAGS
                        ? "Tag limit reached"
                        : "Add a tag…"
                    }
                    aria-label="Add a tag"
                    className="placeholder:text-muted-foreground h-9 min-w-24 flex-1 bg-transparent text-base outline-none md:text-[13px]"
                  />
                </div>
              </div>
            </div>

            <div className="space-y-2.5">
              <div className="hidden items-center justify-between md:flex">
                <span className={fieldLabel}>Attachments</span>
                <Link
                  href="/media"
                  className="text-accent-dark inline-flex items-center gap-1.5 text-xs font-semibold hover:underline"
                >
                  <Paperclip className="size-4" aria-hidden /> Add photo or
                  video
                </Link>
              </div>
              <div className="bg-muted flex items-center gap-4 rounded-lg border px-4 py-4.5">
                <ImageIcon
                  className="text-muted-foreground size-5 shrink-0"
                  aria-hidden
                />
                <div className="min-w-0">
                  <p className="text-[13px] font-semibold">
                    {memory?.media_ids.length
                      ? `${memory.media_ids.length} attached`
                      : "No media attached"}
                  </p>
                  <p className="text-muted-foreground hidden text-xs md:block">
                    A photo can make this memory easier to recognize.
                  </p>
                  <Link
                    href="/media"
                    className="text-accent-dark text-[11px] font-medium md:hidden"
                  >
                    Add photo or video
                  </Link>
                </div>
              </div>
            </div>

            {memory && (
              <p className="text-muted-foreground flex items-center gap-2 border-y py-3 text-xs md:hidden">
                <Clock3 className="text-accent-dark size-4" aria-hidden />
                Updated {formatStamp(memory.updated_at)}
              </p>
            )}

            {memory && (
              <div className="mt-auto flex items-center justify-between gap-4 pt-6 md:border-t md:pt-5">
                <div className="hidden md:block">
                  <p className="text-[13px] font-semibold">
                    Delete this memory
                  </p>
                  <p className="text-muted-foreground text-xs">
                    Alexa will no longer be able to recall it.
                  </p>
                </div>
                <ConfirmDialog
                  title="Delete this memory?"
                  description={`Alexa will no longer remember: “${memory.content}”`}
                  onConfirm={async () => {
                    await remove.mutateAsync(memory.id)
                    toast.success("Memory deleted")
                    router.replace("/memories")
                  }}
                  trigger={
                    <Button
                      variant="outline"
                      size="lg"
                      className="text-destructive md:border-destructive/30 md:bg-destructive/5 hover:text-destructive -ml-3 border-transparent bg-transparent md:ml-0"
                    >
                      <Trash2 aria-hidden />
                      <span className="md:hidden">Delete memory</span>
                      <span className="hidden md:inline">Delete</span>
                    </Button>
                  }
                />
              </div>
            )}
          </section>

          <aside className="hidden flex-col gap-5 md:flex">
            {memory && (
              <section className="bg-card rounded-xl border p-5">
                <h2 className="font-heading text-lg font-medium">
                  Memory activity
                </h2>
                <ul className="mt-4 space-y-4 text-xs">
                  <li className="flex gap-3">
                    <Clock3
                      className="text-accent-dark size-4.5 shrink-0"
                      aria-hidden
                    />
                    <div>
                      <p className="font-semibold">Created</p>
                      <p className="text-muted-foreground text-[11px]">
                        {formatStamp(memory.created_at)}
                      </p>
                    </div>
                  </li>
                  <li className="flex gap-3">
                    <RefreshCw
                      className="text-accent-dark size-4.5 shrink-0"
                      aria-hidden
                    />
                    <div>
                      <p className="font-semibold">Updated</p>
                      <p className="text-muted-foreground text-[11px]">
                        {formatStamp(memory.updated_at)}
                      </p>
                    </div>
                  </li>
                </ul>
              </section>
            )}
            <section className="bg-secondary rounded-xl p-5">
              <CalendarPlus className="text-accent-dark size-6" aria-hidden />
              <h2 className="font-heading mt-4 text-lg font-medium">
                Link to your calendar
              </h2>
              <p className="text-muted-foreground mt-2 text-[13px]">
                Attach a to-do memory to an upcoming event so Alexa can mention
                it at the right time.
              </p>
              <Link
                href="/calendar"
                className="text-accent-dark mt-4 inline-flex min-h-8 items-center gap-2 text-[13px] font-semibold hover:underline"
              >
                Choose an event <ArrowRight className="size-4" aria-hidden />
              </Link>
            </section>
          </aside>
        </div>
      </div>

      <div className="bg-background sticky bottom-[calc(4rem+env(safe-area-inset-bottom))] z-10 border-t p-4 md:hidden">
        <Button
          size="lg"
          className="h-12 w-full"
          disabled={save.isPending || (memory && !dirty)}
          onClick={onSave}
        >
          <Check aria-hidden /> {saveLabel}
        </Button>
      </div>
    </div>
  )
}
