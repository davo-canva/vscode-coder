import axios from "axios"
import { execFile } from "child_process"
import { getBuildInfo } from "coder/site/src/api/api"
import fs from "fs"
import { IncomingMessage } from "http"
import os from "os"
import path from "path"
import prettyBytes from "pretty-bytes"
import * as vscode from "vscode"

export class Storage {
  constructor(
    private readonly output: vscode.OutputChannel,
    private readonly memento: vscode.Memento,
    private readonly globalStorageUri: vscode.Uri,
  ) {}

  // init ensures that the storage places values in the
  // appropriate default values.
  public init(): void {
    this.updateURL()
    this.updateSessionToken()
  }

  public setURL(url?: string): Thenable<void> {
    return this.memento.update("url", url).then(() => {
      this.updateURL()
    })
  }

  public getURL(): string | undefined {
    return this.memento.get("url")
  }

  public setSessionToken(sessionToken?: string): Thenable<void> {
    return this.memento.update("sessionToken", sessionToken).then(() => {
      this.updateSessionToken()
    })
  }

  public getSessionToken(): string | undefined {
    return this.memento.get("sessionToken")
  }

  // fetchBinary returns the path to a Coder binary.
  // The binary will be cached if a matching server version already exists.
  public async fetchBinary(): Promise<string | undefined> {
    const baseURL = this.getURL()
    if (!baseURL) {
      throw new Error("Must be logged in!")
    }
    const baseURI = vscode.Uri.parse(baseURL)

    const buildInfo = await getBuildInfo()
    const binPath = this.binaryPath(buildInfo.version)
    const exists = await new Promise<boolean>((resolve) =>
      fs.stat(binPath, (err) => {
        if (err) {
          this.output.appendLine("Checking for cached binary: " + err)
        }
        resolve(err === null)
      }),
    )
    if (exists) {
      // Even if the file exists, it could be corrupted.
      // We run `coder version` to ensure the binary can be executed.
      this.output.appendLine(`Using cached binary: ${binPath}`)
      const valid = await new Promise<boolean>((resolve) => {
        try {
          execFile(binPath, ["version"], (err) => {
            if (err) {
              this.output.appendLine("Check for binary corruption: " + err)
            }
            resolve(err === null)
          })
        } catch (ex) {
          this.output.appendLine("The cached binary cannot be executed: " + ex)
          resolve(false)
        }
      })
      if (valid) {
        return binPath
      }
    }
    const os = goos()
    const arch = goarch()
    let binName = `coder-${os}-${arch}`
    // Windows binaries have an exe suffix!
    if (goos() === "windows") {
      binName += ".exe"
    }
    const controller = new AbortController()
    const resp = await axios.get("/bin/" + binName, {
      signal: controller.signal,
      baseURL: baseURL,
      responseType: "stream",
      // Ignore all errors so we can catch a 404!
      validateStatus: () => true,
    })
    if (resp.status === 404) {
      vscode.window
        .showErrorMessage(
          "Coder isn't supported for your platform. Please open an issue, we'd love to support it!",
          "Open an Issue",
        )
        .then((value) => {
          if (!value) {
            return
          }
          const params = new URLSearchParams({
            title: `Support the \`${os}-${arch}\` platform`,
            body: `I'd like to use the \`${os}-${arch}\` architecture with the VS Code extension.`,
          })
          const uri = vscode.Uri.parse(`https://github.com/coder/vscode-coder/issues/new?` + params.toString())
          vscode.env.openExternal(uri)
        })
      return
    }
    if (resp.status !== 200) {
      vscode.window.showErrorMessage("Failed to fetch the Coder binary: " + resp.statusText)
      return
    }

    const contentLength = Number.parseInt(resp.headers["content-length"])

    // Ensure the binary directory exists!
    await new Promise<void>((resolve, reject) => {
      fs.mkdir(
        path.dirname(binPath),
        {
          recursive: true,
        },
        (err) => {
          if (err) {
            return reject(err)
          }
          resolve()
        },
      )
    })

    const completed = await vscode.window.withProgress<boolean>(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Downloading the latest binary (${buildInfo.version} from ${baseURI.authority})`,
        cancellable: true,
      },
      async (progress, token) => {
        const readStream = resp.data as IncomingMessage
        let cancelled = false
        token.onCancellationRequested(() => {
          controller.abort()
          readStream.destroy()
          cancelled = true
        })

        const contentLengthPretty = prettyBytes(contentLength)
        const writeStream = fs.createWriteStream(binPath, {
          autoClose: true,
          mode: 0o755,
        })
        let written = 0
        readStream.on("data", (buffer: Buffer) => {
          writeStream.write(buffer, () => {
            written += buffer.byteLength
            progress.report({
              message: `${prettyBytes(written)} / ${contentLengthPretty}`,
              increment: (buffer.byteLength / contentLength) * 100,
            })
          })
        })
        try {
          await new Promise<void>((resolve, reject) => {
            readStream.on("error", (err) => {
              reject(err)
            })
            readStream.on("close", () => {
              if (cancelled) {
                return reject()
              }
              writeStream.close()
              resolve()
            })
          })
          return true
        } catch (ex) {
          return false
        }
      },
    )
    if (!completed) {
      return
    }

    this.output.appendLine(`Downloaded binary: ${binPath}`)
    return binPath
  }

  // getBinaryCachePath returns the path where binaries are cached.
  // The caller must ensure it exists before use.
  public getBinaryCachePath(): string {
    return path.join(this.globalStorageUri.fsPath, "bin")
  }

  private updateURL() {
    axios.defaults.baseURL = this.getURL()
  }

  private binaryPath(version: string): string {
    const os = goos()
    const arch = goarch()
    let binPath = path.join(this.getBinaryCachePath(), `coder-${os}-${arch}-${version}`)
    if (os === "windows") {
      binPath += ".exe"
    }
    return binPath
  }

  private updateSessionToken() {
    const token = this.getSessionToken()
    if (token) {
      axios.defaults.headers.common["Coder-Session-Token"] = token
    } else {
      delete axios.defaults.headers.common["Coder-Session-Token"]
    }
  }
}

// goos returns the Go format for the current platform.
// Coder binaries are created in Go, so we conform to that name structure.
const goos = (): string => {
  const platform = os.platform()
  switch (platform) {
    case "win32":
      return "windows"
    default:
      return platform
  }
}

// goarch returns the Go format for the current architecture.
const goarch = (): string => {
  const arch = os.arch()
  switch (arch) {
    case "arm":
      return "armv7"
    case "x64":
      return "amd64"
    default:
      return arch
  }
}