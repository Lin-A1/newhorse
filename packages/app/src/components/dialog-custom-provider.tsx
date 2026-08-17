import { Button } from "@newhorse/ui/button"
import { Spinner } from "@newhorse/ui/spinner"
import { useDialog } from "@newhorse/ui/context/dialog"
import { Dialog } from "@newhorse/ui/dialog"
import { IconButton } from "@newhorse/ui/icon-button"
import { ProviderIcon } from "@newhorse/ui/provider-icon"
import { useMutation } from "@tanstack/solid-query"
import { TextField } from "@newhorse/ui/text-field"
import { Tooltip } from "@newhorse/ui/tooltip"
import { showToast } from "@/utils/toast"
import { batch, createSignal, For, Show } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { Link } from "@/components/link"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { useLanguage } from "@/context/language"
import { type FormState, headerRow, modelRow, validateCustomProvider } from "./dialog-custom-provider-form"

// OpenAI-compatible /models discovery. Tries the Base URL as-is first, then a
// `/v1` suffix (many providers host the OpenAI surface under /v1), and finally
// strips an `/anthropic` compat sub-path for Anthropic-style endpoints that
// still expose /v1/models. Mirrors the approach cc-switch uses.
async function fetchModelsFromProvider(baseURL: string, apiKey: string): Promise<{ id: string }[]> {
  const normalized = baseURL.trim().replace(/\/+$/, "")
  if (!normalized) throw new Error("no base url")
  const candidates = [normalized, `${normalized}/v1`, normalized.replace(/\/anthropic$/, ""), normalized.replace(/\/anthropic$/, "/v1")]
  let lastError: unknown
  for (const candidate of [...new Set(candidates)]) {
    const url = `${candidate}/models`
    try {
      const res = await fetch(url, {
        headers: {
          accept: "application/json",
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        signal: AbortSignal.timeout(10_000),
      })
      if (res.status === 401 || res.status === 403) throw new Error(`auth:${res.status}`)
      if (!res.ok) {
        lastError = new Error(`http:${res.status}`)
        continue
      }
      const data = (await res.json()) as { data?: { id: string }[] }
      const models = (data.data ?? []).filter((m) => typeof m.id === "string" && m.id.length > 0)
      if (models.length > 0) return models
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("auth:")) throw error
      lastError = error
    }
  }
  throw lastError ?? new Error("no models endpoint")
}

type Props = {
  onBack: () => void
}

export function DialogCustomProvider(props: Props) {
  const language = useLanguage()

  return (
    <Dialog
      class="h-full"
      title={
        <IconButton
          tabIndex={-1}
          icon="arrow-left"
          variant="ghost"
          onClick={props.onBack}
          aria-label={language.t("common.goBack")}
        />
      }
      transition
    >
      <CustomProviderForm />
    </Dialog>
  )
}

