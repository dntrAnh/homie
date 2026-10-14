"use client"

import { Mail, ShieldCheck, UserPlus } from "lucide-react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useEffect } from "react"

import { AuthCard, AuthLayout } from "@/components/auth/auth-layout"
import { buttonVariants } from "@/components/ui/button"
import { useAuth } from "@/lib/auth"
import { cn } from "@/lib/utils"

export default function Welcome() {
  const { session } = useAuth()
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
        <Link
          href="/sign-in"
          className={cn(
            buttonVariants({ size: "lg" }),
            "mt-5 h-12 w-full text-[15px] md:mt-6",
          )}
        >
          <Mail aria-hidden /> Continue with email
        </Link>
        <div className="text-muted-foreground my-4 flex items-center gap-3 text-xs before:h-px before:flex-1 before:bg-current/25 after:h-px after:flex-1 after:bg-current/25">
          New to Homie?
        </div>
        <Link
          href="/create-account"
          className={cn(
            buttonVariants({ variant: "outline", size: "lg" }),
            "h-12 w-full text-[15px]",
          )}
        >
          <UserPlus aria-hidden /> Create an account
        </Link>
        <p className="text-muted-foreground mt-5 hidden items-center gap-2 border-t pt-5 text-xs md:flex">
          <ShieldCheck className="text-accent-dark size-4" aria-hidden />
          Your memories stay private and can be edited or deleted anytime.
        </p>
      </AuthCard>
    </AuthLayout>
  )
}
