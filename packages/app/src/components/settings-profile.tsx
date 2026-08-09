import { Button } from "@newhorse/ui/button"
import { Select } from "@newhorse/ui/select"
import { TextField } from "@newhorse/ui/text-field"
import { Switch } from "@newhorse/ui/switch"
import { useLanguage } from "@/context/language"
import { SettingsList } from "./settings-list"
import { useCompanionProfileSettings, type MemoryPolicy } from "./settings-profile-state"
import { Show, type Component, type JSX } from "solid-js"

const policies: MemoryPolicy[] = ["off", "ask", "auto-safe"]

export const SettingsProfile: Component = () => {
  const language = useLanguage()
  const profile = useCompanionProfileSettings()

  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar px-4 pb-10 sm:px-10 sm:pb-10">
      <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-stronger-non-alpha)_calc(100%_-_24px),transparent)]">
        <div class="flex items-center justify-between gap-4 pt-6 pb-8 max-w-[720px]">
          <h2 class="text-16-medium text-text-strong">{language.t("settings.profile.title")}</h2>
        </div>
      </div>

      <Show when={!profile.state.loading} fallback={<div>{language.t("common.loading")}</div>}>
        <div class="flex flex-col gap-4 max-w-[720px]">
          <SettingsList>
            <SettingsRow
              title={language.t("settings.profile.persona.title")}
              description={language.t("settings.profile.persona.description")}
            >
              <TextField
                multiline
                value={profile.state.persona}
                onChange={(value) => profile.setState("persona", value)}
                aria-label={language.t("settings.profile.persona.title")}
                class="min-h-24"
              />
            </SettingsRow>
            <SettingsRow
              title={language.t("settings.profile.memory.title")}
              description={language.t("settings.profile.memory.description")}
            >
              <Select
                options={policies}
                current={profile.state.memory}
                label={(value) => language.t(`settings.profile.memory.${value}`)}
                onSelect={(value) => value && profile.setState("memory", value)}
                variant="secondary"
                size="small"
                triggerVariant="settings"
              />
            </SettingsRow>
            <SettingsRow
              title={language.t("settings.profile.proactive.title")}
              description={language.t("settings.profile.proactive.description")}
            >
              <Switch checked={profile.state.proactive} onChange={(value) => profile.setState("proactive", value)} />
            </SettingsRow>
            <Show when={profile.state.proactive}>
              <SettingsRow
                title={language.t("settings.profile.proactivePaused.title")}
                description={language.t("settings.profile.proactivePaused.description")}
              >
                <Switch
                  checked={profile.state.proactivePaused}
                  onChange={(value) => profile.setState("proactivePaused", value)}
                />
              </SettingsRow>
              <SettingsRow
                title={language.t("settings.profile.quietHours.title")}
                description={language.t("settings.profile.quietHours.description")}
              >
                <div class="grid min-w-0 w-full max-w-full grid-cols-[repeat(auto-fit,minmax(min(100%,120px),1fr))] gap-2 [&>*]:min-w-0 [&>*]:!w-full">
                  <TextField
                    type="time"
                    value={profile.state.quietStart}
                    onChange={(value) => profile.setState("quietStart", value)}
                  />
                  <TextField
                    type="time"
                    value={profile.state.quietEnd}
                    onChange={(value) => profile.setState("quietEnd", value)}
                  />
                  <TextField value={profile.state.timezone} onChange={(value) => profile.setState("timezone", value)} />
                </div>
              </SettingsRow>
              <SettingsRow
                title={language.t("settings.profile.frequency.title")}
                description={language.t("settings.profile.frequency.description")}
              >
                <div class="grid min-w-0 w-full max-w-full grid-cols-[repeat(auto-fit,minmax(min(100%,150px),1fr))] gap-2 [&>*]:min-w-0 [&>*]:!w-full">
                  <TextField
                    type="number"
                    min="1"
                    max="24"
                    value={String(profile.state.maxPerDay)}
                    onChange={(value) => profile.setState("maxPerDay", Number(value))}
                  />
                  <TextField
                    type="number"
                    min="1"
                    max="1440"
                    value={String(profile.state.minIntervalMinutes)}
                    onChange={(value) => profile.setState("minIntervalMinutes", Number(value))}
                  />
                </div>
              </SettingsRow>
            </Show>
            <SettingsRow
              title={language.t("settings.profile.crisisRegion.title")}
              description={language.t("settings.profile.crisisRegion.description")}
            >
              <TextField
                value={profile.state.crisisRegion}
                onChange={(value) => profile.setState("crisisRegion", value)}
                aria-label={language.t("settings.profile.crisisRegion.title")}
              />
            </SettingsRow>
          </SettingsList>
          <div class="flex justify-end">
            <Button variant="primary" disabled={profile.state.saving} onClick={() => void profile.save()}>
              {language.t("common.save")}
            </Button>
          </div>
        </div>
      </Show>
    </div>
  )
}

const SettingsRow: Component<{ title: string; description: string; children: JSX.Element }> = (props) => (
  <div class="flex flex-col gap-3 py-4 border-b border-border-weak-base last:border-none">
    <div class="flex min-w-0 flex-col gap-0.5">
      <span class="text-14-medium text-text-strong">{props.title}</span>
      <span class="text-12-regular text-text-weak">{props.description}</span>
    </div>
    <div>{props.children}</div>
  </div>
)

