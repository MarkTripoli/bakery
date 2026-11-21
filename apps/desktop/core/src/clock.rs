//! The time as the page is told it: an RFC 3339 UTC string, which the page shows on the person's own
//! clock. Pure and dependency-free, so it is tested against known dates.

/// `unix_seconds` as `YYYY-MM-DDTHH:MM:SSZ`.
pub fn rfc3339_utc(unix_seconds: u64) -> String {
    let days = (unix_seconds / 86_400) as i64;
    let rest = unix_seconds % 86_400;
    let (hour, minute, second) = (rest / 3600, (rest % 3600) / 60, rest % 60);
    // Days since 1970-01-01 to a calendar date (Howard Hinnant's civil-from-days).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * shifted_month + 2) / 5 + 1;
    let month = if shifted_month < 10 {
        shifted_month + 3
    } else {
        shifted_month - 9
    };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_moments_come_out_as_their_dates() {
        for (seconds, text) in [
            (0, "1970-01-01T00:00:00Z"),
            (86_399, "1970-01-01T23:59:59Z"),
            (951_782_400, "2000-02-29T00:00:00Z"),
            (1_078_012_800, "2004-02-29T00:00:00Z"),
            (1_700_000_000, "2023-11-14T22:13:20Z"),
            (1_795_300_000, "2026-11-21T22:26:40Z"),
            (2_000_000_000, "2033-05-18T03:33:20Z"),
            (4_102_444_800, "2100-01-01T00:00:00Z"),
        ] {
            assert_eq!(rfc3339_utc(seconds), text, "{seconds}");
        }
    }

    #[test]
    fn a_leap_day_and_the_day_after_it_are_both_real() {
        assert_eq!(rfc3339_utc(1_709_164_800), "2024-02-29T00:00:00Z");
        assert_eq!(rfc3339_utc(1_709_251_200), "2024-03-01T00:00:00Z");
        assert_eq!(rfc3339_utc(1_704_067_199), "2023-12-31T23:59:59Z");
    }
}
