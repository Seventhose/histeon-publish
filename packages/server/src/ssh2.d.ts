declare module "ssh2" {
  import { EventEmitter } from "node:events";
  import type { Duplex, Readable } from "node:stream";

  export interface Stats {
    mode?: number;
    size?: number;
    isDirectory(): boolean;
  }

  export interface SFTPWrapper {
    readdir(path: string, callback: (error: Error | null | undefined, entries: Array<{ filename: string; attrs?: { mode?: number; size?: number } }>) => void): void;
    stat(path: string, callback: (error: Error | null | undefined, stats: Stats) => void): void;
    lstat(path: string, callback: (error: Error | null | undefined, stats: Stats) => void): void;
    createReadStream(path: string): Readable;
    mkdir(path: string, callback: (error?: Error | null) => void): void;
    fastPut(localPath: string, remotePath: string, callback: (error?: Error | null) => void): void;
    unlink(path: string, callback: (error?: Error | null) => void): void;
  }

  export class Client extends EventEmitter {
    connect(config: {
      host: string;
      port: number;
      username?: string;
      password?: string;
      privateKey?: string;
      passphrase?: string;
      readyTimeout?: number;
      hostHash?: "sha256";
      hostVerifier?: (hash: string) => boolean;
    }): void;
    end(): void;
    sftp(callback: (error: Error | null | undefined, sftp: SFTPWrapper) => void): void;
    forwardOut(srcIP: string, srcPort: number, dstIP: string, dstPort: number, callback: (error: Error | null | undefined, stream: Duplex) => void): void;
  }
}
