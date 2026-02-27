use serde_json::{json, Map, Value};

#[derive(Clone, Default, PartialEq, Eq)]
struct CellStyle {
    fg: Option<String>,
    bg: Option<String>,
    bold: bool,
    italic: bool,
    underline: bool,
    inverse: bool,
}

#[derive(Clone)]
struct Cell {
    text: String,
    style: CellStyle,
}

#[derive(Clone)]
struct SavedScreen {
    lines: Vec<Vec<Cell>>,
    cursor_row: usize,
    cursor_col: usize,
    saved_row: usize,
    saved_col: usize,
    style: CellStyle,
    scroll_top: usize,
    scroll_bottom: usize,
    cursor_visible: bool,
}

struct VtLite {
    cols: usize,
    rows: usize,
    lines: Vec<Vec<Cell>>,
    cursor_row: usize,
    cursor_col: usize,
    saved_row: usize,
    saved_col: usize,
    style: CellStyle,
    scroll_top: usize,
    scroll_bottom: usize,
    wrap_pending: bool,
    cursor_visible: bool,
    saved_primary: Option<SavedScreen>,
}

pub fn build_styled_frame(buffer: &str, cols: u16, rows: u16) -> Value {
    let safe_cols = cols.clamp(20, 300) as usize;
    let safe_rows = rows.clamp(6, 200) as usize;
    let mut vt = VtLite::new(safe_cols, safe_rows);
    vt.feed(buffer);
    vt.into_frame()
}

impl VtLite {
    fn new(cols: usize, rows: usize) -> Self {
        Self {
            cols,
            rows,
            lines: vec![make_row(cols); rows],
            cursor_row: 0,
            cursor_col: 0,
            saved_row: 0,
            saved_col: 0,
            style: CellStyle::default(),
            scroll_top: 0,
            scroll_bottom: rows.saturating_sub(1),
            wrap_pending: false,
            cursor_visible: true,
            saved_primary: None,
        }
    }

    fn feed(&mut self, input: &str) {
        let chars = input.chars().collect::<Vec<_>>();
        let mut i = 0usize;

        while i < chars.len() {
            let ch = chars[i];
            if ch == '\x1b' {
                if i + 1 >= chars.len() {
                    break;
                }
                let next = chars[i + 1];

                if next == '[' {
                    let mut j = i + 2;
                    while j < chars.len() {
                        let code = chars[j] as u32;
                        if (0x40..=0x7e).contains(&code) {
                            break;
                        }
                        j += 1;
                    }
                    if j >= chars.len() {
                        break;
                    }

                    let final_char = chars[j];
                    let raw = chars[i + 2..j].iter().collect::<String>();
                    self.handle_csi(&raw, final_char);
                    i = j + 1;
                    continue;
                }

                if next == ']' {
                    let mut j = i + 2;
                    let mut terminated = false;
                    while j < chars.len() {
                        if chars[j] == '\u{0007}' {
                            j += 1;
                            terminated = true;
                            break;
                        }
                        if chars[j] == '\x1b' && j + 1 < chars.len() && chars[j + 1] == '\\' {
                            j += 2;
                            terminated = true;
                            break;
                        }
                        j += 1;
                    }
                    if !terminated {
                        break;
                    }
                    i = j;
                    continue;
                }

                match next {
                    '7' => {
                        self.saved_row = self.cursor_row;
                        self.saved_col = self.cursor_col;
                        self.wrap_pending = false;
                        i += 2;
                        continue;
                    }
                    '8' => {
                        self.cursor_row = self.saved_row.min(self.rows.saturating_sub(1));
                        self.cursor_col = self.saved_col.min(self.cols.saturating_sub(1));
                        self.wrap_pending = false;
                        i += 2;
                        continue;
                    }
                    'D' => {
                        self.wrap_pending = false;
                        self.line_feed();
                        i += 2;
                        continue;
                    }
                    'E' => {
                        self.wrap_pending = false;
                        self.cursor_col = 0;
                        self.line_feed();
                        i += 2;
                        continue;
                    }
                    'M' => {
                        self.wrap_pending = false;
                        self.reverse_index();
                        i += 2;
                        continue;
                    }
                    'c' => {
                        self.reset();
                        i += 2;
                        continue;
                    }
                    _ => {
                        i += 2;
                        continue;
                    }
                }
            }

            match ch {
                '\r' => {
                    self.cursor_col = 0;
                    self.wrap_pending = false;
                    i += 1;
                }
                '\n' => {
                    self.wrap_pending = false;
                    self.line_feed();
                    i += 1;
                }
                '\x08' => {
                    self.wrap_pending = false;
                    self.cursor_col = self.cursor_col.saturating_sub(1);
                    i += 1;
                }
                '\t' => {
                    let spaces = 8usize.saturating_sub(self.cursor_col % 8);
                    for _ in 0..spaces {
                        self.write_char(' ');
                    }
                    i += 1;
                }
                _ => {
                    let code = ch as u32;
                    if code < 0x20 || code == 0x7f {
                        i += 1;
                        continue;
                    }
                    self.write_char(ch);
                    i += 1;
                }
            }
        }
    }

