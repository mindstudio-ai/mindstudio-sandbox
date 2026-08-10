/**
 * Do NOT unref() this timer, and do not "dedupe" it against the identically
 * named helper in DraftSnapshotManager, which does.
 *
 * Inside the CLI's polling loops (`releases wait`, `releases status --wait`,
 * `diagnostics get --wait`) this timer is often the only live handle, so an
 * unref'd version lets node exit mid-wait: the poll silently abandons and never
 * reports a result. Verified — the process exits 13 and the code after the
 * sleep never runs. The server can unref safely because its sockets keep the
 * loop alive; a short-lived CLI cannot.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
