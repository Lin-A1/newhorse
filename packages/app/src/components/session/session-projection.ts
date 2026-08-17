import { createQuery } from "@tanstack/solid-query"
import { useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"
import type { Session, SessionProjected } from "@newhorse/sdk/v2/client"

export function useSessionProjection(sessionID: () => string | undefined) {
  const sdk = useSDK()
  const serverSDK = useServerSDK()
  const query = createQuery(() => {
    const id = sessionID()
    return {
      queryKey: [serverSDK().scope, sdk().directory, id ?? "none", "session-projected"] as const,
      enabled: !!id,
      staleTime: 10_000,
      queryFn: () => {
        if (!id) return undefined as SessionProjected | undefined
        return sdk()
          .client.session.projected({ sessionID: id })
          .then((result) => result.data ?? undefined)
      },
    }
  })
  return {
    data: () => query.data,
    pending: () => query.isPending,
  }
}

/** Cache hit rate over the billed input footprint: read / (input + read + write). */
export function cacheHitRate(session: Session | undefined): number | undefined {
  const tokens = session?.tokens
  if (!tokens) return undefined
  const total = tokens.input + tokens.cache.read + tokens.cache.write
  if (total <= 0) return undefined
  return tokens.cache.read / total
}