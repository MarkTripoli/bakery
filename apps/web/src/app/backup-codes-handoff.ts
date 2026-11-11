/**
 * The one-time hand-off of a freshly issued backup-code set from the page
 * that created it (authenticator setup, or a regeneration) to the page that
 * shows it. Deliberately in-memory only: these codes are shown once and must
 * never outlive the tab's navigation, so nothing is written to storage and a
 * reload legitimately loses them — `BackupCodesPage` then asks for the
 * confirmation that issues a new set instead of showing a stale one.
 */
let issued: readonly string[] | null = null;

export function holdIssuedBackupCodes(codes: readonly string[]): void {
  issued = codes;
}

export function readIssuedBackupCodes(): readonly string[] | null {
  return issued;
}

export function clearIssuedBackupCodes(): void {
  issued = null;
}
