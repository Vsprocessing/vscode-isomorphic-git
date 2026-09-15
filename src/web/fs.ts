import type { PromiseFsClient } from "isomorphic-git";
import * as path from "path";
import { FileStat, FileType, Uri, workspace } from "vscode";

type EncodingOptions = { encoding?: BufferEncoding } | BufferEncoding | undefined;

const errorCodes = new Map<string, string>([
  ["EntryNotFound", "ENOENT"],
  ["FileNotFound", "ENOENT"],
  ["FileExists", "EEXIST"],
  ["FileIsADirectory", "EISDIR"],
  ["FileNotADirectory", "ENOTDIR"],
  ["NoPermissions", "EACCES"],
  ["Unavailable", "EIO"],
]);

interface GitStats {
  type: "file" | "dir" | "symlink";
  mode: number;
  size: number;
  ino: number;
  mtimeMs: number;
  ctimeMs: number;
  uid: number;
  gid: number;
  dev: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export class FileSystem implements PromiseFsClient {
  private readonly decoder = new TextDecoder();
  private readonly encoder = new TextEncoder();
  private readonly roots = new Map<string, Uri>();
  private activeRoot: Uri | undefined;

  public readonly promises = {
    readFile: this.readFile.bind(this),
    writeFile: this.writeFile.bind(this),
    unlink: this.unlink.bind(this),
    readdir: this.readdir.bind(this),
    mkdir: this.mkdir.bind(this),
    rmdir: this.rmdir.bind(this),
    rename: this.rename.bind(this),
    stat: this.stat.bind(this),
    lstat: this.lstat.bind(this),
    readlink: this.readlink.bind(this),
    symlink: this.symlink.bind(this),
    chmod: this.chmod.bind(this),
    exists: this.exists.bind(this),
  };

  addRoot(rootUri: Uri): void {
    this.roots.set(rootUri.toString(), rootUri);
    this.activeRoot = rootUri;
  }

  async readFile(filePath: string, options?: EncodingOptions) {
    const data = await this.runFs(() =>
      workspace.fs.readFile(this.uriForPath(filePath))
    );
    if (this.encoding(options)?.replace("-", "") === "utf8") {
      return this.decoder.decode(data);
    }
    return data;
  }

  async writeFile(filePath: string, data: Uint8Array | string): Promise<void> {
    await this.runFs(() =>
      workspace.fs.writeFile(
        this.uriForPath(filePath),
        typeof data === "string" ? this.encoder.encode(data) : data
      )
    );
  }

  async unlink(filePath: string): Promise<void> {
    await this.runFs(() =>
      workspace.fs.delete(this.uriForPath(filePath), { recursive: false })
    );
  }

  async readdir(filePath: string): Promise<string[]> {
    return (
      await this.runFs(() => workspace.fs.readDirectory(this.uriForPath(filePath)))
    ).map(([name]) => name);
  }

  async exists(filePath: string): Promise<boolean> {
    try {
      await this.stat(filePath);
      return true;
    } catch (error) {
      if (this.isNotFound(error)) {
        return false;
      }
      throw error;
    }
  }

  async mkdir(filePath: string): Promise<void> {
    await this.runFs(() => workspace.fs.createDirectory(this.uriForPath(filePath)));
  }

  async rmdir(filePath: string): Promise<void> {
    await this.runFs(() =>
      workspace.fs.delete(this.uriForPath(filePath), { recursive: false })
    );
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    await this.runFs(() =>
      workspace.fs.rename(this.uriForPath(oldPath), this.uriForPath(newPath), {
        overwrite: true,
      })
    );
  }

  async stat(filePath: string): Promise<GitStats> {
    return this.toStats(
      await this.runFs(() => workspace.fs.stat(this.uriForPath(filePath)))
    );
  }

  async lstat(filePath: string): Promise<GitStats> {
    return this.stat(filePath);
  }

  async readlink(): Promise<string> {
    throw new Error("readlink is not supported by vscode.workspace.fs");
  }

  async symlink(): Promise<void> {
    throw new Error("symlink is not supported by vscode.workspace.fs");
  }

  async chmod(): Promise<void> {
    // vscode.workspace.fs does not expose chmod. Git can continue without it.
  }

  private encoding(options: EncodingOptions): BufferEncoding | undefined {
    return typeof options === "string" ? options : options?.encoding;
  }

  private async runFs<T>(operation: () => Thenable<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw this.toNodeError(error);
    }
  }

