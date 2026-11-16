// token-radar-01: the entry point (Node 22, standard library only, no build step).
//
// It reads one sealed snapshot, scores every pre-token protocol with the model in ./lib/model.ts, writes
// the ranked board to <output>/board.json and the dashboard's dataset to <output>/data.js, copies the
// dashboard/ and screenshots/ trees into <output>, and last writes <output>/dossier.json with the
// vendored make.fun library. A board the gate would refuse is refused here, before anything is written.
//
// Usage:
//   node main.ts                                  # /input/snapshot.json -> /output
//   node main.ts --input snapshot.json            # one file
//   node main.ts --input ./input --output ./out   # a directory of inputs, an output directory
//   MAKEFUN_OUTPUT_DIR=out node main.ts           # an output directory from the environment
//
// Flags: --input <file|dir> (default /input), --output <dir> (default MAKEFUN_OUTPUT_DIR or /output),
//        --model <file.json> (optional overrides for the model constants), --quiet.

import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODEL, MODEL_VERSION, SnapshotError, boardIssue, buildRadar, dataScript, parseSnapshot, type ModelConstants } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const HERE = fileURLToPath(new URL('.', import.meta.url));

/** The scorer's caps (reference/gate.json): the text cap shapes the bytes, the rest only refuse. */
const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 } as const;
const DASHBOARD_CAPS = { max_files: 400, max_bytes: 4_194_304 } as const;
/** A plain file name, as the dossier and the gate require: a letter, digit or _, then letters, digits and . _ -. */
const PLAIN_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
/** The landing pages of the dashboard, written beside data.js. */
const DASHBOARD_FILES = ['index.html', 'app.css', 'app.js'] as const;
const MIN_SCREENSHOTS = 3;

const log = (line: string): void => void process.stdout.write(`token radar: ${line}\n`);
const die = (line: string, code = 1): never => {
  process.stderr.write(`token radar: ${line}\n`);
  process.exit(code);
};

/** The value of `--name <value>` or `--name=<value>` in the arguments, else the fallback. */
function arg(name: string, fallback: string): string {
  const argv = process.argv;
  const at = argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < argv.length) return argv[at + 1]!;
  const withEquals = argv.find((a) => a.startsWith(`--${name}=`));
  return withEquals === undefined ? fallback : withEquals.slice(name.length + 3);
}

const hasFlag = (name: string): boolean => process.argv.includes(`--${name}`);

/** The snapshot file for an --input value that is a file, a directory, or a path that does not exist yet. */
function snapshotPath(input: string): string {
  if (input.endsWith('.json')) return input;
  return join(input, 'snapshot.json');
}

/** The model constants: the house model, with any whole-number keys of `file` overriding it. */
function loadModel(file: string | null): ModelConstants {
  if (file === null) return MODEL;
  if (!existsSync(file)) die(`no model file at ${file}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    die(`${file} is not JSON`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) die(`${file} is not a JSON object of model constants`);
  const model: ModelConstants = { ...MODEL };
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (!(k in MODEL)) die(`${file} names an unknown model constant: ${k}`);
    if (typeof v !== 'number' || !Number.isFinite(v)) die(`${file}'s ${k} is not a finite number`);
    (model as unknown as Record<string, number>)[k] = v;
  }
  return model;
}

/** Every regular file of `from`, copied into `to`; names starting with a dot are skipped. */
function copyTree(from: string, to: string): string[] {
  if (!existsSync(from)) die(`${from} is missing: the repository must carry it beside main.ts`);
  if (!lstatSync(from).isDirectory()) die(`${from} is not a directory`);
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

// ------------------------------------------------------------------ arguments

const inputArg = arg('input', '/input');
const inputFile = snapshotPath(inputArg);
if (!existsSync(inputFile)) die(`no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input`, 2);
const outDir = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');
const modelFile = process.argv.some((a) => a === '--model' || a.startsWith('--model=')) ? arg('model', '') : null;
const quiet = hasFlag('quiet');

// ------------------------------------------------------------------ the board

let snapshot;
try {
  snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
} catch (err) {
  if (err instanceof SnapshotError) die(`${inputFile}: ${err.message}`);
  throw err;
}
const model = loadModel(modelFile);
const { board, radar } = buildRadar(snapshot, model);
const issue = boardIssue(board, snapshot);
if (issue !== null) die(`the model wrote a board the gate refuses: ${issue}`);

// ------------------------------------------------------------------ output

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'board.json'), `${JSON.stringify({ model_version: MODEL_VERSION, as_of: snapshot.as_of, rows: board })}\n`);
writeFileSync(join(outDir, 'data.js'), dataScript(radar));

const dashboard = copyTree(join(HERE, 'dashboard'), join(outDir, 'dashboard'));
for (const name of DASHBOARD_FILES) if (!dashboard.includes(name)) die(`dashboard/${name} is missing from the repository`);
const shots = copyTree(join(HERE, 'screenshots'), join(outDir, 'screenshots'));
if (shots.length < MIN_SCREENSHOTS) die(`screenshots/ holds ${shots.length} image${shots.length === 1 ? '' : 's'}: hand in 3 — the board, a detail view and a filtered view`);
for (const name of shots) if (!PLAIN_NAME.test(name)) die(`screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters`);

// The dossier is written last: the scorer rebuilds it from this output directory and compares bytes.
let dossier: Uint8Array;
try {
  dossier = buildDossier(outDir, { text_max_bytes: TEXT_MAX_BYTES, screenshots: SCREENSHOT_CAPS, dashboard: DASHBOARD_CAPS });
} catch (err) {
  die(`the dossier could not be built from ${outDir}: ${(err as Error).message}`);
}
writeFileSync(join(outDir, 'dossier.json'), dossier);

if (!quiet) {
  const early = radar.early_size;
  log(`${snapshot.protocols.length} protocols read, ${radar.watchlist_size} on the watchlist, ${board.length} pre-token rows scored (${early} early below or off the floor, ${radar.live_size} live-token protocols set aside)`);
  log(`${MODEL_VERSION}: $${board[0]!.implied_value_usd.toLocaleString('en-US')} at rank 1, $${board[board.length - 1]!.implied_value_usd.toLocaleString('en-US')} at rank ${board.length}`);
  log(`wrote board.json, data.js, dashboard/ (${dashboard.length} files), screenshots/ (${shots.length} images) and dossier.json to ${outDir}`);
}
