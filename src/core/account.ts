import { TarsError } from "./exit.ts";

/**
 * The home directory in the account database. Bun's os.userInfo().homedir returns $HOME, which
 * `tars agy` points at a directory of its own, so it cannot say where the user's files are.
 */
export function accountHome(): string {
  const uid = process.getuid?.();
  if (uid === undefined) throw new TarsError("cannot tell the current user id");
  const proc = Bun.spawnSync(["getent", "passwd", String(uid)]);
  const home = proc.stdout.toString().trim().split(":")[5];
  if (proc.exitCode !== 0 || !home?.startsWith("/"))
    throw new TarsError(`getent passwd ${uid} gave no home directory`);
  return home;
}
