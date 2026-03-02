use std::collections::HashMap;

pub fn build_terminal_response(
    query_carry: &mut String,
    private_modes: &mut HashMap<i32, bool>,
    chunk: &str,
    cols: u16,
    rows: u16,
    cursor_row: usize,
    cursor_col: usize,
) -> String {
    let mut data = String::new();
    data.push_str(query_carry);
    data.push_str(chunk);
    query_carry.clear();

    let bytes = data.as_bytes();
    let mut out = String::new();
    let mut i = 0usize;

    while i < bytes.len() {
        if bytes[i] != 0x1b {
            i += 1;
            continue;
        }

        if i + 1 >= bytes.len() {
            query_carry.push_str(&data[i..]);
            break;
        }

        let next = bytes[i + 1];

        if next == b'[' {
            let mut j = i + 2;
            while j < bytes.len() {
                if (0x40..=0x7e).contains(&bytes[j]) {
                    break;
                }
                j += 1;
            }

            if j >= bytes.len() {
                query_carry.push_str(&data[i..]);
                break;
            }

            let final_char = bytes[j] as char;
            let raw = std::str::from_utf8(&bytes[i + 2..j]).unwrap_or_default();

            if final_char == 'n' && raw == "6" {
                out.push_str(&format!("\x1b[{};{}R", cursor_row + 1, cursor_col + 1));
            }

            if final_char == 'n' && raw == "?6" {
                out.push_str(&format!("\x1b[?{};{}R", cursor_row + 1, cursor_col + 1));
            }

            if final_char == 'n' && raw == "5" {
                out.push_str("\x1b[0n");
            }

            if final_char == 'p' && raw.starts_with('?') && raw.ends_with('$') {
                let mode = raw[1..raw.len().saturating_sub(1)].parse::<i32>().ok();
                if let Some(mode) = mode {
                    out.push_str(&format!(
                        "\x1b[?{};{}$y",
                        mode,
                        private_mode_state(private_modes, mode)
                    ));
                }
            }

            if (final_char == 'h' || final_char == 'l') && raw.starts_with('?') {
                let enable = final_char == 'h';
                for item in raw[1..].split(';') {
                    if let Ok(mode) = item.parse::<i32>() {
                        private_modes.insert(mode, enable);
                    }
                }
            }

            if final_char == 'u' && raw == "?" {
                out.push_str("\x1b[?0u");
            }

            if final_char == 't' && raw == "14" {
                let width_px = (cols as usize * 11).max(320);
                let height_px = (rows as usize * 22).max(200);
                out.push_str(&format!("\x1b[4;{};{}t", height_px, width_px));
            }

            if final_char == 'c' && raw.is_empty() {
                out.push_str("\x1b[?62;c");
            }

            i = j + 1;
            continue;
        }

        if next == b']' {
            let mut j = i + 2;
            let mut terminated = false;
            let mut end_index = 0usize;
            while j < bytes.len() {
                if bytes[j] == 0x07 {
                    end_index = j;
                    j += 1;
                    terminated = true;
                    break;
                }
                if bytes[j] == 0x1b && j + 1 < bytes.len() && bytes[j + 1] == b'\\' {
                    end_index = j;
                    j += 2;
                    terminated = true;
                    break;
                }
                j += 1;
            }

            if !terminated {
                query_carry.push_str(&data[i..]);
                break;
            }

            let body = std::str::from_utf8(&bytes[i + 2..end_index]).unwrap_or_default();
            if body == "10;?" {
                out.push_str("\x1b]10;rgb:e5e5/e5e5/e5e5\x07");
            }
            if body == "11;?" {
                out.push_str("\x1b]11;rgb:0a0a/0a0a/0a0a\x07");
            }
            if let Some(index) = parse_osc_indexed_color_query(body) {
                let (r, g, b) = xterm_256_color(index);
                out.push_str(&format!("\x1b]4;{};rgb:{}/{}/{}\x07", index, r, g, b));
            }

            i = j;
            continue;
        }

        if next == b'_' {
            let mut j = i + 2;
            let mut terminated = false;
            while j < bytes.len() {
                if bytes[j] == 0x1b && j + 1 < bytes.len() && bytes[j + 1] == b'\\' {
                    j += 2;
                    terminated = true;
                    break;
                }
                j += 1;
            }

            if !terminated {
                query_carry.push_str(&data[i..]);
                break;
            }

            let body = std::str::from_utf8(&bytes[i + 2..j.saturating_sub(2)]).unwrap_or_default();
            if body.contains("a=q") {
                out.push_str("\x1b_Gi=31337;OK\x1b\\");
            }

            i = j;
            continue;
        }

        i += 2;
    }

    out
}

