export function startLocalFtpServer(options?: {
  username?: string;
  password?: string;
  secure?: boolean;
  host?: string;
}): Promise<{
  host: string;
  port: number;
  state: { authenticatedUsers: string[] };
  close: () => Promise<void>;
}>;
