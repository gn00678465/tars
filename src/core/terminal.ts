import { closeSync, openSync, writeSync } from "node:fs";
import { TarsError } from "./exit.ts";

/**
 * The user's own terminal. Gate 3 shows its material and reads its answers here and nowhere else,
 * so a pipe cannot answer it and a redirect cannot hide what the person typing is approving.
 */
export interface Terminal {
  write(text: string): void;
  /** One line without its newline; undefined at end of input. */
  ask(prompt: string): Promise<string | undefined>;
  /** Like ask, with the terminal's echo off while the line is typed. */
  askHidden(prompt: string): Promise<string | undefined>;
  close(): void;
}

// Both reads run in a child with /dev/tty as stdin and the prompt as $1, so that the process that
// changes the terminal's mode is the one that puts it back: Ctrl-C reaches tars and the child
// together, and tars cannot run a handler while it waits in a blocking read. Exit 3 is end of
// input.

// bash's readline gives the line its cursor keys and restores the terminal itself on Ctrl-C. On
// a terminal without TERM, or a dumb one, readline cannot move the cursor and scrolls a long
// prompt out of sight, so the kernel's own line editing reads it there.
const LINE_READ = `exec 3>&1 >&0 2>&0
case "$TERM" in ""|dumb) edit= ;; *) edit=-e ;; esac
IFS= read $edit -r -p "$1" line || exit 3
printf '%s' "$line" >&3`;

// Echo and line mode go off once, before the prompt, so no key typed in answer to it can show;
// each character then comes back as a "*". Escape sequences (arrows, bracketed-paste markers) are
// dropped rather than kept in the secret. Ctrl-C still raises SIGINT, and the EXIT trap puts the
// terminal back.
const HIDDEN_READ = `saved=$(stty -g) || exit 1
trap 'stty "$saved"' EXIT
trap 'exit 130' INT TERM HUP
stty -echo -icanon min 1 time 0 || exit 1
printf '%s' "$1" >&0
line=
while IFS= read -r -n1 c; do
  case $c in
    '') break ;;
    $'\\x04') [ -z "$line" ] && exit 3; break ;;
    $'\\x7f'|$'\\b') [ -n "$line" ] && { line=\${line%?}; printf '\\b \\b' >&0; } ;;
    $'\\e') IFS= read -r -n1 c
      [ "$c" = '[' ] && while IFS= read -r -n1 c; do case $c in [@-~]) break ;; esac; done ;;
    [[:cntrl:]]) ;;
    *) line+=$c; printf '*' >&0 ;;
  esac
done
printf '%s' "$line"`;

export function openTty(): Terminal {
  let fd: number;
  try {
    fd = openSync("/dev/tty", "r+");
  } catch {
    throw new TarsError(
      "this command reads only from your terminal (/dev/tty), and this process has none. Run it in your own terminal.",
    );
  }
  const write = (text: string) => {
    let rest = new TextEncoder().encode(text);
    while (rest.length > 0) rest = rest.subarray(writeSync(fd, rest));
  };
  const read = (argv: readonly string[], failure: string) => {
    // With a listener the signal no longer kills tars, so the child restores the terminal while
    // tars still holds its foreground.
    const keepAlive = () => {};
    process.on("SIGINT", keepAlive);
    try {
      const child = Bun.spawnSync([...argv], { stdin: fd, stdout: "pipe", stderr: "ignore" });
      if (child.exitCode === 0) return child.stdout.toString();
      if (child.exitCode === 3) return undefined;
      throw new TarsError(
        child.exitCode === 130 || child.signalCode === "SIGINT" ? "cancelled" : failure,
      );
    } finally {
      process.off("SIGINT", keepAlive);
    }
  };
  return {
    write,
    ask: async (prompt) => {
      const line = read(["bash", "-c", LINE_READ, "bash", prompt], "cannot read from the terminal");
      if (line === undefined) write("\n");
      return line;
    },
    askHidden: async (prompt) => {
      try {
        return read(
          ["bash", "-c", HIDDEN_READ, "bash", prompt],
          "cannot turn off the terminal's echo",
        );
      } finally {
        write("\n");
      }
    },
    close: () => closeSync(fd),
  };
}
