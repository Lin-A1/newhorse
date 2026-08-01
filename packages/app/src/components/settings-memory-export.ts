import type { MemoryInfo } from "@newhorse/sdk/v2"
import type { Platform } from "@/context/platform"

export async function exportMemory(
  records: readonly MemoryInfo[],
  platform: Pick<Platform, "saveTextFileDialog">,
  download: (input: { filename: string; contents: string }) => void,
  date = new Date(),
) {
  const filename = `newhorse-memory-${date.toISOString().slice(0, 10)}.json`
  const contents = JSON.stringify(records, null, 2)
  if (platform.saveTextFileDialog) {
    await platform.saveTextFileDialog({ title: "Export Memory", defaultPath: filename, contents })
    return
  }
  download({ filename, contents })
}
