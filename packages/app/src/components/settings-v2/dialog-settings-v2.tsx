import { Component, createSignal, startTransition } from "solid-js"
import { Dialog } from "@newhorse/ui/v2/dialog-v2"
import { TabsV2 } from "@newhorse/ui/v2/tabs-v2"
import { Icon } from "@newhorse/ui/icon"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { SettingsGeneralV2 } from "./general"
import { SettingsKeybinds } from "../settings-keybinds"
import { SettingsProvidersV2 } from "./providers"
import { SettingsModelsV2 } from "./models"
import "./settings-v2.css"
import { SettingsServersV2 } from "./servers"
import { useDialog } from "@newhorse/ui/context/dialog"
import { SettingsProfileV2 } from "./profile"
import { SettingsMemory } from "../settings-memory"
import { SettingsContinuityGrants } from "../settings-continuity-grants"
import { SettingsCompanionPlan } from "../settings-companion-plan"
import { SettingsReminders } from "../settings-reminders"
import { SettingsSkillsMcp } from "../settings-skills-mcp"
import { SettingsUsage } from "../settings-usage"

export const DialogSettings: Component<{
  sessionID?: string
  directory?: string
  defaultValue?: string
}> = (props) => {
  const language = useLanguage()
  const platform = usePlatform()
  const dialog = useDialog()
  const [tab, setTab] = createSignal(props.defaultValue ?? "general")

  const showProviders = () => {
    void dialog.show(() => (
      <DialogSettings sessionID={props.sessionID} directory={props.directory} defaultValue="providers" />
    ))
  }

  return (
    <Dialog size="x-large" variant="settings" class="settings-v2-dialog">
      <TabsV2
        orientation="vertical"
        variant="settings"
        value={tab()}
        onChange={(value) => void startTransition(() => setTab(value))}
        class="settings-v2"
      >
        <TabsV2.List>
          <div class="flex flex-col justify-between h-full w-full">
            <div class="flex flex-col gap-3 w-full">
              <div class="flex flex-col gap-3">
                <div class="flex flex-col gap-1.5">
                  <TabsV2.SectionTitle>{language.t("settings.section.desktop")}</TabsV2.SectionTitle>
                  <div class="flex flex-col gap-1.5 w-full">
                    <TabsV2.Trigger value="general">
                      <Icon name="sliders" />
                      {language.t("settings.tab.general")}
                    </TabsV2.Trigger>
                    <TabsV2.Trigger value="shortcuts">
                      <Icon name="keyboard" />
                      {language.t("settings.tab.shortcuts")}
                    </TabsV2.Trigger>
                  </div>
                </div>

                <div class="flex flex-col gap-1.5">
                  <TabsV2.SectionTitle>{language.t("settings.section.server")}</TabsV2.SectionTitle>
                  <div class="flex flex-col gap-1.5 w-full">
                    <TabsV2.Trigger value="servers">
                      <Icon name="server" />
                      {language.t("status.popover.tab.servers")}
                    </TabsV2.Trigger>
                    <TabsV2.Trigger value="providers">
                      <Icon name="providers" />
                      {language.t("settings.providers.title")}
                    </TabsV2.Trigger>
                    <TabsV2.Trigger value="models">
                      <Icon name="models" />
                      {language.t("settings.models.title")}
                    </TabsV2.Trigger>
                    <TabsV2.Trigger value="memory">
                      <Icon name="brain" />
                      {language.t("settings.tab.memory")}
                    </TabsV2.Trigger>
                    <TabsV2.Trigger value="continuity">
                      <Icon name="branch" />
                      {language.t("settings.tab.continuity")}
                    </TabsV2.Trigger>
                    <TabsV2.Trigger value="reminders">
                      <Icon name="task" />
                      {language.t("settings.tab.reminders")}
                    </TabsV2.Trigger>
                    <TabsV2.Trigger value="companion-plan">
                      <Icon name="glasses" />
                      {language.t("settings.tab.companionPlan")}
                    </TabsV2.Trigger>
                    <TabsV2.Trigger value="profile">
                      <Icon name="brain" />
                      {language.t("settings.profile.title")}
                    </TabsV2.Trigger>
                    <TabsV2.Trigger value="skills-mcp">
                      <Icon name="mcp" />
                      {language.t("settings.tab.skillsMcp")}
                    </TabsV2.Trigger>
                    <TabsV2.Trigger value="usage">
                      <Icon name="dash" />
                      {language.t("settings.tab.usage")}
                    </TabsV2.Trigger>
                  </div>
                </div>
              </div>
            </div>
            <div class="settings-v2-nav-footer">
              <span>{language.t("app.name.desktop")}</span>
              <span>v{platform.version}</span>
            </div>
          </div>
        </TabsV2.List>
        <TabsV2.Content value="general" class="settings-v2-panel">
          <SettingsGeneralV2 sessionID={props.sessionID} directory={props.directory} />
        </TabsV2.Content>
        <TabsV2.Content value="shortcuts" class="settings-v2-panel">
          <SettingsKeybinds v2 />
        </TabsV2.Content>
        <TabsV2.Content value="servers" class="settings-v2-panel">
          <SettingsServersV2 />
        </TabsV2.Content>
        <TabsV2.Content value="providers" class="settings-v2-panel">
          <SettingsProvidersV2 onBack={showProviders} />
        </TabsV2.Content>
        <TabsV2.Content value="models" class="settings-v2-panel">
          <SettingsModelsV2 />
        </TabsV2.Content>
        <TabsV2.Content value="memory" class="settings-v2-panel">
          <SettingsMemory sessionID={props.sessionID} />
        </TabsV2.Content>
        <TabsV2.Content value="continuity" class="settings-v2-panel">
          <SettingsContinuityGrants sessionID={props.sessionID} />
        </TabsV2.Content>
        <TabsV2.Content value="reminders" class="settings-v2-panel">
          <SettingsReminders sessionID={props.sessionID} />
        </TabsV2.Content>
        <TabsV2.Content value="companion-plan" class="settings-v2-panel">
          <SettingsCompanionPlan sessionID={props.sessionID} />
        </TabsV2.Content>
        <TabsV2.Content value="profile" class="settings-v2-panel">
          <SettingsProfileV2 />
        </TabsV2.Content>
        <TabsV2.Content value="skills-mcp" class="settings-v2-panel">
          <SettingsSkillsMcp />
        </TabsV2.Content>
        <TabsV2.Content value="usage" class="settings-v2-panel">
          <SettingsUsage />
        </TabsV2.Content>
      </TabsV2>
    </Dialog>
  )
}
