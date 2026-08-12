import { Effect, Layer } from "effect"
import { LayerNode } from "@newhorse/core/effect/layer-node"
import { CrossSpawnSpawner } from "@newhorse/core/cross-spawn-spawner"
import { FSUtil } from "@newhorse/core/fs-util"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "../../src/tool/truncate"
import { LSP } from "@/lsp/lsp"

export type LSPOverrides = Partial<LSP.Interface>

export const mockLspLayer = (overrides: LSPOverrides = {}) =>
  Layer.succeed(
    LSP.Service,
    LSP.Service.of({
      init: () => Effect.void,
      status: () => Effect.succeed([]),
      hasClients: () => Effect.succeed(true),
      touchFile: () => Effect.void,
      diagnostics: () => Effect.succeed({}),
      hover: () => Effect.succeed([]),
      definition: () => Effect.succeed([]),
      references: () => Effect.succeed([]),
      implementation: () => Effect.succeed([]),
      documentSymbol: () => Effect.succeed([]),
      workspaceSymbol: () => Effect.succeed([]),
      prepareCallHierarchy: () => Effect.succeed([]),
      incomingCalls: () => Effect.succeed([]),
      outgoingCalls: () => Effect.succeed([]),
      prepareRename: () => Effect.succeed([]),
      rename: () => Effect.succeed([]),
      ...overrides,
    }),
  )

export const lspToolTestLayer = (overrides: LSPOverrides = {}) =>
  LayerNode.compile(
    LayerNode.group([Agent.node, FSUtil.node, CrossSpawnSpawner.node, Truncate.node, LSP.node]),
    [[LSP.node, mockLspLayer(overrides)]],
  )
