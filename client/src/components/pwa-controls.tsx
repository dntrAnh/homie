"use client"

import { Download, RefreshCw } from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import { usePathname } from "next/navigation"

import { Button } from "@/components/ui/button"

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>
}

type WorkerState = "loading" | "ready" | "unavailable" | "error"

export function PwaControls() {
  const pathname = usePathname()
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(
    null,
  )
  const [installDismissed, setInstallDismissed] = useState(false)
  const [isStandalone, setIsStandalone] = useState(false)
  const [workerState, setWorkerState] = useState<WorkerState>(
    process.env.NODE_ENV === "production" ? "loading" : "unavailable",
  )

  useEffect(() => {
    const syncInstallState = () => {
      setIsStandalone(
        window.matchMedia("(display-mode: standalone)").matches ||
          ("standalone" in navigator && navigator.standalone === true),
      )
      setInstallDismissed(
        window.localStorage.getItem("homie:pwa-install-dismissed") === "true",
      )
    }
    const frame = window.requestAnimationFrame(syncInstallState)

    const onBeforeInstallPrompt = (event: Event) => {
      event.preventDefault()
      setInstallPrompt(event as InstallPromptEvent)
    }
    const onAppInstalled = () => {
      setInstallPrompt(null)
      setIsStandalone(true)
    }
    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt)
    window.addEventListener("appinstalled", onAppInstalled)

    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt)
      window.removeEventListener("appinstalled", onAppInstalled)
      window.cancelAnimationFrame(frame)
    }
  }, [])

  const registerWorker = useCallback(async () => {
    if (process.env.NODE_ENV !== "production") {
      return
    }
    if (!("serviceWorker" in navigator)) {
      setWorkerState("unavailable")
      return
    }

    try {
      await navigator.serviceWorker.register("/sw.js", { scope: "/" })
      setWorkerState("ready")
    } catch {
      setWorkerState("error")
    }
  }, [])

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => void registerWorker())
    return () => window.cancelAnimationFrame(frame)
  }, [registerWorker])

  const install = async () => {
    if (!installPrompt) return
    await installPrompt.prompt()
    const choice = await installPrompt.userChoice
    setInstallPrompt(null)
    if (choice.outcome === "dismissed") {
      window.localStorage.setItem("homie:pwa-install-dismissed", "true")
      setInstallDismissed(true)
    }
  }

  if (isStandalone || pathname !== "/settings") return null

  return (
    <section
      className="bg-card mx-4 mb-4 space-y-3 rounded-md border p-4 md:mx-8"
      aria-labelledby="pwa-title"
    >
      <div>
        <h2 id="pwa-title" className="font-medium">
          Install Homie
        </h2>
        <p className="text-muted-foreground mt-1 text-sm">
          Use Homie from your home screen. Your memories still require an
          internet connection.
        </p>
      </div>

      {installPrompt && !installDismissed ? (
        <Button size="lg" className="w-full" onClick={() => void install()}>
          <Download aria-hidden />
          Install app
        </Button>
      ) : (
        <div className="text-muted-foreground space-y-2 text-sm">
          <p>
            iPhone or iPad: open this page in Safari, tap Share, then choose Add
            to Home Screen.
          </p>
          <p>
            Android: open this page in Chrome, tap the menu, then choose Install
            app or Add to Home screen.
          </p>
        </div>
      )}

      {workerState === "error" ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-muted-foreground text-sm">
            Offline fallback setup failed. Homie still works while you’re
            online.
          </p>
          <Button
            variant="outline"
            size="lg"
            onClick={() => void registerWorker()}
          >
            <RefreshCw aria-hidden />
            Retry
          </Button>
        </div>
      ) : null}
    </section>
  )
}
