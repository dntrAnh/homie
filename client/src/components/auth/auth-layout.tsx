import {
  CalendarCheck,
  HouseHeart,
  Mic,
  Search,
  ShieldCheck,
} from "lucide-react"
import Link from "next/link"

import { cn } from "@/lib/utils"

const CAPABILITIES = [
  {
    title: "Capture",
    short: "Say it once",
    body: "Save places, preferences, facts, and to-dos from Alexa.",
    icon: Mic,
    tint: "bg-[#d6eddc] text-accent-dark",
  },
  {
    title: "Recall",
    short: "Ask naturally",
    body: "Ask naturally and find the detail when you need it.",
    icon: Search,
    tint: "bg-[#e9ddf5] text-[#6b4a8a]",
  },
  {
    title: "Act",
    short: "Calendar and Maps",
    body: "Create reminders and use context with Calendar and Maps.",
    icon: CalendarCheck,
    tint: "bg-[#f9dfc9] text-[#b4642a]",
  },
  {
    title: "Control",
    short: "Edit or forget",
    body: "Review, update, or delete anything Homie remembers.",
    icon: ShieldCheck,
    tint: "bg-[#dce5f6] text-[#41609a]",
  },
]

function Logo() {
  return (
    <Link
      href="/"
      className="font-heading text-sidebar flex items-center gap-2.5 text-[25px] font-bold"
    >
      <HouseHeart className="text-accent-dark size-6.5" aria-hidden />
      homie
    </Link>
  )
}

/** Split welcome layout. */
export function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-welcome min-h-dvh px-5 pt-[max(1.75rem,env(safe-area-inset-top))] pb-[max(1.75rem,env(safe-area-inset-bottom))] md:px-16 md:pt-10">
      <header className="mx-auto flex max-w-7xl items-center justify-between">
        <Logo />
        <p className="text-muted-foreground hidden text-[13px] font-medium md:block">
          Alexa+ memory assistant
        </p>
      </header>

      <div className="mx-auto mt-6 grid max-w-7xl gap-10 md:mt-11 md:grid-cols-[minmax(0,470px)_minmax(0,1fr)] md:gap-[78px] md:pl-2">
        <div className="min-w-0">
          <div>
            <p className="text-primary text-xs font-bold tracking-wide uppercase">
              Your private memory space
            </p>
            <h1 className="font-heading text-sidebar mt-3 text-[38px] leading-[1.05] font-medium tracking-tight md:w-[520px] md:text-[50px] md:whitespace-pre-line">
              {"Remember once.\nFind it when it matters."}
            </h1>
          </div>
          <div className="mt-5 md:mt-10">{children}</div>

          <section className="mt-6 md:hidden" aria-labelledby="helps-mobile">
            <h2 id="helps-mobile" className="text-sm font-semibold">
              What Homie helps with
            </h2>
            <ul className="mt-3 space-y-3">
              {CAPABILITIES.map(({ title, short, icon: Icon, tint }) => (
                <li key={title} className="flex items-center gap-3 text-sm">
                  <span
                    className={cn(
                      "grid size-8 place-items-center rounded-lg",
                      tint,
                    )}
                  >
                    <Icon className="size-4" aria-hidden />
                  </span>
                  <span className="font-semibold">{title}</span>
                  <span className="text-muted-foreground">{short}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>

        <section
          aria-labelledby="helps"
          className="hidden rounded-[28px] border border-[#d4e3d9] bg-[#e2ede6] px-10 py-11 md:block"
        >
          <p className="text-[11px] font-bold tracking-wide text-[#46735a] uppercase">
            How Homie helps
          </p>
          <h2
            id="helps"
            className="font-heading text-sidebar mt-3 text-[30px] font-medium"
          >
            Four ways Homie helps
          </h2>
          <ol className="relative mt-8 space-y-9 pl-[74px] before:absolute before:top-0 before:bottom-0 before:left-[46px] before:w-0.5 before:bg-[#6ead83]">
            {CAPABILITIES.map(({ title, body, icon: Icon, tint }, i) => (
              <li
                key={title}
                className={cn(
                  "relative flex max-w-[520px] items-start gap-4 rounded-[14px] bg-white px-4.5 py-5 shadow-[0_8px_24px_rgb(24_52_41/0.09)]",
                  i % 2 === 1 && "ml-12",
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    "absolute top-8 size-5 rounded-full border-[3px] border-[#3e9b63] bg-[#e2ede6]",
                    i % 2 === 1 ? "-left-[86px]" : "-left-[38px]",
                  )}
                />
                <span
                  className={cn(
                    "grid size-10.5 shrink-0 place-items-center rounded-full",
                    tint,
                  )}
                >
                  <Icon className="size-4.5" aria-hidden />
                </span>
                <div className="pt-0.5">
                  <h3 className="text-base font-semibold">{title}</h3>
                  <p className="text-muted-foreground mt-2 text-xs">{body}</p>
                </div>
              </li>
            ))}
          </ol>
          <p className="mt-8 pl-[74px] text-xs font-medium text-[#557064]">
            A capability preview — no personal memories are shown.
          </p>
        </section>
      </div>
    </div>
  )
}

/** White card holding the welcome actions. */
export function AuthCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-card rounded-2xl border p-5 shadow-[0_10px_30px_rgb(21_49_39/0.07)] md:p-9">
      {children}
    </div>
  )
}
