import { describe, expect, test } from "bun:test"
import { authFromToken, authTokenFromCredentials } from "./server"

describe("authFromToken", () => {
  test("decodes basic auth credentials from auth_token", () => {
    expect(authFromToken(btoa("kit:secret"))).toEqual({ username: "kit", password: "secret" })
  })

  test("defaults blank username to opencode", () => {
    expect(authFromToken(btoa(":secret"))).toEqual({ username: "opencode", password: "secret" })
  })

  test("ignores malformed tokens", () => {
    expect(authFromToken("not base64")).toBeUndefined()
    expect(authFromToken(btoa("missing-separator"))).toBeUndefined()
  })
})

describe("authTokenFromCredentials", () => {
  test("encodes credentials with the default username", () => {
    expect(authTokenFromCredentials({ password: "secret" })).toBe("b3BlbmNvZGU6c2VjcmV0")
  })

  test("encodes unicode credentials as utf-8", () => {
    const token = authTokenFromCredentials({ password: "密码" })
    expect(authFromToken(token)).toEqual({ username: "opencode", password: "密码" })
  })
})
