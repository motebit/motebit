/**
 * origin/main's display-strip functions, copied verbatim (main @ 97f1b96c4,
 * packages/ai-core/src/core.ts) as the differential oracle for
 * `display-strip-differential.test.ts`. Never edit to match the branch —
 * the point is that the branch must never show LESS than this did.
 */
/* eslint-disable */
export function mainStripTags(text: string): string {
  return text
    .replace(/<memory\s+[^>]*>[\s\S]*?<\/memory>/g, "")
    .replace(/<thinking>[\s\S]*?<\/thinking>/g, "")
    .replace(/<state\s+[^>]*\/>/g, "")
    .replace(/<narration\s*>[\s\S]*?<\/narration\s*>/g, "")
    .replace(/\[EXTERNAL_DATA[^\]]*\][\s\S]*?\[\/EXTERNAL_DATA\]/g, "")
    .replace(/\[MEMORY_DATA\][\s\S]*?\[\/MEMORY_DATA\]/g, "")
    .replace(/\[EXTERNAL_DATA[^\]]*\]/g, "")
    .replace(/\[\/EXTERNAL_DATA\]/g, "")
    .replace(/\[MEMORY_DATA\]/g, "")
    .replace(/\[\/MEMORY_DATA\]/g, "")
    .replace(/\*[^*]+\*/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function mainStripInternalTags(text: string): string {
  return (
    text
      // Completed tag/marker pairs
      .replace(/<state\s+[^>]*\/>/g, "")
      .replace(/<thinking>[\s\S]*?<\/thinking>/g, "")
      .replace(/<memory\s+[^>]*>[\s\S]*?<\/memory>/g, "")
      .replace(/\[EXTERNAL_DATA[^\]]*\][\s\S]*?\[\/EXTERNAL_DATA\]/g, "")
      .replace(/\[MEMORY_DATA\][\s\S]*?\[\/MEMORY_DATA\]/g, "")
      // Partial fragments — opener or closer alone, mid-stream
      .replace(/\[EXTERNAL_DATA[^\]]*\]/g, "")
      .replace(/\[\/EXTERNAL_DATA\]/g, "")
      .replace(/\[MEMORY_DATA\]/g, "")
      .replace(/\[\/MEMORY_DATA\]/g, "")
      .replace(/<(?:state|thinking|memory)[^>]*$/g, "")
  );
}

/**
 * Strip internal tags plus the creature's `*action*` asterisk syntax and
 * normalize whitespace. Used by plain-text chat surfaces (desktop) that
 * render `bubble.textContent` directly — markdown surfaces (web) use
 * `stripInternalTags` alone because their `*italic*` asterisks are
 * rendered by the markdown pass, not stripped.
 */
export function mainStripPartialActionTag(text: string): string {
  return mainStripInternalTags(text)
    .replace(/\*[^*]+\*/g, "")
    .replace(/\*[^*]*$/, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\s{2,}/g, " ")
    .trim();
}
