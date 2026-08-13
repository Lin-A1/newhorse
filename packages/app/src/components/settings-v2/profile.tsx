import { ButtonV2 } from "@newhorse/ui/v2/button-v2"
import { Spinner } from "@newhorse/ui/spinner"
import { SelectV2 } from "@newhorse/ui/v2/select-v2"
import { TextInputV2 } from "@newhorse/ui/v2/text-input-v2"
import { TextareaV2 } from "@newhorse/ui/v2/textarea-v2"
import { Switch } from "@newhorse/ui/v2/switch-v2"
import { useLanguage } from "@/context/language"
import { useCompanionProfileSettings, type MemoryPolicy } from "../settings-profile-state"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import { Show, type Component } from "solid-js"
import "./settings-v2.css"

const policies: MemoryPolicy[] = ["off", "ask", "auto-safe"]

export const SettingsProfileV2: Component = () => {
  const language = useLanguage()
  const profile = useCompanionProfileSettings()

  return (
    <>
      <div class="settings-v2-tab-header">
        <h2 class="settings-v2-tab-title">{language.t("settings.profile.title")}</h2>
      </div>
      <div class="settings-v2-tab-body">
        <Show when={!profile.state.loading} fallback={<div>{language.t("common.loading")}</div>}>
          <div class="settings-v2-section">
            <SettingsListV2>
              <div class="px-4 pt-4 text-13-medium text-text-weak">{language.t("settings.profile.section.identity")}</div>
              <div class="p-4 border-b border-border-weak-base">
                <div class="flex flex-col gap-1 pb-3">
                  <span class="text-14-medium text-text-strong">{language.t("settings.profile.persona.title")}</span>
                  <span class="text-12-regular text-text-weak">
                    {language.t("settings.profile.persona.description")}
                  </span>
                </div>
                <TextareaV2
                  rows={6}
                  value={profile.state.persona}
                  onInput={(event) => profile.setState("persona", event.currentTarget.value)}
                  aria-label={language.t("settings.profile.persona.title")}
                />
              </div>
              <SettingsRowV2
                title={language.t("settings.profile.memory.title")}
                description={language.t("settings.profile.memory.description")}
              >
                <SelectV2
                  appearance="inline"
                  options={policies}
                  current={profile.state.memory}
                  label={(value) => language.t(`settings.profile.memory.${value}`)}
                  onSelect={(value) => value && profile.setState("memory", value)}
                />
              </SettingsRowV2>
              <div class="px-4 pt-4 text-13-medium text-text-weak">{language.t("settings.profile.section.care")}</div>
              <SettingsRowV2
                title={language.t("settings.profile.proactive.title")}
                description={language.t("settings.profile.proactive.description")}
              >
                <Switch checked={profile.state.proactive} onChange={(value) => profile.setState("proactive", value)} />
              </SettingsRowV2>
              <SettingsRowV2
                title={language.t("settings.profile.dailySummary.title")}
                description={language.t("settings.profile.dailySummary.description")}
              >
                <Switch
                  checked={profile.state.dailySummary}
                  onChange={(value) => profile.setState("dailySummary", value)}
                />
              </SettingsRowV2>
              <Show when={profile.state.proactive}>
                <SettingsRowV2
                  title={language.t("settings.profile.proactivePaused.title")}
                  description={language.t("settings.profile.proactivePaused.description")}
                >
                  <Switch
                    checked={profile.state.proactivePaused}
                    onChange={(value) => profile.setState("proactivePaused", value)}
                  />
                </SettingsRowV2>
                <div class="p-4 border-b border-border-weak-base">
                  <div class="flex flex-col gap-1 pb-3">
                    <span class="text-14-medium text-text-strong">
                      {language.t("settings.profile.quietHours.title")}
                    </span>
                    <span class="text-12-regular text-text-weak">
                      {language.t("settings.profile.quietHours.description")}
                    </span>
                  </div>
                  <div class="grid min-w-0 w-full max-w-full grid-cols-[repeat(auto-fit,minmax(min(100%,120px),1fr))] gap-2 [&>*]:min-w-0 [&>*]:!w-full">
                    <TextInputV2
                      type="time"
                      value={profile.state.quietStart}
                      onInput={(event) => profile.setState("quietStart", event.currentTarget.value)}
                    />
                    <TextInputV2
                      type="time"
                      value={profile.state.quietEnd}
                      onInput={(event) => profile.setState("quietEnd", event.currentTarget.value)}
                    />
                    <TextInputV2
                      value={profile.state.timezone}
                      onInput={(event) => profile.setState("timezone", event.currentTarget.value)}
                    />
                  </div>
                </div>
                <div class="p-4 border-b border-border-weak-base">
                  <div class="flex flex-col gap-1 pb-3">
                    <span class="text-14-medium text-text-strong">
                      {language.t("settings.profile.frequency.title")}
                    </span>
                    <span class="text-12-regular text-text-weak">
                      {language.t("settings.profile.frequency.description")}
                    </span>
                  </div>
                  <div class="grid min-w-0 w-full max-w-full grid-cols-[repeat(auto-fit,minmax(min(100%,150px),1fr))] gap-2 [&>*]:min-w-0 [&>*]:!w-full">
                    <TextInputV2
                      type="number"
                      min="1"
                      max="24"
                      value={String(profile.state.maxPerDay)}
                      onInput={(event) => profile.setState("maxPerDay", Number(event.currentTarget.value))}
                    />
                    <TextInputV2
                      type="number"
                      min="1"
                      max="1440"
                      value={String(profile.state.minIntervalMinutes)}
                      onInput={(event) => profile.setState("minIntervalMinutes", Number(event.currentTarget.value))}
                    />
                  </div>
                </div>
              </Show>
              <SettingsRowV2
                title={language.t("settings.profile.crisisRegion.title")}
                description={language.t("settings.profile.crisisRegion.description")}
              >
                <TextInputV2
                  value={profile.state.crisisRegion}
                  onInput={(event) => profile.setState("crisisRegion", event.currentTarget.value)}
                  aria-label={language.t("settings.profile.crisisRegion.title")}
                />
              </SettingsRowV2>
            </SettingsListV2>
            <div class="flex justify-end pt-4">
              <ButtonV2
                variant="contrast"
                disabled={profile.state.saving}
                aria-busy={profile.state.saving}
                onClick={() => void profile.save()}
              >
                {profile.state.saving ? (
                  <>
                    <Spinner class="size-3.5" />
                    {language.t("common.saving")}
                  </>
                ) : (
                  language.t("common.save")
                )}
              </ButtonV2>
            </div>
          </div>
        </Show>
      </div>
    </>
  )
}

