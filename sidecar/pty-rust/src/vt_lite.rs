pub use crate::terminal_pane::build_styled_frame;

#[cfg(test)]
mod tests {
    use super::build_styled_frame;
    use crate::terminal_pane::TerminalPane;
    use serde_json::Value;

    fn line_text(frame: &Value, row: usize) -> String {
        frame["lines"][row]["segments"]
            .as_array()
            .map(|segments| {
                segments
                    .iter()
                    .filter_map(|seg| seg["text"].as_str())
                    .collect::<String>()
            })
            .unwrap_or_default()
    }

    #[test]
    fn renders_cursor_rewrites() {
        let frame = build_styled_frame("hello\rbye", 20, 6);
        let first = line_text(&frame, 0);
        assert!(first.starts_with("byelo"));
    }

    #[test]
    fn handles_clear_screen_and_home() {
        let frame = build_styled_frame("old\x1b[2J\x1b[Hnew", 20, 6);
        let first = line_text(&frame, 0);
        assert!(first.starts_with("new"));
        assert!(!first.contains("old"));
    }

    #[test]
    fn keeps_primary_buffer_after_alt_screen_leave() {
        let frame = build_styled_frame("primary\x1b[?1049halt\x1b[?1049l", 20, 6);
        let joined = (0..6)
            .map(|idx| line_text(&frame, idx))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(joined.contains("primary"));
        assert!(!joined.contains("alt"));
    }

    #[test]
    fn emits_sgr_color_segments() {
        let frame = build_styled_frame("\x1b[31mred\x1b[0m normal", 20, 6);
        let red = frame["lines"][0]["segments"]
            .as_array()
            .and_then(|segments| {
                segments
                    .iter()
                    .find(|seg| seg["text"].as_str().unwrap_or("").contains("red"))
            });
        assert_eq!(
            red.and_then(|seg| seg.get("fg")).and_then(|v| v.as_str()),
            Some("#cd3131")
        );
    }

    #[test]
    fn supports_split_csi_sequence_across_feeds() {
        let mut pane = TerminalPane::new(20, 6);
        pane.feed("\x1b[31");
        pane.feed("mred");

        let frame = pane.frame();
        let red = frame["lines"][0]["segments"]
            .as_array()
            .and_then(|segments| {
                segments
                    .iter()
                    .find(|seg| seg["text"].as_str().unwrap_or("").contains("red"))
            });
        assert_eq!(
            red.and_then(|seg| seg.get("fg")).and_then(|v| v.as_str()),
            Some("#cd3131")
        );
    }

    #[test]
    fn supports_split_osc_sequence_across_feeds() {
        let mut pane = TerminalPane::new(20, 6);
        pane.feed("\x1b]0;window title");
        pane.feed("\u{0007}done");

        let frame = pane.frame();
        let first = line_text(&frame, 0);
        assert!(first.starts_with("done"));
    }

    #[test]
    fn supports_split_scs_sequence_across_feeds() {
        let mut pane = TerminalPane::new(20, 6);
        pane.feed("\x1b(");
        pane.feed("BOK");

        let frame = pane.frame();
        let first = line_text(&frame, 0);
        assert!(first.starts_with("OK"));
        assert!(!first.contains("BOK"));
    }

    #[test]
    fn supports_split_dcs_sequence_across_feeds() {
        let mut pane = TerminalPane::new(20, 6);
        pane.feed("\x1bPignored");
        pane.feed("-payload\x1b\\done");

        let frame = pane.frame();
        let first = line_text(&frame, 0);
        assert!(first.starts_with("done"));
        assert!(!first.contains("ignored"));
    }

    #[test]
    fn supports_split_apc_sequence_across_feeds() {
        let mut pane = TerminalPane::new(20, 6);
        pane.feed("\x1b_kitty");
        pane.feed("-query\x1b\\ok");

        let frame = pane.frame();
        let first = line_text(&frame, 0);
        assert!(first.starts_with("ok"));
        assert!(!first.contains("kitty"));
    }

    #[test]
    fn wraps_at_last_column_and_continues_on_next_line() {
        let frame = build_styled_frame("12345678901234567890X", 20, 6);
        assert_eq!(line_text(&frame, 0), "12345678901234567890");
        assert!(line_text(&frame, 1).starts_with('X'));
    }

    #[test]
    fn scroll_region_line_feed_affects_only_region() {
        let frame = build_styled_frame("r1\r\nr2\r\nr3\r\nr4\x1b[2;4r\x1b[4;1H\n", 20, 6);
        assert!(line_text(&frame, 0).starts_with("r1"));
        assert!(line_text(&frame, 1).starts_with("r3"));
        assert!(line_text(&frame, 2).starts_with("r4"));
        assert_eq!(line_text(&frame, 3), "");
    }

