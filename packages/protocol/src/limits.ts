export const PROTOCOL_VERSION = 1;
/** One message; the DO, the local end and the page all take it from here. */
export const MESSAGE_BYTES = 262_144;
/**
 * One frame on the link connection: a message wrapped with its connection, or an open frame with
 * its JWT. A browser message at MESSAGE_BYTES still fits once the DO wraps it.
 */
export const FRAME_BYTES = MESSAGE_BYTES + 16_384;
export const SNAPSHOT_BYTES = 200_000;
export const SNAPSHOT_ITEMS = 50;
/** turn.submit's text. */
export const TEXT_BYTES = 100_000;
/** The text of one item sent out. */
export const ITEM_TEXT_BYTES = 65_536;
/** A tool's input or output. */
export const TOOL_TEXT_BYTES = 16_384;
/** A snapshot's running text: only its tail. */
export const RUNNING_TEXT_BYTES = 65_536;
export const DELTA_BYTES = 16_384;
export const ID_CHARS = 64;
export const ARGV_ITEMS = 64;
export const ARGV_CHARS = 4_096;

/** The skills status lists: at most this many, each description cut to SKILL_TEXT characters. */
export const SKILLS = 200;
export const SKILL_TEXT = 300;
/** The models models.result lists. */
export const MODELS = 200;
/** A model's effort levels in models.result, and one level's name. */
export const EFFORT_LEVELS = 8;
export const EFFORT_NAME = 16;
/** turn.submit's keepLast: the turns a continuation carries at most. */
export const KEEP_LAST = 1_000;
