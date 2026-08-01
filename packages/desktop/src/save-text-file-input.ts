export const MAX_TEXT_FILE_BYTES = 10 * 1024 * 1024
export const MAX_TEXT_FILE_TITLE_LENGTH = 512
export const MAX_TEXT_FILE_PATH_LENGTH = 4096

export type SaveTextFileInput = {
  title?: string
  defaultPath?: string
  contents: string
}

export function validateSaveTextFileInput(input: unknown): SaveTextFileInput {
  if (!input || typeof input !== "object") throw new Error("Invalid text file payload")
  const value = input as Partial<SaveTextFileInput>
  if (typeof value.contents !== "string") throw new Error("Text file contents must be a string")
  if (value.title !== undefined && typeof value.title !== "string") throw new Error("Text file title must be a string")
  if (value.defaultPath !== undefined && typeof value.defaultPath !== "string")
    throw new Error("Text file defaultPath must be a string")
  if (value.title && (value.title.length > MAX_TEXT_FILE_TITLE_LENGTH || value.title.includes("\0")))
    throw new Error("Text file title is invalid")
  if (value.defaultPath && (value.defaultPath.length > MAX_TEXT_FILE_PATH_LENGTH || value.defaultPath.includes("\0")))
    throw new Error("Text file defaultPath is invalid")
  if (new TextEncoder().encode(value.contents).byteLength > MAX_TEXT_FILE_BYTES)
    throw new Error(`Text file exceeds the ${MAX_TEXT_FILE_BYTES / 1024 / 1024} MB limit`)
  return { title: value.title, defaultPath: value.defaultPath, contents: value.contents }
}
