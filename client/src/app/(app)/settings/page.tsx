"use client"

import {
  Bike,
  BusFront,
  CalendarCheck,
  CarFront,
  Check,
  ChevronDown,
  Clock3,
  Download,
  Footprints,
  LogOut,
  MapPinned,
  Unlink,
  UserRound,
} from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"

import { ConfirmDialog } from "@/components/confirm-dialog"
import { ErrorState, LoadingRows } from "@/components/data-states"
import { mobileActionClass, PageHeader } from "@/components/page-header"
import { PwaControls } from "@/components/pwa-controls"
import { DeleteAccount } from "@/components/settings/delete-account"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  useConnectGoogle,
  useDisconnectGoogle,
  useGoogleStatus,
} from "@/lib/api/google"
import {
  type Profile,
  type TravelMode,
  useExportData,
  useProfile,
  useUpdateProfile,
} from "@/lib/api/profile"
import { useAuth } from "@/lib/auth"
import { cn } from "@/lib/utils"

const MODES: { value: TravelMode; label: string; icon: typeof CarFront }[] = [
  { value: "DRIVE", label: "Driving", icon: CarFront },
  { value: "WALK", label: "Walking", icon: Footprints },
  { value: "TRANSIT", label: "Transit", icon: BusFront },
  { value: "BICYCLE", label: "Cycling", icon: Bike },
]

const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone
const ZONES = Intl.supportedValuesOf("timeZone")

const card = "bg-card rounded-xl border p-4.5 md:p-6"
const fieldLabel = "text-[11px] font-bold tracking-wide uppercase"

function zoneLabel(zone: string) {
  return zone.replace(/_/g, " ").replace("/", " / ")
}

export default function SettingsPage() {
  const profile = useProfile()

  if (profile.isPending || profile.isError) {
    return (
      <>
        <PageHeader
          title="Settings"
          subtitle="Manage your account, connections, local time, and data."
        />
        <div className="p-4 md:px-11 md:pt-6">
          {profile.isPending ? (
            <LoadingRows count={3} className="h-40" />
          ) : (
            <ErrorState
              error={profile.error}
              onRetry={() => profile.refetch()}
            />
          )}
        </div>
      </>
    )
  }
  return <SettingsForm key={profile.dataUpdatedAt} profile={profile.data} />
}

