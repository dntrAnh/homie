"use client"

import { useState } from "react"
import { toast } from "sonner"

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"

/** Destructive confirmation that stays open (and shows errors) until the action succeeds. */
export function ConfirmDialog({
  trigger,
  title,
  description,
  confirmLabel = "Delete",
  pendingLabel = "Deleting…",
  confirmDisabled = false,
  onConfirm,
  children,
}: {
  trigger: React.ComponentProps<typeof AlertDialogTrigger>["render"]
  title: string
  description: React.ReactNode
  confirmLabel?: string
  pendingLabel?: string
  confirmDisabled?: boolean
  onConfirm: () => Promise<unknown>
  children?: React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)

  async function confirm() {
    setPending(true)
    try {
      await onConfirm()
      setOpen(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "That didn't work.")
    } finally {
      setPending(false)
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={(next) => !pending && setOpen(next)}>
      <AlertDialogTrigger render={trigger} />
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {children}
        <AlertDialogFooter>
          <AlertDialogCancel size="lg" disabled={pending}>
            Cancel
          </AlertDialogCancel>
          <Button
            size="lg"
            className="bg-destructive hover:bg-destructive/90 text-white"
            disabled={pending || confirmDisabled}
            onClick={confirm}
          >
            {pending ? pendingLabel : confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
