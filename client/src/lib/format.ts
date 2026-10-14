const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" })

/** "2 hours ago", "Yesterday", then "Oct 4" — matches the design's lists. */
export function formatRelative(iso: string, now = Date.now()) {
  const date = new Date(iso)
  const minutes = Math.round((date.getTime() - now) / 60_000)
  if (Math.abs(minutes) < 60) {
    return minutes === 0 ? "Just now" : rtf.format(minutes, "minute")
  }
  const hours = Math.round(minutes / 60)
  if (Math.abs(hours) < 24) return rtf.format(hours, "hour")
  const days = Math.round(hours / 24)
  if (Math.abs(days) < 2) {
    const text = rtf.format(days, "day")
    return text[0].toUpperCase() + text.slice(1)
  }
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

/** "today at 2:14 PM" / "Oct 6 at 12:03 PM" */
export function formatStamp(iso: string) {
  const date = new Date(iso)
  const time = date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  })
  const sameDay = date.toDateString() === new Date().toDateString()
  const day = sameDay
    ? "today"
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric" })
  return `${day} at ${time}`
}
