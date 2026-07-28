import { batch } from "solid-js"
import type { Path, Workspace } from "@newhorse/sdk/v2"
import { createStore, reconcile } from "solid-js/store"
import { createSimpleContext } from "./helper"
import { useSDK } from "./sdk"
import type { TuiPluginHost } from "../plugin/runtime"

type WorkspaceStatus = "connected" | "connecting" | "disconnected" | "error"

export const { use: useProject, provider: ProjectProvider } = createSimpleContext({
  name: "Project",
  init: (props: { pluginHost?: TuiPluginHost }) => {
    const sdk = useSDK()

    const defaultPath = {
      home: "",
      state: "",
      config: "",
      worktree: "",
      directory: sdk.directory ?? "",
    } satisfies Path

    const [store, setStore] = createStore({
      project: {
        id: undefined as string | undefined,
        worktree: undefined as string | undefined,
        mainDir: undefined as string | undefined,
      },
      instance: {
        path: defaultPath,
      },
      workspace: {
        current: undefined as string | undefined,
        list: [] as Workspace[],
        status: {} as Record<string, WorkspaceStatus>,
      },
    })

    async function sync() {
      const workspace = store.workspace.current
      const [instancePath, project] = await Promise.all([
        sdk.client.path.get({ workspace }),
        sdk.client.project.current({ workspace }),
      ])
      const directories = project.data?.id
        ? await sdk.client.project.directories({ projectID: project.data.id, workspace })
        : undefined
      batch(() => {
        setStore("instance", "path", reconcile(instancePath.data || defaultPath))
        setStore("project", "id", project.data?.id)
        setStore("project", "worktree", project.data?.worktree)
        setStore("project", "mainDir", directories?.data?.findLast((item) => item.strategy === undefined)?.directory)
      })
    }

    async function syncWorkspace() {
      const listed = await sdk.client.experimental.workspace.list().catch(() => undefined)
      if (!listed?.data) return
      const status = await sdk.client.experimental.workspace.status().catch(() => undefined)
      const next = Object.fromEntries((status?.data ?? []).map((item) => [item.workspaceID, item.status]))

      const current = store.workspace.current
      const reset = current !== undefined && !listed.data.some((item) => item.id === current)
      if (reset) {
        const reconcileWorkspace = props.pluginHost?.setWorkspace
        if (reconcileWorkspace) {
          await reconcileWorkspace(undefined, () => {
            setStore("workspace", "current", undefined)
          })
        }
      }

      batch(() => {
        setStore("workspace", "list", reconcile(listed.data))
        setStore("workspace", "status", reconcile(next))
        if (reset && !props.pluginHost?.setWorkspace) setStore("workspace", "current", undefined)
      })
    }

    sdk.event.on("event", (event) => {
      if (event.payload.type === "workspace.status") {
        setStore("workspace", "status", event.payload.properties.workspaceID, event.payload.properties.status)
      }
    })

    return {
      data: store,
      project() {
        return store.project.id
      },
      instance: {
        path() {
          return store.instance.path
        },
        directory() {
          return store.instance.path.directory
        },
      },
      workspace: {
        current() {
          return store.workspace.current
        },
        set(next?: string | null) {
          const workspace = next ?? undefined
          if (store.workspace.current === workspace) return Promise.resolve()
          const reconcileWorkspace = props.pluginHost?.setWorkspace
          if (!reconcileWorkspace) {
            setStore("workspace", "current", workspace)
            return Promise.resolve()
          }
          const resolveMetadata = async () => {
            if (!workspace) return undefined
            const cached = store.workspace.list.find((item) => item.id === workspace)
            if (cached) return cached
            await syncWorkspace()
            const metadata = store.workspace.list.find((item) => item.id === workspace)
            if (!metadata) throw new Error(`Workspace metadata unavailable: ${workspace}`)
            return metadata
          }
          return resolveMetadata().then((metadata) =>
            reconcileWorkspace(metadata, () => {
              setStore("workspace", "current", workspace)
            }),
          )
        },
        list() {
          return store.workspace.list
        },
        get(workspaceID: string) {
          return store.workspace.list.find((item) => item.id === workspaceID)
        },
        status(workspaceID: string) {
          return store.workspace.status[workspaceID]
        },
        statuses() {
          return store.workspace.status
        },
        sync: syncWorkspace,
      },
      sync,
    }
  },
})
