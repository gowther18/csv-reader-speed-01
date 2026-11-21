// Fast drop-in for make.fun's csv-reader 1.0.0.
//
// Same answers as csv-reader 1.0.0 on every input, much less CPU: the reference
// walks the text one character at a time and builds every field by string
// concatenation. This reader instead jumps between delimiters with native
// indexOf scans and slices whole fields out of the text, only falling back to
// a character-at-a-time walk for the rare broken pieces (stray CRs, doubled
// quotes, quoted newlines, quote junk, unterminated quotes).
//
// The one scan that must stay bounded: a stray CR is rare (about 1 in 250
// records), so a plain indexOf('\r') from a field start would scan kilobytes
// of unrelated text looking for the next one. Instead the positions of every
// CR in the case are collected once (one native pass) and walked with a
// pointer that only moves forward, so each field's CR check is O(1).

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const n = text.length;
  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (text.charCodeAt(0) === 0xfeff) pos = 1;

  // Every CR position in the text, in order (one native pass per case).
  const crs = [];
  {
    let at = text.indexOf('\r');
    while (at !== -1) {
      crs.push(at);
      at = text.indexOf('\r', at + 1);
    }
  }
  let crPtr = 0; // first CR at or after pos
  const advanceCr = () => {
    while (crPtr < crs.length && crs[crPtr] < pos) crPtr++;
  };

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  const error = (code) => {
    errors.push({ code, line: recordLine, row: recordRow });
  };

  // Character-at-a-time unquoted read, exactly as the reference does it:
  // a CR not followed by LF is dropped (stray_cr). `value` is the field so
  // far; returns {value, ended} with ended 0 = comma, 1 = line break, 2 = end.
  // `added` counts the characters kept (a dropped stray CR does not count).
  function readUnquotedSlow(value) {
    let added = 0;
    let ended;
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 44) {
        pos += 1;
        ended = 0;
        return { value, ended, added };
      }
      if (c === 10) {
        pos += 1;
        line += 1;
        ended = 1;
        return { value, ended, added };
      }
      if (c === 13) {
        if (text.charCodeAt(pos + 1) === 10) {
          pos += 2;
          line += 1;
          ended = 1;
          return { value, ended, added };
        }
        error('stray_cr');
        pos += 1;
        continue;
      }
      value += text[pos];
      added += 1;
      pos += 1;
    }
    return { value, ended: 2, added };
  }

  // Character-at-a-time quoted read, exactly as the reference does it.
  // Returns {value, ended} with the same ended codes as readUnquotedSlow.
  function readQuotedSlow() {
    const open = pos;
    const openLine = line;
    let value = '';
    pos += 1;
    let closed = false;
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 34) {
        if (text.charCodeAt(pos + 1) === 34) {
          value += '"';
          pos += 2;
          continue;
        }
        pos += 1;
        closed = true;
        break;
      }
      if (c === 13) {
        // CRLF and a lone CR inside quotes are each one LF.
        value += '\n';
        line += 1;
        pos += text.charCodeAt(pos + 1) === 10 ? 2 : 1;
        continue;
      }
      if (c === 10) line += 1;
      value += text[pos];
      pos += 1;
    }
    if (!closed) {
      // The quote never closes: it is a literal character, and the text after
      // it is read again as unquoted.
      pos = open + 1;
      line = openLine;
      error('unterminated_quote');
      return readUnquotedSlow('"');
    }
    if (pos >= n) return { value, ended: 2 };
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      return { value, ended: 0 };
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      return { value, ended: 1 };
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      return { value, ended: 1 };
    }
    // What follows the closing quote is appended as it stands, up to the next
    // comma or line break.
    const junk = readUnquotedSlow(value);
    if (junk.added > 0) error('quote_junk');
    return junk;
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let ended;
    let quoted = false;
    do {
      quoted = text.charCodeAt(pos) === 34;
      let value;
      if (quoted) {
        // Quoted field: find its closing quote.
        const close = text.indexOf('"', pos + 1);
        if (close === -1 || text.charCodeAt(close + 1) === 34) {
          // Never closes, or a doubled quote inside: walk it slowly.
          const f = readQuotedSlow();
          value = f.value;
          ended = f.ended;
        } else {
          // Fast only when the quoted span holds no line break or CR: a
          // newline or CR inside needs line counting and CR-to-LF rewrites.
          advanceCr();
          const nl = text.indexOf('\n', pos + 1);
          if ((nl !== -1 && nl < close) || (crPtr < crs.length && crs[crPtr] < close)) {
            const f = readQuotedSlow();
            value = f.value;
            ended = f.ended;
          } else {
            value = text.slice(pos + 1, close);
            if (close + 1 >= n) {
              pos = n;
              ended = 2;
            } else {
              const t = text.charCodeAt(close + 1);
              if (t === 44) {
                pos = close + 2;
                ended = 0;
              } else if (t === 10) {
                pos = close + 2;
                line += 1;
                ended = 1;
              } else if (t === 13 && text.charCodeAt(close + 2) === 10) {
                pos = close + 3;
                line += 1;
                ended = 1;
              } else {
                // Junk after the closing quote: walk it slowly.
                pos = close + 1;
                const junk = readUnquotedSlow(value);
                if (junk.added > 0) error('quote_junk');
                value = junk.value;
                ended = junk.ended;
              }
            }
          }
        }
      } else {
        // Unquoted field: the next comma and the next LF bound it.
        const ci = text.indexOf(',', pos);
        const ni = text.indexOf('\n', pos);
        let end;
        if (ci !== -1 && (ni === -1 || ci < ni)) {
          end = ci;
          ended = 0;
        } else if (ni !== -1) {
          end = ni;
          ended = 1;
        } else {
          end = n;
          ended = 2;
        }
        // A CR inside the field is a stray CR (the CR of a CRLF terminator
        // sits at end - 1 and is not one). Slow path when one is present.
        advanceCr();
        const cr = crPtr < crs.length ? crs[crPtr] : -1;
        if (cr !== -1 && cr < end && !(ended === 1 && cr === end - 1)) {
          const f = readUnquotedSlow('');
          value = f.value;
          ended = f.ended;
        } else {
          value = ended === 1 && end > pos && text.charCodeAt(end - 1) === 13
            ? text.slice(pos, end - 1)
            : text.slice(pos, end);
          pos = ended === 0 ? end + 1 : ended === 1 ? end + 1 : n;
          if (ended === 1) line += 1;
        }
      }
      fields.push(value);
    } while (ended === 0);

    // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