fn private_mode_state(private_modes: &HashMap<i32, bool>, mode: i32) -> i32 {
    if let Some(value) = private_modes.get(&mode) {
        return if *value { 1 } else { 2 };
    }

    if mode == 7 || mode == 25 {
        return 1;
    }

    2
}

fn parse_osc_indexed_color_query(body: &str) -> Option<i32> {
    let mut parts = body.split(';');
    if parts.next()? != "4" {
        return None;
    }
    let index = parts.next()?.parse::<i32>().ok()?;
    if parts.next()? != "?" {
        return None;
    }
    if !(0..=255).contains(&index) {
        return None;
    }
    Some(index)
}

fn xterm_256_color(index: i32) -> (String, String, String) {
    let to_hex4 = |value: i32| {
        let clamped = value.clamp(0, 255) as u8;
        let part = format!("{:02x}", clamped);
        format!("{part}{part}")
    };

    if index < 16 {
        let palette = [
            (0, 0, 0),
            (205, 49, 49),
            (13, 188, 121),
            (229, 229, 16),
            (36, 114, 200),
            (188, 63, 188),
            (17, 168, 205),
            (229, 229, 229),
            (102, 102, 102),
            (241, 76, 76),
            (35, 209, 139),
            (245, 245, 67),
            (59, 142, 234),
            (214, 112, 214),
            (41, 184, 219),
            (255, 255, 255),
        ];
        let (r, g, b) = palette.get(index as usize).copied().unwrap_or((0, 0, 0));
        return (to_hex4(r), to_hex4(g), to_hex4(b));
    }

    if index >= 232 {
        let v = 8 + (index - 232) * 10;
        let value = to_hex4(v);
        return (value.clone(), value.clone(), value);
    }

    let i = index - 16;
    let r = i / 36;
    let g = (i % 36) / 6;
    let b = i % 6;
    let map = [0, 95, 135, 175, 215, 255];
    (
        to_hex4(map[r as usize]),
        to_hex4(map[g as usize]),
        to_hex4(map[b as usize]),
    )
}

#[cfg(test)]
mod tests {
    use super::build_terminal_response;
    use serde::Deserialize;
    use std::collections::HashMap;

    #[derive(Deserialize)]
    struct QueryFixture {
        name: String,
        cols: u16,
        rows: u16,
        cursor_row: usize,
        cursor_col: usize,
        chunks: Vec<String>,
        expect_contains: Vec<String>,
    }

    #[test]
    fn handles_split_sequences_and_private_modes() {
        let mut carry = String::new();
        let mut modes = HashMap::new();

        let mut response = String::new();
        response.push_str(&build_terminal_response(
            &mut carry, &mut modes, "\x1b[", 80, 24, 0, 2,
        ));
        response.push_str(&build_terminal_response(
            &mut carry,
            &mut modes,
            "?25$p\x1b[6n",
            80,
            24,
            0,
            2,
        ));

        assert!(response.contains("\x1b[?25;1$y"));
        assert!(response.contains("\x1b[1;3R"));
        assert!(carry.is_empty());
    }

    #[test]
    fn replays_agent_query_regression_fixtures() {
        let fixtures = serde_json::from_str::<Vec<QueryFixture>>(include_str!(
            "agent_query_regression_fixtures.json"
        ))
        .expect("fixtures should parse");

        for fixture in fixtures {
            let mut carry = String::new();
            let mut modes = HashMap::new();
            let mut response = String::new();

            for chunk in fixture.chunks {
                response.push_str(&build_terminal_response(
                    &mut carry,
                    &mut modes,
                    &chunk,
                    fixture.cols,
                    fixture.rows,
                    fixture.cursor_row,
                    fixture.cursor_col,
                ));
            }

            for expected in fixture.expect_contains {
                assert!(
                    response.contains(&expected),
                    "fixture '{}' missing expected token: {}",
                    fixture.name,
                    expected
                );
            }
            assert!(
                carry.is_empty(),
                "fixture '{}' left carry bytes: {:?}",
                fixture.name,
                carry
            );
        }
    }
}
