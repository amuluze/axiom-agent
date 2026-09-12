//! Fuzzy matching helpers for workspace edits.
//!
//! Ported from pi's `edit-diff.ts`. When a model's `oldText` does not match the
//! file exactly (tabs vs spaces, smart quotes, Unicode dashes, NFKC differences),
//! we normalize both sides and retry before rejecting. Unmatched lines retain
//! their original bytes by aligning replacements back onto the original content.

use unicode_normalization::UnicodeNormalization;

/// A single replacement resolved against a (possibly normalized) match space.
#[derive(Clone, Copy, Debug)]
pub(crate) struct TextReplacement {
    pub match_index: usize,
    pub match_length: usize,
}

/// Result of locating `old_text` inside `content`.
#[derive(Clone, Copy, Debug)]
pub(crate) struct FuzzyMatchResult {
    pub index: usize,
    pub match_length: usize,
    pub used_fuzzy: bool,
}

/// Normalize text for fuzzy matching, mirroring pi's `normalizeForFuzzyMatch`.
///
/// Order matters and matches pi `edit-diff.ts` lines 33-54:
/// 1. NFKC Unicode normalization
/// 2. Per-line `trim_end` (leading whitespace preserved)
/// 3. Smart single quotes -> `'`
/// 4. Smart double quotes -> `"`
/// 5. Dashes/hyphens -> `-`
/// 6. Special spaces -> regular space
pub(crate) fn normalize_for_fuzzy_match(text: &str) -> String {
    // 1. NFKC
    let nfkc: String = text.nfkc().collect();
    // 2. Per-line trim_end, preserving line structure.
    let trimmed = nfkc
        .split('\n')
        .map(|line| line.trim_end())
        .collect::<Vec<_>>()
        .join("\n");
    // 3-6. Character-class replacements.
    trimmed
        .chars()
        .map(|c| match c {
            '\u{2018}' | '\u{2019}' | '\u{201A}' | '\u{201B}' => '\'',
            '\u{201C}' | '\u{201D}' | '\u{201E}' | '\u{201F}' => '"',
            '\u{2010}' | '\u{2011}' | '\u{2012}' | '\u{2013}' | '\u{2014}' | '\u{2015}'
            | '\u{2212}' => '-',
            '\u{00A0}' | '\u{2002}' | '\u{2003}' | '\u{2004}' | '\u{2005}' | '\u{2006}'
            | '\u{2007}' | '\u{2008}' | '\u{2009}' | '\u{200A}' | '\u{202F}' | '\u{205F}'
            | '\u{3000}' => ' ',
            other => other,
        })
        .collect()
}

/// Try an exact match first, then a normalized (fuzzy) match.
///
/// Returns the match offset/length within the match space (original content when
/// exact, normalized content when fuzzy) plus whether fuzzy was used.
pub(crate) fn fuzzy_find(content: &str, old_text: &str) -> Option<FuzzyMatchResult> {
    if let Some(index) = content.find(old_text) {
        return Some(FuzzyMatchResult {
            index,
            match_length: old_text.len(),
            used_fuzzy: false,
        });
    }
    let fuzzy_content = normalize_for_fuzzy_match(content);
    let fuzzy_old_text = normalize_for_fuzzy_match(old_text);
    let index = fuzzy_content.find(&fuzzy_old_text)?;
    Some(FuzzyMatchResult {
        index,
        match_length: fuzzy_old_text.len(),
        used_fuzzy: true,
    })
}

/// Count occurrences of `old_text` in the normalized match space.
pub(crate) fn count_occurrences_normalized(content: &str, old_text: &str) -> usize {
    let fuzzy_content = normalize_for_fuzzy_match(content);
    let fuzzy_old_text = normalize_for_fuzzy_match(old_text);
    if fuzzy_old_text.is_empty() {
        return 0;
    }
    fuzzy_content.matches(&fuzzy_old_text).count()
}

/// Split content into lines, each keeping its trailing newline (the final line
/// has no newline when the content does not end in `\n`). Mirrors pi's
/// `splitLinesWithEndings`.
fn split_lines_with_endings(content: &str) -> Vec<&str> {
    if content.is_empty() {
        return Vec::new();
    }
    let mut lines = Vec::new();
    let mut start = 0;
    let bytes = content.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\n' {
            // include the newline
            lines.push(&content[start..=i]);
            start = i + 1;
        }
        i += 1;
    }
    if start < bytes.len() {
        lines.push(&content[start..]);
    }
    lines
}