export function CustomProviderForm(props: { autofocus?: boolean } = {}) {
  const dialog = useDialog()
  const serverSync = useServerSync()
  const serverSDK = useServerSDK()
  const language = useLanguage()

  const [form, setForm] = createStore<FormState>({
    providerID: "",
    name: "",
    baseURL: "",
    apiKey: "",
    models: [modelRow()],
    headers: [headerRow()],
    err: {},
  })

  const addModel = () => {
    setForm(
      "models",
      produce((rows) => {
        rows.push(modelRow())
      }),
    )
  }

  const removeModel = (index: number) => {
    if (form.models.length <= 1) return
    setForm(
      "models",
      produce((rows) => {
        rows.splice(index, 1)
      }),
    )
  }

  const addHeader = () => {
    setForm(
      "headers",
      produce((rows) => {
        rows.push(headerRow())
      }),
    )
  }

  const removeHeader = (index: number) => {
    if (form.headers.length <= 1) return
    setForm(
      "headers",
      produce((rows) => {
        rows.splice(index, 1)
      }),
    )
  }

  const setField = (key: "providerID" | "name" | "baseURL" | "apiKey", value: string) => {
    setForm(key, value)
    if (key === "apiKey") return
    setForm("err", key, undefined)
  }

  const setModel = (index: number, key: "id" | "name", value: string) => {
    batch(() => {
      setForm("models", index, key, value)
      setForm("models", index, "err", key, undefined)
    })
  }

  const setHeader = (index: number, key: "key" | "value", value: string) => {
    batch(() => {
      setForm("headers", index, key, value)
      setForm("headers", index, "err", key, undefined)
    })
  }

  const [fetchingModels, setFetchingModels] = createSignal(false)

  // Auto-discover models from the provider's OpenAI-compatible endpoint and
  // prefill the model rows (replacing the single empty row with discovered ids).
  // cc-switch-style: tries the base URL, /v1, and anthropic-stripped candidates.
  const fetchModels = async () => {
    const base = form.baseURL.trim()
    const key = form.apiKey.trim()
    if (!base) {
      showToast({ title: language.t("provider.custom.models.fetch.needBaseUrl") })
      return
    }
    if (!key) {
      showToast({ title: language.t("provider.custom.models.fetch.needApiKey") })
      return
    }
    setFetchingModels(true)
    try {
      const models = await fetchModelsFromProvider(base, key)
      if (models.length === 0) {
        showToast({ title: language.t("provider.custom.models.fetch.none") })
        return
      }
      setForm(
        "models",
        produce((rows) => {
          rows.splice(0, rows.length, ...models.map((m) => ({ ...modelRow(), id: m.id, name: m.id })))
        }),
      )
      showToast({ variant: "success", title: language.t("provider.custom.models.fetch.filled", { count: String(models.length) }) })
    } catch {
      showToast({ variant: "error", title: language.t("provider.custom.models.fetch.failed") })
    } finally {
      setFetchingModels(false)
    }
  }

  const validate = () => {
    const output = validateCustomProvider({
      form,
      t: language.t,
      disabledProviders: serverSync().data.config.disabled_providers ?? [],
      existingProviderIDs: new Set(serverSync().data.provider.all.keys()),
    })
    batch(() => {
      setForm("err", output.err)
      output.models.forEach((err, index) => setForm("models", index, "err", err))
      output.headers.forEach((err, index) => setForm("headers", index, "err", err))
    })
    return output.result
  }

  const saveMutation = useMutation(() => ({
    mutationFn: async (result: NonNullable<ReturnType<typeof validate>>) => {
      const disabledProviders = serverSync().data.config.disabled_providers ?? []
      const nextDisabled = disabledProviders.filter((id) => id !== result.providerID)

      if (result.key) {
        await serverSDK().client.auth.set({
          providerID: result.providerID,
          auth: {
            type: "api",
            key: result.key,
          },
        })
      }

      await serverSync().updateConfig({
        provider: { [result.providerID]: result.config },
        disabled_providers: nextDisabled,
      })
      return result
    },
    onSuccess: (result) => {
      dialog.close()
      showToast({
        variant: "success",
        icon: "circle-check",
        title: language.t("provider.connect.toast.connected.title", { provider: result.name }),
        description: language.t("provider.connect.toast.connected.description", { provider: result.name }),
      })
    },
    onError: (err) => {
      const message = err instanceof Error ? err.message : String(err)
      showToast({ title: language.t("common.requestFailed"), description: message })
    },
  }))

  const save = (e: SubmitEvent) => {
    e.preventDefault()
    if (saveMutation.isPending) return

    const result = validate()
    if (!result) return
    saveMutation.mutate(result)
  }

  return (
    <div class="flex flex-col gap-6 px-2.5 pb-3 overflow-y-auto max-h-[60vh]">
      <div class="px-2.5 flex gap-4 items-center">
        <ProviderIcon id="synthetic" class="size-5 shrink-0 icon-strong-base" />
        <div class="text-16-medium text-text-strong">{language.t("provider.custom.title")}</div>
      </div>

      <form onSubmit={save} class="px-2.5 pb-6 flex flex-col gap-6">
        <p class="text-14-regular text-text-base">
          {language.t("provider.custom.description.prefix")}
          {language.t("provider.custom.description.link")}
          {language.t("provider.custom.description.suffix")}
        </p>

        <div class="flex flex-col gap-4">
          <TextField
            autofocus={props.autofocus ?? true}
            label={language.t("provider.custom.field.providerID.label")}
            placeholder={language.t("provider.custom.field.providerID.placeholder")}
            description={language.t("provider.custom.field.providerID.description")}
            value={form.providerID}
            onChange={(v) => setField("providerID", v)}
            validationState={form.err.providerID ? "invalid" : undefined}
            error={form.err.providerID}
          />
          <TextField
            label={language.t("provider.custom.field.name.label")}
            placeholder={language.t("provider.custom.field.name.placeholder")}
            value={form.name}
            onChange={(v) => setField("name", v)}
            validationState={form.err.name ? "invalid" : undefined}
            error={form.err.name}
          />
          <TextField
            label={language.t("provider.custom.field.baseURL.label")}
            placeholder={language.t("provider.custom.field.baseURL.placeholder")}
            value={form.baseURL}
            onChange={(v) => setField("baseURL", v)}
            validationState={form.err.baseURL ? "invalid" : undefined}
            error={form.err.baseURL}
          />
          <TextField
            label={language.t("provider.custom.field.apiKey.label")}
            placeholder={language.t("provider.custom.field.apiKey.placeholder")}
            description={language.t("provider.custom.field.apiKey.description")}
            value={form.apiKey}
            onChange={(v) => setField("apiKey", v)}
          />
        </div>

        <div class="flex flex-col gap-3">
          <div class="flex items-center justify-between gap-2">
            <label class="text-12-medium text-text-weak">{language.t("provider.custom.models.label")}</label>
            <Button
              type="button"
              size="small"
              variant="secondary"
              disabled={fetchingModels()}
              onClick={() => void fetchModels()}
            >
              <Show when={fetchingModels()}>
                <Spinner class="size-3.5 shrink-0" />
              </Show>
              {fetchingModels()
                ? language.t("provider.custom.models.fetching")
                : language.t("provider.custom.models.fetch")}
            </Button>
          </div>
          <For each={form.models}>
            {(m, i) => (
              <div class="flex gap-2 items-start" data-row={m.row}>
                <div class="flex-1">
                  <TextField
                    label={language.t("provider.custom.models.id.label")}
                    hideLabel
                    placeholder={language.t("provider.custom.models.id.placeholder")}
                    value={m.id}
                    onChange={(v) => setModel(i(), "id", v)}
                    validationState={m.err.id ? "invalid" : undefined}
                    error={m.err.id}
                  />
                </div>
                <div class="flex-1">
                  <TextField
                    label={language.t("provider.custom.models.name.label")}
                    hideLabel
                    placeholder={language.t("provider.custom.models.name.placeholder")}
                    value={m.name}
                    onChange={(v) => setModel(i(), "name", v)}
                    validationState={m.err.name ? "invalid" : undefined}
                    error={m.err.name}
                  />
                </div>
                <Tooltip placement="bottom" value={language.t("provider.custom.models.remove")}>
                  <IconButton
                    type="button"
                    icon="trash"
                    variant="ghost"
                    class="mt-1.5"
                    onClick={() => removeModel(i())}
                    disabled={form.models.length <= 1}
                    aria-label={language.t("provider.custom.models.remove")}
                  />
                </Tooltip>
              </div>
            )}
          </For>
          <Button type="button" size="small" variant="ghost" icon="plus-small" onClick={addModel} class="self-start">
            {language.t("provider.custom.models.add")}
          </Button>
        </div>

        <div class="flex flex-col gap-3">
          <label class="text-12-medium text-text-weak">{language.t("provider.custom.headers.label")}</label>
          <For each={form.headers}>
            {(h, i) => (
              <div class="flex gap-2 items-start" data-row={h.row}>
                <div class="flex-1">
                  <TextField
                    label={language.t("provider.custom.headers.key.label")}
                    hideLabel
                    placeholder={language.t("provider.custom.headers.key.placeholder")}
                    value={h.key}
                    onChange={(v) => setHeader(i(), "key", v)}
                    validationState={h.err.key ? "invalid" : undefined}
                    error={h.err.key}
                  />
                </div>
                <div class="flex-1">
                  <TextField
                    label={language.t("provider.custom.headers.value.label")}
                    hideLabel
                    placeholder={language.t("provider.custom.headers.value.placeholder")}
                    value={h.value}
                    onChange={(v) => setHeader(i(), "value", v)}
                    validationState={h.err.value ? "invalid" : undefined}
                    error={h.err.value}
                  />
                </div>
                <Tooltip placement="bottom" value={language.t("provider.custom.headers.remove")}>
                  <IconButton
                    type="button"
                    icon="trash"
                    variant="ghost"
                    class="mt-1.5"
                    onClick={() => removeHeader(i())}
                    disabled={form.headers.length <= 1}
                    aria-label={language.t("provider.custom.headers.remove")}
                  />
                </Tooltip>
              </div>
            )}
          </For>
          <Button type="button" size="small" variant="ghost" icon="plus-small" onClick={addHeader} class="self-start">
            {language.t("provider.custom.headers.add")}
          </Button>
        </div>

        <Button
          class="w-auto self-start"
          type="submit"
          size="large"
          variant="primary"
          disabled={saveMutation.isPending}
        >
          {saveMutation.isPending ? language.t("common.saving") : language.t("common.submit")}
        </Button>
      </form>
    </div>
  )
}