    fn handle_csi(&mut self, raw: &str, final_char: char) {
        let private = raw.starts_with('?');
        let params_raw = if private { &raw[1..] } else { raw };
        let params = parse_params(params_raw);

        match final_char {
            'A' => {
                let n = param_or(&params, 0, 1).max(1) as usize;
                self.wrap_pending = false;
                self.cursor_row = self.cursor_row.saturating_sub(n);
            }
            'B' => {
                let n = param_or(&params, 0, 1).max(1) as usize;
                self.wrap_pending = false;
                self.cursor_row = (self.cursor_row + n).min(self.rows.saturating_sub(1));
            }
            'C' => {
                let n = param_or(&params, 0, 1).max(1) as usize;
                self.wrap_pending = false;
                self.cursor_col = (self.cursor_col + n).min(self.cols.saturating_sub(1));
            }
            'D' => {
                let n = param_or(&params, 0, 1).max(1) as usize;
                self.wrap_pending = false;
                self.cursor_col = self.cursor_col.saturating_sub(n);
            }
            'G' => {
                let col = param_or(&params, 0, 1).max(1) as usize;
                self.wrap_pending = false;
                self.cursor_col = col.saturating_sub(1).min(self.cols.saturating_sub(1));
            }
            'd' => {
                let row = param_or(&params, 0, 1).max(1) as usize;
                self.wrap_pending = false;
                self.cursor_row = row.saturating_sub(1).min(self.rows.saturating_sub(1));
            }
            'H' | 'f' => {
                let row = param_or(&params, 0, 1).max(1) as usize;
                let col = param_or(&params, 1, 1).max(1) as usize;
                self.wrap_pending = false;
                self.cursor_row = row.saturating_sub(1).min(self.rows.saturating_sub(1));
                self.cursor_col = col.saturating_sub(1).min(self.cols.saturating_sub(1));
            }
            'J' => {
                self.wrap_pending = false;
                self.erase_display(param_or(&params, 0, 0));
            }
            'K' => {
                self.wrap_pending = false;
                self.erase_line(param_or(&params, 0, 0));
            }
            'm' => {
                self.apply_sgr(&params);
            }
            'r' => {
                let top = param_or(&params, 0, 1).max(1) as usize;
                let bottom = param_or(&params, 1, self.rows as i32).max(1) as usize;
                let top0 = top.saturating_sub(1).min(self.rows.saturating_sub(1));
                let bottom0 = bottom.saturating_sub(1).min(self.rows.saturating_sub(1));
                if top0 < bottom0 {
                    self.scroll_top = top0;
                    self.scroll_bottom = bottom0;
                    self.cursor_row = top0;
                    self.cursor_col = 0;
                    self.wrap_pending = false;
                }
            }
            's' => {
                self.saved_row = self.cursor_row;
                self.saved_col = self.cursor_col;
                self.wrap_pending = false;
            }
            'u' => {
                self.cursor_row = self.saved_row.min(self.rows.saturating_sub(1));
                self.cursor_col = self.saved_col.min(self.cols.saturating_sub(1));
                self.wrap_pending = false;
            }
            'h' | 'l' if private => {
                let set = final_char == 'h';
                for param in params {
                    if let Some(code) = param {
                        match code {
                            25 => {
                                self.cursor_visible = set;
                            }
                            1049 => {
                                if set {
                                    self.enter_alt_screen();
                                } else {
                                    self.leave_alt_screen();
                                }
                            }
                            _ => {}
                        }
                    }
                }
                self.wrap_pending = false;
            }
            _ => {}
        }
    }

