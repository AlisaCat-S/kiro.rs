//! UTF-8 字符边界工具
//!
//! 目前标准库的 `str::floor_char_boundary()` 仍是 nightly-only。
//! 为了在 stable 上安全按字节索引截断 UTF-8 字符串，这里提供等价实现。

/// 返回不大于 `idx` 的最大 UTF-8 字符边界（byte index）。
///
/// - 若 `idx >= s.len()`，返回 `s.len()`
/// - 否则向左回退到最近的 `is_char_boundary()` 位置
#[inline]
pub fn floor_char_boundary(s: &str, idx: usize) -> usize {
    if idx >= s.len() {
        return s.len();
    }

    let mut i = idx;
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_floor_char_boundary_ascii() {
        let s = "abcdef";
        assert_eq!(floor_char_boundary(s, 3), 3);
        assert_eq!(floor_char_boundary(s, 999), s.len());
    }

    #[test]
    fn test_floor_char_boundary_utf8() {
        let s = "你好ab";
        // "你" 占 3 字节；idx=1/2 应回退到 0
        assert_eq!(floor_char_boundary(s, 1), 0);
        assert_eq!(floor_char_boundary(s, 2), 0);
        assert_eq!(floor_char_boundary(s, 3), 3);
        // idx 落在第二个汉字中间（3..6）
        assert_eq!(floor_char_boundary(s, 4), 3);
        assert_eq!(floor_char_boundary(s, 5), 3);
        assert_eq!(floor_char_boundary(s, 6), 6);
    }
}
