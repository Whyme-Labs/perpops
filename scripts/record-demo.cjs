#!/usr/bin/env node
'use strict';

// Records the actual local simulation API. Captions are added after recording;
// application state, receipts and transaction counts are never substituted.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdtemp, mkdir, readFile, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
if (argv.includes('--help')) {
  process.stdout.write(`Usage: node scripts/record-demo.cjs [--output docs/demo.mp4] [--speed 1]\n\nRequires Node 24+, npm ci, Playwright Chromium, and ffmpeg with libass.\nSet PERPOPS_BROWSER_EXECUTABLE to use an existing Chromium binary.\nDefault duration is about 100 seconds. --speed 5 makes a short rehearsal.\nThe script starts an isolated local simulation and never loads a trading key.\n`);
  process.exit(0);
}
function option(name, fallback) {
  const index = argv.indexOf(name);
  return index === -1 ? fallback : argv[index + 1];
}
const output = path.resolve(root, option('--output', 'docs/demo.mp4'));
const speed = Number(option('--speed', '1'));
if (!Number.isFinite(speed) || speed <= 0 || speed > 20) throw new Error('--speed must be between 0 and 20.');
const screenshots = path.join(root, 'docs', 'screenshots');

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-12000); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(stdout) : reject(new Error(`${command} failed (${code}): ${stderr}`)));
  });
}

