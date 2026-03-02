use crate::grid_scrollback::{blank_cell, make_row, Cell};

#[derive(Clone)]
pub struct ScreenFrame {
    pub cols: usize,
    pub rows: usize,
    pub lines: Vec<Vec<Cell>>,
    pub cursor_row: usize,
    pub cursor_col: usize,
    pub cursor_visible: bool,
}

#[derive(Default)]
pub struct Screen;

impl Screen {
    pub fn new() -> Self {
        Self
    }

    pub fn compose(
        &self,
        source_lines: &[Vec<Cell>],
        cols: usize,
        rows: usize,
        cursor_row: usize,
        cursor_col: usize,
        cursor_visible: bool,
    ) -> ScreenFrame {
        let mut lines = source_lines.to_vec();

        if lines.len() < rows {
            lines.extend((0..(rows - lines.len())).map(|_| make_row(cols)));
        }

        for row in &mut lines {
            if row.len() < cols {
                row.extend((0..(cols - row.len())).map(|_| blank_cell()));
            } else if row.len() > cols {
                row.truncate(cols);
            }
        }

        if lines.len() > rows {
            lines.truncate(rows);
        }

        ScreenFrame {
            cols,
            rows,
            lines,
            cursor_row: cursor_row.min(rows.saturating_sub(1)),
            cursor_col: cursor_col.min(cols.saturating_sub(1)),
            cursor_visible,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::Screen;
    use crate::grid_scrollback::make_row;

    #[test]
    fn composes_and_clamps_cursor_metadata() {
        let screen = Screen::new();
        let frame = screen.compose(&[make_row(10)], 10, 6, 20, 20, true);

        assert_eq!(frame.lines.len(), 6);
        assert_eq!(frame.cursor_row, 5);
        assert_eq!(frame.cursor_col, 9);
        assert!(frame.cursor_visible);
    }
}