/// Byte spans `[start, end)` of each line produced by `split_lines_with_endings`.
fn line_spans(content: &str) -> Vec<(usize, usize)> {
    let mut spans = Vec::new();
    let bytes = content.as_bytes();
    let mut start = 0;
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\n' {
            spans.push((start, i + 1));
            start = i + 1;
        }
        i += 1;
    }
    if start < bytes.len() {
        spans.push((start, bytes.len()));
    }
    spans
}

/// Range of lines `[start_line, end_line)` (end exclusive) touched by a
/// replacement whose span is `[match_index, match_index + match_length)`.
fn replacement_line_range(
    lines: &[(usize, usize)],
    replacement: TextReplacement,
) -> Option<(usize, usize)> {
    let end_byte = replacement
        .match_index
        .saturating_add(replacement.match_length);
    // First line whose span contains the replacement start.
    let start_line = lines.iter().position(|(s, e)| {
        replacement.match_index >= *s && replacement.match_index < *e
    })?;
    // Advance end_line while lines fall before the replacement end.
    let mut end_line = start_line;
    while end_line < lines.len() && lines[end_line].1 < end_byte {
        end_line += 1;
    }
    Some((start_line, end_line + 1))
}

/// Apply replacements to `content` in reverse order (highest index first) so
/// earlier offsets stay valid. `offset` is subtracted from each `match_index`
/// (used when applying to a sliced sub-range).
fn apply_replacements(content: &str, replacements: &[TextReplacement], new_texts: &[String], offset: usize) -> String {
    let mut result = content.to_string();
    // Iterate from the end backwards.
    let mut order: Vec<usize> = (0..replacements.len()).collect();
    order.sort_by(|&a, &b| replacements[b].match_index.cmp(&replacements[a].match_index));
    for &i in &order {
        let r = replacements[i];
        let start = r.match_index.saturating_sub(offset);
        let end = start + r.match_length;
        if end > result.len() {
            continue;
        }
        result.replace_range(start..end, &new_texts[i]);
    }
    result
}

