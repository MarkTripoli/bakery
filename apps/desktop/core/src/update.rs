pub const CHECK_EVERY_SECONDS: i64 = 24 * 60 * 60;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum State {
    Unavailable,
    Never,
    Looking,
    UpToDate {
        checked: i64,
    },
    Downloading {
        version: String,
        percent: Option<u8>,
    },
    Ready {
        version: String,
        package: bool,
        folder: Option<String>,
    },
    Failed {
        tried: i64,
    },
    NoFeed {
        checked: i64,
    },
    NotVerified {
        tried: i64,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    CheckForUpdates,
    RestartToUpdate,
    ShowUpdateInFolder,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MenuLines {
    pub version: String,
    pub status: Option<String>,
    pub action: Option<(String, Option<Action>)>,
}

pub const CHECK_FOR_UPDATES: &str = "Check for updates";
pub const CHECKING: &str = "Checking for updates…";
pub const RESTART_TO_UPDATE: &str = "Restart to update";
pub const SHOW_IN_FOLDER_MENU: &str = "Show the update in its folder";

pub fn menu_lines(state: &State, version: &str, now: i64, offset_minutes: i32) -> MenuLines {
    let (status, action): (Option<String>, Option<(String, Option<Action>)>) = match state {
        State::Unavailable => (None, None),
        State::Never => (
            None,
            Some((CHECK_FOR_UPDATES.into(), Some(Action::CheckForUpdates))),
        ),
        State::Looking => (None, Some((CHECKING.into(), None))),
        State::UpToDate { checked } => (
            Some(format!(
                "Up to date. Checked {}.",
                time_phrase(*checked, now, offset_minutes)
            )),
            Some((CHECK_FOR_UPDATES.into(), Some(Action::CheckForUpdates))),
        ),
        State::Downloading { version, percent } => (Some(downloading(version, *percent)), None),
        State::Ready {
            version, package, ..
        } => (
            Some(format!("Bakery {version} is ready.")),
            Some(if *package {
                (SHOW_IN_FOLDER_MENU.into(), Some(Action::ShowUpdateInFolder))
            } else {
                (RESTART_TO_UPDATE.into(), Some(Action::RestartToUpdate))
            }),
        ),
        State::Failed { tried } | State::NotVerified { tried } => (
            Some(format!(
                "Could not check. Tried {}.",
                time_phrase(*tried, now, offset_minutes)
            )),
            Some((CHECK_FOR_UPDATES.into(), Some(Action::CheckForUpdates))),
        ),
        State::NoFeed { checked } => (
            Some(format!(
                "This server does not offer app updates. Checked {}.",
                time_phrase(*checked, now, offset_minutes)
            )),
            Some((CHECK_FOR_UPDATES.into(), Some(Action::CheckForUpdates))),
        ),
    };
    MenuLines {
        version: format!("Version {version}"),
        status,
        action,
    }
}

fn downloading(version: &str, percent: Option<u8>) -> String {
    match percent {
        Some(n) => format!("Downloading Bakery {version}… {n}%"),
        None => format!("Downloading Bakery {version}…"),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Button {
    RestartToUpdate,
    Later,
    ShowInFolder,
    TryAgain,
}

impl Button {
    pub fn label(self) -> &'static str {
        match self {
            Button::RestartToUpdate => RESTART_TO_UPDATE,
            Button::Later => "Later",
            Button::ShowInFolder => "Show in folder",
            Button::TryAgain => "Try again",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tone {
    Information,
    Success,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Notice {
    pub tone: Tone,
    pub first: String,
    pub second: Option<String>,
    pub buttons: Vec<Button>,
    pub goes_after: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Say {
    Ready {
        version: String,
    },
    ReadyPackage {
        version: String,
        folder: String,
    },
    NotVerified {
        have: String,
    },
    UpToDateAsked {
        have: String,
    },
    DownloadingAsked {
        version: String,
        percent: Option<u8>,
    },
    DownloadStopped {
        have: String,
    },
    CheckFailedAsked {
        server: String,
        have: String,
    },
    NoFeedAsked {
        have: String,
    },
    Updated {
        version: String,
    },
}

pub fn notice(say: &Say) -> Notice {
    match say {
        Say::Ready { version } => Notice {
            tone: Tone::Information,
            first: format!("Bakery {version} is ready."),
            second: Some("Restarting takes a few seconds. Work on the server keeps running.".into()),
            buttons: vec![Button::RestartToUpdate, Button::Later],
            goes_after: None,
        },
        Say::ReadyPackage { version, folder } => Notice {
            tone: Tone::Information,
            first: format!("Bakery {version} is ready."),
            second: Some(format!(
                "It is saved in {folder}. Open it to install, then start Bakery again."
            )),
            buttons: vec![Button::ShowInFolder, Button::Later],
            goes_after: None,
        },
        Say::NotVerified { have } => Notice {
            tone: Tone::Error,
            first: "An update could not be verified and was not installed.".into(),
            second: Some(format!(
                "You are still on version {have}. If you see this again, tell whoever runs your Bakery server."
            )),
            buttons: vec![],
            goes_after: None,
        },
        Say::UpToDateAsked { have } => Notice {
            tone: Tone::Information,
            first: "Bakery is up to date.".into(),
            second: Some(format!("Version {have}.")),
            buttons: vec![],
            goes_after: Some(6),
        },
        Say::DownloadingAsked { version, percent } => Notice {
            tone: Tone::Information,
            first: downloading(version, *percent),
            second: None,
            buttons: vec![],
            goes_after: None,
        },
        Say::DownloadStopped { have } => Notice {
            tone: Tone::Error,
            first: "The update did not finish downloading.".into(),
            second: Some(format!("You are still on version {have}. Check your connection.")),
            buttons: vec![Button::TryAgain],
            goes_after: None,
        },
        Say::CheckFailedAsked { server, have } => Notice {
            tone: Tone::Error,
            first: "Bakery could not check for updates.".into(),
            second: Some(format!("{server} did not answer. Your version is {have}.")),
            buttons: vec![Button::TryAgain],
            goes_after: None,
        },
        Say::NoFeedAsked { have } => Notice {
            tone: Tone::Information,
            first: "This server does not offer app updates.".into(),
            second: Some(format!(
                "Your version is {have}. To get updates, ask whoever runs your Bakery server."
            )),
            buttons: vec![],
            goes_after: None,
        },
        Say::Updated { version } => Notice {
            tone: Tone::Success,
            first: format!("Bakery was updated to version {version}."),
            second: None,
            buttons: vec![],
            goes_after: Some(6),
        },
    }
}

pub fn panel_line(state: &State) -> Option<String> {
    match state {
        State::Ready {
            version,
            package: false,
            ..
        } => Some(format!(
            "Bakery {version} is ready. Restarting takes a few seconds."
        )),
        State::Ready {
            version,
            package: true,
            folder,
        } => Some(format!(
            "Bakery {version} is ready. It is saved in {}. Open it to install, then start Bakery again.",
            folder.as_deref().unwrap_or("its folder")
        )),
        State::Downloading { version, percent } => Some(downloading(version, *percent)),
        State::NotVerified { .. } => Some(
            "An update could not be verified and was not installed. If you see this again, tell whoever runs your Bakery server."
                .into(),
        ),
        State::NoFeed { .. } => Some(
            "This server does not offer app updates. Ask whoever runs it how to get the new version."
                .into(),
        ),
        _ => None,
    }
}

pub fn app_older_action(state: &State) -> Option<Action> {
    match state {
        State::Ready { package: false, .. } => Some(Action::RestartToUpdate),
        State::Ready { package: true, .. } => Some(Action::ShowUpdateInFolder),
        State::Never
        | State::UpToDate { .. }
        | State::Failed { .. }
        | State::NotVerified { .. } => Some(Action::CheckForUpdates),
        State::Unavailable | State::Looking | State::Downloading { .. } | State::NoFeed { .. } => {
            None
        }
    }
}

pub fn check_due(now: i64, last_check: Option<i64>, first_page_shown: bool) -> bool {
    if !first_page_shown {
        return false;
    }
    match last_check {
        None => true,
        Some(last) => now - last >= CHECK_EVERY_SECONDS,
    }
}

pub fn is_newer(offered: &str, have: &str) -> bool {
    match (parse_version(offered), parse_version(have)) {
        (Some(offered), Some(have)) => offered > have,
        _ => false,
    }
}

fn parse_version(text: &str) -> Option<(u64, u64, u64)> {
    let core = text.trim_start_matches('v').split(['-', '+']).next()?;
    let mut parts = core.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next()?.parse().ok()?;
    parts.next().is_none().then_some((major, minor, patch))
}

pub fn time_phrase(then: i64, now: i64, offset_minutes: i32) -> String {
    let shift = i64::from(offset_minutes) * 60;
    let (then_local, now_local) = (then + shift, now + shift);
    let (then_day, now_day) = (then_local.div_euclid(86_400), now_local.div_euclid(86_400));
    let seconds = then_local.rem_euclid(86_400);
    let (hour24, minute) = (seconds / 3600, (seconds % 3600) / 60);
    let (hour12, meridiem) = match hour24 {
        0 => (12, "AM"),
        1..=11 => (hour24, "AM"),
        12 => (12, "PM"),
        _ => (hour24 - 12, "PM"),
    };
    let clock = format!("{hour12}:{minute:02} {meridiem}");
    match now_day - then_day {
        0 => format!("today at {clock}"),
        1 => format!("yesterday at {clock}"),
        _ => {
            let (year, month, day) = civil_from_days(then_day);
            const MONTHS: [&str; 12] = [
                "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
            ];
            format!("{} {day}, {year}", MONTHS[(month - 1) as usize])
        }
    }
}

fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    (if month <= 2 { year + 1 } else { year }, month, day)
}

pub const BANNED_WORDS: [&str; 6] = [
    "endpoint",
    "signature",
    "key",
    "minisign",
    "artifact",
    "manifest",
];

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_795_511_640;

    #[test]
    fn a_time_is_today_yesterday_or_a_date_in_the_local_zone() {
        assert_eq!(time_phrase(NOW, NOW, 0), "today at 9:14 AM");
        assert_eq!(time_phrase(NOW - 86_400, NOW, 0), "yesterday at 9:14 AM");
        assert_eq!(time_phrase(NOW - 2 * 86_400, NOW, 0), "Nov 22, 2026");
        assert_eq!(time_phrase(NOW, NOW, -300), "today at 4:14 AM");
        assert_eq!(
            time_phrase(NOW + 2 * 3600 + 46 * 60, NOW + 2 * 3600 + 46 * 60, 0),
            "today at 12:00 PM"
        );
        assert_eq!(
            time_phrase(NOW - 9 * 3600 - 14 * 60, NOW, 0),
            "today at 12:00 AM"
        );
        assert_eq!(
            time_phrase(NOW - 4 * 3600 - 20 * 60, NOW, -300),
            "yesterday at 11:54 PM"
        );
    }

    fn lines(state: State) -> MenuLines {
        menu_lines(&state, "1.3.0", NOW, 0)
    }

    #[test]
    fn the_menu_says_the_version_and_the_state_in_the_designs_words() {
        let never = lines(State::Never);
        assert_eq!(never.version, "Version 1.3.0");
        assert_eq!(never.status, None);
        assert_eq!(
            never.action,
            Some(("Check for updates".into(), Some(Action::CheckForUpdates)))
        );

        let looking = lines(State::Looking);
        assert_eq!(looking.status, None);
        assert_eq!(looking.action, Some(("Checking for updates…".into(), None)));

        let current = lines(State::UpToDate { checked: NOW - 600 });
        assert_eq!(
            current.status.as_deref(),
            Some("Up to date. Checked today at 9:04 AM.")
        );
        assert_eq!(current.action.as_ref().unwrap().0, "Check for updates");

        let going = lines(State::Downloading {
            version: "1.4.0".into(),
            percent: Some(42),
        });
        assert_eq!(
            going.status.as_deref(),
            Some("Downloading Bakery 1.4.0… 42%")
        );
        assert_eq!(going.action, None);
        let unknown = lines(State::Downloading {
            version: "1.4.0".into(),
            percent: None,
        });
        assert_eq!(unknown.status.as_deref(), Some("Downloading Bakery 1.4.0…"));

        let ready = lines(State::Ready {
            version: "1.4.0".into(),
            package: false,
            folder: None,
        });
        assert_eq!(ready.status.as_deref(), Some("Bakery 1.4.0 is ready."));
        assert_eq!(
            ready.action,
            Some(("Restart to update".into(), Some(Action::RestartToUpdate)))
        );
        let package = lines(State::Ready {
            version: "1.4.0".into(),
            package: true,
            folder: Some("Downloads".into()),
        });
        assert_eq!(
            package.action,
            Some((
                "Show the update in its folder".into(),
                Some(Action::ShowUpdateInFolder)
            ))
        );

        let failed = lines(State::Failed {
            tried: NOW - 86_400,
        });
        assert_eq!(
            failed.status.as_deref(),
            Some("Could not check. Tried yesterday at 9:14 AM.")
        );
    }

    #[test]
    fn a_build_with_no_release_key_draws_no_update_lines() {
        let none = lines(State::Unavailable);
        assert_eq!((none.status, none.action), (None, None));
        assert_eq!(none.version, "Version 1.3.0");
    }

    #[test]
    fn every_notice_has_the_designs_words_buttons_and_lifetime() {
        let ready = notice(&Say::Ready {
            version: "1.4.0".into(),
        });
        assert_eq!(ready.first, "Bakery 1.4.0 is ready.");
        assert_eq!(
            ready.second.as_deref(),
            Some("Restarting takes a few seconds. Work on the server keeps running.")
        );
        assert_eq!(ready.buttons, [Button::RestartToUpdate, Button::Later]);
        assert_eq!((ready.tone, ready.goes_after), (Tone::Information, None));

        let package = notice(&Say::ReadyPackage {
            version: "1.4.0".into(),
            folder: "Downloads".into(),
        });
        assert_eq!(
            package.second.as_deref(),
            Some("It is saved in Downloads. Open it to install, then start Bakery again.")
        );
        assert_eq!(package.buttons, [Button::ShowInFolder, Button::Later]);

        let unverified = notice(&Say::NotVerified {
            have: "1.3.0".into(),
        });
        assert_eq!(unverified.tone, Tone::Error);
        assert_eq!(
            unverified.first,
            "An update could not be verified and was not installed."
        );
        assert_eq!(unverified.second.as_deref(), Some("You are still on version 1.3.0. If you see this again, tell whoever runs your Bakery server."));
        assert!(unverified.buttons.is_empty());

        let current = notice(&Say::UpToDateAsked {
            have: "1.3.0".into(),
        });
        assert_eq!(
            (
                current.first.as_str(),
                current.second.as_deref(),
                current.goes_after
            ),
            ("Bakery is up to date.", Some("Version 1.3.0."), Some(6))
        );

        let going = notice(&Say::DownloadingAsked {
            version: "1.4.0".into(),
            percent: Some(7),
        });
        assert_eq!(
            (going.first.as_str(), going.second),
            ("Downloading Bakery 1.4.0… 7%", None)
        );

        let stopped = notice(&Say::DownloadStopped {
            have: "1.3.0".into(),
        });
        assert_eq!(stopped.first, "The update did not finish downloading.");
        assert_eq!(
            stopped.second.as_deref(),
            Some("You are still on version 1.3.0. Check your connection.")
        );
        assert_eq!(stopped.buttons, [Button::TryAgain]);

        let silent = notice(&Say::CheckFailedAsked {
            server: "https://bakery.acme.example".into(),
            have: "1.3.0".into(),
        });
        assert_eq!(silent.first, "Bakery could not check for updates.");
        assert_eq!(
            silent.second.as_deref(),
            Some("https://bakery.acme.example did not answer. Your version is 1.3.0.")
        );

        let updated = notice(&Say::Updated {
            version: "1.4.0".into(),
        });
        assert_eq!(
            (updated.tone, updated.first.as_str(), updated.goes_after),
            (
                Tone::Success,
                "Bakery was updated to version 1.4.0.",
                Some(6)
            )
        );
    }

    #[test]
    fn no_word_on_screen_names_the_machinery() {
        let all = [
            notice(&Say::Ready {
                version: "1.4.0".into(),
            }),
            notice(&Say::ReadyPackage {
                version: "1.4.0".into(),
                folder: "Downloads".into(),
            }),
            notice(&Say::NotVerified {
                have: "1.3.0".into(),
            }),
            notice(&Say::UpToDateAsked {
                have: "1.3.0".into(),
            }),
            notice(&Say::DownloadStopped {
                have: "1.3.0".into(),
            }),
            notice(&Say::CheckFailedAsked {
                server: "https://s.example".into(),
                have: "1.3.0".into(),
            }),
        ];
        let mut texts: Vec<String> = all
            .iter()
            .flat_map(|n| {
                let mut v = vec![n.first.clone()];
                v.extend(n.second.clone());
                v.extend(n.buttons.iter().map(|b| b.label().to_string()));
                v
            })
            .collect();
        for state in [
            State::Never,
            State::Looking,
            State::UpToDate { checked: NOW },
            State::Failed { tried: NOW },
        ] {
            let l = lines(state);
            texts.extend(l.status);
            texts.extend(l.action.map(|(label, _)| label));
        }
        for text in texts {
            for banned in BANNED_WORDS {
                assert!(
                    !text.to_lowercase().contains(banned),
                    "{text} names {banned}"
                );
            }
        }
    }

    #[test]
    fn a_server_with_no_feed_is_said_in_its_own_words() {
        let none = lines(State::NoFeed { checked: NOW - 600 });
        assert_eq!(
            none.status.as_deref(),
            Some("This server does not offer app updates. Checked today at 9:04 AM.")
        );
        assert_eq!(
            none.action,
            Some(("Check for updates".into(), Some(Action::CheckForUpdates)))
        );
        let asked = notice(&Say::NoFeedAsked {
            have: "1.3.0".into(),
        });
        assert_eq!(asked.tone, Tone::Information);
        assert_eq!(asked.first, "This server does not offer app updates.");
        assert_eq!(
            asked.second.as_deref(),
            Some("Your version is 1.3.0. To get updates, ask whoever runs your Bakery server.")
        );
        assert!(asked.buttons.is_empty() && asked.goes_after.is_none());
        let state = State::NoFeed { checked: NOW };
        assert_eq!(
            panel_line(&state).as_deref(),
            Some("This server does not offer app updates. Ask whoever runs it how to get the new version.")
        );
        assert_eq!(app_older_action(&state), None);
    }

    #[test]
    fn a_panel_carries_the_update_in_one_line_and_the_older_app_panel_offers_its_first_button() {
        let ready = State::Ready {
            version: "1.4.0".into(),
            package: false,
            folder: None,
        };
        assert_eq!(
            panel_line(&ready).as_deref(),
            Some("Bakery 1.4.0 is ready. Restarting takes a few seconds.")
        );
        assert_eq!(app_older_action(&ready), Some(Action::RestartToUpdate));
        let package = State::Ready {
            version: "1.4.0".into(),
            package: true,
            folder: Some("Downloads".into()),
        };
        assert_eq!(panel_line(&package).as_deref(), Some("Bakery 1.4.0 is ready. It is saved in Downloads. Open it to install, then start Bakery again."));
        assert_eq!(app_older_action(&package), Some(Action::ShowUpdateInFolder));
        let going = State::Downloading {
            version: "1.4.0".into(),
            percent: Some(40),
        };
        assert_eq!(
            panel_line(&going).as_deref(),
            Some("Downloading Bakery 1.4.0… 40%")
        );
        assert_eq!(app_older_action(&going), None);
        let unverified = State::NotVerified { tried: NOW };
        assert_eq!(
            panel_line(&unverified).as_deref(),
            Some("An update could not be verified and was not installed. If you see this again, tell whoever runs your Bakery server.")
        );
        for state in [
            State::Never,
            State::UpToDate { checked: NOW },
            State::Failed { tried: NOW },
        ] {
            assert_eq!(panel_line(&state), None);
            assert_eq!(app_older_action(&state), Some(Action::CheckForUpdates));
        }
        assert_eq!(app_older_action(&State::Unavailable), None);
        assert_eq!(app_older_action(&State::Looking), None);
        assert_eq!(
            lines(unverified).status.as_deref(),
            Some("Could not check. Tried today at 9:14 AM.")
        );
    }

    #[test]
    fn the_app_looks_once_the_first_page_shows_and_every_day_after_the_last_look() {
        assert!(!check_due(NOW, None, false));
        assert!(check_due(NOW, None, true));
        assert!(!check_due(NOW, Some(NOW - CHECK_EVERY_SECONDS + 1), true));
        assert!(check_due(NOW, Some(NOW - CHECK_EVERY_SECONDS), true));
    }

    #[test]
    fn an_update_is_only_ever_a_newer_version() {
        assert!(is_newer("1.4.0", "1.3.0"));
        assert!(is_newer("2.0.0", "1.9.9"));
        assert!(is_newer("1.3.1", "1.3.0"));
        assert!(!is_newer("1.3.0", "1.3.0"));
        assert!(!is_newer("1.2.9", "1.3.0"));
        assert!(!is_newer("soon", "1.3.0"));
        assert!(!is_newer("1.4", "1.3.0"));
        assert!(is_newer("v1.4.0", "1.3.0"));
    }
}
