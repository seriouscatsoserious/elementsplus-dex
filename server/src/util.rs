//! Small parsing helpers shared by the API and validation code.

use std::str::FromStr;

use elements::{AssetId, Txid};

/// Longest decimal representation of a `u64`.
const MAX_AMOUNT_DIGITS: usize = 20;

/// Parse a canonical decimal string of atomic units (`"0"` is rejected by
/// callers that need positive amounts). Leading zeros, signs, whitespace and
/// exponents are rejected so every amount has exactly one representation.
pub fn parse_amount(value: &str) -> Result<u64, String> {
    if value.is_empty()
        || value.len() > MAX_AMOUNT_DIGITS
        || !value.bytes().all(|byte| byte.is_ascii_digit())
        || (value.len() > 1 && value.starts_with('0'))
    {
        return Err(format!(
            "amount {value:?} is not a canonical decimal string"
        ));
    }
    value
        .parse::<u64>()
        .map_err(|_| format!("amount {value:?} is out of range"))
}

/// True for exactly 64 lowercase hex characters.
pub fn is_hex32(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub fn parse_asset_id(value: &str) -> Result<AssetId, String> {
    if !is_hex32(value) {
        return Err("asset id must be 64 lowercase hex characters".into());
    }
    AssetId::from_str(value).map_err(|_| "invalid asset id".into())
}

pub fn parse_txid(value: &str) -> Result<Txid, String> {
    if !is_hex32(value) {
        return Err("txid must be 64 lowercase hex characters".into());
    }
    Txid::from_str(value).map_err(|_| "invalid txid".into())
}

/// Decode lowercase/uppercase hex with an upper bound on the decoded size.
pub fn decode_hex(value: &str, max_bytes: usize, what: &str) -> Result<Vec<u8>, String> {
    if value.len() > max_bytes * 2 {
        return Err(format!("{what} exceeds {max_bytes} bytes"));
    }
    if value.is_empty() || value.len() % 2 != 0 {
        return Err(format!("{what} must be non-empty even-length hex"));
    }
    hex::decode(value).map_err(|_| format!("{what} is not valid hex"))
}

pub fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn amounts_are_canonical() {
        assert_eq!(parse_amount("0"), Ok(0));
        assert_eq!(parse_amount("2500000"), Ok(2_500_000));
        assert_eq!(parse_amount("18446744073709551615"), Ok(u64::MAX));
        for bad in [
            "",
            "01",
            "-1",
            "+1",
            "1.0",
            "1e3",
            " 1",
            "18446744073709551616",
        ] {
            assert!(parse_amount(bad).is_err(), "{bad:?} accepted");
        }
    }

    #[test]
    fn hex32_is_strict() {
        assert!(is_hex32(&"a".repeat(64)));
        assert!(!is_hex32(&"A".repeat(64)));
        assert!(!is_hex32(&"a".repeat(63)));
    }
}