function SettingsForm({ profile }: { profile: Profile }) {
  const { session, signOut } = useAuth()
  const update = useUpdateProfile()
  const exportData = useExportData()
  const google = useGoogleStatus()
  const connect = useConnectGoogle()
  const disconnect = useDisconnectGoogle()

  const [timezone, setTimezone] = useState(profile.timezone || browserZone)
  const [mode, setMode] = useState<TravelMode>(profile.travel_mode)
  const [home, setHome] = useState(profile.home?.address ?? "")
  const dirty =
    timezone !== profile.timezone ||
    mode !== profile.travel_mode ||
    home !== (profile.home?.address ?? "")

  function save() {
    update.mutate(
      {
        timezone,
        travel_mode: mode,
        home: home.trim() ? { address: home.trim() } : null,
      },
      {
        onSuccess: () => toast.success("Settings saved"),
        onError: (err) => toast.error(err.message),
      },
    )
  }

  const saveLabel = update.isPending ? "Saving…" : "Save changes"

  return (
    <>
      <PageHeader
        title="Settings"
        subtitle="Manage your account, connections, local time, and data."
        mobileSubtitle="Account, connections, and privacy"
        action={
          <Button
            size="lg"
            disabled={!dirty || update.isPending}
            onClick={save}
          >
            <Check aria-hidden /> {saveLabel}
          </Button>
        }
        mobileAction={
          <button
            type="button"
            aria-label={saveLabel}
            disabled={!dirty || update.isPending}
            onClick={save}
            className={mobileActionClass}
          >
            <Check aria-hidden />
          </button>
        }
      />

      <div className="grid items-start gap-4 p-4 md:grid-cols-[minmax(0,1fr)_430px] md:gap-5 md:px-11 md:pt-6 md:pb-9">
        <section className={cn(card, "md:min-h-[740px]")}>
          <h2 className="font-heading text-[22px] font-medium">
            Account &amp; preferences
          </h2>
          <p className="text-muted-foreground mt-1 text-[13px]">
            Manage your Homie account and how dates and reminders appear.
          </p>

          <h3 className={cn(fieldLabel, "mt-6")}>Account</h3>
          <div className="bg-muted mt-2.5 flex items-center gap-3 rounded-[10px] border p-3.5">
            <span className="bg-secondary text-accent-dark grid size-10.5 shrink-0 place-items-center rounded-full">
              <UserRound className="size-5" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">
                {session?.user.name}
              </p>
              <p className="text-muted-foreground truncate text-xs">
                {session?.user.email}
              </p>
            </div>
            <Button
              variant="outline"
              size="lg"
              onClick={() =>
                void signOut().catch(() =>
                  toast.error("Couldn't sign out. Please try again."),
                )
              }
            >
              <LogOut aria-hidden /> Sign out
            </Button>
          </div>

          <label htmlFor="timezone" className={cn(fieldLabel, "mt-6 block")}>
            Timezone
          </label>
          <div className="relative mt-2.5">
            <Clock3
              className="text-accent-dark pointer-events-none absolute top-1/2 left-4 size-4.5 -translate-y-1/2"
              aria-hidden
            />
            <select
              id="timezone"
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              className="bg-muted focus-visible:border-ring focus-visible:ring-ring/50 h-12 w-full appearance-none rounded-lg border pr-10 pl-11 text-base outline-none focus-visible:ring-3 md:text-[15px]"
            >
              {/* Some runtimes omit zones like "UTC" (the server default); keep the saved one selectable. */}
              {(ZONES.includes(timezone) ? ZONES : [timezone, ...ZONES]).map(
                (zone) => (
                  <option key={zone} value={zone}>
                    {zoneLabel(zone)}
                    {zone === browserZone ? " (this device)" : ""}
                  </option>
                ),
              )}
            </select>
            <ChevronDown
              className="text-muted-foreground pointer-events-none absolute top-1/2 right-4 size-4 -translate-y-1/2"
              aria-hidden
            />
          </div>

          <label htmlFor="home" className={cn(fieldLabel, "mt-6 block")}>
            Home address
          </label>
          <Input
            id="home"
            value={home}
            onChange={(e) => setHome(e.target.value)}
            maxLength={300}
            autoComplete="street-address"
            placeholder="Used for nearby places and directions"
            className="bg-muted mt-2.5"
          />

          <fieldset className="mt-6">
            <legend className={fieldLabel}>Default travel mode</legend>
            <div className="mt-2.5 grid grid-cols-2 gap-2 md:grid-cols-4">
              {MODES.map(({ value, label, icon: Icon }) => (
                <label
                  key={value}
                  className={cn(
                    "has-focus-visible:ring-ring/50 flex h-12 cursor-pointer items-center justify-center gap-2 rounded-lg border text-[13px] font-medium has-focus-visible:ring-3",
                    mode === value
                      ? "bg-sidebar border-sidebar text-white"
                      : "bg-muted",
                  )}
                >
                  <input
                    type="radio"
                    name="travel_mode"
                    value={value}
                    checked={mode === value}
                    onChange={() => setMode(value)}
                    className="sr-only"
                  />
                  <Icon className="size-4" aria-hidden />
                  {label}
                </label>
              ))}
            </div>
          </fieldset>

          <p className="bg-secondary text-muted-foreground mt-5 flex gap-3 rounded-lg p-4 text-xs">
            <Clock3
              className="text-accent-dark size-4.5 shrink-0"
              aria-hidden
            />
            Timezone and travel mode are used for Calendar reminders, place
            suggestions, and directions. You can change them anytime.
          </p>
        </section>

        <div className="flex flex-col gap-4 md:gap-5">
          <section className={card}>
            <h2 className="font-heading text-[22px] font-medium">
              Connections
            </h2>
            <p className="text-muted-foreground mt-2 text-xs">
              Connect Calendar and control how Homie uses Google services.
            </p>
            <div className="mt-4 flex items-center gap-3">
              <span className="bg-blue-soft grid size-10.5 shrink-0 place-items-center rounded-[9px] text-[#41609a]">
                <CalendarCheck className="size-5" aria-hidden />
              </span>
              <div className="min-w-0">
                <p className="text-sm font-semibold">Google Calendar</p>
                <p className="text-accent-dark truncate text-[11px]">
                  {google.isPending
                    ? "Checking…"
                    : google.isError
                      ? "Status unavailable"
                      : google.data.connected
                        ? [google.data.email, "Connected"]
                            .filter(Boolean)
                            .join(" · ")
                        : "Not connected"}
                </p>
              </div>
            </div>
            {google.data?.connected ? (
              <ConfirmDialog
                title="Disconnect Google Calendar?"
                description="Alexa won't be able to read your events or create reminders until you reconnect."
                confirmLabel="Disconnect"
                pendingLabel="Disconnecting…"
                onConfirm={async () => {
                  await disconnect.mutateAsync()
                  toast.success("Google Calendar disconnected")
                }}
                trigger={
                  <Button variant="outline" size="lg" className="mt-3 w-full">
                    <Unlink aria-hidden /> Disconnect Calendar
                  </Button>
                }
              />
            ) : (
              <Button
                size="lg"
                className="mt-3 w-full"
                disabled={!google.data || connect.isPending}
                onClick={() =>
                  connect.mutate(undefined, {
                    onError: (err) => toast.error(err.message),
                  })
                }
              >
                <CalendarCheck aria-hidden /> Connect Google Calendar
              </Button>
            )}

            <div className="mt-4 flex items-center gap-3 border-t pt-4">
              <span className="bg-secondary text-accent-dark grid size-10.5 shrink-0 place-items-center rounded-[9px]">
                <MapPinned className="size-5" aria-hidden />
              </span>
              <div>
                <p className="text-sm font-semibold">Google Maps</p>
                <p className="text-accent-dark text-[11px]">
                  {profile.home
                    ? "Enabled for place suggestions & directions"
                    : "Add a home address to enable nearby suggestions"}
                </p>
              </div>
            </div>
          </section>

          <PwaControls className={card} />

          <section className={card}>
            <h2 className="font-heading text-[22px] font-medium">
              Privacy &amp; data
            </h2>
            <p className="text-muted-foreground mt-2 text-xs">
              Download what Homie stores or permanently delete your account and
              data.
            </p>
            <button
              type="button"
              disabled={exportData.isPending}
              onClick={() =>
                exportData.mutate(undefined, {
                  onError: (err) => toast.error(err.message),
                })
              }
              className="hover:bg-muted/60 mt-4 flex min-h-14 w-full items-center gap-3 border-y py-3 text-left disabled:opacity-60"
            >
              <span className="flex-1">
                <span className="block text-[13px] font-semibold">
                  {exportData.isPending
                    ? "Preparing download…"
                    : "Download my data"}
                </span>
                <span className="text-muted-foreground block text-[11px]">
                  Memories, media details, and settings
                </span>
              </span>
              <Download className="text-accent-dark size-4.5" aria-hidden />
            </button>
            <div className="mt-4">
              <DeleteAccount />
            </div>
          </section>
        </div>
      </div>
    </>
  )
}
