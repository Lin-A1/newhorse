import { Component, createSignal, startTransition } from "solid-js"
import { Dialog } from "@newhorse/ui/dialog"
import { Tabs } from "@newhorse/ui/tabs"
import { Icon } from "@newhorse/ui/icon"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useDialog } from "@newhorse/ui/context/dialog"
import { SettingsGeneral } from "./settings-general"
import { SettingsKeybinds } from "./settings-keybinds"
import { SettingsProviders } from "./settings-providers"
import { SettingsModels } from "./settings-models"
import { SettingsServers } from "./settings-servers"
import { SettingsProfile } from "./settings-profile"
import { SettingsMemory } from "./settings-memory"
import { SettingsContinuityGrants } from "./settings-continuity-grants"
import { SettingsCompanionPlan } from "./settings-companion-plan"
import { SettingsReminders } from "./settings-reminders"
import { SettingsSkillsMcp } from "./settings-skills-mcp"
import { SettingsUsage } from "./settings-usage"

export const DialogSettings: Component<{ defaultValue?: string; directory?: string }> = (props) => {
  const language = useLanguage()
  const platform = usePlatform()
  const dialog = useDialog()
  const [tab, setTab] = createSignal(props.defaultValue ?? "general")

  const showProviders = () => {
    void dialog.show(() => <DialogSettings defaultValue="providers" />)
  }

  return (
    <Dialog size="x-large" transition>
      <Tabs
        orientation="vertical"
        variant="settings"
        value={tab()}
        onChange={(value) => void startTransition(() => setTab(value))}
        class="h-full settings-dialog"
      >
        <Tabs.List>
          <div class="flex flex-col justify-between h-full w-full gap-4">
            <div class="flex flex-col gap-3 w-full pt-3">
              <div class="flex flex-col gap-3">
                <div class="flex flex-col gap-1.5">
                  <Tabs.SectionTitle>{language.t("settings.section.desktop")}</Tabs.SectionTitle>
                  <div class="flex flex-col gap-1.5 w-full">
                    <Tabs.Trigger value="general">
                      <Icon name="sliders" />
                      {language.t("settings.tab.general")}
                    </Tabs.Trigger>
                    <Tabs.Trigger value="shortcuts">
                      <Icon name="keyboard" />
                      {language.t("settings.tab.shortcuts")}
                    </Tabs.Trigger>
                    <Tabs.Trigger value="servers">
                      <Icon name="server" />
                      {language.t("status.popover.tab.servers")}
                    </Tabs.Trigger>
                  </div>
                </div>

                <div class="flex flex-col gap-1.5">
                  <Tabs.SectionTitle>{language.t("settings.section.server")}</Tabs.SectionTitle>
                  <div class="flex flex-col gap-1.5 w-full">
                    <Tabs.Trigger value="providers">
                      <Icon name="providers" />
                      {language.t("settings.providers.title")}
                    </Tabs.Trigger>
                    <Tabs.Trigger value="models">
                      <Icon name="models" />
                      {language.t("settings.models.title")}
                    </Tabs.Trigger>
                    <Tabs.Trigger value="memory">
                      <Icon name="brain" />
                      {language.t("settings.tab.memory")}
                    </Tabs.Trigger>
                    <Tabs.Trigger value="continuity">
                      <Icon name="branch" />
                      {language.t("settings.tab.continuity")}
                    </Tabs.Trigger>
                    <Tabs.Trigger value="reminders">
                      <Icon name="task" />
                      {language.t("settings.tab.reminders")}
                    </Tabs.Trigger>
                    <Tabs.Trigger value="companion-plan">
                      <Icon name="glasses" />
                      {language.t("settings.tab.companionPlan")}
                    </Tabs.Trigger>
                    <Tabs.Trigger value="profile">
                      <Icon name="brain" />
                      {language.t("settings.profile.title")}
                    </Tabs.Trigger>
                    <Tabs.Trigger value="skills-mcp">
                      <Icon name="mcp" />
                      {language.t("settings.tab.skillsMcp")}
                    </Tabs.Trigger>
                    <Tabs.Trigger value="usage">
                      <Icon name="dash" />
                      {language.t("settings.tab.usage")}
                    </Tabs.Trigger>
                  </div>
                </div>
              </div>
            </div>
            <div class="flex flex-col gap-1 pl-1 py-1 text-12-medium text-text-weak">
              <span>{language.t("app.name.desktop")}</span>
              <span class="text-11-regular">v{platform.version}</span>
            </div>
          </div>
        </Tabs.List>
        <Tabs.Content value="general" class="no-scrollbar">
          <SettingsGeneral directory={props.directory} />
        </Tabs.Content>
        <Tabs.Content value="shortcuts" class="no-scrollbar">
          <SettingsKeybinds />
        </Tabs.Content>
        <Tabs.Content value="servers" class="no-scrollbar">
          <SettingsServers />
        </Tabs.Content>
        <Tabs.Content value="providers" class="no-scrollbar">
          <SettingsProviders onBack={showProviders} />
        </Tabs.Content>
        <Tabs.Content value="models" class="no-scrollbar">
          <SettingsModels />
        </Tabs.Content>
        <Tabs.Content value="memory" class="no-scrollbar">
          <SettingsMemory />
        </Tabs.Content>
        <Tabs.Content value="continuity" class="no-scrollbar">
          <SettingsContinuityGrants />
        </Tabs.Content>
        <Tabs.Content value="reminders" class="no-scrollbar">
          <SettingsReminders />
        </Tabs.Content>
        <Tabs.Content value="companion-plan" class="no-scrollbar">
          <SettingsCompanionPlan />
        </Tabs.Content>
        <Tabs.Content value="profile" class="no-scrollbar">
          <SettingsProfile />
        </Tabs.Content>
        <Tabs.Content value="skills-mcp" class="no-scrollbar">
          <SettingsSkillsMcp />
        </Tabs.Content>
        <Tabs.Content value="usage" class="no-scrollbar">
          <SettingsUsage />
        </Tabs.Content>
      </Tabs>
    </Dialog>
  )
}
