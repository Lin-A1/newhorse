import { validateSaveTextFileInput } from "../save-text-file-input"

export { MAX_TEXT_FILE_BYTES } from "../save-text-file-input"

type SaveResult = { canceled: boolean; filePath?: string }

export async function saveTextFile(
  input: unknown,
  deps: {
    choose: (options: {
      title: string
      defaultPath?: string
      filters: { name: string; extensions: string[] }[]
    }) => Promise<SaveResult>
    write: (path: string, contents: string) => Promise<void>
  },
) {
  const value = validateSaveTextFileInput(input)

  const result = await deps.choose({
    title: value.title ?? "Save file",
    defaultPath: value.defaultPath,
    filters: [{ name: "JSON", extensions: ["json"] }],
  })
  if (result.canceled || !result.filePath) return null
  await deps.write(result.filePath, value.contents)
  return result.filePath
}
