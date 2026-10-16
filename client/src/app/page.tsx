"use client"

import { ShieldCheck } from "lucide-react"
import { useRouter } from "next/navigation"
import { useEffect } from "react"

import { AuthCard, AuthLayout } from "@/components/auth/auth-layout"
import { Button } from "@/components/ui/button"
import { useAuth } from "@/lib/auth"

export default function Welcome() {
  const { loading, session, error, signIn } = useAuth()
  const router = useRouter()

  useEffect(() => {
    if (session) router.replace("/memories")
  }, [session, router])

  return (
    <AuthLayout>
      <AuthCard>
        <h2 className="font-heading text-2xl font-medium md:text-[32px]">
          Welcome home
        </h2>
        <p className="text-muted-foreground mt-3 text-sm md:mt-5 md:text-[15px]">
          Sign in to see and manage everything Homie remembers for you.
        </p>
        {/* Cognito's Hosted UI handles both sign-in and sign-up (plan Task 9). */}
        <Button
          size="lg"
          disabled={loading}
          onClick={signIn}
          className="mt-5 h-12 w-full text-[15px] md:mt-6"
        >
          Continue
        </Button>
        <p className="text-muted-foreground mt-3 text-center text-xs">
          New to Homie? You can create an account on the next screen.
        </p>
        {error && (
          <p role="alert" className="text-destructive mt-3 text-sm">
            {error}
          </p>
        )}
        <p className="text-muted-foreground mt-5 hidden items-center gap-2 border-t pt-5 text-xs md:flex">
          <ShieldCheck className="text-accent-dark size-4" aria-hidden />
          Your memories stay private and can be edited or deleted anytime.
        </p>
      </AuthCard>
    </AuthLayout>
  )
}
