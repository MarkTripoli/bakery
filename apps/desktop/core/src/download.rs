//! The words of a file saved from a page (#77 slice 5, design-ux's answer to builder question 5).
//! Only wording and the folder's short name live here; the window system draws the notice.

/// The folder's name only ("Downloads"); the full path is the notice's tooltip.
pub fn folder_name(path: &str) -> String {
    let trimmed = path.trim_end_matches(['/', '\\']);
    if trimmed.is_empty() {
        return path.to_string();
    }
    trimmed
        .rsplit(['/', '\\'])
        .next()
        .filter(|name| !name.is_empty())
        .unwrap_or(trimmed)
        .to_string()
}

/// "Saving {file}…": shown only when a save takes more than a second.
pub fn saving(file: &str) -> String {
    format!("Saving {file}…")
}

/// "Saved {file} to {folder}."
pub fn saved(file: &str, folder: &str) -> String {
    format!("Saved {file} to {folder}.")
}

/// Why a save failed, in the design's three sentences.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Failure {
    /// The chosen folder cannot be written to.
    NoPermission,
    /// The disk is full.
    DiskFull,
    /// The connection dropped, or anything else: the part file is deleted.
    Stopped,
}

pub fn failure_title(file: &str) -> String {
    format!("{file} could not be saved.")
}

pub fn failure_reason(failure: Failure) -> &'static str {
    match failure {
        Failure::NoPermission => "You cannot save to that folder. Choose another.",
        Failure::DiskFull => "There is not enough space on this disk.",
        Failure::Stopped => {
            "The download stopped before it finished. Nothing was kept. Check your connection and the space on this disk."
        }
    }
}

pub const SHOW_IN_FOLDER: &str = if cfg!(target_os = "macos") {
    "Show in Finder"
} else {
    "Show in folder"
};
pub const TRY_AGAIN: &str = "Try again";

/// Deletes what a failed save left behind, so nothing is kept. True when nothing remains: a file that
/// is already gone counts, a file that cannot be removed does not.
pub fn discard_partial(path: &std::path::Path) -> bool {
    match std::fs::remove_file(path) {
        Ok(()) => true,
        Err(error) => error.kind() == std::io::ErrorKind::NotFound,
    }
}

/// How long a "Saved" notice stays when the pointer and focus are away from it.
pub const SAVED_NOTICE_SECONDS: u64 = 8;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_folder_is_named_by_its_last_part() {
        assert_eq!(folder_name("/home/ana/Downloads"), "Downloads");
        assert_eq!(folder_name("/home/ana/Downloads/"), "Downloads");
        assert_eq!(folder_name("C:\\Users\\Ana\\Downloads"), "Downloads");
        assert_eq!(folder_name("/"), "/");
    }

    #[test]
    fn the_sentences_are_the_designs() {
        assert_eq!(saving("report.pdf"), "Saving report.pdf…");
        assert_eq!(
            saved("report.pdf", "Downloads"),
            "Saved report.pdf to Downloads."
        );
        assert_eq!(
            failure_title("report.pdf"),
            "report.pdf could not be saved."
        );
        assert_eq!(
            failure_reason(Failure::Stopped),
            "The download stopped before it finished. Nothing was kept. Check your connection and the space on this disk."
        );
        assert_eq!(
            failure_reason(Failure::DiskFull),
            "There is not enough space on this disk."
        );
        assert_eq!(
            failure_reason(Failure::NoPermission),
            "You cannot save to that folder. Choose another."
        );
    }

    #[test]
    fn a_failed_save_leaves_no_file_behind() {
        let dir = std::env::temp_dir().join(format!("bakery-partial-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let part = dir.join("report.pdf");
        std::fs::write(&part, b"half a file").unwrap();
        assert!(part.exists());
        assert!(discard_partial(&part));
        assert!(!part.exists());
        // Already gone is fine; a path that cannot be removed is reported.
        assert!(discard_partial(&part));
        assert!(!discard_partial(&dir));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_words_avoid_the_terms_the_design_bans() {
        let all = [
            saving("a"),
            saved("a", "b"),
            failure_title("a"),
            failure_reason(Failure::NoPermission).into(),
            failure_reason(Failure::DiskFull).into(),
            failure_reason(Failure::Stopped).into(),
            SHOW_IN_FOLDER.into(),
            TRY_AGAIN.into(),
        ];
        for words in all {
            for banned in [
                "URL",
                "origin",
                "host",
                "endpoint",
                "protocol",
                "navigation",
            ] {
                assert!(!words.contains(banned), "{banned} in {words}");
            }
        }
    }
}
