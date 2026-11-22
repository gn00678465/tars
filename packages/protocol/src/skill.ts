/**
 * The user message `/<skill> [content]` sends, from the terminal's tars chat and from the web
 * page alike: one wording, so the model sees the same request from both.
 */
export function skillInvocationText(name: string, content: string): string {
  const head = `請用 skill「${name}」處理下面的內容。先用 skill_load 讀它。`;
  return content === "" ? head : `${head}\n\n${content}`;
}
