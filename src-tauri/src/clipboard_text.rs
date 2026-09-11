//! Decoding is bounded by the clipboard allocation, never a terminator search through memory.
pub fn decode(bytes: &[u8]) -> Result<String, &'static str> {
    if bytes.len() % 2 != 0 { return Err("Invalid UTF-16 clipboard allocation"); }
    let mut units = Vec::new();
    for pair in bytes.chunks_exact(2) {
        let unit = u16::from_le_bytes([pair[0], pair[1]]);
        if unit == 0 { return String::from_utf16(&units).map_err(|_| "Invalid UTF-16 clipboard text"); }
        units.push(unit);
    }
    Err("Clipboard text is not terminated")
}

#[cfg(test)]
mod tests {
    use super::decode;
    #[test]
    fn decodes_only_bounded_terminated_utf16() {
        assert_eq!(decode(&[65, 0, 0, 0, 66, 0]), Ok("A".into()));
        assert_eq!(decode(&[0, 0]), Ok(String::new()));
        assert!(decode(&[]).is_err());
        assert!(decode(&[65, 0]).is_err());
        assert!(decode(&[65]).is_err());
        assert!(decode(&[0, 216, 0, 0]).is_err());
    }
}