/// Apply replacements while preserving unchanged lines verbatim from
/// `original`.
///
/// Ported from pi `applyReplacementsPreservingUnchangedLines`
/// (`edit-diff.ts:131-172`). Only the line blocks a replacement touches are
/// rewritten from the normalized `base`; all other lines are copied byte-for-byte
/// from `original` (which keeps the original whitespace, quotes, etc.).
///
/// `original` is the LF-normalized original content; `base` is the match space
/// (normalized content when fuzzy, otherwise equal to `original`). The two must
/// have the same line count.
pub(crate) fn apply_replacements_preserving_lines(
    original: &str,
    base: &str,
    replacements: &[TextReplacement],
    new_texts: &[String],
) -> Result<String, String> {
    let original_lines = split_lines_with_endings(original);
    let base_lines = line_spans(base);
    if original_lines.len() != base_lines.len() {
        return Err(
            "cannot preserve unchanged lines because the base content has a different line count"
                .to_string(),
        );
    }

    // Group replacements by overlapping line ranges, sorted by match_index.
    let mut indexed: Vec<usize> = (0..replacements.len()).collect();
    indexed.sort_by_key(|&i| replacements[i].match_index);

    #[derive(Clone)]
    struct Group {
        start_line: usize,
        end_line: usize,
        indices: Vec<usize>,
    }

    let mut groups: Vec<Group> = Vec::new();
    for &i in &indexed {
        let r = replacements[i];
        let (start_line, end_line) = match replacement_line_range(&base_lines, r) {
            Some(range) => range,
            None => return Err("replacement range is outside the base content".to_string()),
        };
        if let Some(last) = groups.last_mut() {
            if start_line < last.end_line {
                // Overlaps the current group: merge.
                last.end_line = last.end_line.max(end_line);
                last.indices.push(i);
                continue;
            }
        }
        groups.push(Group {
            start_line,
            end_line,
            indices: vec![i],
        });
    }

    let mut result = String::new();
    let mut original_line_index = 0usize;
    for group in &groups {
        // Copy untouched original lines up to this group.
        if group.start_line > original_line_index {
            result.push_str(
                &original_lines[original_line_index..group.start_line]
                    .iter()
                    .copied()
                    .collect::<String>(),
            );
        }
        // Rewrite the touched block from base, applying only this group's replacements.
        let group_start_byte = base_lines[group.start_line].0;
        let group_end_byte = base_lines[group.end_line.saturating_sub(1)].1;
        let slice = &base[group_start_byte..group_end_byte];
        let group_replacements: Vec<TextReplacement> = group.indices.iter().map(|&i| replacements[i]).collect();
        let group_new_texts: Vec<String> = group.indices.iter().map(|&i| new_texts[i].clone()).collect();
        let rewritten = apply_replacements(slice, &group_replacements, &group_new_texts, group_start_byte);
        result.push_str(&rewritten);
        original_line_index = group.end_line;
    }
    // Copy any trailing untouched original lines.
    if original_line_index < original_lines.len() {
        result.push_str(
            &original_lines[original_line_index..]
                .iter()
                .copied()
                .collect::<String>(),
        );
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_smart_quotes_dashes_and_spaces() {
        let normalized = normalize_for_fuzzy_match("“hello” ‘world’ — test\u{00A0}end");
        assert_eq!(normalized, "\"hello\" 'world' - test end");
    }

    #[test]
    fn normalizes_nfkc_and_trailing_whitespace() {
        // NFKC folds ligatures and fullwidth forms; trailing spaces trimmed.
        let normalized = normalize_for_fuzzy_match("line one   \nline two");
        assert_eq!(normalized, "line one\nline two");
    }

    #[test]
    fn exact_match_takes_precedence() {
        let result = fuzzy_find("hello world", "world").unwrap();
        assert_eq!(result.index, 6);
        assert_eq!(result.match_length, 5);
        assert!(!result.used_fuzzy);
    }

    #[test]
    fn fuzzy_match_falls_back_when_exact_fails() {
        // File uses smart quotes, model provided straight quotes.
        let content = "const s = \u{201C}hello\u{201D}";
        let result = fuzzy_find(content, "\"hello\"").unwrap();
        assert!(result.used_fuzzy);
        assert_eq!(result.match_length, "\"hello\"".len());
    }

    #[test]
    fn count_occurrences_works_in_normalized_space() {
        // Two smart-quote occurrences normalize to two straight-quote matches.
        let content = "\u{201C}a\u{201D} \u{201C}a\u{201D}";
        assert_eq!(count_occurrences_normalized(content, "\"a\""), 2);
        assert_eq!(count_occurrences_normalized(content, "\"b\""), 0);
    }

    #[test]
    fn apply_preserves_unchanged_lines_verbatim() {
        // Original keeps smart quotes on line 2; replacement targets line 1 only.
        let original = "target line\nkeep \u{201C}smart\u{201D} quotes";
        // Base is the normalized form (smart quotes -> straight) with same line count.
        let base = normalize_for_fuzzy_match(original);
        assert_eq!(base, "target line\nkeep \"smart\" quotes");
        // Replace "target" with "updated" in the base.
        let idx = base.find("target").unwrap();
        let replacements = vec![TextReplacement {
            match_index: idx,
            match_length: "target".len(),
        }];
        let new_texts = vec!["updated".to_string()];
        let result =
            apply_replacements_preserving_lines(original, &base, &replacements, &new_texts).unwrap();
        // Line 1 changed; line 2 retains original smart quotes.
        assert_eq!(result, "updated line\nkeep \u{201C}smart\u{201D} quotes");
    }

    #[test]
    fn apply_rejects_mismatched_line_count() {
        let original = "one line";
        let base = "one line\ntwo lines";
        let replacements = vec![TextReplacement {
            match_index: 0,
            match_length: 3,
        }];
        let new_texts = vec!["1".to_string()];
        let result = apply_replacements_preserving_lines(original, base, &replacements, &new_texts);
        assert!(result.is_err());
    }

    #[test]
    fn multiple_non_overlapping_replacements_each_preserve_their_blocks() {
        let original = "a one\nb two\nc three";
        let base = original; // exact match space
        let r0 = TextReplacement {
            match_index: base.find("one").unwrap(),
            match_length: 3,
        };
        let r1 = TextReplacement {
            match_index: base.find("three").unwrap(),
            match_length: 5,
        };
        let replacements = vec![r0, r1];
        let new_texts = vec!["ONE".to_string(), "THREE".to_string()];
        let result =
            apply_replacements_preserving_lines(original, base, &replacements, &new_texts).unwrap();
        assert_eq!(result, "a ONE\nb two\nc THREE");
    }
}