    fn enter_alt_screen(&mut self) {
        if self.saved_primary.is_some() {
            return;
        }

        self.saved_primary = Some(SavedScreen {
            lines: self.lines.clone(),
            cursor_row: self.cursor_row,
            cursor_col: self.cursor_col,
            saved_row: self.saved_row,
            saved_col: self.saved_col,
            style: self.style.clone(),
            scroll_top: self.scroll_top,
            scroll_bottom: self.scroll_bottom,
            cursor_visible: self.cursor_visible,
        });

        self.lines = vec![make_row(self.cols); self.rows];
        self.cursor_row = 0;
        self.cursor_col = 0;
        self.saved_row = 0;
        self.saved_col = 0;
        self.style = CellStyle::default();
        self.scroll_top = 0;
        self.scroll_bottom = self.rows.saturating_sub(1);
        self.wrap_pending = false;
    }

    fn leave_alt_screen(&mut self) {
        if let Some(saved) = self.saved_primary.take() {
            self.lines = saved.lines;
            self.cursor_row = saved.cursor_row.min(self.rows.saturating_sub(1));
            self.cursor_col = saved.cursor_col.min(self.cols.saturating_sub(1));
            self.saved_row = saved.saved_row.min(self.rows.saturating_sub(1));
            self.saved_col = saved.saved_col.min(self.cols.saturating_sub(1));
            self.style = saved.style;
            self.scroll_top = saved.scroll_top.min(self.rows.saturating_sub(1));
            self.scroll_bottom = saved.scroll_bottom.min(self.rows.saturating_sub(1));
            self.cursor_visible = saved.cursor_visible;
            self.wrap_pending = false;
        }
    }

    fn erase_display(&mut self, mode: i32) {
        match mode {
            0 => {
                self.erase_line(0);
                for row in (self.cursor_row + 1)..self.rows {
                    self.lines[row] = make_row(self.cols);
                }
            }
            1 => {
                for row in 0..self.cursor_row {
                    self.lines[row] = make_row(self.cols);
                }
                self.erase_line(1);
            }
            2 | 3 => {
                for row in 0..self.rows {
                    self.lines[row] = make_row(self.cols);
                }
            }
            _ => {}
        }
    }

    fn erase_line(&mut self, mode: i32) {
        match mode {
            0 => {
                for col in self.cursor_col..self.cols {
                    self.lines[self.cursor_row][col] = blank_cell();
                }
            }
            1 => {
                for col in 0..=self.cursor_col.min(self.cols.saturating_sub(1)) {
                    self.lines[self.cursor_row][col] = blank_cell();
                }
            }
            2 => {
                self.lines[self.cursor_row] = make_row(self.cols);
            }
            _ => {}
        }
    }

    fn line_feed(&mut self) {
        if self.cursor_row >= self.scroll_top && self.cursor_row <= self.scroll_bottom {
            if self.cursor_row == self.scroll_bottom {
                self.scroll_region_up(self.scroll_top, self.scroll_bottom, 1);
            } else {
                self.cursor_row = (self.cursor_row + 1).min(self.rows.saturating_sub(1));
            }
            return;
        }
        self.cursor_row = (self.cursor_row + 1).min(self.rows.saturating_sub(1));
    }

    fn reverse_index(&mut self) {
        if self.cursor_row >= self.scroll_top && self.cursor_row <= self.scroll_bottom {
            if self.cursor_row == self.scroll_top {
                self.scroll_region_down(self.scroll_top, self.scroll_bottom, 1);
            } else {
                self.cursor_row = self.cursor_row.saturating_sub(1);
            }
            return;
        }
        self.cursor_row = self.cursor_row.saturating_sub(1);
    }

    fn scroll_region_up(&mut self, top: usize, bottom: usize, count: usize) {
        if top >= bottom || bottom >= self.rows {
            return;
        }
        let n = count.max(1).min(bottom - top + 1);
        for _ in 0..n {
            self.lines.remove(top);
            self.lines.insert(bottom, make_row(self.cols));
        }
    }

