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
    void Promise.all([serverSDK().client.global.profile.get(), serverSDK().client.global.config.get()])
      .then(([profileResponse, configResponse]) => {
        const profile = profileResponse.data?.items.find((item) => item.id === "companion")
        const config = configResponse.data?.profile?.items?.companion
        setState({
          persona: config?.persona ?? "",
          memory: profile?.memory ?? config?.memory ?? "ask",
          crisisRegion: config?.crisisRegion ?? "",
          proactive: config?.proactive ?? false,
          proactivePaused: config?.proactivePaused ?? false,
          quietStart: config?.quietHours?.start ?? "22:00",
          quietEnd: config?.quietHours?.end ?? "08:00",
          timezone: config?.quietHours?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
          maxPerDay: config?.proactiveFrequency?.maxPerDay ?? 3,
          minIntervalMinutes: config?.proactiveFrequency?.minIntervalMinutes ?? 120,
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
    await serverSDK()
      .client.global.profile.update({
        profileID: "companion",
        persona: state.persona,
        memory: state.memory,
        proactive: state.proactive,
        proactivePaused: state.proactivePaused,
        quietHours: { start: state.quietStart, end: state.quietEnd, timezone: state.timezone },
        proactiveFrequency: {
          maxPerDay: state.maxPerDay,
          minIntervalMinutes: state.minIntervalMinutes,
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
          timezone: response.data.quietHours?.timezone ?? state.timezone,
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
