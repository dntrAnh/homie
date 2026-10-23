"use client"

import { Share, Smartphone, SquarePlus } from "lucide-react"
import { useState } from "react"

import { Button } from "@/components/ui/button"
import { useInstallPrompt, useStandalone } from "@/lib/pwa"

const DISMISSED = "homie:install-help-dismissed"

function readDismissed() {
  try {
    return localStorage.getItem(DISMISSED) === "1"
  } catch {
    return false
  }
}

const isIos = () =>
  typeof navigator !== "undefined" &&
  (/iPhone|iPad|iPod/.test(navigator.userAgent) ||
    // iPadOS reports itself as a Mac
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1))

/** Installation help for Settings; hidden once running as the installed app. */
export function PwaControls({ className }: { className?: string }) {
  const standalone = useStandalone()
  const install = useInstallPrompt()
  const [dismissed, setDismissed] = useState(readDismissed)

  if (standalone || dismissed) return null

  function dismiss() {
    setDismissed(true)
    try {
      localStorage.setItem(DISMISSED, "1")
    } catch {
      // Private mode: it just shows again next visit.
    }
  }

  return (
    <section className={className} aria-labelledby="install-title">
      <div className="flex items-center gap-3">
        <span className="bg-secondary text-accent-dark grid size-10.5 shrink-0 place-items-center rounded-[9px]">
          <Smartphone className="size-5" aria-hidden />
        </span>
        <div>
          <h2 id="install-title" className="text-sm font-semibold">
            Install Homie
          </h2>
          <p className="text-muted-foreground text-[11px]">
            Open it from your home screen like an app.
          </p>
        </div>
      </div>

      {install ? (
        <Button
          size="lg"
          className="mt-3 w-full"
          onClick={async () => {
            if ((await install()) === "dismissed") dismiss()
          }}
        >
          <SquarePlus aria-hidden /> Install app
        </Button>
      ) : isIos() ? (
        <p className="text-muted-foreground mt-3 text-xs">
          In Safari, tap{" "}
          <Share className="inline size-3.5" aria-label="Share" /> Share, then{" "}
          <strong>Add to Home Screen</strong>.
        </p>
      ) : (
        <p className="text-muted-foreground mt-3 text-xs">
          Open your browser menu and choose <strong>Install app</strong> or{" "}
          <strong>Add to Home Screen</strong>.
        </p>
      )}

      <Button
        variant="ghost"
        size="lg"
        className="mt-1 w-full"
        onClick={dismiss}
      >
        Not now
      </Button>
    </section>
  )
}