    fn scroll_region_down(&mut self, top: usize, bottom: usize, count: usize) {
        if top >= bottom || bottom >= self.rows {
            return;
        }
        let n = count.max(1).min(bottom - top + 1);
        for _ in 0..n {
            self.lines.remove(bottom);
            self.lines.insert(top, make_row(self.cols));
        }
    }

    fn write_char(&mut self, ch: char) {
        if self.rows == 0 || self.cols == 0 {
            return;
        }

        let width = char_display_width(ch);
        if width == 0 {
            let prev_col = if self.cursor_col > 0 {
                self.cursor_col - 1
            } else {
                self.cursor_col
            };
            if self.cursor_row < self.rows && prev_col < self.cols {
                self.lines[self.cursor_row][prev_col].text.push(ch);
            }
            return;
        }

        if self.wrap_pending {
            self.cursor_col = 0;
            self.line_feed();
            self.wrap_pending = false;
        }

        if self.cursor_col >= self.cols {
            self.cursor_col = 0;
            self.line_feed();
        }

        self.lines[self.cursor_row][self.cursor_col] = Cell {
            text: ch.to_string(),
            style: self.style.clone(),
        };

        if self.cursor_col >= self.cols.saturating_sub(1) {
            self.wrap_pending = true;
        } else {
            self.cursor_col += 1;
        }
    }

    fn apply_sgr(&mut self, params: &[Option<i32>]) {
        if params.is_empty() {
            self.style = CellStyle::default();
            return;
        }

        let mut i = 0usize;
        while i < params.len() {
            let code = params[i].unwrap_or(0);
            match code {
                0 => self.style = CellStyle::default(),
                1 => self.style.bold = true,
                3 => self.style.italic = true,
                4 => self.style.underline = true,
                7 => self.style.inverse = true,
                22 => self.style.bold = false,
                23 => self.style.italic = false,
                24 => self.style.underline = false,
                27 => self.style.inverse = false,
                30..=37 => self.style.fg = ansi_16_color((code - 30) as usize),
                39 => self.style.fg = None,
                40..=47 => self.style.bg = ansi_16_color((code - 40) as usize),
                49 => self.style.bg = None,
                90..=97 => self.style.fg = ansi_16_color((code - 90 + 8) as usize),
                100..=107 => self.style.bg = ansi_16_color((code - 100 + 8) as usize),
                38 | 48 => {
                    let is_fg = code == 38;
                    let mode = params.get(i + 1).and_then(|v| *v);
                    if mode == Some(2) {
                        let r = params.get(i + 2).and_then(|v| *v);
                        let g = params.get(i + 3).and_then(|v| *v);
                        let b = params.get(i + 4).and_then(|v| *v);
                        if let (Some(r), Some(g), Some(b)) = (r, g, b) {
                            let color = rgb_hex(r, g, b);
                            if is_fg {
                                self.style.fg = Some(color);
                            } else {
                                self.style.bg = Some(color);
                            }
                        }
                        i += 4;
                    } else if mode == Some(5) {
                        let index = params.get(i + 2).and_then(|v| *v);
                        if let Some(idx) = index.and_then(xterm_256_color) {
                            if is_fg {
                                self.style.fg = Some(idx);
                            } else {
                                self.style.bg = Some(idx);
                            }
                        }
                        i += 2;
                    }
                }
                _ => {}
            }
            i += 1;
        }
    }

    fn reset(&mut self) {
        self.lines = vec![make_row(self.cols); self.rows];
        self.cursor_row = 0;
        self.cursor_col = 0;
        self.saved_row = 0;
        self.saved_col = 0;
        self.style = CellStyle::default();
        self.scroll_top = 0;
        self.scroll_bottom = self.rows.saturating_sub(1);
        self.wrap_pending = false;
        self.cursor_visible = true;
        self.saved_primary = None;
    }

