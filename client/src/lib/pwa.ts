"use client"

import { useSyncExternalStore } from "react"

function subscribeOnline(onChange: () => void) {
  window.addEventListener("online", onChange)
  window.addEventListener("offline", onChange)
  return () => {
    window.removeEventListener("online", onChange)
    window.removeEventListener("offline", onChange)
  }
}

/** Advisory only: requests can still fail while this says online. */
export function useOnline() {
  return useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine,
    () => true,
  )
}

function subscribeStandalone(onChange: () => void) {
  const query = window.matchMedia("(display-mode: standalone)")
  query.addEventListener("change", onChange)
  return () => query.removeEventListener("change", onChange)
}

/** True when running as the installed app. */
export function useStandalone() {
  return useSyncExternalStore(
    subscribeStandalone,
    () =>
      window.matchMedia("(display-mode: standalone)").matches ||
      // iOS Safari's own flag
      ("standalone" in navigator && navigator.standalone === true),
    () => false,
  )
}

/** Offline fallback only; production builds so dev never serves stale pages. */
export function registerServiceWorker() {
  if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator))
    return
  navigator.serviceWorker
    .register("/sw.js", { scope: "/", updateViaCache: "none" })
    // The app works without it; the next page load tries again.
    .catch(() => {})
}

type InstallPrompt = Event & {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>
}

// Chrome fires this once, often before Settings mounts, so keep it here.
let installPrompt: InstallPrompt | null = null
const installListeners = new Set<() => void>()
function setInstallPrompt(next: InstallPrompt | null) {
  installPrompt = next
  installListeners.forEach((listener) => listener())
}
if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault() // we offer our own button in Settings
    setInstallPrompt(e as InstallPrompt)
  })
  window.addEventListener("appinstalled", () => setInstallPrompt(null))
}

/** The browser's install prompt, when it offers one (Chromium only). */
export function useInstallPrompt() {
  const prompt = useSyncExternalStore(
    (onChange) => {
      installListeners.add(onChange)
      return () => installListeners.delete(onChange)
    },
    () => installPrompt,
    () => null,
  )
  return (
    prompt &&
    (async () => {
      await prompt.prompt()
      // A prompt can only be shown once either way.
      setInstallPrompt(null)
      return (await prompt.userChoice).outcome
    })
  )
}
