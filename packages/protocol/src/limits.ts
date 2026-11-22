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

/**
 * The knowledge base (wiki.*). The page's own rules live in the local end's wiki/page.ts
 * LIMITS, which this package cannot import; a local test keeps the two equal.
 */
export const WIKI_TITLE = 80;
export const WIKI_ALIAS = 40;
export const WIKI_ALIASES = 10;
export const WIKI_SUMMARY = 3_000;
export const WIKI_ENTRY = 300;
export const WIKI_RELATED = 20;
/** A search's query, in characters, as `tars wiki search` takes it. */
export const WIKI_QUERY = 100;
/** The local end cuts these, so a hand-edited page still fits one message. */
export const WIKI_PAGES = 500;
export const WIKI_ENTRIES = 40;
export const WIKI_ENTRY_SOURCES = 8;
export const WIKI_CHANGELOG = 50;
export const WIKI_CHANGELOG_TEXT = 500;
export const WIKI_ERROR = 200;
/** Results per track in wiki.search.result. */
export const WIKI_RESULTS = 50;
export const WIKI_SNIPPET = 160;
export const WIKI_CONV_TITLE = 200;
/** Each side of a source turn, cut in the middle as sync cuts what the model reads. */
export const WIKI_TURN_TEXT_BYTES = 4_000;
export const WIKI_QUOTES = 5;
/** wiki.status's example queries: the first alias of the most recently updated pages. */
export const WIKI_EXAMPLES = 3;
export const WIKI_QUOTE = 200;
/** An error's or a failure's data: at most this many keys. */
export const DATA_KEYS = 16;
/** conv.compact's focus, in characters: the local end's summary prompt takes no more. */
export const COMPACT_FOCUS_CHARS = 500;
/** status's models whose prices need confirming. */
export const PRICE_WARNS = 50;
