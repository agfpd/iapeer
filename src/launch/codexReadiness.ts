// Startup paints a placeholder input arrow before account/read/session initialization completes.
// These are native startup rows, not arbitrary occurrences of "loading" in conversation text.
export function codexBootstrapPending(pane: string): boolean {
  return /^\s*(?:(?:Resuming|Forking) session[….]*|loading|Waiting for startup\s*·.*)\s*$/mi.test(pane)
    || /^\s*>_ OpenAI Codex[^\n]*\bloading\b/m.test(pane)
    || /^\s*Error: [^\n]*failed during TUI bootstrap:/m.test(pane)
}
export function codexInputReady(pane: string): boolean {
  if (pane.includes('Press enter to continue') || codexBootstrapPending(pane)) return false
  const lines = pane.split(/\r?\n/)
  const composer = lines.findLastIndex(line => { const l = line.trimStart(); return l.startsWith('› ') && !/^› \d+\. /.test(l) })
  if (composer < 0) return false
  // v0.164's NEW-thread startup replaces the loading row with cwd and shows no
  // loading text at all. Its header + placeholder has NO initialized footer.
  // Do not demand a splash on resume (it can scroll away), nor a specific model/statusline.
  if (pane.includes('>_ OpenAI Codex') && !lines.slice(composer + 1).some(l => l.trim())) return false
  return true
}
