//! FNV-1a 64, the parity checksum for the port's tier-2 cross-check.
//!
//! Why not the XOR fold the 2026-08-16 spikes used: that fold proved four
//! implementations across three languages agreed on 1,000,000 points, and it
//! caught a real sentinel bug in the Go arm that the timings would have kept.
//! But XOR is blind to order and cancels pairs - swap two points, or break two
//! points identically, and the value does not move. FNV-1a is order-sensitive,
//! which is what `the_fold_is_order_sensitive` pins.

const FNV_OFFSET_BASIS: u64 = 0xcbf2_9ce4_8422_2325;
const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

/// FNV-1a 64 over a byte slice.
#[must_use]
pub fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut hash = FNV_OFFSET_BASIS;
    for &byte in bytes {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    hash
}

/// Fold one `f64` result into a running checksum, by its RAW BITS.
///
/// Raw bits rather than the value: two results that differ in the last bit are
/// the thing this exists to catch, and any comparison that goes through a
/// tolerance cannot see them. Start an accumulator at 0 and fold in evaluation
/// order.
#[must_use]
pub fn fold_f64(acc: u64, value: f64) -> u64 {
    let mut hash = if acc == 0 { FNV_OFFSET_BASIS } else { acc };
    for &byte in &value.to_bits().to_le_bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    hash
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Published FNV-1a 64-bit vectors. Ground truth from the reference
    /// implementation, not from this port - a test that checks a function
    /// against itself proves nothing. Re-derived independently in Python
    /// before being written down here.
    #[test]
    fn matches_the_published_fnv1a64_vectors() {
        assert_eq!(fnv1a64(b""), 0xcbf2_9ce4_8422_2325);
        assert_eq!(fnv1a64(b"a"), 0xaf63_dc4c_8601_ec8c);
        assert_eq!(fnv1a64(b"foobar"), 0x8594_4171_f739_67e8);
    }

    /// The whole reason FNV-1a replaces the spike's XOR fold: XOR is blind to
    /// order, so swapping two values leaves it unchanged. This test is what
    /// makes that property load-bearing rather than a claim in a comment.
    #[test]
    fn the_fold_is_order_sensitive() {
        let a = fold_f64(fold_f64(0, 1.5), 2.5);
        let b = fold_f64(fold_f64(0, 2.5), 1.5);
        assert_ne!(a, b, "fold must depend on order; an XOR fold would not");
    }

    /// A fold that ignored the value entirely would pass the test above.
    #[test]
    fn the_fold_depends_on_the_value() {
        assert_ne!(fold_f64(0, 1.5), fold_f64(0, 1.500_000_000_000_000_2));
    }
}
