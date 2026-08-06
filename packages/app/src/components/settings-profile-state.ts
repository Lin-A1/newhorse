import { createStore } from "solid-js/store"
import { onMount } from "solid-js"
import { useServerSDK } from "@/context/server-sdk"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"

export type MemoryPolicy = "off" | "ask" | "auto-safe"

export function useCompanionProfileSettings() {
  const language = useLanguage()
  const serverSDK = useServerSDK()
  const [state, setState] = createStore({
    persona: "",
    memory: "ask" as MemoryPolicy,
    crisisRegion: "",
    proactive: false,
    proactivePaused: false,
    quietStart: "22:00",
    quietEnd: "08:00",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    maxPerDay: 3,
    minIntervalMinutes: 120,
    loading: true,
    saving: false,
  })

  onMount(() => {
    void serverSDK()
      .client.global.profile.runtime({ profileID: "companion" })
      .then((response) => {
        const profile = response.data
        if (!profile) throw new Error("Profile settings returned no data")
        setState({
          persona: profile.persona ?? "",
          memory: profile.memory,
          crisisRegion: profile.crisisRegion ?? "",
          proactive: profile.proactive,
          proactivePaused: profile.proactivePaused,
          quietStart: profile.quietHours?.start ?? "22:00",
          quietEnd: profile.quietHours?.end ?? "08:00",
          timezone: profile.quietHours?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
          maxPerDay: profile.proactiveFrequency.maxPerDay,
          minIntervalMinutes: profile.proactiveFrequency.minIntervalMinutes,
          loading: false,
        })
      })
      .catch((error: unknown) => {
        setState("loading", false)
        showToast({
          title: language.t("common.requestFailed"),
          description: error instanceof Error ? error.message : String(error),
        })
      })
  })

  const save = async () => {
    setState("saving", true)
    // Clamp numeric inputs so a cleared/invalid field never sends NaN to the server.
    const maxPerDay = Number.isFinite(state.maxPerDay) ? Math.max(0, Math.floor(state.maxPerDay)) : 3
    const minIntervalMinutes = Number.isFinite(state.minIntervalMinutes)
      ? Math.max(1, Math.floor(state.minIntervalMinutes))
      : 120
    const timezone = isValidTimezone(state.timezone) ? state.timezone : Intl.DateTimeFormat().resolvedOptions().timeZone
    await serverSDK()
      .client.global.profile.update({
        profileID: "companion",
        persona: state.persona,
        memory: state.memory,
        proactive: state.proactive,
        proactivePaused: state.proactivePaused,
        quietHours: { start: state.quietStart, end: state.quietEnd, timezone },
        proactiveFrequency: {
          maxPerDay,
          minIntervalMinutes,
        },
        crisisRegion: state.crisisRegion,
      })
      .then((response) => {
        if (!response.data) throw new Error("Profile update returned no data")
        setState({
          persona: response.data.persona ?? "",
          memory: response.data.memory,
          proactive: response.data.proactive,
          proactivePaused: response.data.proactivePaused,
          quietStart: response.data.quietHours?.start ?? "22:00",
          quietEnd: response.data.quietHours?.end ?? "08:00",
          timezone: response.data.quietHours?.timezone ?? timezone,
          maxPerDay: response.data.proactiveFrequency.maxPerDay,
          minIntervalMinutes: response.data.proactiveFrequency.minIntervalMinutes,
          crisisRegion: response.data.crisisRegion ?? "",
        })
        showToast({ variant: "success", icon: "circle-check", title: language.t("settings.profile.saved") })
      })
      .catch((error: unknown) => {
        showToast({
          title: language.t("common.requestFailed"),
          description: error instanceof Error ? error.message : String(error),
        })
      })
      .finally(() => setState("saving", false))
  }

  return { state, setState, save }
}

function isValidTimezone(value: string) {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: value })
    return true
  } catch {
    return false
  }
}
