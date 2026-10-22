"use client"

import { Brain, Images, Trash2, Unlink, UserRoundX } from "lucide-react"
import { useState } from "react"

import { ConfirmDialog } from "@/components/confirm-dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useDeleteAccount } from "@/lib/api/profile"
import { useAuth } from "@/lib/auth"

const DELETES = [
  {
    icon: Brain,
    title: "All memories",
    body: "Content, tags, and linked to-dos",
  },
  {
    icon: Images,
    title: "Uploaded media",
    body: "Photos, videos, and attachment records",
  },
  {
    icon: Unlink,
    title: "Connected services",
    body: "Google Calendar and Maps settings",
  },
  {
    icon: UserRoundX,
    title: "Homie account",
    body: "Profile and authentication data",
  },
]

export function DeleteAccount() {
  const { signOut } = useAuth()
  const remove = useDeleteAccount()
  const [typed, setTyped] = useState("")
  const [understood, setUnderstood] = useState(false)

  return (
    <div className="border-destructive/25 bg-destructive/5 rounded-[10px] border p-4">
      <p className="text-destructive text-[13px] font-bold">
        Delete account and data
      </p>
      <p className="text-muted-foreground mt-2 text-[11px]">
        Permanently deletes your account, memories, media files, and Google
        connection. This cannot be undone.
      </p>
      <ConfirmDialog
        title="Delete account & data?"
        description="Homie cannot restore your account or memories after deletion."
        confirmLabel="Delete permanently"
        confirmDisabled={typed !== "DELETE" || !understood}
        onClose={() => {
          setTyped("")
          setUnderstood(false)
        }}
        onConfirm={async () => {
          await remove.mutateAsync()
          signOut()
        }}
        trigger={
          <Button
            size="lg"
            className="bg-destructive hover:bg-destructive/90 mt-3 w-full text-white"
          >
            <Trash2 aria-hidden /> Delete account…
          </Button>
        }
      >
        <ul className="divide-y rounded-lg border text-left">
          {DELETES.map(({ icon: Icon, title, body }) => (
            <li key={title} className="flex items-start gap-3 px-3 py-2.5">
              <Icon className="text-destructive mt-0.5 size-4.5" aria-hidden />
              <div>
                <p className="text-[13px] font-semibold">{title}</p>
                <p className="text-muted-foreground text-[11px]">{body}</p>
              </div>
            </li>
          ))}
        </ul>
        <div className="space-y-2 text-left">
          <label
            htmlFor="delete-confirm"
            className="text-destructive text-[11px] font-bold tracking-wide uppercase"
          >
            Type DELETE to confirm
          </label>
          <Input
            id="delete-confirm"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="DELETE"
            autoComplete="off"
            className="border-destructive/40"
          />
          <label className="flex min-h-11 items-center gap-3 text-[13px]">
            <input
              type="checkbox"
              checked={understood}
              onChange={(e) => setUnderstood(e.target.checked)}
              className="accent-destructive size-4.5"
            />
            I understand this cannot be undone.
          </label>
        </div>
      </ConfirmDialog>
    </div>
  )
}
