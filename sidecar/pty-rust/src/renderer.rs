use crate::grid_scrollback::{applied_style, segment_json, style_key};
use crate::screen::ScreenFrame;
use serde_json::{json, Value};

#[derive(Default)]
pub struct Renderer;

impl Renderer {
    pub fn new() -> Self {
        Self
    }

    pub fn render_styled_frame(&self, screen: &ScreenFrame) -> Value {
        let mut line_values = Vec::with_capacity(screen.rows);

        for row in &screen.lines {
            let mut end = row.len();
            while end > 0 && row[end - 1].text == " " {
                end -= 1;
            }

            if end == 0 {
                line_values.push(json!({ "segments": [ { "text": "" } ] }));
                continue;
            }

            let mut segments = Vec::new();
            let mut current_text = String::new();
            let mut current_style = applied_style(&row[0].style);

            for cell in row.iter().take(end) {
                let style = applied_style(&cell.style);
                if style_key(&style) != style_key(&current_style) {
                    segments.push(segment_json(&current_text, &current_style));
                    current_text.clear();
                    current_style = style;
                }
                current_text.push_str(&cell.text);
            }

            segments.push(segment_json(&current_text, &current_style));
            line_values.push(json!({ "segments": segments }));
        }

        json!({
            "cols": screen.cols,
            "rows": screen.rows,
            "lines": line_values,
            "cursorRow": screen.cursor_row,
            "cursorCol": screen.cursor_col,
            "cursorVisible": screen.cursor_visible,
        })
    }

    #[allow(dead_code)]
    pub fn render_patch(&self, previous: &ScreenFrame, next: &ScreenFrame) -> Option<Value> {
        let max_rows = previous.rows.max(next.rows);
        let mut changed_lines = Vec::new();

        for row in 0..max_rows {
            let prev = previous.lines.get(row);
            let curr = next.lines.get(row);
            if prev == curr {
                continue;
            }

            let rendered = if row < next.lines.len() {
                let mut single_row = next.clone();
                single_row.lines = vec![next.lines[row].clone()];
                single_row.rows = 1;
                self.render_styled_frame(&single_row)["lines"][0].clone()
            } else {
                json!({ "segments": [ { "text": "" } ] })
            };

            changed_lines.push(json!({ "row": row, "line": rendered }));
        }

        let cursor_changed = previous.cursor_row != next.cursor_row
            || previous.cursor_col != next.cursor_col
            || previous.cursor_visible != next.cursor_visible;

        let size_changed = previous.cols != next.cols || previous.rows != next.rows;

        if changed_lines.is_empty() && !cursor_changed && !size_changed {
            return None;
        }

        Some(json!({
            "cols": next.cols,
            "rows": next.rows,
            "changedLines": changed_lines,
            "cursorRow": next.cursor_row,
            "cursorCol": next.cursor_col,
            "cursorVisible": next.cursor_visible,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::Renderer;
    use crate::grid_scrollback::{blank_cell, Cell, CellStyle};
    use crate::screen::ScreenFrame;
    use std::time::Instant;

    fn cell(text: &str) -> Cell {
        Cell {
            text: text.to_string(),
            style: CellStyle::default(),
        }
    }

    fn screen_with_text(text: &str) -> ScreenFrame {
        let mut row = vec![blank_cell(); 20];
        for (idx, ch) in text.chars().enumerate() {
            if idx >= row.len() {
                break;
            }
            row[idx] = cell(&ch.to_string());
        }
        ScreenFrame {
            cols: 20,
            rows: 6,
            lines: vec![
                row,
                vec![blank_cell(); 20],
                vec![blank_cell(); 20],
                vec![blank_cell(); 20],
                vec![blank_cell(); 20],
                vec![blank_cell(); 20],
            ],
            cursor_row: 0,
            cursor_col: text.chars().count().min(19),
            cursor_visible: true,
        }
    }

    fn dense_screen(cols: usize, rows: usize) -> ScreenFrame {
        let mut lines = Vec::with_capacity(rows);
        for row in 0..rows {
            let mut line = vec![blank_cell(); cols];
            for (col, item) in line.iter_mut().enumerate().take(cols) {
                let ch = match (row + col) % 4 {
                    0 => "A",
                    1 => "B",
                    2 => "C",
                    _ => "D",
                };
                *item = Cell {
                    text: ch.to_string(),
                    style: CellStyle {
                        bold: (row + col) % 3 == 0,
                        italic: (row + col) % 5 == 0,
                        underline: (row + col) % 7 == 0,
                        fg: Some("#ffffff".to_string()),
                        bg: Some("#000000".to_string()),
                        inverse: false,
                    },
                };
            }
            lines.push(line);
        }

        ScreenFrame {
            cols,
            rows,
            lines,
            cursor_row: rows.saturating_sub(1),
            cursor_col: cols.saturating_sub(1),
            cursor_visible: true,
        }
    }

    #[test]
    fn renders_deterministic_frame_for_same_input() {
        let renderer = Renderer::new();
        let screen = screen_with_text("hello");

        let a = renderer.render_styled_frame(&screen);
        let b = renderer.render_styled_frame(&screen);
        assert_eq!(a, b);
    }

    #[test]
    fn emits_no_patch_when_state_unchanged() {
        let renderer = Renderer::new();
        let previous = screen_with_text("hello");
        let next = screen_with_text("hello");

        assert!(renderer.render_patch(&previous, &next).is_none());
    }

    #[test]
    fn emits_changed_rows_when_content_changes() {
        let renderer = Renderer::new();
        let previous = screen_with_text("hello");
        let next = screen_with_text("hallo");

        let patch = renderer
            .render_patch(&previous, &next)
            .expect("patch should be produced");

        let changed = patch["changedLines"]
            .as_array()
            .expect("changed lines should be array");
        assert_eq!(changed.len(), 1);
        assert_eq!(changed[0]["row"].as_u64(), Some(0));
    }

    #[test]
    fn keeps_frame_generation_cost_within_budget() {
        let renderer = Renderer::new();
        let screen = dense_screen(120, 40);

        let started = Instant::now();
        for _ in 0..20 {
            let _ = renderer.render_styled_frame(&screen);
        }
        let elapsed_ms = started.elapsed().as_millis();

        assert!(
            elapsed_ms <= 1_500,
            "frame generation budget exceeded: {}ms",
            elapsed_ms
        );
    }
}