function assTime(seconds) {
  const centiseconds = Math.max(0, Math.round(seconds * 100));
  const hours = Math.floor(centiseconds / 360000);
  const minutes = Math.floor(centiseconds / 6000) % 60;
  const wholeSeconds = Math.floor(centiseconds / 100) % 60;
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(wholeSeconds).padStart(2, '0')}.${String(centiseconds % 100).padStart(2, '0')}`;
}

function assText(text) { return text.replace(/[{}]/g, '').replace(/\r?\n/g, '\\N'); }

function captionFile(cues, duration) {
  const lines = [
    '[Script Info]', 'ScriptType: v4.00+', 'PlayResX: 1920', 'PlayResY: 1080', 'WrapStyle: 2', 'ScaledBorderAndShadow: yes', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Header,DejaVu Sans,18,&H00C7D5D2,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0.6,0,1,0,0,4,0,0,0,1',
    'Style: Environment,DejaVu Sans,18,&H0077BBE8,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0.3,0,1,0,0,6,0,0,0,1',
    'Style: Chapter,DejaVu Sans,18,&H0077BBE8,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,1,0,1,0,0,4,0,0,0,1',
    'Style: Title,DejaVu Sans,33,&H00E8F0EE,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,4,0,0,0,1',
    'Style: Body,DejaVu Sans,25,&H00AABBB5,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,4,0,0,0,1',
    '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    `Dialogue: 0,0:00:00.00,${assTime(duration)},Header,,0,0,0,,{\\pos(64,24)}PERPOPS / INTENT RECOVERY DEMO`,
    `Dialogue: 0,0:00:00.00,${assTime(duration)},Environment,,0,0,0,,{\\pos(1856,24)}LOCAL SIMULATION / NO BLOCKCHAIN TRANSACTIONS`,
  ];
  cues.forEach((cue, index) => {
    const start = assTime(cue.at);
    const end = assTime(cues[index + 1]?.at ?? duration);
    lines.push(`Dialogue: 1,${start},${end},Chapter,,0,0,0,,{\\pos(72,959)}${String(index + 1).padStart(2, '0')} / ${assText(cue.label.toUpperCase())}`);
    lines.push(`Dialogue: 1,${start},${end},Title,,0,0,0,,{\\pos(72,995)}${assText(cue.title)}`);
    lines.push(`Dialogue: 1,${start},${end},Body,,0,0,0,,{\\pos(72,1042)}${assText(cue.body)}`);
  });
  return `${lines.join('\n')}\n`;
}

(async () => {
  await run('ffmpeg', ['-version']);
  const { startServer } = await import(pathToFileURL(path.join(root, 'src', 'server.ts')).href);
  const temporary = await mkdtemp(path.join(tmpdir(), 'perpops-recording-'));
  await mkdir(screenshots, { recursive: true });
  await mkdir(path.dirname(output), { recursive: true });
  const app = await startServer({ mode: 'simulation', directory: path.join(temporary, 'state'), port: 0 });
  let browser, context, videoPath;
  const cues = [];
  let started = 0;
  const seconds = () => (performance.now() - started) / 1000;
  try {
    const executablePath = process.env.PERPOPS_BROWSER_EXECUTABLE || process.env.PERPOPS_CHROMIUM;
    browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
    });
    context = await browser.newContext({
      viewport: { width: 1600, height: 740 }, deviceScaleFactor: 1,
      locale: 'en-GB', timezoneId: 'UTC',
      recordVideo: { dir: path.join(temporary, 'video'), size: { width: 1600, height: 740 } },
      acceptDownloads: true, reducedMotion: 'reduce',
    });
    const origin = new URL(app.url).origin;
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    started = performance.now();
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const video = page.video();
    const state = async () => (await page.request.get(`${app.url}/api/state`)).json();
    const ready = async () => page.waitForFunction(() => !document.querySelector('#refresh-state').disabled && document.querySelector('#connection-state').textContent.includes('connected'));
    const waitStatus = async value => {
      await page.waitForFunction(expected => document.querySelector('#detail-status').textContent.toLowerCase() === expected, value);
      await ready();
    };
    const until = async moment => {
      let remaining = moment / speed - seconds();
      while (remaining > 0) {
        await page.waitForTimeout(Math.min(remaining, 10) * 1000);
        remaining = moment / speed - seconds();
      }
    };
    const focus = async selector => {
      await page.locator(selector).evaluate(element => window.scrollTo({ top: Math.max(0, element.getBoundingClientRect().top + window.scrollY - 28), behavior: 'instant' }));
      await page.waitForTimeout(300 / speed);
    };
    const click = async selector => {
      await page.locator(selector).hover();
      await page.waitForTimeout(650 / speed);
      await page.locator(selector).click();
    };
    const chapter = (label, title, body) => {
      cues.push({ at: Math.max(0, seconds()), label, title, body });
      process.stdout.write(`[${seconds().toFixed(1)}s] ${title}\n`);
    };

    await page.goto(app.url, { waitUntil: 'networkidle' });
    await ready();
    assert.equal((await state()).mode, 'simulation');
    chapter('The instruction', 'Set a target position. Keep its execution history.', 'The workbench talks to the actual PerpOps local execution service. Prices and balances are fictional.');
    await page.screenshot({ path: path.join(screenshots, 'overview.png'), fullPage: true });
    await until(4);
    await focus('.composer-card');
    await until(10);

    chapter('A controlled failure', 'The order lands. Its acknowledgement disappears.', 'Run the recovery demo to open a 0.001 BTC target and deliberately lose the response.');
    await click('#run-demo');
    await waitStatus('uncertain');
    await focus('.detail-card');
    let observed = await state();
    const initial = observed.intents.find(intent => intent.id === observed.activeIntentId);
    assert(initial);
    const originalId = initial.id;
    const originalHash = initial.attempts[0].hash;
    assert.equal(observed.stats.transactionCount, 1);
    assert.equal(observed.account.position, '0.001');
    await page.screenshot({ path: path.join(screenshots, 'uncertain-intent.png'), fullPage: true });
    await until(22);

    chapter('The uncertain state', 'The persisted hash identifies the existing transaction.', `Observed position: 0.001 BTC. Transactions: 1. Original hash: ${originalHash.slice(0, 12)}…${originalHash.slice(-6)}.`);
    await page.locator('#selected-transaction').hover();
    await until(32);

    chapter('Reconciliation', 'Recover the original transaction.', 'PerpOps checks its receipt, then reads account state at the confirmed block.');
    await click('#recover-intent');
    await waitStatus('completed');
    await focus('.detail-card');
    observed = await state();
    assert.equal(observed.stats.transactionCount, 1);
    assert.equal(observed.account.position, '0.001');
    assert.equal(observed.intents.find(intent => intent.id === originalId).attempts[0].hash, originalHash);
    await page.screenshot({ path: path.join(screenshots, 'recovered-intent.png'), fullPage: true });
    await until(46);

    chapter('The same request', 'Retrying this intent keeps one transaction.', 'The request ID, transaction hash and 0.001 BTC position stay the same.');
    await click('#retry-intent');
    await ready();
    observed = await state();
    assert.equal(observed.stats.transactionCount, 1);
    assert.equal(observed.stats.intentCount, 1);
    assert.equal(observed.account.position, '0.001');
    assert.equal(observed.intents[0].attempts[0].hash, originalHash);
    await focus('.history-card');
    await until(58);

    chapter('The receipt', 'Export the order, receipt and event history.', 'The JSON records the original intent and its recovery. It excludes private keys and signed transaction payloads.');
    const downloadReady = page.waitForEvent('download');
    await click('#export-receipt');
    const download = await downloadReady;
    const receiptPath = path.join(temporary, 'receipt.json');
    await download.saveAs(receiptPath);
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
    assert.equal(receipt.mode, 'simulation');
    assert.equal(receipt.intent.id, originalId);
    assert.equal(receipt.intent.attempts[0].hash, originalHash);
    const receiptKeys = [];
    const collectKeys = value => {
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) { receiptKeys.push(key); collectKeys(child); }
    };
    collectKeys(receipt);
    assert(!receiptKeys.some(key => /privateKey|rawTransaction|serializedTransaction|signedTransaction/i.test(key)));
    await page.locator('.raw-receipt summary').click();
    await page.waitForFunction(() => document.querySelector('#receipt-json').textContent.includes('schemaVersion'));
    await focus('.raw-receipt');
    await until(72);

    chapter('A separate close', 'Review a zero target and its price limit.', 'Prepare close creates a new instruction. Submit it after reviewing the bounded sell price.');
    await click('#close-position');
    await focus('.composer-card');
    assert.equal(await page.locator('#target-input').inputValue(), '0');
    assert(Number(await page.locator('#price-input').inputValue()) < 100000);
    await until(80);
    await click('#submit-intent');
    await waitStatus('completed');
    await focus('.history-card');
    observed = await state();
    assert.equal(observed.account.position, '0');
    assert.equal(observed.stats.intentCount, 2);
    assert.equal(observed.stats.transactionCount, 2);
    assert(observed.intents.some(intent => intent.id !== originalId && intent.target === '0'));
    await until(90);

    chapter('The result', 'Two instructions. Two transactions. A flat position.', 'Local simulation results: recovery reused the original transaction, and a separate close returned the position to zero.');
    await focus('.position-strip');
    await page.screenshot({ path: path.join(screenshots, 'closed-position.png'), fullPage: true });
    await until(100);
    const duration = seconds();
    assert.deepEqual(errors, []);
    await page.close();
    videoPath = await video.path();
    await context.close();
    context = null;

    const mobile = await browser.newPage({ viewport: { width: 375, height: 812 }, reducedMotion: 'reduce' });
    await mobile.goto(app.url, { waitUntil: 'networkidle' });
    await mobile.waitForFunction(() => document.querySelector('#connection-state').textContent.includes('connected'));
    assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await mobile.screenshot({ path: path.join(screenshots, 'mobile.png'), fullPage: true });
    await mobile.close();
    await browser.close();
    browser = null;
    await writeFile(path.join(temporary, 'captions.ass'), captionFile(cues, duration));
    process.stdout.write('Encoding the captioned 1920 × 1080 MP4…\n');
    await run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y', '-i', videoPath,
      '-vf', 'fps=30,scale=1920:888:flags=lanczos,pad=1920:1080:0:48:color=0x0e1518,drawbox=x=0:y=936:w=iw:h=1:color=0x2a363b:t=fill,ass=filename=captions.ass',
      '-t', duration.toFixed(3), '-an', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p',
      '-threads', '2', '-movflags', '+faststart', output,
    ], temporary);
    const metadata = JSON.parse(await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration,size:stream=width,height,codec_name', '-of', 'json', output]));
    assert.equal(metadata.streams[0].width, 1920);
    assert.equal(metadata.streams[0].height, 1080);
    process.stdout.write(`${JSON.stringify({ output: path.relative(root, output), verified: true, simulationOnly: true, metadata }, null, 2)}\n`);
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    await app.close();
    await rm(temporary, { recursive: true, force: true });
  }
})().catch(error => { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; });