    #[test]
    fn reverse_index_at_scroll_top_scrolls_region_down() {
        let frame = build_styled_frame("r1\r\nr2\r\nr3\r\nr4\x1b[2;4r\x1b[2;1H\x1bM", 20, 6);
        assert!(line_text(&frame, 0).starts_with("r1"));
        assert_eq!(line_text(&frame, 1), "");
        assert!(line_text(&frame, 2).starts_with("r2"));
        assert!(line_text(&frame, 3).starts_with("r3"));
    }

    #[test]
    fn supports_csi_and_dec_save_restore_cursor() {
        let csi = build_styled_frame("abc\x1b[sZZ\x1b[uQ", 20, 6);
        assert!(line_text(&csi, 0).starts_with("abcQZ"));

        let dec = build_styled_frame("abc\x1b7ZZ\x1b8Q", 20, 6);
        assert!(line_text(&dec, 0).starts_with("abcQZ"));
    }

    #[test]
    fn supports_insert_delete_and_scroll_commands_in_region() {
        let inserted = build_styled_frame("a\r\nb\r\nc\r\nd\x1b[2;4r\x1b[3;1H\x1b[L", 20, 6);
        assert!(line_text(&inserted, 1).starts_with("b"));
        assert_eq!(line_text(&inserted, 2), "");
        assert!(line_text(&inserted, 3).starts_with("c"));

        let deleted = build_styled_frame("a\r\nb\r\nc\r\nd\x1b[2;4r\x1b[3;1H\x1b[M", 20, 6);
        assert!(line_text(&deleted, 1).starts_with("b"));
        assert!(line_text(&deleted, 2).starts_with("d"));
        assert_eq!(line_text(&deleted, 3), "");

        let scrolled_up = build_styled_frame("a\r\nb\r\nc\r\nd\x1b[2;4r\x1b[S", 20, 6);
        assert!(line_text(&scrolled_up, 1).starts_with("c"));
        assert!(line_text(&scrolled_up, 2).starts_with("d"));
        assert_eq!(line_text(&scrolled_up, 3), "");

        let scrolled_down = build_styled_frame("a\r\nb\r\nc\r\nd\x1b[2;4r\x1b[T", 20, 6);
        assert_eq!(line_text(&scrolled_down, 1), "");
        assert!(line_text(&scrolled_down, 2).starts_with("b"));
        assert!(line_text(&scrolled_down, 3).starts_with("c"));
    }

    #[test]
    fn tracks_cursor_visibility_through_alt_screen_transitions() {
        let mut pane = TerminalPane::new(20, 6);
        pane.feed("\x1b[?25l");
        assert_eq!(pane.frame()["cursorVisible"].as_bool(), Some(false));

        pane.feed("\x1b[?1049h");
        assert_eq!(pane.frame()["cursorVisible"].as_bool(), Some(true));

        pane.feed("\x1b[?1049l");
        assert_eq!(pane.frame()["cursorVisible"].as_bool(), Some(false));
    }

    #[test]
    fn supports_alt_screen_modes_47_and_1047() {
        let frame_47 = build_styled_frame("primary\x1b[?47halt\x1b[?47l", 20, 6);
        let joined_47 = (0..6)
            .map(|idx| line_text(&frame_47, idx))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(joined_47.contains("primary"));
        assert!(!joined_47.contains("alt"));

        let frame_1047 = build_styled_frame("primary\x1b[?1047halt\x1b[?1047l", 20, 6);
        let joined_1047 = (0..6)
            .map(|idx| line_text(&frame_1047, idx))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(joined_1047.contains("primary"));
        assert!(!joined_1047.contains("alt"));
    }

    #[test]
    fn tracks_wide_characters_without_cursor_corruption() {
        let mut pane = TerminalPane::new(20, 6);
        pane.feed("한글A");

        let frame = pane.frame();
        assert_eq!(frame["cursorRow"].as_u64(), Some(0));
        assert_eq!(frame["cursorCol"].as_u64(), Some(5));
        assert!(line_text(&frame, 0).contains("한글A"));
    }

    #[test]
    fn keeps_combining_mark_on_last_cell_before_wrap() {
        let mut pane = TerminalPane::new(20, 6);
        pane.feed("ABCDEFGHIJ0123456789");
        pane.feed("\u{0301}");
        pane.feed("X");

        let frame = pane.frame();
        assert_eq!(frame["cursorRow"].as_u64(), Some(1));
        assert_eq!(frame["cursorCol"].as_u64(), Some(1));
        assert!(line_text(&frame, 0).contains("9\u{0301}"));
        assert!(line_text(&frame, 1).starts_with('X'));
    }

    #[test]
    fn treats_zwj_emoji_cluster_as_single_glyph_cell_cluster() {
        let mut pane = TerminalPane::new(20, 6);
        pane.feed("👨\u{200d}💻A");

        let frame = pane.frame();
        assert_eq!(frame["cursorRow"].as_u64(), Some(0));
        assert_eq!(frame["cursorCol"].as_u64(), Some(3));
        assert!(line_text(&frame, 0).contains("👨\u{200d}💻A"));
    }
}