    fn into_frame(self) -> Value {
        let mut line_values = Vec::with_capacity(self.rows);

        for row in &self.lines {
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
            "cols": self.cols,
            "rows": self.rows,
            "lines": line_values,
            "cursorRow": self.cursor_row.min(self.rows.saturating_sub(1)),
            "cursorCol": self.cursor_col.min(self.cols.saturating_sub(1)),
            "cursorVisible": self.cursor_visible,
        })
    }
}

fn parse_params(raw: &str) -> Vec<Option<i32>> {
    if raw.is_empty() {
        return vec![None];
    }
    raw.split(';')
        .map(|part| {
            if part.is_empty() {
                None
            } else {
                part.parse::<i32>().ok()
            }
        })
        .collect::<Vec<_>>()
}

fn param_or(params: &[Option<i32>], index: usize, default: i32) -> i32 {
    params.get(index).and_then(|v| *v).unwrap_or(default)
}

fn make_row(cols: usize) -> Vec<Cell> {
    vec![blank_cell(); cols]
}

fn blank_cell() -> Cell {
    Cell {
        text: " ".to_string(),
        style: CellStyle::default(),
    }
}

fn style_key(style: &CellStyle) -> String {
    format!(
        "{}|{}|{}|{}|{}",
        style.fg.as_deref().unwrap_or(""),
        style.bg.as_deref().unwrap_or(""),
        if style.bold { "1" } else { "0" },
        if style.italic { "1" } else { "0" },
        if style.underline { "1" } else { "0" },
    )
}

fn applied_style(style: &CellStyle) -> CellStyle {
    if !style.inverse {
        return style.clone();
    }
    CellStyle {
        fg: style.bg.clone(),
        bg: style.fg.clone(),
        bold: style.bold,
        italic: style.italic,
        underline: style.underline,
        inverse: false,
    }
}

fn segment_json(text: &str, style: &CellStyle) -> Value {
    let mut map = Map::new();
    map.insert("text".to_string(), Value::String(text.to_string()));
    if let Some(fg) = &style.fg {
        map.insert("fg".to_string(), Value::String(fg.clone()));
    }
    if let Some(bg) = &style.bg {
        map.insert("bg".to_string(), Value::String(bg.clone()));
    }
    if style.bold {
        map.insert("bold".to_string(), Value::Bool(true));
    }
    if style.italic {
        map.insert("italic".to_string(), Value::Bool(true));
    }
    if style.underline {
        map.insert("underline".to_string(), Value::Bool(true));
    }
    Value::Object(map)
}

fn ansi_16_color(index: usize) -> Option<String> {
    let palette = [
        "#000000", "#cd3131", "#0dbc79", "#e5e510", "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5",
        "#666666", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#d670d6", "#29b8db", "#ffffff",
    ];
    palette.get(index).map(|v| v.to_string())
}

fn rgb_hex(r: i32, g: i32, b: i32) -> String {
    format!(
        "#{:02x}{:02x}{:02x}",
        r.clamp(0, 255),
        g.clamp(0, 255),
        b.clamp(0, 255)
    )
}

fn xterm_256_color(index: i32) -> Option<String> {
    if !(0..=255).contains(&index) {
        return None;
    }
    if index < 16 {
        return ansi_16_color(index as usize);
    }
    if index >= 232 {
        let v = 8 + (index - 232) * 10;
        return Some(rgb_hex(v, v, v));
    }

    let i = index - 16;
    let r = i / 36;
    let g = (i % 36) / 6;
    let b = i % 6;
    let map = [0, 95, 135, 175, 215, 255];
    Some(rgb_hex(map[r as usize], map[g as usize], map[b as usize]))
}

fn char_display_width(ch: char) -> usize {
    let cp = ch as u32;
    if cp == 0 {
        return 0;
    }
    if cp < 32 || (cp >= 0x7f && cp < 0xa0) {
        return 0;
    }
    if (0x0300..=0x036f).contains(&cp)
        || (0x1ab0..=0x1aff).contains(&cp)
        || (0x1dc0..=0x1dff).contains(&cp)
        || (0x20d0..=0x20ff).contains(&cp)
        || (0xfe20..=0xfe2f).contains(&cp)
        || cp == 0x200d
        || (0xfe00..=0xfe0f).contains(&cp)
    {
        return 0;
    }
    1
}

#[cfg(test)]
mod tests {
    use super::build_styled_frame;
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
}
