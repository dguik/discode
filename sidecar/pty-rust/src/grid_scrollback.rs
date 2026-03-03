use serde_json::{Map, Value};

#[derive(Clone, Default, PartialEq, Eq)]
pub struct CellStyle {
    pub fg: Option<String>,
    pub bg: Option<String>,
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    pub inverse: bool,
}

#[derive(Clone, PartialEq, Eq)]
pub struct Cell {
    pub text: String,
    pub style: CellStyle,
}

#[derive(Clone)]
pub struct SavedScreen {
    pub lines: Vec<Vec<Cell>>,
    pub cursor_row: usize,
    pub cursor_col: usize,
    pub saved_row: usize,
    pub saved_col: usize,
    pub style: CellStyle,
    pub scroll_top: usize,
    pub scroll_bottom: usize,
    pub cursor_visible: bool,
}

pub fn make_row(cols: usize) -> Vec<Cell> {
    vec![blank_cell(); cols]
}

pub fn blank_cell() -> Cell {
    Cell {
        text: " ".to_string(),
        style: CellStyle::default(),
    }
}

pub fn style_key(style: &CellStyle) -> String {
    format!(
        "{}|{}|{}|{}|{}",
        style.fg.as_deref().unwrap_or(""),
        style.bg.as_deref().unwrap_or(""),
        if style.bold { "1" } else { "0" },
        if style.italic { "1" } else { "0" },
        if style.underline { "1" } else { "0" },
    )
}

pub fn applied_style(style: &CellStyle) -> CellStyle {
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

pub fn segment_json(text: &str, style: &CellStyle) -> Value {
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

pub fn char_display_width(ch: char) -> usize {
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

    if (0x1100..=0x115f).contains(&cp)
        || (0x2329..=0x232a).contains(&cp)
        || (0x2e80..=0xa4cf).contains(&cp)
        || (0xac00..=0xd7a3).contains(&cp)
        || (0xf900..=0xfaff).contains(&cp)
        || (0xfe10..=0xfe19).contains(&cp)
        || (0xfe30..=0xfe6f).contains(&cp)
        || (0xff00..=0xff60).contains(&cp)
        || (0xffe0..=0xffe6).contains(&cp)
        || (0x1f300..=0x1faff).contains(&cp)
        || (0x20000..=0x3fffd).contains(&cp)
    {
        return 2;
    }

    1
}