  private toNodeError(error: unknown): Error {
    const code = this.nodeCode(error);
    if (code) {
      const message = error instanceof Error ? error.message : String(error);
      const nodeError = new Error(message);
      (nodeError as NodeJS.ErrnoException).code = code;
      return nodeError;
    }
    return error instanceof Error ? error : new Error(String(error));
  }

  private isNotFound(error: unknown): boolean {
    return this.nodeCode(error) === "ENOENT";
  }

  private nodeCode(error: unknown): string | undefined {
    const candidate = error as { code?: string; name?: string; message?: string };
    if (candidate?.code && errorCodes.has(candidate.code)) {
      return errorCodes.get(candidate.code);
    }
    if (candidate?.name && errorCodes.has(candidate.name)) {
      return errorCodes.get(candidate.name);
    }
    const fromMessage = [...errorCodes].find(([vscodeCode]) =>
      candidate?.message?.includes(vscodeCode)
    )?.[1];
    if (fromMessage) {
      return fromMessage;
    }
    // Errors crossing the extension host boundary can lose their code and keep only the message.
    if (/does not exist|nonexistent|not found/i.test(candidate?.message ?? "")) {
      return "ENOENT";
    }
    if (/already exists/i.test(candidate?.message ?? "")) {
      return "EEXIST";
    }
    return undefined;
  }

  /** Maps an absolute POSIX path to its workspace URI (e.g. vscode-userdata:), or file: if none matches. */
  uriForPath(filePath: string): Uri {
    filePath = this.resolvePath(filePath);
    const roots = [
      ...this.roots.values(),
      ...(workspace.workspaceFolders || []).map((folder) => folder.uri),
    ];
    const root = roots
      .slice()
      .sort((a, b) => b.path.length - a.path.length)
      .find((uri) => this.isInside(filePath, uri.path));

    return root ? root.with({ path: filePath }) : Uri.file(filePath);
  }

  private resolvePath(filePath: string): string {
    if (filePath.startsWith("/")) {
      return path.posix.normalize(filePath);
    }

    const rootPath =
      this.activeRoot?.path || workspace.workspaceFolders?.[0]?.uri.path || "/";
    if (filePath === "." || !filePath) {
      return rootPath;
    }
    return path.posix.normalize(
      rootPath.replace(/\/+$/, "") + "/" + filePath.replace(/^\/+/, "")
    );
  }

  private isInside(filePath: string, folderPath: string): boolean {
    return (
      filePath === folderPath ||
      folderPath === "/" ||
      filePath.startsWith(folderPath.replace(/\/+$/, "") + "/")
    );
  }

  private toStats(stat: FileStat): GitStats {
    const isDirectory = Boolean(stat.type & FileType.Directory);
    const isSymbolicLink = Boolean(stat.type & FileType.SymbolicLink);
    const isFile = !isDirectory && !isSymbolicLink;

    return {
      type: isDirectory ? "dir" : isSymbolicLink ? "symlink" : "file",
      mode: isDirectory ? 0o040000 : 0o100644,
      size: stat.size,
      ino: 0,
      mtimeMs: stat.mtime,
      ctimeMs: stat.ctime,
      uid: 1,
      gid: 1,
      dev: 1,
      isFile: () => isFile,
      isDirectory: () => isDirectory,
      isSymbolicLink: () => isSymbolicLink,
    };
  }
}
