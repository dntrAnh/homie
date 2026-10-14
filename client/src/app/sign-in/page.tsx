"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useState } from "react"
import { toast } from "sonner"

import { AuthCard, AuthLayout, BackLink } from "@/components/auth/auth-layout"
import { PasswordInput } from "@/components/auth/password-input"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useAuth } from "@/lib/auth"

export default function SignIn() {
  const { signIn } = useAuth()
  const router = useRouter()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    setPending(true)
    setError(null)
    try {
      await signIn({
        email: String(form.get("email")).trim(),
        password: String(form.get("password")),
      })
      router.replace("/memories")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't sign you in.")
      setPending(false)
    }
  }

  return (
    <AuthLayout form>
      <AuthCard flushOnMobile>
        <BackLink />
        <h2 className="font-heading text-[32px] leading-tight font-medium md:mt-2 md:text-[28px]">
          Sign in with email
        </h2>
        <p className="text-muted-foreground mt-3 text-[15px] md:text-sm">
          Enter the email and password connected to your Homie account.
        </p>
        <form onSubmit={onSubmit} className="mt-5 space-y-4">
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
              autoComplete="current-password"
              required
              placeholder="Enter your password"
            />
          </div>
          <div className="flex justify-end">
            <button
              type="button"
              className="text-accent-dark min-h-11 text-[13px] hover:underline md:min-h-8"
              onClick={() => toast.info("Password reset is coming soon.")}
            >
              Forgot password?
            </button>
          </div>
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
            {pending ? "Signing in…" : "Sign in"}
          </Button>
        </form>
        <p className="text-muted-foreground mt-5 text-center text-[13px]">
          New to Homie?{" "}
          <Link
            href="/create-account"
            className="text-accent-dark hover:underline"
          >
            Create an account
          </Link>
        </p>
      </AuthCard>
    </AuthLayout>
  )
}
