"use client"

import { Eye, EyeOff } from "lucide-react"
import { useState } from "react"

import { Input } from "@/components/ui/input"

export function PasswordInput(props: React.ComponentProps<typeof Input>) {
  const [visible, setVisible] = useState(false)
  return (
    <div className="relative">
      <Input
        {...props}
        type={visible ? "text" : "password"}
        className="pr-12"
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? "Hide password" : "Show password"}
        aria-pressed={visible}
        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 absolute top-0.5 right-0.5 grid size-11 place-items-center rounded-lg outline-none focus-visible:ring-3"
      >
        {visible ? (
          <EyeOff className="size-4.5" aria-hidden />
        ) : (
          <Eye className="size-4.5" aria-hidden />
        )}
      </button>
    </div>
  )
}
