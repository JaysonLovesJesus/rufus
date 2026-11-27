/**
 * The Speaker writes light markdown (**bold**, *italic* or _italic_, `code`).
 * Telegram shows it literally unless it is sent as HTML, and a voice call should never read it out.
 */

const CODE_SPAN = /`([^`\n]+)`/g;

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function inlineHtml(s: string): string {
  return escapeHtml(s)
    .replace(/\*\*([^*\n]+?)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^\w*])\*([^*\s][^*\n]*?)\*(?![\w*])/g, '$1<i>$2</i>')
    .replace(/(^|[^\w])_([^_\s][^_\n]*?)_(?!\w)/g, '$1<i>$2</i>');
}

/** Light markdown as Telegram HTML (parse_mode "HTML"); everything else is escaped, so it shows exactly as written. */
export function toTelegramHtml(text: string): string {
  let out = '';
  let last = 0;
  for (const m of text.matchAll(CODE_SPAN)) {
    out += inlineHtml(text.slice(last, m.index)) + `<code>${escapeHtml(m[1]!)}</code>`;
    last = m.index + m[0].length;
  }
  return out + inlineHtml(text.slice(last));
}

/** The same text with the markdown marks taken out, for speech and plain-text displays. */
export function stripMarkdown(text: string): string {
  return text
    .replace(CODE_SPAN, '$1')
    .replace(/\*\*([^*\n]+?)\*\*/g, '$1')
    .replace(/(^|[^\w*])\*([^*\s][^*\n]*?)\*(?![\w*])/g, '$1$2')
    .replace(/(^|[^\w])_([^_\s][^_\n]*?)_(?!\w)/g, '$1$2');
}
