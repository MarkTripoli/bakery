import {
  REPOSITORY_INSPECTION_EXECUTABLES,
  REPOSITORY_INSPECTION_LIMITS,
} from "../../../packages/config/src/env.ts";

/** Code-owned child; stdin is withheld until cgroup attach and limits succeed. */
export const REPOSITORY_INSPECTION_CHILD = `
const limits = ${JSON.stringify(REPOSITORY_INSPECTION_LIMITS)};
const executables = { ...${
  JSON.stringify(REPOSITORY_INSPECTION_EXECUTABLES)
}, deno: ${JSON.stringify(Deno.execPath())} };
const ownerPid = Deno.ppid;
const ownerWatch = setInterval(() => { if (Deno.ppid !== ownerPid) Deno.exit(125); }, 25);
const stdin = [];
let inputBytes = 0;
for await (const bytes of Deno.stdin.readable) { inputBytes += bytes.length; if (inputBytes > 100000) Deno.exit(126); stdin.push(bytes); }
const merged = new Uint8Array(inputBytes);
let position = 0;
for (const bytes of stdin) { merged.set(bytes, position); position += bytes.length; }
const { input, receipt, sourceDirectory, startedAt } = JSON.parse(new TextDecoder().decode(merged));
if (Date.parse(receipt.expiresAt) <= Date.now()) Deno.exit(126);
const digest = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
async function command(tool, args) {
  const started = performance.now();
  let child;
  try { child = new Deno.Command(executables[tool], { args, cwd: sourceDirectory, clearEnv: true, stdin: 'null', stdout: 'piped', stderr: 'piped' }).spawn(); }
  catch { return { status: 'missing', reason: 'tool_missing', exitCode: null, outputDigest: null, durationMs: Math.min(limits.commandMs, Math.floor(performance.now()-started)), text: '' }; }
  let breach = null;
  let total = 0;
  const kill = () => { try { child.kill('SIGKILL'); } catch {} };
  const timer = setTimeout(() => { breach = 'deadline'; kill(); }, limits.commandMs);
  const consume = async stream => {
    const chunks = [];
    let length = 0;
    for await (const bytes of stream) {
      total += bytes.length;
      if (total > limits.outputBytes) { breach = 'output_limit'; kill(); continue; }
      chunks.push(bytes); length += bytes.length;
    }
    const result = new Uint8Array(length);
    let offset = 0;
    for (const bytes of chunks) { result.set(bytes, offset); offset += bytes.length; }
    return result;
  };
  try {
    const [stdout, stderr, status] = await Promise.all([consume(child.stdout), consume(child.stderr), child.status]);
    const combined = new Uint8Array(stdout.length+stderr.length);
    combined.set(stdout); combined.set(stderr, stdout.length);
    return { status: !breach && status.success ? 'passed' : 'failed', reason: breach ?? (status.success ? 'verified' : 'exit_nonzero'), exitCode: breach ? null : status.code >= 0 && status.code <= 255 ? status.code : null, outputDigest: await digest(combined), durationMs: Math.min(limits.commandMs, Math.floor(performance.now()-started)), text: new TextDecoder().decode(stdout) };
  } finally { clearTimeout(timer); }
}
const tools = [];
const evidence = {};
for (const definition of input.profile.config.checkPolicy.tools) {
  const result = await command(definition.tool, ['--version']);
  const line = result.text.split('\\n')[0].trim();
  const available = result.status === 'passed' && line.length > 0 && line.length <= 256 && [...line].every(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127);
  const tool = { tool: definition.tool, status: available ? 'available' : 'missing', version: available ? line : null, outputDigest: available ? result.outputDigest : null };
  tools.push(tool); evidence[definition.tool] = { ...result, available };
}
const checks = [];
for (const check of input.profile.config.checkPolicy.checks) {
  let result;
  if (check.template === 'source.integrity.v1') result = { status: 'passed', reason: 'verified', exitCode: null, outputDigest: input.source.manifestDigest, durationMs: 0 };
  else if (Deno.build.os !== 'linux') result = { status: 'unsupported', reason: 'platform_mismatch', exitCode: null, outputDigest: null, durationMs: 0 };
  else if (check.template === 'unsupported.v1') result = { status: 'unsupported', reason: 'unsupported_command', exitCode: null, outputDigest: null, durationMs: 0 };
  else if (!check.tool || !evidence[check.tool]?.available) result = { status: 'missing', reason: 'tool_missing', exitCode: null, outputDigest: null, durationMs: evidence[check.tool]?.durationMs ?? 0 };
  else if (check.template === 'tool.version.v1') result = evidence[check.tool];
  else if (check.template === 'node.syntax.v1' && check.tool === 'node' && check.paths.length === 1) result = await command('node', ['--check', check.paths[0]]);
  else if (check.template === 'deno.check.v1' && check.tool === 'deno' && check.paths.length > 0) result = await command('deno', ['check', '--no-remote', '--no-npm', '--no-config', '--no-lock', ...check.paths]);
  else result = { status: 'unsupported', reason: 'unsupported_command', exitCode: null, outputDigest: null, durationMs: 0 };
  checks.push({ id: check.id, template: check.template, required: check.required, status: result.status, reason: result.reason, exitCode: result.exitCode, outputDigest: result.outputDigest, durationMs: Math.min(60000, result.durationMs) });
}
const report = { input, receipt, host: { workerHostId: receipt.workerHostId, os: Deno.build.os === 'darwin' ? 'macos' : Deno.build.os, architecture: Deno.build.arch === 'x86_64' ? 'x64' : Deno.build.arch === 'aarch64' ? 'arm64' : Deno.build.arch, tools }, checks, startedAt, completedAt: new Date().toISOString() };
const bytes = new TextEncoder().encode(JSON.stringify(report));
if (bytes.length > limits.reportBytes || Date.parse(receipt.expiresAt) <= Date.now()) Deno.exit(126);
await Deno.stdout.write(bytes);
clearInterval(ownerWatch);
`;
