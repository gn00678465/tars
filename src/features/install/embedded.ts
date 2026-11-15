/** One skill file, with its path relative to the skills dir. */
export interface EmbeddedFile {
  readonly path: string;
  readonly bytes: Uint8Array;
}

const PREFIX = "tars-skills/";

/** Parses the files `bun run build` embeds; a binary run from source has none. */
export async function skillsFromBundle(
  blobs: ReadonlyArray<Blob & { readonly name?: string }>,
): Promise<EmbeddedFile[]> {
  const files: EmbeddedFile[] = [];
  for (const blob of blobs) {
    if (!blob.name?.startsWith(PREFIX)) continue;
    // --asset-naming '[name].[ext]' names an extension-less file such as LICENSE "LICENSE.".
    const path = blob.name.slice(PREFIX.length).replace(/\.$/, "");
    files.push({ path, bytes: new Uint8Array(await blob.arrayBuffer()) });
  }
  return files;
}
