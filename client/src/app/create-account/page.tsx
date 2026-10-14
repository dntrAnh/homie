"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useState } from "react"

import { AuthCard, AuthLayout, BackLink } from "@/components/auth/auth-layout"
import { PasswordInput } from "@/components/auth/password-input"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useAuth } from "@/lib/auth"

export default function CreateAccount() {
  const { signUp } = useAuth()
  const router = useRouter()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    setPending(true)
    setError(null)
    try {
      await signUp({
        name: String(form.get("name")).trim(),
        email: String(form.get("email")).trim(),
        password: String(form.get("password")),
      })
      router.replace("/memories")
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Couldn't create your account.",
      )
      setPending(false)
    }
  }

  return (
    <AuthLayout form>
      <AuthCard flushOnMobile>
        <BackLink />
        <h2 className="font-heading text-[32px] leading-tight font-medium md:mt-1 md:text-[28px]">
          Create your account
        </h2>
        <p className="text-muted-foreground mt-3 text-[15px] md:text-sm">
          Start a private memory space that works with Alexa.
        </p>
        <form onSubmit={onSubmit} className="mt-4 space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name">Name</Label>
            <Input
              id="name"
              name="name"
              autoComplete="name"
              required
              maxLength={100}
              placeholder="Your name"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="email">Email address</Label>
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              placeholder="you@example.com"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <PasswordInput
              id="password"
              name="password"
              autoComplete="new-password"
              required
              minLength={8}
              placeholder="At least 8 characters"
            />
          </div>
          <label className="text-muted-foreground flex min-h-11 items-center gap-3 text-xs">
            <input
              type="checkbox"
              name="terms"
              required
              className="accent-primary size-4.5 shrink-0"
            />
            I agree to the Terms and acknowledge the Privacy Policy.
          </label>
          {error && (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}
          <Button
            type="submit"
            size="lg"
            disabled={pending}
            className="h-12 w-full font-medium"
          >
            {pending ? "Creating account…" : "Create account"}
          </Button>
        </form>
        <p className="text-muted-foreground mt-5 text-center text-[13px]">
          Already have an account?{" "}
          <Link href="/sign-in" className="text-accent-dark hover:underline">
            Sign in
          </Link>
        </p>
      </AuthCard>
    </AuthLayout>
  )
}
